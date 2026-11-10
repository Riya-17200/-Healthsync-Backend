
console.log("APPOINTMENT ROUTES LOADED");

const express = require("express");
const mongoose = require("mongoose");
const crypto = require("crypto");
const router = express.Router();

const { paymentMode, razorpay } = require("../config/paymentGateway");

const Appointment = require("../models/appointment");
const Doctor = require("../models/doctor");
const DoctorSchedule = require("../models/doctorSchedule");
const Payment = require("../models/payment");

const authMiddleware = require("../middleware/authMiddleware");
const doctorVerificationMiddleware = require("../middleware/doctorVerificationMiddleware");

const ONLINE_PAYMENT_WINDOW_MINUTES = 10;

// Convert HH:mm into minutes
function timeToMinutes(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

// Get today's date in Indian Standard Time
function getTodayIST() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = {};
  for (const part of parts) values[part.type] = part.value;

  return `${values.year}-${values.month}-${values.day}`;
}

// Find another appointment that currently occupies an overlapping slot.
// Online pending appointments occupy a slot only while their payment window is active.
async function findSlotConflict({
  doctorId,
  appointmentDate,
  startTime,
  endTime,
  excludeAppointmentId,
}) {
  const now = new Date();

  const query = {
    doctorId,
    appointmentDate,
    startTime: { $lt: endTime },
    endTime: { $gt: startTime },
    $or: [
      { appointmentStatus: "confirmed" },
      {
        appointmentStatus: "pending",
        paymentMethod: "cash",
      },
      {
        appointmentStatus: "pending",
        paymentMethod: { $in: ["upi", "card"] },
        paymentStatus: "pending",
        onlinePaymentExpiresAt: { $gt: now },
      },
    ],
  };

  if (excludeAppointmentId) {
    query._id = { $ne: excludeAppointmentId };
  }

  return Appointment.findOne(query);
}

// Create a mock or Razorpay order.
async function createOnlinePaymentOrder(payment, appointment) {
  if (paymentMode === "mock") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Mock payments are disabled in production.");
    }

    const orderId =
      "mock_order_" + crypto.randomBytes(12).toString("hex");

    payment.mockOrderId = orderId;
    payment.razorpayOrderId = null;
    payment.razorpayPaymentId = null;

    return {
      paymentMode: "mock",
      orderId,
      amount: payment.amount,
      currency: payment.currency,
    };
  }

  if (paymentMode === "razorpay") {
    if (!razorpay) {
      throw new Error("Razorpay is not configured.");
    }

    const order = await razorpay.orders.create({
      amount: Math.round(payment.amount * 100),
      currency: payment.currency,
      receipt: appointment._id.toString(),
    });

    payment.razorpayOrderId = order.id;
    payment.mockOrderId = null;
    payment.razorpayPaymentId = null;

    return {
      paymentMode: "razorpay",
      orderId: order.id,
      keyId: process.env.RAZORPAY_KEY_ID,
      amount: Math.round(payment.amount * 100),
      currency: payment.currency,
    };
  }

  throw new Error("Unsupported payment mode.");
}

// ==========================================
// POST /api/appointments/book
// Patient books an appointment and starts online payment
// ==========================================

router.post("/book", authMiddleware, async (req, res) => {
  let appointment = null;
  let payment = null;

  try {
    const {
      doctorId,
      appointmentDate,
      startTime,
      endTime,
      paymentMethod,
    } = req.body;

    if (req.user.role !== "patient") {
      return res.status(403).json({
        message: "Only patients can book appointments.",
      });
    }

    if (
      !doctorId ||
      !appointmentDate ||
      !startTime ||
      !endTime ||
      !paymentMethod
    ) {
      return res.status(400).json({
        message: "Please provide all required fields.",
      });
    }

    if (!mongoose.isValidObjectId(doctorId)) {
      return res.status(400).json({
        message: "Invalid doctor ID.",
      });
    }

    if (!["upi", "card", "cash"].includes(paymentMethod)) {
      return res.status(400).json({
        message: "Choose UPI, card or cash.",
      });
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

    if (!dateRegex.test(appointmentDate)) {
      return res.status(400).json({
        message: "Date must be in YYYY-MM-DD format.",
      });
    }

    const [year, month, day] = appointmentDate.split("-").map(Number);
    const appointmentDay = new Date(Date.UTC(year, month - 1, day));

    if (
      appointmentDay.getUTCFullYear() !== year ||
      appointmentDay.getUTCMonth() !== month - 1 ||
      appointmentDay.getUTCDate() !== day
    ) {
      return res.status(400).json({
        message: "Invalid appointment date.",
      });
    }

    const today = getTodayIST();

    if (appointmentDate < today) {
      return res.status(400).json({
        message: "Appointment date cannot be in the past.",
      });
    }

    const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

    if (
      !timeRegex.test(startTime) ||
      !timeRegex.test(endTime) ||
      startTime >= endTime
    ) {
      return res.status(400).json({
        message: "Invalid appointment time.",
      });
    }

    if (appointmentDate === today) {
      const indiaTime = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date());

      if (startTime <= indiaTime) {
        return res.status(400).json({
          message: "This appointment time has already passed.",
        });
      }
    }

    const doctor = await Doctor.findOne({
      _id: doctorId,
      verificationStatus: "approved",
    });

    if (!doctor) {
      return res.status(404).json({
        message: "Approved doctor not found.",
      });
    }

    if (
      typeof doctor.consultationFee !== "number" ||
      !Number.isFinite(doctor.consultationFee) ||
      doctor.consultationFee < 0
    ) {
      return res.status(400).json({
        message: "Doctor consultation fee is not configured correctly.",
      });
    }

    const dateSchedule = await DoctorSchedule.findOne({
      doctorId: doctor._id,
      scheduleType: "date",
      date: appointmentDate,
    });

    let selectedSchedule = dateSchedule;

    if (!selectedSchedule) {
      selectedSchedule = await DoctorSchedule.findOne({
        doctorId: doctor._id,
        scheduleType: "weekly",
        dayOfWeek: appointmentDay.getUTCDay(),
      });
    }

    if (!selectedSchedule || !selectedSchedule.isAvailable) {
      return res.status(400).json({
        message: "Doctor is not available on this date.",
      });
    }

    const requestedStart = timeToMinutes(startTime);
    const requestedEnd = timeToMinutes(endTime);

    const validSlot = selectedSchedule.timeSlots.some((slot) => {
      const scheduleStart = timeToMinutes(slot.startTime);
      const scheduleEnd = timeToMinutes(slot.endTime);
      const duration = slot.slotDurationMinutes || 30;

      return (
        requestedStart >= scheduleStart &&
        requestedEnd <= scheduleEnd &&
        requestedEnd - requestedStart === duration &&
        (requestedStart - scheduleStart) % duration === 0
      );
    });

    if (!validSlot) {
      return res.status(400).json({
        message:
          "Selected time is not a valid appointment slot in the doctor's schedule.",
      });
    }

    const conflict = await findSlotConflict({
      doctorId: doctor._id,
      appointmentDate: appointmentDay,
      startTime,
      endTime,
    });

    if (conflict) {
      return res.status(409).json({
        message: "This appointment slot is already booked or being held for payment.",
      });
    }

    const isCash = paymentMethod === "cash";
    const paymentExpiry = isCash
      ? null
      : new Date(Date.now() + ONLINE_PAYMENT_WINDOW_MINUTES * 60 * 1000);

    appointment = await Appointment.create({
      patientId: req.user.userId,
      doctorId: doctor._id,
      appointmentDate: appointmentDay,
      startTime,
      endTime,
      consultationFee: doctor.consultationFee,
      paymentMethod,
      appointmentStatus: isCash ? "confirmed" : "pending",
      paymentStatus: "pending",
      onlinePaymentExpiresAt: paymentExpiry,
    });

    payment = await Payment.create({
      appointmentId: appointment._id,
      patientId: req.user.userId,
      doctorId: doctor._id,
      amount: doctor.consultationFee,
      currency: "INR",
      paymentMethod,
      paymentStatus: "pending",
    });

    // Cash appointment: confirmed immediately, no online order needed.
    if (isCash) {
      return res.status(201).json({
        message: "Appointment booked successfully. Pay the doctor in cash.",
        appointment,
        payment,
      });
    }

    // UPI/Card: create payment order immediately during booking.
    const orderDetails = await createOnlinePaymentOrder(
      payment,
      appointment
    );

    await payment.save();

    return res.status(201).json({
      message: "Appointment held successfully. Complete payment within 10 minutes.",
      appointment,
      payment: {
        _id: payment._id,
        amount: payment.amount,
        currency: payment.currency,
        paymentMethod: payment.paymentMethod,
        paymentStatus: payment.paymentStatus,
        retryCount: payment.retryCount,
      },
      paymentOrder: orderDetails,
      expiresAt: appointment.onlinePaymentExpiresAt,
    });
  } catch (error) {
    console.error("Appointment booking error:", error);

    // Remove partially created records if booking/order creation fails.
    if (payment) {
      await Payment.findByIdAndDelete(payment._id).catch(() => {});
    }

    if (appointment) {
      await Appointment.findByIdAndDelete(appointment._id).catch(() => {});
    }

    return res.status(500).json({
      message: "Server error while booking appointment or creating payment order.",
    });
  }
});

// ==========================================
// GET /api/appointments/my
// Patient views their appointments
// ==========================================

router.get("/my", authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== "patient") {
      return res.status(403).json({
        message: "Only patients can view their appointments.",
      });
    }

    const appointments = await Appointment.find({
      patientId: req.user.userId,
    })
      .populate("doctorId", "specialization qualification consultationFee")
      .sort({ appointmentDate: -1, startTime: -1 });

    return res.status(200).json({
      message: "Patient appointments fetched successfully.",
      totalAppointments: appointments.length,
      appointments,
    });
  } catch (error) {
    console.error("Fetch patient appointments error:", error);

    return res.status(500).json({
      message: "Server error while fetching appointments.",
    });
  }
});

// ==========================================
// GET /api/appointments/doctor
// Doctor views their appointments
// ==========================================

router.get(
  "/doctor",
  authMiddleware,
  doctorVerificationMiddleware,
  async (req, res) => {
    try {
      const appointments = await Appointment.find({
        doctorId: req.doctor._id,
      })
        .populate("patientId", "fullName email phoneNumber")
        .sort({ appointmentDate: 1, startTime: 1 });

      return res.status(200).json({
        message: "Doctor appointments fetched successfully.",
        totalAppointments: appointments.length,
        appointments,
      });
    } catch (error) {
      console.error("Fetch doctor appointments error:", error);

      return res.status(500).json({
        message: "Server error while fetching doctor appointments.",
      });
    }
  }
);

// ==========================================
// PATCH /api/appointments/:id/cancel
// Patient cancels their appointment
// ==========================================

router.patch("/:id/cancel", authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== "patient") {
      return res.status(403).json({
        message: "Only patients can cancel appointments.",
      });
    }

    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        message: "Invalid appointment ID.",
      });
    }

    const appointment = await Appointment.findOne({
      _id: id,
      patientId: req.user.userId,
    });

    if (!appointment) {
      return res.status(404).json({
        message: "Appointment not found.",
      });
    }

    if (["cancelled", "completed"].includes(appointment.appointmentStatus)) {
      return res.status(400).json({
        message: "This appointment cannot be cancelled.",
      });
    }

    appointment.appointmentStatus = "cancelled";
    appointment.onlinePaymentExpiresAt = null;
    await appointment.save();

    return res.status(200).json({
      message: "Appointment cancelled successfully.",
      appointment,
    });
  } catch (error) {
    console.error("Cancel appointment error:", error);

    return res.status(500).json({
      message: "Server error while cancelling appointment.",
    });
  }
});

// ==========================================
// PATCH /api/appointments/:id/complete
// Doctor completes their appointment
// ==========================================

router.patch(
  "/:id/complete",
  authMiddleware,
  doctorVerificationMiddleware,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!mongoose.isValidObjectId(id)) {
        return res.status(400).json({
          message: "Invalid appointment ID.",
        });
      }

      const appointment = await Appointment.findOne({
        _id: id,
        doctorId: req.doctor._id,
      });

      if (!appointment) {
        return res.status(404).json({
          message: "Appointment not found.",
        });
      }

      if (appointment.appointmentStatus !== "confirmed") {
        return res.status(400).json({
          message: "Only confirmed appointments can be completed.",
        });
      }

      appointment.appointmentStatus = "completed";
      appointment.onlinePaymentExpiresAt = null;
      await appointment.save();

      return res.status(200).json({
        message: "Appointment marked as completed successfully.",
        appointment,
      });
    } catch (error) {
      console.error("Complete appointment error:", error);

      return res.status(500).json({
        message: "Server error while completing appointment.",
      });
    }
  }
);

// ==========================================
// PATCH /api/appointments/:id/cash-payment
// Doctor marks cash payment as paid
// ==========================================

router.patch(
  "/:id/cash-payment",
  authMiddleware,
  doctorVerificationMiddleware,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!mongoose.isValidObjectId(id)) {
        return res.status(400).json({
          message: "Invalid appointment ID.",
        });
      }

      const appointment = await Appointment.findOne({
        _id: id,
        doctorId: req.doctor._id,
        paymentMethod: "cash",
      });

      if (!appointment) {
        return res.status(404).json({
          message: "Cash appointment not found for this doctor.",
        });
      }

      if (appointment.appointmentStatus === "cancelled") {
        return res.status(400).json({
          message: "Cannot collect payment for a cancelled appointment.",
        });
      }

      if (appointment.paymentStatus === "paid") {
        return res.status(400).json({
          message: "Payment has already been marked as paid.",
        });
      }

      const payment = await Payment.findOne({
        appointmentId: appointment._id,
      });

      if (!payment || payment.paymentMethod !== "cash") {
        return res.status(404).json({
          message: "Cash payment record not found.",
        });
      }

      if (payment.paymentStatus !== "pending") {
        return res.status(400).json({
          message: "This payment cannot be updated.",
        });
      }

      payment.paymentStatus = "paid";
      payment.paidAt = new Date();
      await payment.save();

      appointment.paymentStatus = "paid";
      await appointment.save();

      return res.status(200).json({
        message: "Cash payment marked as paid successfully.",
        appointment,
        payment,
      });
    } catch (error) {
      console.error("Cash payment error:", error);

      return res.status(500).json({
        message: "Server error while updating cash payment.",
      });
    }
  }
);

// ==========================================
// PATCH /api/appointments/:id/refund
// Mock refund
// ==========================================

router.patch(
  "/:id/refund",
  authMiddleware,
  doctorVerificationMiddleware,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!mongoose.isValidObjectId(id)) {
        return res.status(400).json({
          message: "Invalid appointment ID.",
        });
      }

      if (paymentMode !== "mock" || process.env.NODE_ENV === "production") {
        return res.status(503).json({
          message: "This refund endpoint currently supports development mock mode only.",
        });
      }

      const appointment = await Appointment.findOne({
        _id: id,
        doctorId: req.doctor._id,
      });

      if (!appointment) {
        return res.status(404).json({
          message: "Appointment not found for this doctor.",
        });
      }

      if (appointment.paymentStatus !== "paid") {
        return res.status(400).json({
          message: "Only paid appointments can be refunded.",
        });
      }

      const payment = await Payment.findOne({
        appointmentId: appointment._id,
        doctorId: req.doctor._id,
      });

      if (!payment || payment.paymentStatus !== "paid") {
        return res.status(400).json({
          message: "A paid payment record was not found.",
        });
      }

      payment.paymentStatus = "refunded";
      payment.refundedAt = new Date();
      await payment.save();

      appointment.paymentStatus = "refunded";
      await appointment.save();

      return res.status(200).json({
        message: "Mock refund recorded successfully. No actual money was transferred.",
        appointment,
        payment,
      });
    } catch (error) {
      console.error("Refund processing error:", error);

      return res.status(500).json({
        message: "Server error while processing refund.",
      });
    }
  }
);

// ==========================================
// POST /api/appointments/:id/create-payment-order
// Retry an online payment
// ==========================================

router.post(
  "/:id/create-payment-order",
  authMiddleware,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (req.user.role !== "patient") {
        return res.status(403).json({
          message: "Only patients can initiate payment.",
        });
      }

      if (!mongoose.isValidObjectId(id)) {
        return res.status(400).json({
          message: "Invalid appointment ID.",
        });
      }

      const appointment = await Appointment.findOne({
        _id: id,
        patientId: req.user.userId,
      });

      if (!appointment) {
        return res.status(404).json({
          message: "Appointment not found.",
        });
      }

      if (appointment.appointmentStatus !== "pending") {
        return res.status(400).json({
          message: "Only pending online appointments can be paid or retried.",
        });
      }

      if (!["upi", "card"].includes(appointment.paymentMethod)) {
        return res.status(400).json({
          message: "Online payment is not applicable to this appointment.",
        });
      }

      const payment = await Payment.findOne({
        appointmentId: appointment._id,
        patientId: req.user.userId,
      });

      if (!payment) {
        return res.status(404).json({
          message: "Payment record not found.",
        });
      }

      if (payment.paymentStatus === "paid") {
        return res.status(400).json({
          message: "This appointment is already paid.",
        });
      }

      if (payment.paymentStatus === "refunded") {
        return res.status(400).json({
          message: "A refunded payment cannot be retried.",
        });
      }

      if (
        !Number.isFinite(payment.amount) ||
        payment.amount <= 0
      ) {
        return res.status(400).json({
          message: "Invalid payment amount.",
        });
      }

      const now = new Date();
      const currentOrderStillActive =
        payment.paymentStatus === "pending" &&
        appointment.onlinePaymentExpiresAt &&
        appointment.onlinePaymentExpiresAt > now &&
        (paymentMode === "mock"
          ? Boolean(payment.mockOrderId)
          : Boolean(payment.razorpayOrderId));

      // If the original order is still active, return it instead of
      // generating another order.
      if (currentOrderStillActive) {
        return res.status(200).json({
          message: "An active payment order already exists.",
          paymentMode,
          orderId:
            paymentMode === "mock"
              ? payment.mockOrderId
              : payment.razorpayOrderId,
          keyId:
            paymentMode === "razorpay"
              ? process.env.RAZORPAY_KEY_ID
              : undefined,
          amount:
            paymentMode === "razorpay"
              ? Math.round(payment.amount * 100)
              : payment.amount,
          currency: payment.currency,
          expiresAt: appointment.onlinePaymentExpiresAt,
          retryCount: payment.retryCount || 0,
        });
      }

      // The old payment attempt failed or its 10-minute hold expired.
      const conflict = await findSlotConflict({
        doctorId: appointment.doctorId,
        appointmentDate: appointment.appointmentDate,
        startTime: appointment.startTime,
        endTime: appointment.endTime,
        excludeAppointmentId: appointment._id,
      });

      if (conflict) {
        appointment.appointmentStatus = "cancelled";
        appointment.onlinePaymentExpiresAt = null;
        await appointment.save();

        return res.status(409).json({
          message: "This slot is no longer available. Please book another slot.",
        });
      }

      const orderDetails = await createOnlinePaymentOrder(
        payment,
        appointment
      );

      payment.paymentStatus = "pending";
      payment.retryCount = (payment.retryCount || 0) + 1;
      await payment.save();

      appointment.paymentStatus = "pending";
      appointment.onlinePaymentExpiresAt = new Date(
        Date.now() + ONLINE_PAYMENT_WINDOW_MINUTES * 60 * 1000
      );
      await appointment.save();

      return res.status(200).json({
        message: "New payment retry order created successfully.",
        ...orderDetails,
        paymentStatus: payment.paymentStatus,
        retryCount: payment.retryCount,
        expiresAt: appointment.onlinePaymentExpiresAt,
      });
    } catch (error) {
      console.error("Payment order creation error:", error);

      return res.status(500).json({
        message: "Failed to create payment order.",
      });
    }
  }
);

// ==========================================
// POST /api/appointments/:id/verify-payment
// Verify UPI/Card payment
// ==========================================

router.post(
  "/:id/verify-payment",
  authMiddleware,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (req.user.role !== "patient") {
        return res.status(403).json({
          message: "Only patients can verify payments.",
        });
      }

      if (!mongoose.isValidObjectId(id)) {
        return res.status(400).json({
          message: "Invalid appointment ID.",
        });
      }

      const appointment = await Appointment.findOne({
        _id: id,
        patientId: req.user.userId,
      });

      if (!appointment) {
        return res.status(404).json({
          message: "Appointment not found.",
        });
      }

      if (appointment.appointmentStatus === "cancelled") {
        return res.status(400).json({
          message: "Cannot pay for a cancelled appointment.",
        });
      }

      const payment = await Payment.findOne({
        appointmentId: appointment._id,
        patientId: req.user.userId,
      });

      if (!payment) {
        return res.status(404).json({
          message: "Payment record not found.",
        });
      }

      if (!["upi", "card"].includes(payment.paymentMethod)) {
        return res.status(400).json({
          message: "This API only supports online payments.",
        });
      }

      if (payment.paymentStatus === "paid") {
        return res.status(200).json({
          message: "Payment is already verified.",
          appointment,
          payment,
        });
      }

      if (payment.paymentStatus !== "pending") {
        return res.status(400).json({
          message: "Payment is not in pending status. Please create a retry order.",
        });
      }

      // MOCK PAYMENT VERIFICATION
      if (paymentMode === "mock") {
        if (process.env.NODE_ENV === "production") {
          return res.status(403).json({
            message: "Mock payments are disabled in production.",
          });
        }

        const { orderId, paymentResult } = req.body;

        if (!orderId || orderId !== payment.mockOrderId) {
          return res.status(400).json({
            message: "Invalid mock order ID.",
          });
        }

        if (!["success", "failed"].includes(paymentResult)) {
          return res.status(400).json({
            message: 'paymentResult must be either "success" or "failed".',
          });
        }

        if (paymentResult === "failed") {
          payment.paymentStatus = "failed";
          await payment.save();

          appointment.paymentStatus = "failed";
          appointment.onlinePaymentExpiresAt = null;
          await appointment.save();

          return res.status(200).json({
            message: "Mock payment failure recorded. You can retry payment if the slot is still available.",
            appointment,
            payment,
          });
        }
      }

      // RAZORPAY PAYMENT VERIFICATION
      else if (paymentMode === "razorpay") {
        const {
          razorpay_order_id,
          razorpay_payment_id,
          razorpay_signature,
        } = req.body;

        if (
          !razorpay_order_id ||
          !razorpay_payment_id ||
          !razorpay_signature
        ) {
          return res.status(400).json({
            message: "Razorpay payment details are required.",
          });
        }

        if (razorpay_order_id !== payment.razorpayOrderId) {
          return res.status(400).json({
            message: "Invalid Razorpay order ID.",
          });
        }

        if (!process.env.RAZORPAY_KEY_SECRET) {
          return res.status(500).json({
            message: "Razorpay key secret is not configured.",
          });
        }

        const generatedSignature = crypto
          .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
          .update(razorpay_order_id + "|" + razorpay_payment_id)
          .digest("hex");

        const received = Buffer.from(razorpay_signature, "utf8");
        const generated = Buffer.from(generatedSignature, "utf8");

        if (
          received.length !== generated.length ||
          !crypto.timingSafeEqual(received, generated)
        ) {
          return res.status(400).json({
            message: "Payment signature verification failed.",
          });
        }

        const razorpayPayment = await razorpay.payments.fetch(
          razorpay_payment_id
        );

        if (razorpayPayment.order_id !== payment.razorpayOrderId) {
          return res.status(400).json({
            message: "Payment order mismatch.",
          });
        }

        if (razorpayPayment.status !== "captured") {
          return res.status(400).json({
            message: "Payment has not been captured yet.",
            paymentStatus: razorpayPayment.status,
          });
        }

        const expectedAmount = Math.round(payment.amount * 100);

        if (
          razorpayPayment.amount !== expectedAmount ||
          razorpayPayment.currency !== payment.currency
        ) {
          return res.status(400).json({
            message: "Payment amount or currency mismatch.",
          });
        }

        if (
          razorpayPayment.method &&
          razorpayPayment.method !== payment.paymentMethod
        ) {
          return res.status(400).json({
            message: "Payment method mismatch.",
          });
        }

        payment.razorpayPaymentId = razorpay_payment_id;
      } else {
        return res.status(400).json({
          message: "Unsupported payment mode.",
        });
      }

      // Check whether another patient booked the slot after this
      // appointment's 10-minute payment hold expired.
      const conflict = await findSlotConflict({
        doctorId: appointment.doctorId,
        appointmentDate: appointment.appointmentDate,
        startTime: appointment.startTime,
        endTime: appointment.endTime,
        excludeAppointmentId: appointment._id,
      });

      payment.paymentStatus = "paid";
      payment.paidAt = new Date();
      await payment.save();

      if (conflict) {
        // Payment was captured, but the original slot is no longer free.
        // Do not confirm a conflicting appointment.
        appointment.appointmentStatus = "cancelled";
        appointment.paymentStatus = "paid";
        appointment.onlinePaymentExpiresAt = null;
        await appointment.save();

        return res.status(409).json({
          message: "Payment was received, but the slot is no longer available. Contact support to arrange a refund.",
          appointment,
          payment,
        });
      }

      appointment.appointmentStatus = "confirmed";
      appointment.paymentStatus = "paid";
      appointment.onlinePaymentExpiresAt = null;
      await appointment.save();

      return res.status(200).json({
        message: "Payment verified successfully. Appointment confirmed.",
        appointment,
        payment,
      });
    } catch (error) {
      console.error("Payment verification error:", error);

      return res.status(500).json({
        message: "Payment verification failed.",
      });
    }
  }
);

module.exports = router;

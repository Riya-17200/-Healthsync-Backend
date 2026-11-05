
console.log("APPOINTMENT ROUTES LOADED");

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const crypto = require("crypto");

const { paymentMode, razorpay } = require("../config/paymentGateway");

const Appointment = require("../models/appointment");
const Doctor = require("../models/doctor");
const DoctorSchedule = require("../models/doctorSchedule");
const Payment = require("../models/payment");

const authMiddleware = require("../middleware/authMiddleware");
const doctorVerificationMiddleware = require("../middleware/doctorVerificationMiddleware");

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

  for (const part of parts) {
    values[part.type] = part.value;
  }

  return `${values.year}-${values.month}-${values.day}`;
}

// ==========================================
// POST /api/appointments/book
// Patient books an appointment
// ==========================================

router.post("/book", authMiddleware, async (req, res) => {
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

    const appointmentDay = new Date(
      Date.UTC(year, month - 1, day)
    );

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
      const dayOfWeek = appointmentDay.getUTCDay();

      selectedSchedule = await DoctorSchedule.findOne({
        doctorId: doctor._id,
        scheduleType: "weekly",
        dayOfWeek,
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

      const requestedDuration = requestedEnd - requestedStart;
      const offset = requestedStart - scheduleStart;

      return (
        requestedStart >= scheduleStart &&
        requestedEnd <= scheduleEnd &&
        requestedDuration === duration &&
        offset >= 0 &&
        offset % duration === 0
      );
    });

    if (!validSlot) {
      return res.status(400).json({
        message:
          "Selected time is not a valid appointment slot in the doctor's schedule.",
      });
    }

    const existingAppointment = await Appointment.findOne({
      doctorId: doctor._id,
      appointmentDate: appointmentDay,
      appointmentStatus: {
        $in: ["pending", "confirmed"],
      },
      startTime: { $lt: endTime },
      endTime: { $gt: startTime },
    });

    if (existingAppointment) {
      return res.status(409).json({
        message: "This appointment slot is already booked.",
      });
    }

    const appointment = await Appointment.create({
      patientId: req.user.userId,
      doctorId: doctor._id,
      appointmentDate: appointmentDay,
      startTime,
      endTime,
      consultationFee: doctor.consultationFee,
      paymentMethod,
      appointmentStatus: "confirmed",
      paymentStatus: "pending",
    });

    let payment;

    try {
      payment = await Payment.create({
        appointmentId: appointment._id,
        patientId: req.user.userId,
        doctorId: doctor._id,
        amount: doctor.consultationFee,
        currency: "INR",
        paymentMethod,
        paymentStatus: "pending",
      });
    } catch (paymentError) {
      await Appointment.findByIdAndDelete(appointment._id);
      throw paymentError;
    }

    return res.status(201).json({
      message: "Appointment booked successfully. Payment is pending.",
      appointment,
      payment,
    });
  } catch (error) {
    console.error("Appointment booking error:", error);

    return res.status(500).json({
      message: "Server error while booking appointment.",
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
      console.log("========== DATABASE DEBUG ==========");

      console.log("Database:", mongoose.connection.name);
      console.log("MongoDB Host:", mongoose.connection.host);
      console.log("Collection:", Appointment.collection.name);

      console.log(
        "Doctor Profile ID:",
        req.doctor._id.toString()
      );

      console.log(
        "Doctor ID Type:",
        typeof req.doctor._id,
        req.doctor._id.constructor.name
      );

      const totalDocuments = await Appointment.countDocuments({});

      console.log(
        "Total appointments in backend DB:",
        totalDocuments
      );

      const firstDocument = await Appointment.collection.findOne({});

      console.log(
        "FIRST DOCUMENT IN BACKEND DATABASE:",
        JSON.stringify(firstDocument, null, 2)
      );

      const rawMatch = await Appointment.collection.findOne({
        doctorId: new mongoose.Types.ObjectId(
          req.doctor._id.toString()
        ),
      });

      console.log(
        "RAW MONGODB MATCHING DOCUMENT:",
        JSON.stringify(rawMatch, null, 2)
      );

      const appointments = await Appointment.find({
        doctorId: req.doctor._id,
      })
        .populate("patientId", "fullName email phoneNumber")
        .sort({ appointmentDate: 1, startTime: 1 });

      console.log(
        "MONGOOSE APPOINTMENTS FOUND:",
        appointments.length
      );

      console.log("====================================");

      return res.status(200).json({
        message: "Doctor appointments fetched successfully.",
        totalAppointments: appointments.length,
        appointments,
      });
    } catch (error) {
      console.error("Fetch doctor appointments error:", error);

      return res.status(500).json({
        message: "Server error while fetching appointments.",
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

    if (appointment.appointmentStatus === "cancelled") {
      return res.status(400).json({
        message: "Appointment is already cancelled.",
      });
    }

    if (appointment.appointmentStatus === "completed") {
      return res.status(400).json({
        message: "Completed appointments cannot be cancelled.",
      });
    }

    appointment.appointmentStatus = "cancelled";

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

      if (appointment.appointmentStatus === "cancelled") {
        return res.status(400).json({
          message: "Cancelled appointments cannot be completed.",
        });
      }

      if (appointment.appointmentStatus === "completed") {
        return res.status(400).json({
          message: "Appointment is already completed.",
        });
      }

      appointment.appointmentStatus = "completed";

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

      if (!payment) {
        return res.status(404).json({
          message: "Payment record not found.",
        });
      }

      if (payment.paymentMethod !== "cash") {
        return res.status(400).json({
          message: "This API is only for cash payments.",
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
        error: error.message,
      });
    }
  }
);

// ==========================================
// POST /api/appointments/:id/create-payment-order
// Create payment order for UPI/Card
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

      if (appointment.appointmentStatus === "cancelled") {
        return res.status(400).json({
          message: "Cannot pay for a cancelled appointment.",
        });
      }

      if (!["upi", "card"].includes(appointment.paymentMethod)) {
        return res.status(400).json({
          message: "Online payment is not applicable to this appointment.",
        });
      }

      if (appointment.paymentStatus === "paid") {
        return res.status(400).json({
          message: "This appointment is already paid.",
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

      if (payment.paymentStatus !== "pending") {
        return res.status(400).json({
          message: "This payment cannot be processed.",
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

      // MOCK PAYMENT MODE
      if (paymentMode === "mock") {
        if (process.env.NODE_ENV === "production") {
          return res.status(403).json({
            message: "Mock payments are disabled in production.",
          });
        }

        if (!payment.mockOrderId) {
          payment.mockOrderId =
            "mock_order_" +
            crypto.randomBytes(12).toString("hex");

          await payment.save();
        }

        return res.status(200).json({
          message: "Mock payment order created successfully.",
          paymentMode: "mock",
          orderId: payment.mockOrderId,
          amount: payment.amount,
          currency: payment.currency,
          paymentStatus: payment.paymentStatus,
        });
      }

      // RAZORPAY MODE
      if (paymentMode === "razorpay") {
        if (!payment.razorpayOrderId) {
          const order = await razorpay.orders.create({
            amount: Math.round(payment.amount * 100),
            currency: payment.currency,
            receipt: appointment._id.toString(),
          });

          payment.razorpayOrderId = order.id;
          await payment.save();
        }

        return res.status(200).json({
          message: "Razorpay order created successfully.",
          paymentMode: "razorpay",
          orderId: payment.razorpayOrderId,
          keyId: process.env.RAZORPAY_KEY_ID,
          amount: Math.round(payment.amount * 100),
          currency: payment.currency,
          paymentStatus: payment.paymentStatus,
        });
      }

      return res.status(400).json({
        message: "Unsupported payment mode.",
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

      // Idempotent response for an already-paid payment
      if (payment.paymentStatus === "paid") {
        return res.status(200).json({
          message: "Payment is already verified.",
          appointment,
          payment,
        });
      }

      if (payment.paymentStatus !== "pending") {
        return res.status(400).json({
          message: "Payment is not in pending status.",
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

        // Record failed payment.
        // Appointment remains confirmed.
        if (paymentResult === "failed") {
          payment.paymentStatus = "failed";
          await payment.save();

          appointment.paymentStatus = "failed";
          await appointment.save();

          return res.status(200).json({
            message: "Mock payment failure recorded successfully.",
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

        const generatedSignature = crypto
          .createHmac(
            "sha256",
            process.env.RAZORPAY_KEY_SECRET
          )
          .update(
            razorpay_order_id + "|" + razorpay_payment_id
          )
          .digest("hex");

        const received = Buffer.from(razorpay_signature);
        const generated = Buffer.from(generatedSignature);

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

        if (
          razorpayPayment.order_id !== payment.razorpayOrderId
        ) {
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

      // Update payment record after successful verification
      payment.paymentStatus = "paid";
      payment.paidAt = new Date();

      await payment.save();

      // Update appointment payment status
      appointment.paymentStatus = "paid";

      await appointment.save();

      return res.status(200).json({
        message: "Payment verified successfully.",
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

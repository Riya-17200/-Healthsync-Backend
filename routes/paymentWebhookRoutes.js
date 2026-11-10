
const express = require("express");
const crypto = require("crypto");

const router = express.Router();

const Payment = require("../models/payment");
const Appointment = require("../models/appointment");
const WebhookEvent = require("../models/webhookEvent");

router.post("/", async (req, res) => {
  let webhookEvent = null;

  try {
    // Webhooks are only used with real Razorpay payments.
    if (process.env.PAYMENT_MODE !== "razorpay") {
      return res.status(503).json({
        message: "Razorpay webhook is disabled in mock mode.",
      });
    }

    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!webhookSecret) {
      return res.status(500).json({
        message: "Webhook secret is not configured.",
      });
    }

    const signature = req.headers["x-razorpay-signature"];

    if (!signature || !Buffer.isBuffer(req.body)) {
      return res.status(400).json({
        message: "Invalid webhook request.",
      });
    }

    // Verify Razorpay webhook signature using the original raw request body.
    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(req.body)
      .digest("hex");

    const receivedBuffer = Buffer.from(signature, "utf8");
    const expectedBuffer = Buffer.from(expectedSignature, "utf8");

    if (
      receivedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
    ) {
      return res.status(400).json({
        message: "Invalid webhook signature.",
      });
    }

    const eventData = JSON.parse(req.body.toString("utf8"));

    // Only process captured and failed payment events.
    if (
      eventData.event !== "payment.captured" &&
      eventData.event !== "payment.failed"
    ) {
      return res.status(200).json({
        message: "Event received but not handled.",
      });
    }

    const eventId = req.headers["x-razorpay-event-id"];

    if (!eventId || typeof eventId !== "string") {
      return res.status(400).json({
        message: "Webhook event ID is missing.",
      });
    }

    const paymentEntity = eventData.payload?.payment?.entity;

    if (!paymentEntity || !paymentEntity.order_id) {
      return res.status(400).json({
        message: "Payment information is missing.",
      });
    }

    // Find the payment using the Razorpay order ID.
    const payment = await Payment.findOne({
      razorpayOrderId: paymentEntity.order_id,
    });

    if (!payment) {
      return res.status(404).json({
        message: "Payment record not found.",
      });
    }

    if (!["upi", "card"].includes(payment.paymentMethod)) {
      return res.status(400).json({
        message: "Invalid payment method for Razorpay.",
      });
    }

    // Validate amount and currency.
    const expectedAmount = Math.round(payment.amount * 100);

    if (
      paymentEntity.amount !== expectedAmount ||
      paymentEntity.currency !== payment.currency
    ) {
      return res.status(400).json({
        message: "Payment amount or currency mismatch.",
      });
    }

    if (
      paymentEntity.method &&
      paymentEntity.method !== payment.paymentMethod
    ) {
      return res.status(400).json({
        message: "Payment method mismatch.",
      });
    }

    // Store the event ID so duplicate webhook deliveries are ignored.
    try {
      webhookEvent = await WebhookEvent.create({
        eventId,
        eventType: eventData.event,
        status: "processing",
      });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(200).json({
          message: "Duplicate webhook event ignored.",
        });
      }

      throw error;
    }

    const markEventProcessed = async () => {
      await WebhookEvent.findByIdAndUpdate(webhookEvent._id, {
        $set: {
          status: "processed",
          processedAt: new Date(),
        },
      });
    };

    const appointment = await Appointment.findById(
      payment.appointmentId
    );

    if (!appointment) {
      return res.status(404).json({
        message: "Associated appointment not found.",
      });
    }

    // ==========================================
    // PAYMENT CAPTURED
    // ==========================================

    if (eventData.event === "payment.captured") {
      if (!paymentEntity.id) {
        return res.status(400).json({
          message: "Razorpay payment ID is missing.",
        });
      }

      // Do not change a refunded payment.
      if (payment.paymentStatus === "refunded") {
        await markEventProcessed();

        return res.status(200).json({
          message: "Payment is already refunded.",
        });
      }

      // Idempotent handling for an already-paid payment.
      if (payment.paymentStatus === "paid") {
        await markEventProcessed();

        return res.status(200).json({
          message: "Payment is already processed.",
        });
      }

      // Check whether another appointment now occupies this slot.
      const conflictingAppointment = await Appointment.findOne({
        _id: { $ne: appointment._id },
        doctorId: appointment.doctorId,
        appointmentDate: appointment.appointmentDate,
        startTime: { $lt: appointment.endTime },
        endTime: { $gt: appointment.startTime },
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
            onlinePaymentExpiresAt: { $gt: new Date() },
          },
        ],
      });

      // Record the captured payment.
      payment.paymentStatus = "paid";
      payment.razorpayPaymentId = paymentEntity.id;
      payment.paidAt = new Date();

      await payment.save();

      if (
        appointment.appointmentStatus === "cancelled" ||
        appointment.appointmentStatus === "completed" ||
        conflictingAppointment
      ) {
        // Money was captured, but the appointment cannot be confirmed.
        // A real Razorpay refund must be handled separately.
        appointment.appointmentStatus = "cancelled";
        appointment.paymentStatus = "paid";
        appointment.onlinePaymentExpiresAt = null;

        await appointment.save();
        await markEventProcessed();

        return res.status(200).json({
          message:
            "Payment captured, but appointment could not be confirmed. Refund or support action is required.",
        });
      }

      // Confirm the appointment only after successful payment capture.
      appointment.appointmentStatus = "confirmed";
      appointment.paymentStatus = "paid";
      appointment.onlinePaymentExpiresAt = null;

      await appointment.save();
      await markEventProcessed();

      return res.status(200).json({
        message: "Payment successfully marked as paid and appointment confirmed.",
      });
    }

    // ==========================================
    // PAYMENT FAILED
    // ==========================================

    if (eventData.event === "payment.failed") {
      // Never overwrite a successful or refunded payment.
      if (
        payment.paymentStatus === "paid" ||
        payment.paymentStatus === "refunded"
      ) {
        await markEventProcessed();

        return res.status(200).json({
          message: "Payment already processed. No update required.",
        });
      }

      if (payment.paymentStatus === "pending") {
        payment.paymentStatus = "failed";
        await payment.save();

        // Keep the appointment record so the patient can retry.
        // Clearing the expiry releases the temporary slot hold.
        if (appointment.appointmentStatus === "pending") {
          appointment.paymentStatus = "failed";
          appointment.onlinePaymentExpiresAt = null;
          await appointment.save();
        }
      }

      await markEventProcessed();

      return res.status(200).json({
        message: "Payment marked as failed. The temporary slot hold has been released.",
      });
    }
  } catch (error) {
    console.error("Razorpay webhook error:", error);

    // Remove the processing event so Razorpay can retry delivery.
    if (webhookEvent) {
      await WebhookEvent.findByIdAndDelete(webhookEvent._id).catch(
        (deleteError) => {
          console.error(
            "Webhook event cleanup error:",
            deleteError.message
          );
        }
      );
    }

    return res.status(500).json({
      message: "Webhook processing failed.",
    });
  }
});

module.exports = router;

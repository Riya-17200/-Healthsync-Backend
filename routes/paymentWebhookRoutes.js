
const express = require("express");
const crypto = require("crypto");

const router = express.Router();

const Payment = require("../models/payment");
const Appointment = require("../models/appointment");

router.post("/", async (req, res) => {
  try {
    // Webhook is only for real Razorpay payments.
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

    // Verify Razorpay signature.
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

    // Handle only payment events.
    if (
      eventData.event !== "payment.captured" &&
      eventData.event !== "payment.failed"
    ) {
      return res.status(200).json({
        message: "Event received but not handled.",
      });
    }

    const paymentEntity = eventData.payload?.payment?.entity;

    if (!paymentEntity || !paymentEntity.order_id) {
      return res.status(400).json({
        message: "Payment information is missing.",
      });
    }

    // Find payment using Razorpay order ID.
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

    // Verify amount and currency against our database.
    const expectedAmount = Math.round(payment.amount * 100);

    if (
      paymentEntity.amount !== expectedAmount ||
      paymentEntity.currency !== payment.currency
    ) {
      return res.status(400).json({
        message: "Payment amount or currency mismatch.",
      });
    }

    if (eventData.event === "payment.captured") {
      if (!paymentEntity.id) {
        return res.status(400).json({
          message: "Razorpay payment ID is missing.",
        });
      }

      // Do not overwrite an already refunded payment.
      if (payment.paymentStatus === "refunded") {
        return res.status(200).json({
          message: "Payment is already refunded.",
        });
      }

      // Update Payment record.
      await Payment.findOneAndUpdate(
        {
          _id: payment._id,
          paymentStatus: { $nin: ["paid", "refunded"] },
        },
        {
          $set: {
            paymentStatus: "paid",
            razorpayPaymentId: paymentEntity.id,
            paidAt: new Date(),
          },
        }
      );

      // Update linked Appointment record.
      await Appointment.findByIdAndUpdate(payment.appointmentId, {
        $set: {
          paymentStatus: "paid",
        },
      });

      return res.status(200).json({
        message: "Payment successfully marked as paid.",
      });
    }

    if (eventData.event === "payment.failed") {
      // Never downgrade an already paid or refunded payment.
      if (
        payment.paymentStatus === "paid" ||
        payment.paymentStatus === "refunded"
      ) {
        return res.status(200).json({
          message: "Payment already processed. No update required.",
        });
      }

      // Only mark pending payments as failed.
      await Payment.findOneAndUpdate(
        {
          _id: payment._id,
          paymentStatus: "pending",
        },
        {
          $set: {
            paymentStatus: "failed",
          },
        }
      );

      await Appointment.findByIdAndUpdate(payment.appointmentId, {
        $set: {
          paymentStatus: "failed",
        },
      });

      return res.status(200).json({
        message: "Payment marked as failed.",
      });
    }
  } catch (error) {
    console.error("Razorpay webhook error:", error.message);

    return res.status(500).json({
      message: "Webhook processing failed.",
    });
  }
});

module.exports = router;


const mongoose = require("mongoose");

const appointmentSchema = new mongoose.Schema(
  {
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
    },

    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Doctor",
      required: true,
    },

    appointmentDate: {
      type: Date,
      required: true,
    },

    startTime: {
      type: String,
      required: true,
    },

    endTime: {
      type: String,
      required: true,
    },

    consultationFee: {
      type: Number,
      required: true,
      min: 0,
    },

    appointmentStatus: {
      type: String,
      enum: ["pending", "confirmed", "cancelled", "completed"],
      default: "pending",
    },

    paymentMethod: {
      type: String,
      enum: ["upi", "card", "cash"],
      required: true,
    },

    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "failed", "refunded"],
      default: "pending",
    },

    // Expiry time for online payment bookings.
    // Cash appointments do not use this field.
    onlinePaymentExpiresAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

appointmentSchema.pre("validate", function () {
  if (this.startTime && this.endTime && this.startTime >= this.endTime) {
    this.invalidate("endTime", "End time must be later than start time.");
  }
});

module.exports = mongoose.model("Appointment", appointmentSchema);

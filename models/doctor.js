
const mongoose = require("mongoose");

const doctorSchema = new mongoose.Schema(
  {
    // Link to the doctor's account in the User collection
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
      unique: true,
    },

    // Professional details
    specialization: {
      type: String,
      required: true,
      trim: true,
    },

    qualification: {
      type: String,
      required: true,
      trim: true,
    },

    experience: {
      type: Number,
      required: true,
      min: 0,
    },
    consultationFee: {
      type: Number,
      required: true,
      min: 0
    },
    medicalRegistrationNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    // Uploaded medical license document
    licenseDocumentUrl: {
      type: String,
      required: true,
    },

    // Admin verification
    verificationStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      required: true,
    },

    rejectionReason: {
      type: String,
      default: null,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Doctor", doctorSchema);

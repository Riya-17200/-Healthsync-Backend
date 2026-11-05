
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 100,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    passwordHash: {
      type: String,
      required: true,
    },

    phoneNumber: {
      type: String,
      required: true,
      trim: true,
    },
dateOfBirth: {
  type: Date,
  required: function () {
    return this.role === "patient";
  },
},

   role: {
  type: String,
  enum: ["patient", "doctor", "admin"],
  default: "patient",
  required: true,
},

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("user", userSchema);

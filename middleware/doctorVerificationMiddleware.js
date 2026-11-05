
const Doctor = require("../models/doctor");

const doctorVerificationMiddleware = async (req, res, next) => {
  try {
    // Check whether the logged-in user is a doctor
    if (!req.user || req.user.role !== "doctor") {
      return res.status(403).json({
        message: "Access denied. Doctor privileges required.",
      });
    }

    // Find the doctor's latest verification status
    const doctor = await Doctor.findOne({
      userId: req.user.userId,
    });

    if (!doctor) {
      return res.status(403).json({
        message: "Doctor profile not found.",
      });
    }

    // Allow access only to approved doctors
    if (doctor.verificationStatus !== "approved") {
      return res.status(403).json({
        message: `Access denied. Your application is ${doctor.verificationStatus}.`,
        rejectionReason: doctor.rejectionReason,
      });
    }

    // Make doctor profile available to the next route
    req.doctor = doctor;

    next();
  } catch (error) {
    console.error("Doctor verification error:", error);

    return res.status(500).json({
      message: "Server error during doctor verification.",
    });
  }
};

module.exports = doctorVerificationMiddleware;

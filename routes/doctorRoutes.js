
const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const doctorVerificationMiddleware = require("../middleware/doctorVerificationMiddleware");
const Doctor = require("../models/doctor");

router.get(
  "/profile",
  authMiddleware,
  doctorVerificationMiddleware,
  async (req, res) => {
    try {
      const doctor = await Doctor.findById(req.doctor._id)
        .populate("userId", "fullName email phoneNumber");

      return res.status(200).json({
        message: "Doctor profile fetched successfully.",
        doctor,
      });
    } catch (error) {
      return res.status(500).json({
        message: "Server error while fetching doctor profile.",
      });
    }
  }
);

module.exports = router;

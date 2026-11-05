const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const User = require("../models/user");
const Doctor = require("../models/doctor");

const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const upload = require("../middleware/uploadMiddleware");
const adminMiddleware = require("../middleware/adminMiddleware");

// ==========================================
// CLEAN FORM DATA
// ==========================================

const cleanFormData = (data) => {
  const cleaned = {};

  for (const [key, value] of Object.entries(data)) {
    const cleanKey = key.trim();

    cleaned[cleanKey] =
      typeof value === "string" ? value.trim() : value;
  }

  return cleaned;
};

// ==========================================
// 1. PATIENT REGISTRATION
// ==========================================

router.post("/patient/register", async (req, res) => {
  try {
    const {
      fullName,
      email,
      password,
      phoneNumber,
      dateOfBirth,
    } = req.body;

    if (!fullName || !email || !password || !phoneNumber || !dateOfBirth) {
      return res.status(400).json({
        message: "All fields are required.",
      });
    }

    const normalizedName = fullName.trim();
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPhone = phoneNumber.trim();

    if (normalizedName.length < 2 || normalizedName.length > 100) {
      return res.status(400).json({
        message: "Full name must be between 2 and 100 characters.",
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({
        message: "Please enter a valid email address.",
      });
    }

    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({
        message: "Password must be at least 8 characters long.",
      });
    }

    const phoneRegex = /^\+?[0-9\s()-]{7,20}$/;

    if (!phoneRegex.test(normalizedPhone)) {
      return res.status(400).json({
        message: "Please enter a valid phone number.",
      });
    }

    const dob = new Date(dateOfBirth);

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth) ||
      Number.isNaN(dob.getTime()) ||
      dob.toISOString().slice(0, 10) !== dateOfBirth ||
      dob >= new Date()
    ) {
      return res.status(400).json({
        message: "Please enter a valid date of birth in YYYY-MM-DD format.",
      });
    }

    const existingUser = await User.findOne({
      email: normalizedEmail,
    });

    if (existingUser) {
      return res.status(409).json({
        message: "An account with this email already exists.",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const newUser = await User.create({
      fullName: normalizedName,
      email: normalizedEmail,
      passwordHash,
      phoneNumber: normalizedPhone,
      dateOfBirth: dob,
      role: "patient",
    });

    return res.status(201).json({
      message: "Patient account created successfully!",
      user: {
        id: newUser._id,
        fullName: newUser.fullName,
        email: newUser.email,
        phoneNumber: newUser.phoneNumber,
        dateOfBirth: newUser.dateOfBirth,
        role: newUser.role,
        createdAt: newUser.createdAt,
      },
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        message: "An account with this email already exists.",
      });
    }

    console.error("Patient registration error:", error.message);

    return res.status(500).json({
      message: "Something went wrong while registering the patient.",
    });
  }
});

// ==========================================
// 2. DOCTOR REGISTRATION
// ==========================================

router.post(
  "/doctor/register",
  upload.single("medicalLicense"),
  async (req, res) => {
    let newUser;

    try {
      const cleanedData = cleanFormData(req.body);

      const {
        fullName,
        email,
        password,
        phoneNumber,
        specialization,
        qualification,
        experience,
        medicalRegistrationNumber,
        consultationFee,
      } = cleanedData;

      // Validate required fields
      if (
        !fullName ||
        !email ||
        !password ||
        !phoneNumber ||
        !specialization ||
        !qualification ||
        experience === undefined ||
        experience === "" ||
        !medicalRegistrationNumber ||
        consultationFee === undefined ||
        consultationFee === ""
      ) {
        return res.status(400).json({
          message: "Please provide all required fields.",
        });
      }

      // Validate uploaded license
      if (!req.file) {
        return res.status(400).json({
          message: "Medical license document is required.",
        });
      }

      // Validate password
      if (typeof password !== "string" || password.length < 8) {
        return res.status(400).json({
          message: "Password must be at least 8 characters long.",
        });
      }

      // Validate experience
      const experienceNumber = Number(experience);

      if (!Number.isFinite(experienceNumber) || experienceNumber < 0) {
        return res.status(400).json({
          message: "Please provide valid years of experience.",
        });
      }

      // Validate consultation fee
      const consultationFeeNumber = Number(consultationFee);

      if (
        !Number.isFinite(consultationFeeNumber) ||
        consultationFeeNumber < 0
      ) {
        return res.status(400).json({
          message: "Please provide a valid consultation fee.",
        });
      }

      // Normalize input
      const normalizedEmail = email.trim().toLowerCase();
      const normalizedName = fullName.trim();
      const normalizedPhone = phoneNumber.trim();
      const normalizedRegistrationNumber =
        medicalRegistrationNumber.trim();

      // Check existing email
      const existingUser = await User.findOne({
        email: normalizedEmail,
      });

      if (existingUser) {
        return res.status(409).json({
          message: "Email is already registered.",
        });
      }

      // Check existing medical registration number
      const existingDoctor = await Doctor.findOne({
        medicalRegistrationNumber: normalizedRegistrationNumber,
      });

      if (existingDoctor) {
        return res.status(409).json({
          message: "Medical registration number is already registered.",
        });
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 12);

      // Create User account
      newUser = await User.create({
        fullName: normalizedName,
        email: normalizedEmail,
        passwordHash,
        phoneNumber: normalizedPhone,
        role: "doctor",
      });

      // Create Doctor profile
      const newDoctor = await Doctor.create({
        userId: newUser._id,
        specialization: specialization.trim(),
        qualification: qualification.trim(),
        experience: experienceNumber,
        medicalRegistrationNumber: normalizedRegistrationNumber,
        licenseDocumentUrl: req.file.path,
        consultationFee: consultationFeeNumber,
        verificationStatus: "pending",
      });

      return res.status(201).json({
        message:
          "Doctor registration submitted successfully. Your application is awaiting admin verification.",
        doctor: {
          userId: newUser._id,
          doctorId: newDoctor._id,
          fullName: newUser.fullName,
          email: newUser.email,
          role: newUser.role,
          consultationFee: newDoctor.consultationFee,
          verificationStatus: newDoctor.verificationStatus,
        },
      });
    } catch (error) {
      if (newUser) {
        await User.findByIdAndDelete(newUser._id);
      }

      if (error.code === 11000) {
        return res.status(409).json({
          message: "Email or medical registration number already exists.",
        });
      }

      console.error("Doctor registration error:", error);

      return res.status(500).json({
        message: "Doctor registration failed.",
      });
    }
  }
);

// ==========================================
// 3. GENERAL LOGIN
// PATIENT / DOCTOR / ADMIN
// ==========================================

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        message: "Email and password are required.",
      });
    }

    const user = await User.findOne({
      email: email.trim().toLowerCase(),
    });

    if (!user) {
      return res.status(401).json({
        message: "Invalid email or password.",
      });
    }

    const isPasswordCorrect = await bcrypt.compare(
      password,
      user.passwordHash
    );

    if (!isPasswordCorrect) {
      return res.status(401).json({
        message: "Invalid email or password.",
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        message: "Your account is inactive.",
      });
    }

    // Doctor verification check
    if (user.role === "doctor") {
      const doctor = await Doctor.findOne({
        userId: user._id,
      });

      if (!doctor) {
        return res.status(403).json({
          message: "Doctor profile not found. Please contact admin.",
        });
      }

      if (doctor.verificationStatus === "pending") {
        return res.status(403).json({
          message: "Your application is pending admin verification.",
        });
      }

      if (doctor.verificationStatus === "rejected") {
        return res.status(403).json({
          message: "Your application has been rejected.",
          rejectionReason: doctor.rejectionReason,
        });
      }

      if (doctor.verificationStatus !== "approved") {
        return res.status(403).json({
          message: "Your account is not approved for login.",
        });
      }
    }

    const token = jwt.sign(
      {
        userId: user._id.toString(),
        role: user.role,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "1h",
      }
    );

    return res.status(200).json({
      message: "Login successful!",
      token,
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Login error:", error.message);

    return res.status(500).json({
      message: "Something went wrong during login.",
    });
  }
});

// ==========================================
// 4. GET LOGGED-IN USER PROFILE
// ==========================================

router.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select(
      "-passwordHash"
    );

    if (!user) {
      return res.status(404).json({
        message: "User not found.",
      });
    }

    return res.status(200).json({
      message: "Profile fetched successfully!",
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
        phoneNumber: user.phoneNumber,
        dateOfBirth: user.dateOfBirth,
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    console.error("Profile fetch error:", error.message);

    return res.status(500).json({
      message: "Something went wrong while fetching profile.",
    });
  }
});

// ==========================================
// 5. ADMIN: GET PENDING DOCTOR APPLICATIONS
// ==========================================

router.get(
  "/admin/doctors/pending",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const pendingDoctors = await Doctor.find({
        verificationStatus: "pending",
      })
        .populate("userId", "fullName email phoneNumber role createdAt")
        .sort({ createdAt: -1 });

      return res.status(200).json({
        message: "Pending doctor applications fetched successfully.",
        total: pendingDoctors.length,
        doctors: pendingDoctors,
      });
    } catch (error) {
      console.error("Pending doctors error:", error.message);

      return res.status(500).json({
        message: "Failed to fetch pending doctor applications.",
      });
    }
  }
);

// ==========================================
// 6. ADMIN: APPROVE DOCTOR APPLICATION
// ==========================================

router.patch(
  "/admin/doctors/:doctorId/approve",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const { doctorId } = req.params;

      if (!/^[0-9a-fA-F]{24}$/.test(doctorId)) {
        return res.status(400).json({
          message: "Invalid doctor ID.",
        });
      }

      const doctor = await Doctor.findById(doctorId);

      if (!doctor) {
        return res.status(404).json({
          message: "Doctor application not found.",
        });
      }

      if (doctor.verificationStatus !== "pending") {
        return res.status(400).json({
          message: `Doctor application is already ${doctor.verificationStatus}.`,
        });
      }

      doctor.verificationStatus = "approved";
      doctor.rejectionReason = null;

      await doctor.save();

      return res.status(200).json({
        message: "Doctor application approved successfully.",
        doctor,
      });
    } catch (error) {
      console.error("Approve doctor error:", error.message);

      return res.status(500).json({
        message: "Failed to approve doctor application.",
      });
    }
  }
);

// ==========================================
// 7. ADMIN: REJECT DOCTOR APPLICATION
// ==========================================

router.patch(
  "/admin/doctors/:doctorId/reject",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const { doctorId } = req.params;
      const { rejectionReason } = req.body;

      if (!/^[0-9a-fA-F]{24}$/.test(doctorId)) {
        return res.status(400).json({
          message: "Invalid doctor ID.",
        });
      }

      if (
        !rejectionReason ||
        typeof rejectionReason !== "string" ||
        !rejectionReason.trim()
      ) {
        return res.status(400).json({
          message: "Please provide a reason for rejection.",
        });
      }

      const doctor = await Doctor.findById(doctorId);

      if (!doctor) {
        return res.status(404).json({
          message: "Doctor application not found.",
        });
      }

      if (doctor.verificationStatus !== "pending") {
        return res.status(400).json({
          message: `Doctor application is already ${doctor.verificationStatus}.`,
        });
      }

      doctor.verificationStatus = "rejected";
      doctor.rejectionReason = rejectionReason.trim();

      await doctor.save();

      return res.status(200).json({
        message: "Doctor application rejected successfully.",
        doctor,
      });
    } catch (error) {
      console.error("Reject doctor error:", error.message);

      return res.status(500).json({
        message: "Failed to reject doctor application.",
      });
    }
  }
);

module.exports = router;
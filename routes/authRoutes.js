
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

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

      if (!req.file) {
        return res.status(400).json({
          message: "Medical license document is required.",
        });
      }

      if (typeof password !== "string" || password.length < 8) {
        return res.status(400).json({
          message: "Password must be at least 8 characters long.",
        });
      }

      const experienceNumber = Number(experience);

      if (!Number.isFinite(experienceNumber) || experienceNumber < 0) {
        return res.status(400).json({
          message: "Please provide valid years of experience.",
        });
      }

      const consultationFeeNumber = Number(consultationFee);

      if (
        !Number.isFinite(consultationFeeNumber) ||
        consultationFeeNumber < 0
      ) {
        return res.status(400).json({
          message: "Please provide a valid consultation fee.",
        });
      }

      const normalizedEmail = email.trim().toLowerCase();
      const normalizedName = fullName.trim();
      const normalizedPhone = phoneNumber.trim();

      const normalizedRegistrationNumber =
        medicalRegistrationNumber.trim();

      const existingUser = await User.findOne({
        email: normalizedEmail,
      });

      // Handle re-registration if doctor was previously rejected
      if (existingUser) {
        if (existingUser.role !== "doctor") {
          return res.status(409).json({
            message: "An account with this email already exists.",
          });
        }

        const existingDoctor = await Doctor.findOne({
          userId: existingUser._id,
        });

        if (!existingDoctor) {
          return res.status(409).json({
            message: "Doctor profile not found for this email.",
          });
        }

        if (existingDoctor.verificationStatus === "approved") {
          return res.status(409).json({
            message: "An approved doctor account already exists with this email. Please log in.",
          });
        }

        if (existingDoctor.verificationStatus === "pending") {
          return res.status(409).json({
            message: "Your application is already submitted and awaiting admin verification.",
          });
        }

        // If status is "rejected" -> Allow reapplication and overwrite details
        if (existingDoctor.verificationStatus === "rejected") {
          // Check if the registration number is taken by another doctor
          const regNumberTaken = await Doctor.findOne({
            medicalRegistrationNumber: normalizedRegistrationNumber,
            _id: { $ne: existingDoctor._id },
          });

          if (regNumberTaken) {
            return res.status(409).json({
              message: "Medical registration number is already registered by another doctor.",
            });
          }

          const passwordHash = await bcrypt.hash(password, 12);

          existingUser.fullName = normalizedName;
          existingUser.phoneNumber = normalizedPhone;
          existingUser.passwordHash = passwordHash;
          await existingUser.save();

          existingDoctor.specialization = specialization.trim();
          existingDoctor.qualification = qualification.trim();
          existingDoctor.experience = experienceNumber;
          existingDoctor.medicalRegistrationNumber = normalizedRegistrationNumber;
          existingDoctor.licenseDocumentUrl = req.file.path || req.file.secure_url;
          existingDoctor.consultationFee = consultationFeeNumber;
          existingDoctor.verificationStatus = "pending";
          existingDoctor.rejectionReason = null;
          await existingDoctor.save();

          return res.status(200).json({
            message:
              "Your updated application has been resubmitted successfully. It is now awaiting admin verification.",
            doctor: {
              userId: existingUser._id,
              doctorId: existingDoctor._id,
              fullName: existingUser.fullName,
              email: existingUser.email,
              role: existingUser.role,
              consultationFee: existingDoctor.consultationFee,
              verificationStatus: existingDoctor.verificationStatus,
            },
          });
        }
      }

      const existingDoctor = await Doctor.findOne({
        medicalRegistrationNumber: normalizedRegistrationNumber,
      });

      if (existingDoctor) {
        return res.status(409).json({
          message: "Medical registration number is already registered.",
        });
      }

      const passwordHash = await bcrypt.hash(password, 12);

      newUser = await User.create({
        fullName: normalizedName,
        email: normalizedEmail,
        passwordHash,
        phoneNumber: normalizedPhone,
        role: "doctor",
      });

      const newDoctor = await Doctor.create({
        userId: newUser._id,
        specialization: specialization.trim(),
        qualification: qualification.trim(),
        experience: experienceNumber,
        medicalRegistrationNumber: normalizedRegistrationNumber,
        licenseDocumentUrl: req.file.path || req.file.secure_url,
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
          message:
            "Your application has been rejected. You can edit your details and reapply by submitting the registration form again.",
          verificationStatus: "rejected",
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
// 4. FORGOT PASSWORD
// ==========================================

router.post("/forgot-password", async (req, res) => {
  let user;

  try {
    const { email } = req.body;

    if (!email || typeof email !== "string") {
      return res.status(400).json({
        message: "Please provide a valid email address.",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({
        message: "Please provide a valid email address.",
      });
    }

    user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.status(200).json({
        message:
          "If an account with that email exists, a password reset link has been sent.",
      });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");

    const hashedResetToken = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");

    const resetTokenExpiry = new Date(Date.now() + 10 * 60 * 1000);

    // Update only reset-token fields.
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          resetPasswordToken: hashedResetToken,
          resetPasswordExpires: resetTokenExpiry,
        },
      },
      { runValidators: false }
    );

    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = Number(process.env.SMTP_PORT || 587);
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const emailFrom = process.env.EMAIL_FROM || smtpUser;
    const frontendUrl = process.env.FRONTEND_URL;
    const brevoApiKey = process.env.BREVO_API_KEY;

    if (!frontendUrl || !emailFrom) {
      throw new Error("Email configuration is incomplete in the .env file.");
    }

    const resetLink =
      `${frontendUrl.replace(/\/$/, "")}/reset-password?token=${resetToken}&email=${encodeURIComponent(
        user.email
      )}`;

    const emailText = `Hello ${user.fullName || "there"},

We received a request to reset your HealthSync password.

Open this link to create a new password:
${resetLink}

This link will expire in 10 minutes.

If you did not request a password reset, you can ignore this email.

HealthSync Team`;

    const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; line-height: 1.6;">
          <h2>Reset your HealthSync password</h2>
          <p>Hello ${user.fullName || "there"},</p>
          <p>We received a request to reset your HealthSync password.</p>
          <p>
            <a href="${resetLink}"
              style="display:inline-block;padding:10px 18px;background:#0d6efd;color:#ffffff;text-decoration:none;border-radius:6px;">
              Reset Password
            </a>
          </p>
          <p>Or copy this link into your browser:</p>
          <p>${resetLink}</p>
          <p>This link will expire in 10 minutes.</p>
          <p>If you did not request a password reset, you can ignore this email.</p>
          <p>HealthSync Team</p>
        </div>
      `;

    let emailResult;

    if (brevoApiKey) {
      // Use Brevo HTTP API (HTTPS port 443 - works reliably on Render)
      const brevoResponse = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "accept": "application/json",
          "api-key": brevoApiKey.trim(),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sender: { email: emailFrom.replace(/.*<(.+)>/, "$1").trim(), name: "HealthSync" },
          to: [{ email: user.email, name: user.fullName || "User" }],
          subject: "HealthSync - Password Reset",
          textContent: emailText,
          htmlContent: emailHtml,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!brevoResponse.ok) {
        const errText = await brevoResponse.text();
        throw new Error(`Brevo API error (${brevoResponse.status}): ${errText}`);
      }
      emailResult = await brevoResponse.json();
    } else {
      if (!smtpHost || !smtpUser || !smtpPass) {
        throw new Error("Email configuration is incomplete in the .env file.");
      }

      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      });

      emailResult = await transporter.sendMail({
        from: emailFrom,
        to: user.email,
        subject: "HealthSync - Password Reset",
        text: emailText,
        html: emailHtml,
      });
    }

    console.log(
      "Password reset email accepted by SMTP server:",
      emailResult.messageId
    );

    return res.status(200).json({
      message: "Password reset email sent successfully.",
    });

  } catch (error) {
    console.error("Forgot password error:", error);

    if (user) {
      await User.updateOne(
        { _id: user._id },
        {
          $set: {
            resetPasswordToken: null,
            resetPasswordExpires: null,
          },
        },
        { runValidators: false }
      ).catch((saveError) => {
        console.error("Could not clear reset token:", saveError.message);
      });
    }

    return res.status(500).json({
      message: "Unable to send password reset email. Please try again later.",
    });
  }
});

// ==========================================
// 5. RESET PASSWORD
// ==========================================

router.post("/reset-password", async (req, res) => {
  try {
    const { email, token, newPassword } = req.body;

    if (
      !email ||
      typeof email !== "string" ||
      !token ||
      typeof token !== "string" ||
      !newPassword ||
      typeof newPassword !== "string"
    ) {
      return res.status(400).json({
        message: "Email, reset token, and new password are required.",
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        message: "New password must be at least 8 characters long.",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const hashedResetToken = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const user = await User.findOne({
      email: normalizedEmail,
      resetPasswordToken: hashedResetToken,
      resetPasswordExpires: {
        $gt: new Date(),
      },
    });

    if (!user) {
      return res.status(400).json({
        message: "The password reset link is invalid or has expired.",
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);

    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          passwordHash,
          resetPasswordToken: null,
          resetPasswordExpires: null,
        },
      },
      { runValidators: false }
    );

    return res.status(200).json({
      message: "Password has been reset successfully. You can now log in.",
    });

  } catch (error) {
    console.error("Reset password error:", error.message);

    return res.status(500).json({
      message: "Something went wrong while resetting the password.",
    });
  }
});

// ==========================================
// 6. GET LOGGED-IN USER PROFILE
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
// 7. ADMIN: GET PENDING DOCTOR APPLICATIONS
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
// 8. ADMIN: APPROVE DOCTOR APPLICATION
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
// 9. ADMIN: REJECT DOCTOR APPLICATION
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

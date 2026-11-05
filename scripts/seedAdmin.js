
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
require("dotenv").config();

const User = require("../models/user");

async function createOrUpdateAdmin() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);

    console.log("MongoDB connected");

    const {
      ADMIN_NAME,
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
      ADMIN_PHONE,
    } = process.env;

    if (!ADMIN_NAME || !ADMIN_EMAIL || !ADMIN_PASSWORD || !ADMIN_PHONE) {
      throw new Error("Please configure all ADMIN variables in .env");
    }

    const email = ADMIN_EMAIL.trim().toLowerCase();

    const existingAdmin = await User.findOne({ email });

    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

    if (existingAdmin) {
      if (existingAdmin.role !== "admin") {
        throw new Error("This email belongs to a non-admin account.");
      }

      existingAdmin.passwordHash = passwordHash;
      existingAdmin.fullName = ADMIN_NAME;
      existingAdmin.phoneNumber = ADMIN_PHONE;

      await existingAdmin.save();

      console.log("Admin password updated successfully!");
    } else {
      const admin = await User.create({
        fullName: ADMIN_NAME,
        email,
        passwordHash,
        phoneNumber: ADMIN_PHONE,
        role: "admin",
      });

      console.log("Admin account created successfully!");
      console.log("Admin ID:", admin._id);
    }

    console.log("Admin Email:", email);

  } catch (error) {
    console.error("Admin operation failed:", error.message);
  } finally {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  }
}

createOrUpdateAdmin();

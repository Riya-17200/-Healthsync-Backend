
const express = require("express");
const router = express.Router();

const DoctorSchedule = require("../models/doctorSchedule");
const authMiddleware = require("../middleware/authMiddleware");
const doctorVerificationMiddleware = require("../middleware/doctorVerificationMiddleware");

// All routes require an authenticated, approved doctor.
router.use(authMiddleware, doctorVerificationMiddleware);

// Helper: validate time ranges and prevent overlapping slots.
const validateTimeSlots = (slots) => {
  if (!Array.isArray(slots) || slots.length === 0) {
    return "At least one time slot is required.";
  }

  const sorted = [...slots].sort((a, b) =>
    a.startTime.localeCompare(b.startTime)
  );

  for (const slot of sorted) {
    if (
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.startTime) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.endTime) ||
      slot.startTime >= slot.endTime
    ) {
      return "Invalid time slot. Use HH:mm format and ensure start is before end.";
    }

    if (
      !Number.isInteger(slot.slotDurationMinutes || 30) ||
      (slot.slotDurationMinutes || 30) < 5 ||
      (slot.slotDurationMinutes || 30) > 240
    ) {
      return "Slot duration must be between 5 and 240 minutes.";
    }
  }

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startTime < sorted[i - 1].endTime) {
      return "Time slots must not overlap.";
    }
  }

  return null;
};

// CREATE WEEKLY SCHEDULE
router.post("/weekly", async (req, res) => {
  try {
    const { dayOfWeek, timeSlots } = req.body;

    if (
      !Number.isInteger(dayOfWeek) ||
      dayOfWeek < 0 ||
      dayOfWeek > 6
    ) {
      return res.status(400).json({
        message: "dayOfWeek must be between 0 (Sunday) and 6 (Saturday).",
      });
    }

    const validationError = validateTimeSlots(timeSlots);
    if (validationError) {
      return res.status(400).json({ message: validationError });
    }

    const doctorId = req.doctor._id;

    const existingSchedule = await DoctorSchedule.findOne({
      doctorId,
      scheduleType: "weekly",
      dayOfWeek,
    });

    if (existingSchedule) {
      return res.status(409).json({
        message: "A weekly schedule already exists for this day. Update it instead.",
      });
    }

    const schedule = await DoctorSchedule.create({
      doctorId,
      scheduleType: "weekly",
      dayOfWeek,
      isAvailable: true,
      timeSlots,
    });

    return res.status(201).json({
      message: "Weekly schedule created successfully.",
      schedule,
    });
  } catch (error) {
    console.error("Create weekly schedule error:", error);
    return res.status(500).json({
      message: "Server error while creating weekly schedule.",
    });
  }
});

// CREATE DATE-SPECIFIC AVAILABILITY OR UNAVAILABILITY
router.post("/date", async (req, res) => {
  try {
    const { date, isAvailable = true, timeSlots = [] } = req.body;

    if (
      typeof date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date
    ) {
      return res.status(400).json({
        message: "Provide a valid date in YYYY-MM-DD format.",
      });
    }

    if (typeof isAvailable !== "boolean") {
      return res.status(400).json({
        message: "isAvailable must be true or false.",
      });
    }

    if (isAvailable) {
      const validationError = validateTimeSlots(timeSlots);
      if (validationError) {
        return res.status(400).json({ message: validationError });
      }
    } else if (timeSlots.length > 0) {
      return res.status(400).json({
        message: "Unavailable dates cannot contain time slots.",
      });
    }

    const doctorId = req.doctor._id;

    const existingSchedule = await DoctorSchedule.findOne({
      doctorId,
      scheduleType: "date",
      date,
    });

    if (existingSchedule) {
      return res.status(409).json({
        message: "Date-specific availability already exists. Update it instead.",
      });
    }

    const schedule = await DoctorSchedule.create({
      doctorId,
      scheduleType: "date",
      date,
      isAvailable,
      timeSlots,
    });

    return res.status(201).json({
      message: "Date-specific schedule created successfully.",
      schedule,
    });
  } catch (error) {
    console.error("Create date schedule error:", error);
    return res.status(500).json({
      message: "Server error while creating date-specific schedule.",
    });
  }
});

// VIEW MY SCHEDULES
router.get("/", async (req, res) => {
  try {
    const schedules = await DoctorSchedule.find({
      doctorId: req.doctor._id,
    }).sort({ scheduleType: 1, dayOfWeek: 1, date: 1 });

    return res.status(200).json({
      message: "Schedules fetched successfully.",
      count: schedules.length,
      schedules,
    });
  } catch (error) {
    console.error("Fetch schedules error:", error);
    return res.status(500).json({
      message: "Server error while fetching schedules.",
    });
  }
});

// UPDATE MY SCHEDULE
router.patch("/:scheduleId", async (req, res) => {
  try {
    const { scheduleId } = req.params;
    const updates = req.body;

    if (!/^[0-9a-fA-F]{24}$/.test(scheduleId)) {
      return res.status(400).json({
        message: "Invalid schedule ID.",
      });
    }

    const schedule = await DoctorSchedule.findOne({
      _id: scheduleId,
      doctorId: req.doctor._id,
    });

    if (!schedule) {
      return res.status(404).json({
        message: "Schedule not found.",
      });
    }

    const allowedFields =
      schedule.scheduleType === "weekly"
        ? ["timeSlots"]
        : ["timeSlots", "isAvailable"];

    const invalidFields = Object.keys(updates).filter(
      (field) => !allowedFields.includes(field)
    );

    if (invalidFields.length > 0) {
      return res.status(400).json({
        message: "You cannot update these fields.",
        invalidFields,
      });
    }

    const nextIsAvailable =
      updates.isAvailable !== undefined
        ? updates.isAvailable
        : schedule.isAvailable;

    const nextTimeSlots =
      updates.timeSlots !== undefined
        ? updates.timeSlots
        : schedule.timeSlots;

    if (typeof nextIsAvailable !== "boolean") {
      return res.status(400).json({
        message: "isAvailable must be true or false.",
      });
    }

    if (nextIsAvailable) {
      const validationError = validateTimeSlots(nextTimeSlots);
      if (validationError) {
        return res.status(400).json({ message: validationError });
      }
    } else if (nextTimeSlots.length > 0) {
      return res.status(400).json({
        message: "Remove time slots when marking a date unavailable.",
      });
    }

    if (updates.timeSlots !== undefined) {
      schedule.timeSlots = updates.timeSlots;
    }

    if (
      schedule.scheduleType === "date" &&
      updates.isAvailable !== undefined
    ) {
      schedule.isAvailable = updates.isAvailable;
    }

    await schedule.save();

    return res.status(200).json({
      message: "Schedule updated successfully.",
      schedule,
    });
  } catch (error) {
    console.error("Update schedule error:", error);
    return res.status(500).json({
      message: "Server error while updating schedule.",
    });
  }
});

// DELETE MY SCHEDULE
router.delete("/:scheduleId", async (req, res) => {
  try {
    const { scheduleId } = req.params;

    if (!/^[0-9a-fA-F]{24}$/.test(scheduleId)) {
      return res.status(400).json({
        message: "Invalid schedule ID.",
      });
    }

    const schedule = await DoctorSchedule.findOneAndDelete({
      _id: scheduleId,
      doctorId: req.doctor._id,
    });

    if (!schedule) {
      return res.status(404).json({
        message: "Schedule not found.",
      });
    }

    return res.status(200).json({
      message: "Schedule deleted successfully.",
    });
  } catch (error) {
    console.error("Delete schedule error:", error);
    return res.status(500).json({
      message: "Server error while deleting schedule.",
    });
  }
});

module.exports = router;

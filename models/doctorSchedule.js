
const mongoose = require("mongoose");

// Stores individual time ranges
const timeSlotSchema = new mongoose.Schema(
  {
    startTime: {
      type: String,
      required: true,
      match: /^([01]\d|2[0-3]):[0-5]\d$/,
    },

    endTime: {
      type: String,
      required: true,
      match: /^([01]\d|2[0-3]):[0-5]\d$/,
    },

    slotDurationMinutes: {
      type: Number,
      default: 30,
      min: 5,
      max: 240,
    },
  },
  { _id: false }
);

// Main doctor schedule schema
const doctorScheduleSchema = new mongoose.Schema(
  {
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Doctor",
      required: true,
      index: true,
    },

    scheduleType: {
      type: String,
      enum: ["weekly", "date"],
      required: true,
    },

    // Used for recurring weekly schedules.
    // 0 = Sunday, 1 = Monday, ... 6 = Saturday
    dayOfWeek: {
      type: Number,
      min: 0,
      max: 6,
      required: function () {
        return this.scheduleType === "weekly";
      },
    },

    // Used for date-specific schedules.
    // Format: YYYY-MM-DD
    date: {
      type: String,
      match: /^\d{4}-\d{2}-\d{2}$/,
      required: function () {
        return this.scheduleType === "date";
      },
    },

    // false means the doctor is unavailable on that date.
    isAvailable: {
      type: Boolean,
      default: true,
    },

    timeSlots: {
      type: [timeSlotSchema],
      default: [],
    },
  },
  { timestamps: true }
);

// Validate time ranges and schedule configuration.
doctorScheduleSchema.pre("validate", function () {
  if (this.scheduleType === "date" && !this.isAvailable) {
    if (this.timeSlots.length > 0) {
      this.invalidate(
        "timeSlots",
        "Unavailable dates cannot contain time slots."
      );
    }
    return;
  }

  if (!this.timeSlots || this.timeSlots.length === 0) {
    this.invalidate(
      "timeSlots",
      "At least one time slot is required."
    );
    return;
  }

  for (const slot of this.timeSlots) {
    if (slot.startTime >= slot.endTime) {
      this.invalidate(
        "timeSlots",
        "Start time must be earlier than end time."
      );
      break;
    }
  }
});

module.exports = mongoose.model(
  "DoctorSchedule",
  doctorScheduleSchema
);

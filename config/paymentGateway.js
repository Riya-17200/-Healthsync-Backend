const Razorpay = require("razorpay");

const paymentMode = process.env.PAYMENT_MODE || "mock";

let razorpay = null;

if (paymentMode === "razorpay") {
  if (
    !process.env.RAZORPAY_KEY_ID ||
    !process.env.RAZORPAY_KEY_SECRET
  ) {
    throw new Error("Razorpay API credentials are missing.");
  }

  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

if (!["mock", "razorpay"].includes(paymentMode)) {
  throw new Error("Invalid PAYMENT_MODE configuration.");
}

module.exports = {
  paymentMode,
  razorpay,
};
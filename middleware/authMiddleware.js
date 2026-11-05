const jwt = require("jsonwebtoken");

const authMiddleware = (req, res, next) => {
  try {
    // 1. Get token from request headers
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        message: "Access denied. Please log in."
      });
    }

    // 2. Extract token
    const token = authHeader.split(" ")[1];

    // 3. Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // 4. Store user information in request
    req.user = decoded;

    // 5. Allow request to continue
    next();

  } catch (error) {
    return res.status(401).json({
      message: "Invalid or expired token. Please log in again."
    });
  }
};

module.exports = authMiddleware;
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const { JWT_SECRET_KEY, REFRESH_JWT_SECRET_KEY } = process.env;

// Function to sign a token
const signToken = (payload, expiresIn = "365d") => {
  return jwt.sign(payload, JWT_SECRET_KEY, { expiresIn });
};

// Function to generate a refresh token
const generateRefreshToken = (payload, expiresIn = "365d") => {
  return jwt.sign(payload, REFRESH_JWT_SECRET_KEY, { expiresIn });
};

export { signToken, generateRefreshToken };
export class AppError extends Error {
  constructor(statusCode, message, code, details) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (err, req, res, next) => {
  if (err instanceof AppError) {
    if (err.statusCode === 429 && err.details?.retryAfter != null) {
      res.setHeader("Retry-After", String(err.details.retryAfter));
    }
    const errCode = err.code ?? "ERROR";
    return res.status(err.statusCode).json({
      statusCode: err.statusCode,
      error: errCode,
      code: errCode,
      message: err.message,
      ...(err.details != null && { details: err.details }),
    });
  }

  const statusCode = err.statusCode ?? 500;
  const safeMessage =
    statusCode >= 500 && process.env.NODE_ENV === "production"
      ? "Internal Server Error"
      : err.message ?? "Internal Server Error";
      
  console.error(err);

  return res.status(statusCode).json({
    statusCode,
    error: safeMessage,
  });
};

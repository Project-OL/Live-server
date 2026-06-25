import { apiErrorRes } from "../utils/globalFunction.js";

export const validateQuery = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.query);

  if (error) {
    return apiErrorRes(req, res, error.details[0].message, 422);
  }

  req.query = value;
  next();
};

export const validate = (schema) => {
  return (req, res, next) => {
    const { error } = schema.validate(req.body);
    if (error) return apiErrorRes(req, res, error.details[0].message, 422);
    next();
  };
};
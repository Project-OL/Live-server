import { AppError } from "./errorHandler.js";
import { ROLES_BRIEF, ROLES_RES } from "../utils/roles.js";

const roleMiddleware = (allowedRoles = []) => {
  return (req, res, next) => {

    if (!req.user) {
      return next(new AppError(401, "Unauthorized", "UNAUTHORIZED"));
    }

    const roleKey = ROLES_RES[req.user.roleId];
    const roleAccess = ROLES_BRIEF[roleKey];

    if (!roleAccess || !allowedRoles.includes(roleKey)) {
      return next(new AppError(403, "Access Denied", "ACCESS_DENIED"));
    }

    req.user.roleAccess = roleAccess;

    next();
  };
};

export default roleMiddleware;

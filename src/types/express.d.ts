import "express";

declare global {
  namespace Express {
    interface User {
      userId?: number;
      siteId?: number;
      email?: string;
      role?: string;
    }

    interface Request {
      user?: User;
    }
  }
}

export {};
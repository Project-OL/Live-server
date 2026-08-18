import jwt from 'jsonwebtoken';
import prisma from '../config/prisma.js';
import { client as redisClient } from '../config/redis.js';
import { AppError } from './errorHandler.js';

const API_PREFIX = '/api/v1';

/**
 * Baseline endpoints accessible by any authenticated admin regardless of view assignments.
 */
const BASE_ALLOWED_ENDPOINTS = new Set([
  'POST /admin/auth/logout',
  'GET /admin/auth/me',
  'GET /admin/views/me',
  'GET /admin/support/notifications',
  'GET /admin/support/notifications/badge',
  'POST /admin/support/notifications/read',
]);

/**
 * Normalize endpoint paths so parameters match:
 * e.g., "GET /admin/users/22814241-837d-43b2-825e-71b792c4befa/restrictions" -> "GET /admin/users/:p/restrictions"
 */
export function normalizeAdminEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'string') return '';
  const parts = endpoint.trim().split(/\s+/);
  const method = parts[0] || 'GET';
  const path = parts[1] || parts[0];

  const normalizedPath = path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':') || /^[0-9a-fA-F-]{36}$/.test(seg) || /^\d+$/.test(seg)) {
        return ':p';
      }
      return seg;
    })
    .join('/')
    .replace(/\/+$/, '');

  return `${method.toUpperCase()} ${normalizedPath}`;
}

/**
 * Authenticate System Admin, check session revocation, update presence, and enforce view-based gating.
 */
export const authenticateAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(new AppError(401, 'Missing admin token', 'ADMIN_TOKEN_MISSING'));
    }

    const token = authHeader.substring(7).trim();
    if (!token) {
      return next(new AppError(401, 'Missing admin token', 'ADMIN_TOKEN_MISSING'));
    }

    const secret = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET;
    let payload;
    try {
      payload = jwt.verify(token, secret);
    } catch (jwtErr) {
      return next(new AppError(401, 'Admin token invalid or expired', 'ADMIN_TOKEN_INVALID'));
    }

    const adminId = payload.sub || payload.id || payload.userId;
    const role = payload.role || 'SUPER_ADMIN';

    if (!adminId) {
      return next(new AppError(401, 'Invalid admin token payload', 'ADMIN_TOKEN_INVALID'));
    }

    // 1. Check Redis for Token Revocation
    if (redisClient.isOpen) {
      const isRevoked = await redisClient.get(`admin:revoked:${adminId}`);
      if (isRevoked) {
        return next(new AppError(401, 'Admin token has been revoked', 'ADMIN_TOKEN_INVALID'));
      }
      // Presence Heartbeat: mark admin online in Redis
      redisClient.set(`admin:online:${adminId}`, '1', { EX: 300 }).catch(() => {});
    }

    // 2. Verify System Admin in DB (if system_admins table exists)
    let adminRecord = null;
    try {
      adminRecord = await prisma.system_admins.findUnique({
        where: { id: adminId }
      });
      if (adminRecord && adminRecord.status !== 'ACTIVE') {
        return next(new AppError(401, 'Admin account is inactive or disabled', 'ADMIN_DISABLED'));
      }
    } catch (dbErr) {
      // If table query is skipped/fails, fallback to token payload
    }

    req.adminUser = {
      id: adminId,
      role: adminRecord?.role || role
    };
    req.userId = adminId;

    // 3. View-Based Gating for non-SUPER_ADMIN admins
    const effectiveRole = req.adminUser.role;
    if (effectiveRole !== 'SUPER_ADMIN') {
      try {
        const viewAssignments = await prisma.admin_view_assignments.findMany({
          where: { admin_id: adminId },
          include: { admin_views: true }
        });

        if (viewAssignments.length > 0) {
          const allowedEndpoints = new Set();
          for (const assignment of viewAssignments) {
            const endpoints = assignment.admin_views?.endpoints || [];
            for (const ep of endpoints) {
              allowedEndpoints.add(normalizeAdminEndpoint(ep));
            }
          }

          let relativePath = req.originalUrl || req.url || '';
          if (relativePath.startsWith(API_PREFIX)) {
            relativePath = relativePath.slice(API_PREFIX.length);
          }
          const currentEndpointKey = normalizeAdminEndpoint(`${req.method} ${relativePath}`);

          req.adminViewAccess = {
            restricted: true,
            endpoints: allowedEndpoints
          };

          if (!allowedEndpoints.has(currentEndpointKey) && !BASE_ALLOWED_ENDPOINTS.has(currentEndpointKey)) {
            return next(new AppError(403, 'Endpoint not in your assigned views', 'ADMIN_VIEW_FORBIDDEN'));
          }
        }
      } catch (viewErr) {
        console.error('[Admin Auth View Check Error]:', viewErr.message);
      }
    }

    next();
  } catch (err) {
    console.error('[Admin Auth Failure]:', err.name, err.message);
    if (err instanceof AppError) return next(err);
    return next(new AppError(401, 'Admin token invalid or expired', 'ADMIN_TOKEN_INVALID'));
  }
};

/**
 * Require specific Admin Role(s) for a route (e.g. requireAdminRole('SUPER_ADMIN', 'MODERATOR'))
 */
export function requireAdminRole(...roles) {
  return async (req, res, next) => {
    if (!req.adminUser) {
      return next(new AppError(401, 'Not authenticated as admin', 'ADMIN_TOKEN_MISSING'));
    }

    // Granted if admin's role is in allowed roles
    if (roles.includes(req.adminUser.role)) {
      return next();
    }

    // View Grant Override: if assigned view explicitly lists this endpoint, grant access
    if (req.adminViewAccess?.restricted) {
      let relativePath = req.originalUrl || req.url || '';
      if (relativePath.startsWith(API_PREFIX)) {
        relativePath = relativePath.slice(API_PREFIX.length);
      }
      const currentEndpointKey = normalizeAdminEndpoint(`${req.method} ${relativePath}`);
      if (req.adminViewAccess.endpoints.has(currentEndpointKey)) {
        return next();
      }
    }

    return next(new AppError(403, 'Insufficient admin role permissions', 'ADMIN_FORBIDDEN'));
  };
}

export default authenticateAdmin;

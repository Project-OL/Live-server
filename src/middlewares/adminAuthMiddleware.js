import jwt from 'jsonwebtoken'
import prisma from '../config/prisma.js'
import { client as redisClient } from '../config/redis.js'
import { AppError } from './errorHandler.js'

const API_PREFIX = '/api/v1'
const ADMIN_ONLINE_TTL = 300
const SINGLE_SESSION_ROLES = new Set(['CUSTOMER_SUPPORT', 'SUPER_ADMIN'])

/**
 * Baseline endpoints accessible by any authenticated admin regardless of view assignments.
 * Same set as ol-node-rest `authenticateAdmin`.
 */
const BASE_ALLOWED_ENDPOINTS = new Set(
  [
    'POST /admin/auth/logout',
    'GET /admin/auth/me',
    'GET /admin/views/me',
    'GET /admin/support/notifications',
    'GET /admin/support/notifications/badge',
    'POST /admin/support/notifications/read',
  ].map(normalizeAdminEndpoint),
)

/**
 * Match ol-node-rest `normalizeAdminEndpoint`:
 * "GET /admin/users/:id/restrictions" ≡ "GET /admin/users/:userId/restrictions".
 * Also collapse UUIDs / numeric ids when the request path (not the route pattern) is used.
 */
export function normalizeAdminEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'string') return ''
  const trimmed = endpoint.trim()
  const space = trimmed.indexOf(' ')
  const method = space === -1 ? 'GET' : trimmed.slice(0, space)
  const path = space === -1 ? trimmed : trimmed.slice(space + 1)

  const normalizedPath = path
    .split('?')[0]
    .split('/')
    .map((seg) => {
      if (!seg) return seg
      if (seg.startsWith(':') || /^[0-9a-fA-F-]{36}$/.test(seg) || /^\d+$/.test(seg)) {
        return ':p'
      }
      return seg
    })
    .join('/')
    .replace(/\/+$/, '')

  return `${method.toUpperCase()} ${normalizedPath}`
}

function adminJwtSecret() {
  const secret = process.env.ADMIN_JWT_SECRET
  if (!secret) {
    throw new AppError(500, 'ADMIN_JWT_SECRET is not configured', 'ADMIN_JWT_NOT_CONFIGURED')
  }
  return secret
}

function currentAdminEndpointKey(req) {
  const mounted = `${req.baseUrl || ''}${req.path || ''}`
  let relative = mounted
  if (relative.startsWith(API_PREFIX)) relative = relative.slice(API_PREFIX.length)
  else if (relative.startsWith('/api')) relative = relative.slice('/api'.length)
  return normalizeAdminEndpoint(`${req.method} ${relative}`)
}

function usesSingleAdminSession(role) {
  return SINGLE_SESSION_ROLES.has(role)
}

/**
 * Same checks as ol-node-rest `systemAdminService.verifyAccessToken`:
 * HS256 + ADMIN_JWT_SECRET, iss=offoo-admin, type=access, Redis revoke, active admin, session.
 */
export async function verifyAdminAccessToken(token) {
  const secret = adminJwtSecret()
  let payload
  try {
    payload = jwt.verify(token, secret, { algorithms: ['HS256'] })
  } catch (err) {
    if (err instanceof AppError) throw err
    throw new AppError(401, 'Admin token invalid or expired', 'ADMIN_TOKEN_INVALID')
  }

  if (payload.iss !== 'offoo-admin' || payload.type !== 'access' || !payload.sub) {
    throw new AppError(401, 'Admin token invalid or expired', 'ADMIN_TOKEN_INVALID')
  }

  try {
    if (redisClient.isOpen) {
      const revoked = await redisClient.get(`admin:revoked:${payload.sub}`)
      if (revoked) {
        throw new AppError(401, 'Admin token invalid or expired', 'ADMIN_TOKEN_INVALID')
      }
    }
  } catch (err) {
    if (err instanceof AppError) throw err
  }

  const admin = await prisma.system_admins.findUnique({ where: { id: payload.sub } })
  if (!admin || !admin.is_active || admin.status !== 'ACTIVE') {
    throw new AppError(401, 'Admin not found or inactive', 'ADMIN_INVALID_CREDENTIALS')
  }

  if (usesSingleAdminSession(admin.role)) {
    if (!payload.sessionId) {
      throw new AppError(401, 'Admin token invalid or expired', 'ADMIN_TOKEN_INVALID')
    }
    const session = await prisma.admin_sessions.findFirst({
      where: {
        id: payload.sessionId,
        revoked_at: null,
        expires_at: { gt: new Date() },
      },
    })
    if (!session || session.admin_id !== admin.id) {
      throw new AppError(401, 'Admin token invalid or expired', 'ADMIN_TOKEN_INVALID')
    }
  }

  return { payload, admin }
}

async function loadViewAccess(adminId) {
  const assignments = await prisma.admin_view_assignments.findMany({
    where: { admin_id: adminId },
    include: { admin_views: true },
  })
  const endpoints = new Set()
  for (const assignment of assignments) {
    const list = assignment.admin_views?.endpoints || []
    for (const ep of list) endpoints.add(normalizeAdminEndpoint(ep))
  }
  return {
    restricted: assignments.length > 0,
    endpoints,
  }
}

/**
 * Authenticate System Admin — same contract as ol-node-rest `authenticateAdmin`.
 */
export const authenticateAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(new AppError(401, 'Missing admin token', 'ADMIN_TOKEN_MISSING'))
    }

    const token = authHeader.substring(7).trim()
    if (!token) {
      return next(new AppError(401, 'Missing admin token', 'ADMIN_TOKEN_MISSING'))
    }

    const { admin } = await verifyAdminAccessToken(token)

    req.adminUser = { id: admin.id, role: admin.role }
    req.userId = admin.id

    if (redisClient.isOpen) {
      redisClient.set(`admin:online:${admin.id}`, '1', { EX: ADMIN_ONLINE_TTL }).catch(() => {})
    }

    if (admin.role !== 'SUPER_ADMIN') {
      const access = await loadViewAccess(admin.id)
      req.adminViewAccess = access
      if (access.restricted) {
        const endpointKey = currentAdminEndpointKey(req)
        if (
          endpointKey &&
          !access.endpoints.has(endpointKey) &&
          !BASE_ALLOWED_ENDPOINTS.has(endpointKey)
        ) {
          return next(new AppError(403, 'Endpoint not in your assigned views', 'ADMIN_VIEW_FORBIDDEN'))
        }
      }
    }

    return next()
  } catch (err) {
    if (err instanceof AppError) return next(err)
    console.error('[Admin Auth Failure]:', err.name, err.message)
    return next(new AppError(401, 'Admin token invalid or expired', 'ADMIN_TOKEN_INVALID'))
  }
}

/**
 * Require specific Admin Role(s) — same override as ol-node-rest `requireAdminRole`.
 */
export function requireAdminRole(...roles) {
  return async (req, res, next) => {
    if (!req.adminUser) {
      return next(new AppError(401, 'Not authenticated as admin', 'ADMIN_TOKEN_MISSING'))
    }

    if (roles.includes(req.adminUser.role)) {
      return next()
    }

    if (req.adminViewAccess?.restricted) {
      const endpointKey = currentAdminEndpointKey(req)
      if (endpointKey && req.adminViewAccess.endpoints.has(endpointKey)) {
        return next()
      }
    }

    return next(new AppError(403, 'Insufficient admin role', 'ADMIN_FORBIDDEN'))
  }
}

export default authenticateAdmin

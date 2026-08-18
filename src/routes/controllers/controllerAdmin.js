import express from 'express';
import { authenticateAdmin } from '../../middlewares/adminAuthMiddleware.js';
import {
  applyUserRestrictionService,
  getUserRestrictionsHistory,
  getUserActiveRestrictions,
  clearRestrictionByIdService,
  clearRestrictionsByTypeService,
  VALID_RESTRICTION_TYPES
} from '../service/serviceAdmin.js';

const router = express.Router();

// ==========================================
// ADMIN ENDPOINTS (/api/v1/admin/users/...)
// ==========================================

/**
 * Apply one restriction for a user
 * POST /api/v1/admin/users/:userId/restrictions
 * POST /admin/users/:userId/restrictions
 */
export const applyUserRestriction = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { type, restrictedUntil, reason, reportId } = req.body;
    const adminId = req.userId || req.user?.id || 'system_admin';

    if (!type || !restrictedUntil) {
      return res.status(400).json({
        success: false,
        message: 'Both type and restrictedUntil are required fields.'
      });
    }

    const restriction = await applyUserRestrictionService({
      userId,
      type,
      restrictedUntil,
      reason,
      reportId,
      adminId
    });

    return res.status(201).json({
      success: true,
      message: `Restriction ${type} applied successfully until ${restrictedUntil}`,
      data: restriction
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      message: err.message || 'Failed to apply restriction'
    });
  }
};

/**
 * List restrictions for a user
 * GET /api/v1/admin/users/:userId/restrictions
 * GET /admin/users/:userId/restrictions
 */
export const getUserRestrictions = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const restrictions = await getUserRestrictionsHistory(userId);

    return res.status(200).json({
      success: true,
      data: restrictions
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to fetch restrictions'
    });
  }
};

/**
 * Clear a specific restriction by ID
 * DELETE /api/v1/admin/users/:userId/restrictions/:restrictionId
 * DELETE /admin/users/:userId/restrictions/:restrictionId
 */
export const clearUserRestrictionById = async (req, res, next) => {
  try {
    const { userId, restrictionId } = req.params;
    const adminId = req.userId || req.user?.id || 'system_admin';

    const cleared = await clearRestrictionByIdService(userId, restrictionId, adminId);

    if (!cleared) {
      return res.status(404).json({
        success: false,
        message: 'Restriction not found or already cleared.'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Restriction cleared successfully.'
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to clear restriction'
    });
  }
};

/**
 * Clear restriction by type
 * POST /api/v1/admin/users/:userId/restrictions/:type/clear
 * POST /admin/users/:userId/restrictions/:type/clear
 */
export const clearUserRestrictionByType = async (req, res, next) => {
  try {
    const { userId, type } = req.params;
    const adminId = req.userId || req.user?.id || 'system_admin';

    if (!VALID_RESTRICTION_TYPES.includes(type)) {
      return res.status(400).json({
        success: false,
        message: `Invalid restriction type. Must be one of: ${VALID_RESTRICTION_TYPES.join(', ')}`
      });
    }

    const count = await clearRestrictionsByTypeService(userId, type, adminId);

    return res.status(200).json({
      success: true,
      message: `Cleared ${count} active restriction(s) of type ${type}.`,
      clearedCount: count
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to clear restriction by type'
    });
  }
};

/**
 * User self check active restrictions
 * GET /api/v1/users/me/restrictions
 * GET /users/me/restrictions
 */
export const getMyRestrictions = async (req, res, next) => {
  try {
    const userId = req.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const activeRestrictions = await getUserActiveRestrictions(userId);

    return res.status(200).json({
      success: true,
      data: activeRestrictions
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to fetch active restrictions'
    });
  }
};

// Admin Endpoints
router.post('/users/:userId/restrictions', authenticateAdmin, applyUserRestriction);
router.get('/users/:userId/restrictions', authenticateAdmin, getUserRestrictions);
router.delete('/users/:userId/restrictions/:restrictionId', authenticateAdmin, clearUserRestrictionById);
router.post('/users/:userId/restrictions/:type/clear', authenticateAdmin, clearUserRestrictionByType);

export default router;

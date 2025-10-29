const express = require('express');
const { requireJwtAuth, checkAdmin } = require('~/server/middleware');
const {
  listUsers,
  getUser,
  getUserStats,
  updateUserRole,
  deleteUserByAdmin,
  listUserConversations,
  listUserMessages,
  getUserUsage,
  listUserActivities,
  getUserActivityStats,
  getTotalExpenditure,
} = require('~/server/controllers/AdminController');

const router = express.Router();

router.use(requireJwtAuth, checkAdmin);

// User management
router.get('/users', listUsers);
router.get('/users/:id', getUser);
router.get('/users/:id/stats', getUserStats);
router.put('/users/:id/role', updateUserRole);
router.delete('/users/:id', deleteUserByAdmin);

// Conversations & Messages
router.get('/users/:id/conversations', listUserConversations);
router.get('/users/:id/messages', listUserMessages);

// Usage
router.get('/users/:id/usage', getUserUsage);

// User Activities
router.get('/user-activities', listUserActivities);
router.get('/users/:id/activity-stats', getUserActivityStats);

// Total Expenditure
router.get('/total-expenditure', getTotalExpenditure);

module.exports = router;



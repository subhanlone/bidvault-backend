import { Router } from 'express';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { fail, ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';

const router = Router();

router.get(
  '/',
  requireAuth(),
  asyncHandler(async (req, res) => {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.auth!.userId },
      orderBy: [{ isRead: 'asc' }, { createdAt: 'desc' }],
      take: 50,
    });
    ok(res, notifications.map(n => ({
      id: n.id,
      type: n.type,
      title: n.title,
      message: n.message,
      isRead: n.isRead,
      createdAt: n.createdAt.toISOString(),
    })));
  }),
);

router.post(
  '/:notificationId/read',
  requireAuth(),
  asyncHandler(async (req, res) => {
    const updated = await prisma.notification.updateMany({
      where: { id: req.params.notificationId, userId: req.auth!.userId },
      data: { isRead: true },
    });
    if (updated.count === 0) {
      fail(res, 'Notification not found.', 404);
      return;
    }
    ok(res, { id: req.params.notificationId, isRead: true });
  }),
);

router.post(
  '/read-all',
  requireAuth(),
  asyncHandler(async (req, res) => {
    await prisma.notification.updateMany({
      where: { userId: req.auth!.userId, isRead: false },
      data: { isRead: true },
    });
    ok(res, { message: 'All notifications marked as read.' });
  }),
);

export default router;

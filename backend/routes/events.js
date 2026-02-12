/**
 * Event ingestion route for explicit client-side behavior signals.
 */

import express from 'express';
import { createAuthenticateMiddleware } from './session.js';
import { isAllowedEventType } from '../events/eventTypes.js';
import { createRequestEvent, trackEventSafe } from '../events/eventLogger.js';

const router = express.Router();
const authenticate = createAuthenticateMiddleware({ scope: 'Events' });

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

router.post('/track', authenticate, async (req, res) => {
  const payload = isPlainObject(req.body) ? req.body : {};
  const eventType = String(payload.eventType || '').trim().toLowerCase();
  if (!isAllowedEventType(eventType)) {
    res.status(400).json({ success: false, message: 'Invalid eventType.' });
    return;
  }

  const actorUid = Number(req.auth?.user?.uid);
  const rawActorUid = Number(payload.actorUid);
  if (Number.isInteger(rawActorUid) && rawActorUid > 0 && rawActorUid !== actorUid) {
    res.status(403).json({ success: false, message: 'actorUid mismatch.' });
    return;
  }

  const targetUid = Number(payload.targetUid);
  const accepted = await trackEventSafe(
    createRequestEvent(req, {
      eventType,
      actorUid,
      targetUid: Number.isInteger(targetUid) && targetUid > 0 ? targetUid : 0,
      targetType: payload.targetType,
      reason: payload.reason,
      tags: payload.tags,
      evidence: payload.evidence,
      metadata: payload.metadata,
    })
  );

  res.json({
    success: true,
    data: accepted,
  });
});

export default router;

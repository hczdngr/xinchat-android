# Phase 0: Event Logging and Feature Switches

## New Event Types

- `impression`
- `click`
- `reply`
- `mute`
- `report`
- `risk_hit`

## New Routes

- `POST /api/events/track`
  - Auth: required
  - Request:
    ```json
    {
      "eventType": "click",
      "targetUid": 100000001,
      "targetType": "friend",
      "reason": "manual_track",
      "tags": ["friends_add"],
      "evidence": ["button:add_friend"],
      "metadata": { "entry": "friends_page" }
    }
    ```
  - Response:
    ```json
    {
      "success": true,
      "data": { "accepted": true, "id": "..." }
    }
    ```

- `GET /api/admin/feature-flags`
  - Auth: admin token
  - Response: current feature snapshot + env mapping.

- `GET /api/admin/events/summary`
  - Auth: admin token
  - Response: event logger queue, limits, counters and error stats.

## Auto Instrumentation (Phase 0)

- `POST /api/chat/send` -> `reply`
- `GET /api/chat/get` -> `impression`
- `POST /api/chat/overview` -> `impression`
- `POST /api/chat/delete-cutoff` -> `mute`
- `POST /api/friends/add` -> `click`
- `POST /api/admin/messages/review` -> `report` / `risk_hit`
- `POST /api/admin/messages/delete` -> `report` / `risk_hit`

## Env Switches

All new switches default to `false` and preserve old logic when disabled.

- `FEATURE_EVENT_LOG_ENABLED`
- `FEATURE_REPLY_ASSISTANT_ENABLED`
- `FEATURE_TRANSLATE_PERSONALIZATION_ENABLED`
- `FEATURE_RISK_GUARD_ENABLED`
- `FEATURE_RELATIONSHIP_OPS_ENABLED`
- `FEATURE_SUMMARY_CENTER_ENABLED`
- `FEATURE_RECO_VW_ENABLED`
- `FEATURE_RECO_VW_SHADOW_ENABLED`
- `FEATURE_RECO_VW_ONLINE_ENABLED`

## Event Logger Runtime Config

- `EVENT_LOG_PATH` (default: `backend/data/event-log.ndjson`)
- `EVENT_LOG_STATE_PATH` (default: `backend/data/event-log-state.json`)
- `EVENT_LOG_ARCHIVE_DIR` (default: `backend/data/event-log-archive`)
- `EVENT_LOG_QUEUE_MAX` (default: `5000`)
- `EVENT_LOG_FLUSH_INTERVAL_MS` (default: `400`)
- `EVENT_LOG_FLUSH_BATCH_SIZE` (default: `200`)
- `EVENT_LOG_WRITE_TIMEOUT_MS` (default: `2000`)
- `EVENT_LOG_WRITE_RETRIES` (default: `2`)
- `EVENT_LOG_RETRY_BACKOFF_MS` (default: `120`)
- `EVENT_LOG_RATE_WINDOW_MS` (default: `60000`)
- `EVENT_LOG_RATE_MAX` (default: `120`)
- `EVENT_LOG_ROTATE_ENABLED` (default: `true`)
- `EVENT_LOG_ROTATE_MAX_BYTES` (default: `20971520`)
- `EVENT_LOG_ROTATE_MAX_FILES` (default: `24`)
- `EVENT_LOG_ROTATE_CHECK_INTERVAL_MS` (default: `1000`)
- `EVENT_LOG_REDIS_TIMEOUT_MS` (default: `180`)
- `EVENT_LOG_REDIS_RETRY_BACKOFF_MS` (default: `5000`)

## Cross-Instance + Restart Guarantees

- Redis mode:
  - Configure `REDIS_URL`.
  - Global counters, global rate limit and shared event stream use Redis keys.
  - Multi-instance reads from `/api/admin/events/summary` are globally consistent.
- Local durability mode:
  - `event-log-state.json` persists counters across process restart.
  - `.ndjson` payload file has rotation + archive retention.
- Distributed rotation:
  - When Redis is enabled, rotation lock uses Redis `SET NX PX` for cross-instance lock.
  - Prevents concurrent rotate races on shared storage.

## Rollback

- Disable event logging only:
  - `FEATURE_EVENT_LOG_ENABLED=false`
- Full feature rollback (Phase 0 + future phases):
  - set all `FEATURE_*_ENABLED=false`

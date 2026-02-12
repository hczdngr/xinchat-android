# Phase 4: 消息摘要中心（已落地）

## 1. 改动文件清单

- 后端
  - `backend/summary/service.js`
  - `backend/routes/summary.js`
  - `backend/routes/chat.js`
  - `backend/routes/insight.js`
  - `backend/routes/admin.js`
  - `backend/index.js`
  - `backend/tests/routes.phase4.test.js`
- Admin（Umi）
  - `backend/admin-pro-umi/src/pages/Phases/Phase4.tsx`
  - `backend/admin-pro-umi/src/services/admin/api.ts`
  - `backend/admin-pro-umi/config/routes.ts`
  - `backend/admin-pro-umi/src/app.tsx`
- 客户端
  - `src/components/Home.tsx`

## 2. 新增/变更接口

### `GET /api/summary`

- 说明：读取摘要中心状态（最新摘要 + 历史摘要 + 徽标统计）
- 鉴权：用户 token
- Query:
  - `limit`：历史条数，默认 20，最大 100
  - `ensureLatest`：`1|0`，默认 `1`
- 返回示例：

```json
{
  "success": true,
  "data": {
    "enabled": true,
    "available": true,
    "generatedAt": "2026-02-12T10:00:00.000Z",
    "latest": {
      "id": "1001-1739354400000-ab12cd34",
      "unreadTotal": 6,
      "unreadConversations": 3,
      "summaryText": "Unread 6 message(s) in 3 conversation(s). Pending reply actions: 2.",
      "highlights": [],
      "todos": []
    },
    "history": [],
    "badges": {
      "hasLatest": true,
      "unreadHistory": 0,
      "unreadTotal": 6
    },
    "stats": {
      "generatedTotal": 9,
      "manualRefreshTotal": 2,
      "archivedTotal": 1,
      "lastError": ""
    }
  }
}
```

### `POST /api/summary/refresh`

- 说明：手动刷新摘要（会触发 WS 推送 `summary_center`）
- 鉴权：用户 token
- Body：`{}`
- 返回：同 `GET /api/summary` 的 `data` 结构

### `POST /api/summary/archive`

- 说明：已读归档最新摘要或指定摘要
- 鉴权：用户 token
- Body：
  - `summaryId`（可选）：不传则归档 latest
- 返回：
  - `success`、`message`
  - `data`：归档后的摘要中心状态
  - `archived`：已归档摘要（如命中）

### `POST /api/chat/overview`（兼容扩展）

- 新增可选入参：`includeSummary: true`
- 新增可选出参：`summaryCenter`

### `GET /api/admin/phase4/overview`

- 说明：Phase4 后台监控总览
- 鉴权：admin token 或安全降级模式
- 返回：摘要中心开关、请求量、响应分布、runtime、Top 用户负载

## 3. 开关与配置项

- `FEATURE_SUMMARY_CENTER_ENABLED`
- `SUMMARY_AUTO_INTERVAL_MS`
- `SUMMARY_AUTO_MAX_USERS`
- `SUMMARY_TODO_DELAY_MS`
- `SUMMARY_QUERY_RATE_WINDOW_MS`
- `SUMMARY_QUERY_RATE_MAX`
- `SUMMARY_REFRESH_RATE_WINDOW_MS`
- `SUMMARY_REFRESH_RATE_MAX`
- `SUMMARY_ARCHIVE_RATE_WINDOW_MS`
- `SUMMARY_ARCHIVE_RATE_MAX`

## 4. 验证步骤与结果

1. 启用开关 `FEATURE_SUMMARY_CENTER_ENABLED=true`。
2. 登录两个用户并产生私聊/群聊消息。
3. 调用 `GET /api/summary`，确认返回最新摘要与徽标。
4. 调用 `POST /api/summary/refresh`，确认摘要更新并收到 WS `summary_center`。
5. 调用 `POST /api/summary/archive`，确认 latest 归档到 history。
6. 调用 `GET /api/admin/phase4/overview`，确认可查看运行态与统计。
7. 客户端首页切换到“摘要中心”tab，验证：
  - 手动刷新
  - 已读归档
  - 点击重点会话/待回复项可跳转会话

## 5. 回滚方案

- 一键回滚：`FEATURE_SUMMARY_CENTER_ENABLED=false`
- 回滚后行为：
  - `/api/summary*` 返回 disabled 数据结构
  - 主聊天链路不受影响
  - `/api/chat/overview` 仍保持兼容，`summaryCenter` 可返回 disabled

## 6. 指标口径

- 离线/运行指标（后端 counters）：
  - `summary_center_generate_total`
  - `summary_center_archive_total`
  - `summary_center_auto_tick_total`
  - `summary_center_push_total`
- 在线观察：
  - `GET /api/admin/phase4/overview` 的 requestVolume/responseStatus/runtime/topUsers

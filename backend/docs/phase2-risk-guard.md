# Phase 2：消息风险与反骚扰（已落地）

## 1. 改动范围

- 新增模块
  - `backend/risk/rules.js`：广告/恶意链接规则
  - `backend/risk/scorer.js`：聊天与加好友风险评分、风险画像聚合
  - `backend/risk/stateStore.js`：风险决策日志、忽略、申诉、加好友行为日志持久化
  - `backend/risk/index.js`：导出聚合
- 改造路由
  - `backend/routes/chat.js`
  - `backend/routes/friends.js`
  - `backend/routes/admin.js`
- 前端联动
  - `src/components/Home.tsx`：聊天头部风险气泡 + 忽略/申诉入口
  - `backend/index.html/index.html`：Admin 风险监控卡片
- 其他
  - `backend/index.js`：路由目录新增风控接口示例
  - `backend/tests/routes.phase2.test.js`：Phase 2 集成测试

## 2. 接口变更

### 2.1 `POST /api/chat/send`（兼容扩展）

- 新增返回字段：`risk`（仅在 `FEATURE_RISK_GUARD_ENABLED=true` 且文本消息时返回）

示例：

```json
{
  "success": true,
  "data": { "id": "xxx", "type": "text" },
  "risk": {
    "enabled": true,
    "source": "chat_send",
    "available": true,
    "score": 84,
    "level": "high",
    "tags": ["malicious_link", "ads_spam"],
    "evidence": [
      {
        "rule": "malicious_link",
        "type": "link",
        "description": "Suspicious link host: bit.ly",
        "snippet": "http://bit.ly/xxx"
      }
    ],
    "summary": "Suspicious link host: bit.ly"
  }
}
```

### 2.2 `POST /api/friends/add`（兼容扩展）

- 新增返回字段：`risk`（功能开启时）
- 识别异常加好友行为（短时高频、广撒网、pending 堆积、重复目标）

### 2.3 `GET /api/chat/risk`

- 入参：`targetType`、`targetUid`
- 出参：会话风险画像（`score`、`level`、`tags`、`evidence`、`summary`、`ignored`）

### 2.4 `POST /api/chat/risk/ignore`

- 入参：`targetType`、`targetUid`、`reason`（可选）、`ttlHours`（可选）
- 出参：忽略结果

### 2.5 `POST /api/chat/risk/appeal`

- 入参：`targetType`、`targetUid`、`reason`
- 出参：申诉受理状态

### 2.6 `GET /api/admin/risk/overview`

- 入参：`limit`（可选）
- 出参：风险统计、最近命中证据、最近申诉记录

## 3. 开关与配置项

- 总开关
  - `FEATURE_RISK_GUARD_ENABLED`（默认 false）
- 路由限流
  - `RISK_PROFILE_RATE_WINDOW_MS`
  - `RISK_PROFILE_RATE_MAX`
  - `RISK_IGNORE_RATE_WINDOW_MS`
  - `RISK_IGNORE_RATE_MAX`
  - `RISK_APPEAL_RATE_WINDOW_MS`
  - `RISK_APPEAL_RATE_MAX`
- 评分窗口/阈值
  - `RISK_CHAT_WINDOW_MS`
  - `RISK_CHAT_PROFILE_WINDOW_MS`
  - `RISK_CHAT_HISTORY_LIMIT`
  - `RISK_FLOOD_WARN_THRESHOLD`
  - `RISK_FLOOD_HIGH_THRESHOLD`
  - `RISK_FRIEND_WINDOW_MS`
  - `RISK_FRIEND_SHORT_WINDOW_MS`
  - `RISK_FRIEND_WARN_THRESHOLD`
  - `RISK_FRIEND_HIGH_THRESHOLD`
- 风险画像异步队列与缓存
  - `RISK_PROFILE_CACHE_ENABLED`
  - `RISK_PROFILE_ASYNC_QUEUE_ENABLED`
  - `RISK_PROFILE_CACHE_TTL_MS`
  - `RISK_PROFILE_CACHE_STALE_TTL_MS`
  - `RISK_PROFILE_CACHE_MAX`
  - `RISK_PROFILE_QUEUE_MAX`
  - `RISK_PROFILE_QUEUE_CONCURRENCY`
  - `RISK_PROFILE_QUEUE_WAIT_MS`
  - `RISK_PROFILE_STALE_WAIT_MS`
  - `RISK_PROFILE_COMPUTE_TIMEOUT_MS`
- 存储
  - `RISK_STATE_PATH`
  - `RISK_STATE_MAX_DECISIONS`
  - `RISK_STATE_MAX_APPEALS`
  - `RISK_STATE_MAX_FRIEND_ATTEMPTS`
  - `RISK_MAX_IGNORE_HOURS`

## 4. 降级与回滚

- 风控不可用时：
  - `chat/send`、`friends/add` 主链路不失败，风险字段降级为 `available=false` 或不返回
  - 风险画像接口可返回低风险/不可用描述，不影响聊天功能
- 一键回滚：
  - `FEATURE_RISK_GUARD_ENABLED=false`
  - 聊天与好友链路行为回到旧逻辑（仅保留兼容字段变化）

## 5. 指标与审计

- 命中中高风险时写事件：`risk_hit`
  - `chat/send` -> `tags: ['chat_send', level, ...riskTags]`
  - `friends/add` -> `tags: ['friends_add', level, ...riskTags]`
- Admin 可查看：
  - 风险级别分布（low/medium/high）
  - 通道分布（chat_send/friends_add）
  - 标签聚合（malicious_link/ads_spam/flooding/abnormal_add_friend）
  - 最近证据和申诉
  - 风险画像缓存/队列运行时（cache size、queue pending、cache hit/miss）

## 6. 验证建议

1. 启用风控后发送可疑链接文本，确认 `chat/send` 返回 `risk` 且 `admin/risk/overview` 有命中。
2. 快速连续发起加好友，确认响应出现 `abnormal_add_friend` 风险。
3. 在聊天页顶部出现风险气泡，点击“忽略”后不再展示；“误报申诉”可在 admin 看到记录。
4. 关闭 `FEATURE_RISK_GUARD_ENABLED`，确认聊天与加好友回到原行为。

# Phase 5 - VW 偏好学习与精准推送

本文档说明 Phase5 的后端实现、配置、灰度与回滚方式、指标口径与验证方法。

## 1. 功能概述

- `backend/reco/*` 新增推荐学习模块：
  - `configStore.js`：运行时参数（rollout/epsilon/learningRate）持久化。
  - `stateStore.js`：决策日志、反馈日志、用户偏好画像持久化。
  - `vwClient.js`：可选 VW CLI 调用（未就绪时自动回退）。
  - `service.js`：shadow/online 决策、在线更新、离线 IPS/DR 评估。
- `chat/overview` 接入推荐排序：
  - `shadow`：只打分不改序。
  - `online`：灰度用户按推荐顺序返回。
  - 失败降级：返回原顺序，不影响主链路。
- `chat/send` 支持回传 `recoDecisionId`，自动记 `reply` 反馈。
- 新增路由：
  - `POST /api/reco/decision`
  - `POST /api/reco/feedback`
  - `GET /api/reco/admin`
  - `POST /api/reco/admin/config`
- 管理端增强：
  - `GET /api/admin/phase5/overview`
  - `GET /api/admin/reco/overview`
  - `POST /api/admin/reco/config`
  - `POST /api/admin/feature-flags/update`（在线切换全部 feature）
  - `GET /api/admin/users/detail` 返回 VW 标签/偏好、AI画像细节、抑郁评级。

## 2. 接口说明

### 2.1 `POST /api/reco/decision`

请求示例：

```json
{
  "source": "chat_overview",
  "candidates": [
    { "uid": 1001, "targetUid": 1001, "targetType": "private", "unread": 3, "latest": { "createdAtMs": 1739345000000 } },
    { "uid": 2001, "targetUid": 2001, "targetType": "group", "unread": 1, "latest": { "createdAtMs": 1739344000000 } }
  ]
}
```

响应示例：

```json
{
  "success": true,
  "data": {
    "decisionId": "uuid",
    "mode": "shadow",
    "provider": "vw_cli",
    "selectedCandidateId": "private:1001",
    "ranking": [
      { "candidateId": "private:1001", "score": 0.82, "rank": 1, "provider": "vw_cli" },
      { "candidateId": "group:2001", "score": 0.66, "rank": 2, "provider": "vw_cli" }
    ],
    "appliedOrder": ["private:1001", "group:2001"],
    "shadowOrder": ["private:1001", "group:2001"],
    "rolloutPercent": 10,
    "epsilon": 0.1
  }
}
```

### 2.2 `POST /api/reco/feedback`

请求示例：

```json
{
  "decisionId": "uuid",
  "candidateId": "private:1001",
  "action": "reply"
}
```

响应示例：

```json
{
  "success": true,
  "data": {
    "success": true,
    "feedback": { "id": "uuid", "action": "reply", "reward": 1 },
    "updatedProfile": {
      "uid": 1000,
      "interactions": { "total": 12, "positive": 9, "negative": 1 },
      "topTags": [{ "name": "private:1001", "weight": 1.42, "polarity": "positive" }]
    }
  }
}
```

### 2.3 `GET /api/admin/phase5/overview`

返回：
- Feature 状态（`recoVw/recoVwShadow/recoVwOnline`）
- 请求/响应统计
- 决策与反馈计数、byMode/byProvider
- 在线指标（CTR/回复率/举报率）
- 离线指标（IPS/DR）
- 最近日志与用户画像列表

## 3. 开关与配置

### 3.1 Feature 开关（支持运行时修改）

- `recoVw`
- `recoVwShadow`
- `recoVwOnline`

通过 `POST /api/admin/feature-flags/update` 更新：

```json
{ "name": "recoVwOnline", "enabled": true }
```

批量更新：

```json
{
  "changes": {
    "recoVw": true,
    "recoVwShadow": true,
    "recoVwOnline": false
  }
}
```

### 3.2 Reco 运行时参数（支持在线修改）

- `rolloutPercent`：在线生效灰度比例（0-100）
- `epsilon`：探索比例
- `learningRate`：在线学习步长
- `onlineUpdate`：是否写入偏好更新
- `minCandidates` / `maxCandidates`
- `vwBinaryPath` / `vwModelPath` / `vwTimeoutMs`

接口：`POST /api/admin/reco/config`

## 4. 部署与回滚

### 4.1 部署建议

1. 先开启 `recoVw=true`、`recoVwShadow=true`、`recoVwOnline=false`。
2. 观察 `phase5/overview` 指标与错误计数，确认日志正常。
3. 将 `rolloutPercent` 设置为 `10`，再开启 `recoVwOnline=true`。

### 4.2 一键回滚

- 将 `recoVwOnline=false` 可立即回退到 shadow。
- 将 `recoVw=false` 可完全关闭推荐模块，主链路走旧逻辑。
- VW 不可用时服务自动回退 `heuristic`，并计入 fallback 统计。

## 5. A/B 指标口径

- `impressions`：decision 日志条数
- `CTR`：`feedback.action=click` / `impressions`
- `replyRate`：`feedback.action=reply` / `impressions`
- `reportRate`：`feedback.action=report` / `impressions`
- `IPS`：`reward/propensity` 平均值（仅有可关联 decision 的 feedback）
- `DR`：Doubly Robust 近似值（`pred + (reward-pred)/propensity`）

## 6. 稳定性与降级

- 所有路由都有限流。
- 决策/反馈写盘失败不阻塞聊天主链路。
- VW 执行失败自动降级为启发式评分。
- 开关关闭后恢复到旧行为（不重排/不在线学习）。


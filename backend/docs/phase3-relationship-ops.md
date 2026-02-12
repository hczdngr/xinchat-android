# Phase 3：关系运营面板（好友/群互动衰减）

## 1. 改动文件清单

- 后端
  - `backend/ops/relationshipService.js`
  - `backend/routes/ops.js`
  - `backend/routes/admin.js`
  - `backend/routes/chat.js`
  - `backend/routes/auth.js`
  - `backend/index.js`
  - `backend/tests/admin.social.test.js`
  - `backend/tests/routes.phase3.test.js`
- 前端
  - `src/components/Home.tsx`
  - `backend/index.html/index.html`

## 2. 新增接口

### `GET /api/ops/relationship`

用于返回互动下降榜单（好友 + 群聊），含 7 天 / 30 天趋势和建议动作。

请求参数（query）：

- `scope`: `all | private | group`（可选，默认 `all`）
- `windowDays`: `7 | 30`（可选，默认 `7`）
- `limit`: `1~60`（可选，默认 `20`）
- `includeStable`: `true|false`（可选，默认 `false`）
- `nowMs`: 调试/测试时间覆盖（仅开发环境默认可用，可选）

响应示例：

```json
{
  "success": true,
  "data": {
    "enabled": true,
    "available": true,
    "generatedAt": "2026-02-11T08:00:00.000Z",
    "scope": "all",
    "windowDays": 7,
    "summary": {
      "totalCandidates": 12,
      "totalDeclined": 5,
      "inactive7d": 3,
      "privateCount": 4,
      "groupCount": 1
    },
    "items": [
      {
        "targetUid": 100000123,
        "targetType": "private",
        "title": "Alice",
        "score": 28,
        "lastInteractionAt": "2026-02-02T12:30:11.000Z",
        "metrics": {
          "recent7d": 0,
          "prev7d": 4,
          "recent30d": 5,
          "prev30d": 8,
          "decline7d": 4,
          "decline30d": 3,
          "declineRate7d": 100,
          "declineRate30d": 38
        },
        "recommendation": {
          "action": "greet",
          "label": "打招呼",
          "reason": "最近7天未互动，建议轻触达维持关系。"
        },
        "tags": ["inactive_7d", "drop_7d", "drop_30d"]
      }
    ]
  }
}
```

## 3. 开关与配置项

- 功能开关
  - `FEATURE_RELATIONSHIP_OPS_ENABLED`（默认 `false`）
- 限流
  - `RELATIONSHIP_OPS_RATE_WINDOW_MS`（默认 `60000`）
  - `RELATIONSHIP_OPS_RATE_MAX`（默认 `90`）
- 测试/调试
  - `RELATIONSHIP_OPS_ALLOW_NOW_OVERRIDE`（生产默认 `false`，开发默认 `true`）

## 4. 前端交付（Home）

- 首页底部导航新增：`关系运营`
- 新增关系运营面板：
  - 维度筛选：全部/好友/群聊
  - 时间窗切换：7 天 / 30 天
  - 榜单字段：下降指数、7/30 天下降幅度、最近互动时间、建议动作
  - 建议动作：`发消息` / `打招呼` / `发群消息` / `群里打招呼`
  - 手动刷新按钮
- 降级展示：
  - 功能关闭：显示“关系运营功能未开启”
  - 服务异常：显示“关系运营服务暂不可用”

## 5. 后台管理页交付（Admin）

- 新增 admin API：
  - `GET /api/admin/social/overview`：全局社交图谱统计
  - `GET /api/admin/social/tree?uid=...`：个人社交树（可选含群关系）
- 管理页新增菜单：`社交图谱`
- 支持能力：
  - 全局指标卡片（用户/群/互好友边/孤立用户/连通分量）
  - Top 用户（好友数）与 Top 群（成员数）
  - 按 UID 查询社交树，支持深度 1~4、是否包含群关系
  - 节点/边预览与截断提示

## 6. 降级与回滚

- 一键回滚：`FEATURE_RELATIONSHIP_OPS_ENABLED=false`
- 回滚后：
  - 后端接口仍可调用，但返回 `enabled=false` 和空列表
  - 不影响聊天主链路与好友主链路

## 7. 验证结果

- 后端测试：
  - `npm --prefix backend test` 通过（含新增 `routes.phase3.test.js`、`admin.social.test.js`）
- 类型检查：
  - `npx tsc --noEmit` 通过

> 说明：仓库根目录 `npm test` 会把 backend ESM 测试纳入 Jest（Jest 不支持 `import.meta`），该失败属于既有测试体系差异，不是本次 Phase 3 改动引入。

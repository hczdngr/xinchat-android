# Phase 1 收尾：回复助手 + 翻译个性化（LibreTranslate + Gemini）

## 1. 目标
- 回复助手：
  - 在 `chat/send` 后返回 3 条建议。
  - 支持风格切换：`polite | concise | formal`。
  - 模型调用优先 Gemini（`gemini-3-flash-preview`），失败自动降级本地模板。
- 翻译个性化：
  - 翻译主链路使用本地 LibreTranslate。
  - 支持用户默认偏好 + 单次覆盖。
  - 支持偏好读写接口：`/api/translate/profile`。

## 2. 关键路由

### 2.1 `POST /api/chat/reply-suggest`
用于给指定会话生成 3 条建议。

请求示例：
```json
{
  "targetType": "private",
  "targetUid": 10002,
  "text": "今晚有空吗？",
  "style": "formal",
  "useProfile": true,
  "count": 3
}
```

响应示例：
```json
{
  "success": true,
  "data": {
    "enabled": true,
    "model": "gemini:gemini-3-flash-preview",
    "intent": "question",
    "styleMode": "single",
    "count": 3,
    "degraded": false,
    "reason": "",
    "suggestions": [
      {
        "id": "formal-1",
        "text": "已收到，我确认后尽快回复你。",
        "style": "formal",
        "confidence": 0.84,
        "reason": "..."
      }
    ]
  }
}
```

### 2.2 `POST /api/chat/send`（兼容扩展）
新增可选参数：
- `replySuggest: boolean`
- `replyStyle: "polite" | "concise" | "formal"`
- `replySuggestUseProfile: boolean`

响应新增：
- `assistant.replySuggestions`
- `assistant.styleMode`
- `assistant.intent`
- `assistant.model`
- `assistant.degraded`

### 2.3 `POST /api/translate`
请求示例：
```json
{
  "text": "hello world",
  "sourceLang": "auto",
  "targetLang": "zh",
  "style": "formal",
  "explanationLevel": "short",
  "useProfile": true,
  "persistProfile": true
}
```

响应示例：
```json
{
  "success": true,
  "translated": "你好，世界。",
  "explanation": "已按正式风格翻译（auto -> zh）。",
  "data": {
    "provider": "libretranslate",
    "degraded": false,
    "style": "formal",
    "explanationLevel": "short",
    "profile": {
      "translateStyle": "formal",
      "explanationLevel": "short",
      "replyStyle": "polite"
    },
    "featureEnabled": true
  }
}
```

### 2.4 `GET /api/translate/profile`
响应示例：
```json
{
  "success": true,
  "data": {
    "profile": {
      "translateStyle": "formal",
      "explanationLevel": "short",
      "replyStyle": "polite"
    },
    "featureEnabled": true
  }
}
```

### 2.5 `POST /api/translate/profile`
请求示例：
```json
{
  "translateStyle": "casual",
  "explanationLevel": "detailed",
  "replyStyle": "concise"
}
```

## 3. 配置与开关

### 3.1 功能开关
- `FEATURE_REPLY_ASSISTANT_ENABLED`
- `FEATURE_TRANSLATE_PERSONALIZATION_ENABLED`

### 3.2 回复助手模型相关
- `REPLY_ASSISTANT_USE_GEMINI`
- `GEMINI_REPLY_ASSISTANT_MODEL`
- `GEMINI_DEFAULT_MODEL`
- `GEMINI_MODELS`
- `REPLY_ASSISTANT_GEMINI_TIMEOUT_MS`
- `REPLY_ASSISTANT_MAX_INPUT_CHARS`

### 3.3 API Key 读取优先级（回复助手）
1. `GEMINI_API_KEY`
2. `HARDCODED_GEMINI_API_KEY_B64`（代码内 base64 fallback）

### 3.4 本地翻译相关
- `LIBRETRANSLATE_URL`（默认 `http://127.0.0.1:5000`）
- `LIBRETRANSLATE_API_KEY`（可选）
- `LIBRETRANSLATE_TIMEOUT_MS`
- `LIBRETRANSLATE_RETRY_MAX`
- `TRANSLATE_RATE_WINDOW_MS` / `TRANSLATE_RATE_MAX`
- `TRANSLATE_PROFILE_RATE_WINDOW_MS` / `TRANSLATE_PROFILE_RATE_MAX`
- `REPLY_SUGGEST_RATE_WINDOW_MS` / `REPLY_SUGGEST_RATE_MAX`

## 4. 前端联调（本次收尾）
- 聊天页：
  - 增加回复风格切换（礼貌/简洁/正式）。
  - 增加“跟随偏好/手动风格”开关。
  - 增加“点击即发送”开关（开：点击建议直接发送；关：点击建议仅回填输入框）。
  - 增加“生成建议”按钮，调用 `/api/chat/reply-suggest`。
  - `send` 自动携带 `replySuggest/replyStyle/replySuggestUseProfile`。
  - 展示后端返回的建议卡片（含风格与置信度），点击可回填输入框。
- 翻译页：
  - 使用 `/api/translate`（不再依赖外部网页翻译）。
  - 可切换风格、解释级别、目标语言。
  - 可切换 `useProfile/persistProfile`。
  - 展示当前用户默认偏好（来自 `/api/translate/profile`）。
  - 支持“保存当前偏好”。

## 5. 降级与回滚
- Gemini 不可用：回复助手自动降级本地模板，不阻断聊天发送。
- LibreTranslate 不可用：翻译返回降级结果，不阻断接口。
- 一键回滚：
  - `FEATURE_REPLY_ASSISTANT_ENABLED=false`
  - `FEATURE_TRANSLATE_PERSONALIZATION_ENABLED=false`

## 6. 验证建议
- 后端：
  - `npm --prefix backend test`
- 手工联调：
  1. 登录后在聊天页切换风格并发送文本，确认返回建议。
  2. 点击“生成建议”，确认可展示 3 条建议并可回填输入框。
  3. 打开翻译页，调整风格/解释级别后翻译，确认结果变化。
  4. 保存偏好后重新进入翻译页，确认默认值生效。

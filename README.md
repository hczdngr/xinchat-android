# XinChat (React Native + Web)

𝓛𝓞𝓥𝓔 𝓕𝓡𝓞𝓜 𝓓𝓖𝓘𝓣𝓒 𝓪𝓷𝓭 𝔀𝓮𝓫𝓬𝓵𝓪𝓼𝓼💗💗

一个支持 Android 与 Web 调试的聊天项目，前端基于 React Native，后端为本地 Node.js 服务。

## 1. 环境要求

- Node.js >= 20
- npm >= 10
- Android 开发（可选）
  - JDK 17+
  - Android SDK
  - `adb` 可用

## 2. 安装依赖

在仓库根目录执行：

```bash
npm install
```

后端依赖可单独安装：

```bash
npm --prefix backend install
```

## 3. 启动后端

```bash
npm run backend
```

默认端口：`3001`

## 4. 启动 Web（推荐先开发功能）

```bash
npm run web
```

默认会自动选择可用端口（优先 8080）。启动日志会显示实际地址。

可通过环境变量改端口：

```bash
WEB_PORT=8090 npm run web
```

## 5. 启动 Android

先开 Metro：

```bash
npm start
```

再开 Android：

```bash
npm run android
```

也可以拆分构建安装：

```bash
npm run android:assemble
npm run android:install
```

可指定设备（USB 序列号或 `ip:port`）：

```bash
ADB_DEVICE=<device> npm run android:install
```

或：

```bash
ANDROID_SERIAL=<device> npm run android:install
```

## 6. API 配置（已做动态化）

`src/config.ts` 中 `API_BASE` 按以下优先级自动解析：

1. `XINCHAT_API_BASE` / `REACT_APP_API_BASE` / `VITE_API_BASE`
2. Web：当前浏览器 host + `:3001`
3. Native 调试：从 Metro 地址自动推断 host + `:3001`
4. Native 调试兜底：Android `http://10.0.2.2:3001`，iOS `http://127.0.0.1:3001`
5. 生产环境：必须通过环境变量显式配置 API（否则会告警）

可复制模板：

```bash
cp .env.example .env
```

然后修改：

```env
XINCHAT_API_BASE=http://127.0.0.1:3001
```

## 7. 可移植性约定

- 不再在项目中硬编码 JDK 本机路径（如 `org.gradle.java.home`）
- `android/local.properties` 属于本地文件，不进 Git
- API 地址不硬编码某台机器 IP，统一用动态解析/环境变量
- Android `release` 不再默认使用 `debug.keystore`，签名从 `keystore.properties` 或环境变量读取
- 网络明文流量仅在 Android `debug` 放开，`release` 默认关闭

`release` 签名可用环境变量：

```bash
ANDROID_KEYSTORE_FILE=...
ANDROID_KEYSTORE_PASSWORD=...
ANDROID_KEY_ALIAS=...
ANDROID_KEY_PASSWORD=...
```

也可在 `android/keystore.properties`（本地文件，不提交）中配置同名字段。

## 8. Git 提交规范

以下内容禁止提交到仓库：

- 依赖与构建产物：`node_modules/`, `dist/`, `build/`
- 临时与缓存：`.gradle/`, `.kotlin/`, `.cache/`, `tmp/`, `.metro-health-check*`
- 本地环境变量：`.env`, `.env.*`（保留 `.env.example`）
- 后端运行时数据：`backend/data/*`（仅保留 `backend/data/.gitkeep`）
- 本地数据库与后端私有环境：`backend/**/*.sqlite`, `backend/.env*`

## 9. 常用命令

```bash
npm run lint
npm test
npm run web:build
```

## 10. 常见问题

### Q1: Android 模拟器崩溃怎么办？

优先用 Web 模式开发业务功能（`npm run web`），并将 Android 真机/模拟器问题与业务开发解耦。

### Q2: 为什么我本机 API 连不上？

检查：

- 后端是否已启动（3001）
- `XINCHAT_API_BASE` 是否正确
- 手机/模拟器与后端机器网络是否互通

### Q3: 前端跨域被拒绝怎么办？

后端在生产环境会按 `CORS_ORIGINS` 白名单放行浏览器来源，示例：

```bash
CORS_ORIGINS=https://chat.example.com,https://admin.example.com npm run backend
```

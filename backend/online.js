/**
 * 模块说明：在线状态模块：管理心跳、超时与用户在线离线状态。
 */


const HEARTBEAT_TIMEOUT_MS = 45 * 1000;
const HEARTBEAT_CHECK_MS = 5 * 1000;

const lastHeartbeatAt = new Map();
const onlineState = new Map();
let statusChangeHandler = null;
let timeoutHandler = null;
let heartbeatTimer = null;

// setStatusChangeHandler：设置运行时状态。
const setStatusChangeHandler = (handler) => {
  statusChangeHandler = typeof handler === 'function' ? handler : null;
};

// setTimeoutHandler：设置运行时状态。
const setTimeoutHandler = (handler) => {
  timeoutHandler = typeof handler === 'function' ? handler : null;
};

// touchHeartbeat?处理 touchHeartbeat 相关逻辑。
const touchHeartbeat = (uid) => {
  if (!Number.isInteger(uid)) return false;
  lastHeartbeatAt.set(uid, Date.now());
  if (onlineState.get(uid) !== true) {
    onlineState.set(uid, true);
    if (statusChangeHandler) {
      statusChangeHandler(uid, true);
    }
    return true;
  }
  return false;
};

// markDisconnected?处理 markDisconnected 相关逻辑。
const markDisconnected = (uid) => {
  if (!Number.isInteger(uid)) return;
  lastHeartbeatAt.delete(uid);
  if (onlineState.get(uid) !== false) {
    onlineState.set(uid, false);
    if (statusChangeHandler) {
      statusChangeHandler(uid, false);
    }
  }
};

// isUserOnline：判断条件是否成立。
const isUserOnline = (user) => {
  if (!user || !Number.isInteger(user.uid)) return false;
  if (onlineState.has(user.uid)) {
    return onlineState.get(user.uid) === true;
  }
  return user.online === true;
};

// startHeartbeatMonitor：启动后台流程。
const startHeartbeatMonitor = () => {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    const cutoff = Date.now() - HEARTBEAT_TIMEOUT_MS;
    for (const [uid, ts] of lastHeartbeatAt.entries()) {
      if (ts < cutoff) {
        lastHeartbeatAt.delete(uid);
        if (onlineState.get(uid) !== false) {
          onlineState.set(uid, false);
          if (statusChangeHandler) {
            statusChangeHandler(uid, false);
          }
        }
        if (timeoutHandler) {
          timeoutHandler(uid);
        }
      }
    }
  }, HEARTBEAT_CHECK_MS);
};

// stopHeartbeatMonitor：停止后台流程。
const stopHeartbeatMonitor = () => {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
};

export {
  HEARTBEAT_TIMEOUT_MS,
  setStatusChangeHandler,
  setTimeoutHandler,
  touchHeartbeat,
  markDisconnected,
  isUserOnline,
  startHeartbeatMonitor,
  stopHeartbeatMonitor,
};

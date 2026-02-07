type NotifyPayload = {
  chatUid: number;
  title: string;
  body: string;
  targetType: 'private' | 'group';
};

let permissionAttempted = false;

export const ensureSystemNotificationPermission = async () => {
  const NotificationCtor = (globalThis as any).Notification;
  if (!NotificationCtor) return false;
  if (NotificationCtor.permission === 'granted') return true;
  if (permissionAttempted) return false;
  permissionAttempted = true;
  try {
    const result = await NotificationCtor.requestPermission();
    return result === 'granted';
  } catch {
    return false;
  }
};

export const notifyIncomingSystemMessage = async (payload: NotifyPayload) => {
  const NotificationCtor = (globalThis as any).Notification;
  if (!NotificationCtor) return;
  const granted = await ensureSystemNotificationPermission();
  if (!granted) return;
  try {
    const notice = new NotificationCtor(payload.title || 'New message', {
      body: payload.body || '',
      tag: `${payload.targetType}:${payload.chatUid}`,
      renotify: true,
    });
    if (!notice) return;
  } catch {}
};

export const cancelChatSystemNotification = (_chatUid: number) => {};

import { NativeModules, PermissionsAndroid, Platform } from 'react-native';

type NotifyPayload = {
  chatUid: number;
  title: string;
  body: string;
  targetType: 'private' | 'group';
};

type NotificationModule = {
  notifyIncomingMessage?: (
    chatUid: number,
    title: string,
    body: string,
    targetType: 'private' | 'group'
  ) => void;
  cancelChatNotification?: (chatUid: number) => void;
};

const nativeModule = (NativeModules?.XinchatNotification || null) as NotificationModule | null;
let permissionAttempted = false;

const requestAndroidNotificationPermission = async () => {
  if (Platform.OS !== 'android') return true;
  if (Platform.Version < 33) return true;
  const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
  if (!permission) return false;
  const granted = await PermissionsAndroid.check(permission);
  if (granted) return true;
  const result = await PermissionsAndroid.request(permission);
  return result === PermissionsAndroid.RESULTS.GRANTED;
};

export const ensureSystemNotificationPermission = async () => {
  if (permissionAttempted) {
    if (Platform.OS !== 'android' || Platform.Version < 33) return true;
    const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
    if (!permission) return false;
    return PermissionsAndroid.check(permission);
  }
  permissionAttempted = true;
  try {
    return await requestAndroidNotificationPermission();
  } catch {
    return false;
  }
};

export const notifyIncomingSystemMessage = async (payload: NotifyPayload) => {
  if (!nativeModule?.notifyIncomingMessage) return;
  const granted = await ensureSystemNotificationPermission();
  if (!granted) return;
  nativeModule.notifyIncomingMessage(
    payload.chatUid,
    payload.title,
    payload.body,
    payload.targetType
  );
};

export const cancelChatSystemNotification = (chatUid: number) => {
  if (!nativeModule?.cancelChatNotification) return;
  nativeModule.cancelChatNotification(chatUid);
};


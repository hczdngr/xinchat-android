import { NativeModules, PermissionsAndroid, Platform } from 'react-native';

export type VoiceRecordingResult = {
  uri: string;
  mimeType: string;
  durationMs: number;
  fileName: string;
};

type NativeVoiceRecorder = {
  startRecording: () => Promise<any>;
  stopRecording: () => Promise<any>;
  cancelRecording: () => Promise<any>;
};

const nativeRecorder: NativeVoiceRecorder | null = (NativeModules as any)?.XinchatAudioRecorder || null;

const ensureMicPermission = async () => {
  if (Platform.OS !== 'android') return true;
  const granted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
  if (granted) return true;
  const status = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
  return status === PermissionsAndroid.RESULTS.GRANTED;
};

const normalizeResult = (value: any): VoiceRecordingResult | null => {
  if (!value || typeof value !== 'object') return null;
  const uri = String(value.uri || value.path || '').trim();
  if (!uri) return null;
  const durationMs = Number(value.durationMs || value.duration || 0);
  const mimeType = String(value.mimeType || value.mime || 'audio/mp4');
  const fileName = String(value.fileName || `voice-${Date.now()}.m4a`);
  return {
    uri,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0,
    mimeType,
    fileName,
  };
};

export const isVoiceRecordingSupported = () => Boolean(nativeRecorder);

export const startVoiceRecording = async () => {
  if (!nativeRecorder) {
    throw new Error('当前设备未接入录音模块。');
  }
  const granted = await ensureMicPermission();
  if (!granted) {
    throw new Error('未授予麦克风权限。');
  }
  await nativeRecorder.startRecording();
};

export const stopVoiceRecording = async (): Promise<VoiceRecordingResult | null> => {
  if (!nativeRecorder) return null;
  const raw = await nativeRecorder.stopRecording();
  return normalizeResult(raw);
};

export const cancelVoiceRecording = async () => {
  if (!nativeRecorder) return;
  await nativeRecorder.cancelRecording();
};

export const revokeVoiceRecordingUri = (_uri: string) => {};



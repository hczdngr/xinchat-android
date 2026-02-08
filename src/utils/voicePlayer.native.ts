import { NativeModules } from 'react-native';

type PlayOptions = {
  onEnded?: () => void;
};

type NativeVoicePlayer = {
  startPlayback?: (url: string) => Promise<any>;
  stopPlayback?: () => Promise<any>;
};

const nativePlayer: NativeVoicePlayer | null =
  (NativeModules as any)?.XinchatAudioRecorder || null;

export const isVoicePlaybackSupported = () =>
  Boolean(nativePlayer?.startPlayback && nativePlayer?.stopPlayback);

export const stopVoicePlayback = async () => {
  if (!nativePlayer?.stopPlayback) return;
  await nativePlayer.stopPlayback();
};

export const playVoicePlayback = async (url: string, options?: PlayOptions) => {
  if (!nativePlayer?.startPlayback) {
    throw new Error('当前设备暂不支持语音播放。');
  }
  const source = String(url || '').trim();
  if (!source) {
    throw new Error('语音地址无效。');
  }
  await nativePlayer.startPlayback(source);
  if (options?.onEnded) {
    // Native side currently has no playback completion callback bridge.
  }
};



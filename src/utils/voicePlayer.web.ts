type PlayOptions = {
  onEnded?: () => void;
};

let activeAudio: HTMLAudioElement | null = null;
let activeToken = 0;

const cleanupAudio = (audio: HTMLAudioElement | null) => {
  if (!audio) return;
  try {
    audio.pause();
  } catch {}
  try {
    audio.removeAttribute('src');
    audio.load();
  } catch {}
};

export const isVoicePlaybackSupported = () => typeof Audio !== 'undefined';

export const stopVoicePlayback = async () => {
  activeToken += 1;
  cleanupAudio(activeAudio);
  activeAudio = null;
};

export const playVoicePlayback = async (url: string, options?: PlayOptions) => {
  if (!isVoicePlaybackSupported()) {
    throw new Error('当前浏览器暂不支持语音播放。');
  }
  const source = String(url || '').trim();
  if (!source) {
    throw new Error('语音地址无效。');
  }

  await stopVoicePlayback();
  const token = activeToken;
  const audio = new Audio(source);
  activeAudio = audio;
  audio.preload = 'auto';

  const finish = () => {
    if (token !== activeToken) return;
    cleanupAudio(audio);
    if (activeAudio === audio) {
      activeAudio = null;
    }
    options?.onEnded?.();
  };

  audio.onended = finish;
  audio.onerror = finish;
  try {
    await audio.play();
  } catch (error) {
    finish();
    throw error;
  }
};



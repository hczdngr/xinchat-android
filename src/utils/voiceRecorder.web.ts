export type VoiceRecordingResult = {
  uri: string;
  blob?: Blob;
  mimeType: string;
  durationMs: number;
  fileName: string;
};

let mediaRecorder: MediaRecorder | null = null;
let mediaStream: MediaStream | null = null;
let recordedChunks: BlobPart[] = [];
let recordingStartedAtMs = 0;

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
];

const pickMimeType = () => {
  const RecorderCtor = (globalThis as any)?.MediaRecorder;
  if (!RecorderCtor || typeof RecorderCtor.isTypeSupported !== 'function') {
    return '';
  }
  for (const candidate of MIME_CANDIDATES) {
    try {
      if (RecorderCtor.isTypeSupported(candidate)) return candidate;
    } catch {}
  }
  return '';
};

const guessExtensionByMime = (mimeType: string) => {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4') || mime.includes('aac')) return 'm4a';
  if (mime.includes('wav')) return 'wav';
  return 'webm';
};

const stopStreamTracks = () => {
  if (!mediaStream) return;
  for (const track of mediaStream.getTracks()) {
    try {
      track.stop();
    } catch {}
  }
  mediaStream = null;
};

const clearRecorderState = () => {
  mediaRecorder = null;
  recordedChunks = [];
  recordingStartedAtMs = 0;
};

export const isVoiceRecordingSupported = () => {
  const nav = (globalThis as any)?.navigator;
  const RecorderCtor = (globalThis as any)?.MediaRecorder;
  return Boolean(nav?.mediaDevices?.getUserMedia && RecorderCtor);
};

export const startVoiceRecording = async () => {
  if (!isVoiceRecordingSupported()) {
    throw new Error('当前浏览器不支持语音录制。');
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    throw new Error('录音已在进行中。');
  }

  const nav = (globalThis as any).navigator;
  mediaStream = await nav.mediaDevices.getUserMedia({ audio: true });
  const mimeType = pickMimeType();
  const RecorderCtor = (globalThis as any).MediaRecorder;
  mediaRecorder = mimeType
    ? new RecorderCtor(mediaStream, { mimeType })
    : new RecorderCtor(mediaStream);
  recordedChunks = [];
  recordingStartedAtMs = Date.now();

  await new Promise<void>((resolve, reject) => {
    if (!mediaRecorder) {
      reject(new Error('录音初始化失败。'));
      return;
    }
    mediaRecorder.onstart = () => resolve();
    mediaRecorder.onerror = () => reject(new Error('录音启动失败。'));
    mediaRecorder.ondataavailable = (event: any) => {
      if (event?.data && event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };
    mediaRecorder.start(120);
  });
};

export const stopVoiceRecording = async (): Promise<VoiceRecordingResult | null> => {
  const recorder = mediaRecorder;
  if (!recorder) return null;

  return new Promise<VoiceRecordingResult | null>((resolve) => {
    const startedAtMs = recordingStartedAtMs;
    recorder.onstop = () => {
      const mimeType = recorder.mimeType || 'audio/webm';
      const blob = new Blob(recordedChunks, { type: mimeType });
      const durationMs = Math.max(0, Date.now() - startedAtMs);
      stopStreamTracks();
      clearRecorderState();
      if (!blob.size) {
        resolve(null);
        return;
      }
      const ext = guessExtensionByMime(blob.type || mimeType);
      const uri = URL.createObjectURL(blob);
      resolve({
        uri,
        blob,
        mimeType: blob.type || mimeType,
        durationMs,
        fileName: `voice-${Date.now()}.${ext}`,
      });
    };
    try {
      recorder.stop();
    } catch {
      stopStreamTracks();
      clearRecorderState();
      resolve(null);
    }
  });
};

export const cancelVoiceRecording = async () => {
  const recorder = mediaRecorder;
  if (!recorder) return;
  try {
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder.stop();
  } catch {}
  stopStreamTracks();
  clearRecorderState();
};

export const revokeVoiceRecordingUri = (uri: string) => {
  const value = String(uri || '').trim();
  if (!value || !value.startsWith('blob:')) return;
  try {
    URL.revokeObjectURL(value);
  } catch {}
};


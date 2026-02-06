import { NativeModules, Platform } from 'react-native';

const DEFAULT_API_PORT = 3001;
const isDevRuntime =
  typeof __DEV__ !== 'undefined'
    ? Boolean(__DEV__)
    : String((globalThis as any)?.process?.env?.NODE_ENV || 'development') !== 'production';

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

const readEnvBase = () => {
  const proc = (globalThis as any)?.process;
  const env = proc?.env || {};
  const candidates = [
    (globalThis as any)?.__XINCHAT_API_BASE__,
    env.XINCHAT_API_BASE,
    env.REACT_APP_API_BASE,
    env.VITE_API_BASE,
  ];
  for (const raw of candidates) {
    const value = String(raw || '').trim();
    if (value) return trimTrailingSlash(value);
  }
  return '';
};

const buildBaseFromHost = (host: string, port = DEFAULT_API_PORT) => {
  if (!host) return '';
  return `http://${host}:${port}`;
};

const detectWebBase = () => {
  if (Platform.OS !== 'web') return '';
  const location = (globalThis as any)?.location;
  const host = String(location?.hostname || '').trim();
  if (!host) return '';
  return buildBaseFromHost(host);
};

const detectNativeDevBase = () => {
  if (Platform.OS === 'web') return '';
  const scriptURL = String(NativeModules?.SourceCode?.scriptURL || '');
  if (!scriptURL.startsWith('http')) return '';
  try {
    const parsed = new URL(scriptURL);
    let host = parsed.hostname;
    if (Platform.OS === 'android' && host === 'localhost') {
      host = '10.0.2.2';
    }
    return buildBaseFromHost(host);
  } catch {
    return '';
  }
};

const resolveApiBase = () => {
  const fromEnv = readEnvBase();
  if (fromEnv) return fromEnv;
  const webBase = detectWebBase();
  if (webBase) return webBase;
  const nativeDevBase = detectNativeDevBase();
  if (nativeDevBase) return nativeDevBase;
  if (Platform.OS !== 'web' && isDevRuntime) {
    return Platform.OS === 'android'
      ? `http://10.0.2.2:${DEFAULT_API_PORT}`
      : `http://127.0.0.1:${DEFAULT_API_PORT}`;
  }
  return '';
};

export const API_BASE = resolveApiBase();
if (!API_BASE) {
  console.warn('API_BASE 未配置，请设置 XINCHAT_API_BASE / REACT_APP_API_BASE / VITE_API_BASE。');
}

const stripUnsafeChars = (value: string) => {
  let normalized = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) continue;
    if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff) continue;
    normalized += char;
  }
  return normalized;
};
export const normalizeImageUrl = (value?: string) => {
  if (!value) return '';
  const trimmed = stripUnsafeChars(String(value)).trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('data:image/')) return trimmed;
  if (trimmed.startsWith('/uploads/')) {
    const cleaned = trimmed
      .replace(/\/uploads\/images\/(uploads\/images\/)+/g, '/uploads/images/')
      .replace(/\/+$/, '');
    return `${API_BASE}${cleaned}`;
  }
  try {
    const url = new URL(trimmed);
    const pathname = url.pathname
      .replace(/\/uploads\/images\/(uploads\/images\/)+/g, '/uploads/images/')
      .replace(/\/+$/, '');
    if (pathname.startsWith('/uploads/')) {
      return `${API_BASE}${pathname}${url.search || ''}`;
    }
    return `${url.origin}${pathname}${url.search || ''}`;
  } catch {}
  return trimmed.replace(/\/+$/, '');
};



import { NativeModules, Platform } from 'react-native';

const DEFAULT_API_PORT = 3001;

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
  return (
    readEnvBase() || detectWebBase() || detectNativeDevBase() || `http://127.0.0.1:${DEFAULT_API_PORT}`
  );
};

export const API_BASE = resolveApiBase();

export const normalizeImageUrl = (value?: string) => {
  if (!value) return '';
  const trimmed = String(value)
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
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
  } catch (_) {}
  return trimmed.replace(/\/+$/, '');
};

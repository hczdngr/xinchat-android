const DEFAULT_API_PORT = 3001;
const LOCAL_MACHINE_HOST = 'localhost';
const LOCAL_MACHINE_API_BASE = `http://${LOCAL_MACHINE_HOST}:${DEFAULT_API_PORT}`;

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

const resolveApiBase = () => {
  const fromEnv = readEnvBase();
  if (fromEnv) return fromEnv;
  return LOCAL_MACHINE_API_BASE;
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

export const API_BASE = 'http://192.168.0.7:3001';
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
    let pathname = url.pathname
      .replace(/\/uploads\/images\/(uploads\/images\/)+/g, '/uploads/images/')
      .replace(/\/+$/, '');
    if (pathname.startsWith('/uploads/')) {
      return `${API_BASE}${pathname}${url.search || ''}`;
    }
    return `${url.origin}${pathname}${url.search || ''}`;
  } catch (_) {}
  return trimmed.replace(/\/+$/, '');
};

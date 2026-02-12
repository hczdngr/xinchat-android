export const ADMIN_TOKEN_STORAGE_KEY = 'xinchat_admin_token';

export const readAdminToken = (): string => {
  if (typeof window === 'undefined') return '';
  return String(window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || '').trim();
};

export const writeAdminToken = (token: string): void => {
  if (typeof window === 'undefined') return;
  const safeToken = String(token || '').trim();
  if (!safeToken) {
    window.localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, safeToken);
};

export const clearAdminToken = (): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
};

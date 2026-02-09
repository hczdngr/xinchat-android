import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { STORAGE_KEYS } from './constants/storageKeys';

type WebStorageTier = 'local' | 'session';

const WEB_SESSION_KEY_SET = new Set<string>([
  STORAGE_KEYS.token,
  STORAGE_KEYS.profile,
  STORAGE_KEYS.pendingOpenChat,
  STORAGE_KEYS.pendingChatSettingsAction,
]);

const canUseWebStorage = () => Platform.OS === 'web' && typeof globalThis !== 'undefined';

const resolveWebStorageTier = (key: string): WebStorageTier =>
  WEB_SESSION_KEY_SET.has(key) ? 'session' : 'local';

const getWebStorageByTier = (tier: WebStorageTier): Storage | null => {
  if (!canUseWebStorage()) return null;
  try {
    const holder = globalThis as any;
    const target = tier === 'session' ? holder.sessionStorage : holder.localStorage;
    return target || null;
  } catch {
    return null;
  }
};

const readWebRaw = (key: string): string => {
  const preferredTier = resolveWebStorageTier(key);
  const fallbackTier: WebStorageTier = preferredTier === 'session' ? 'local' : 'session';
  const preferred = getWebStorageByTier(preferredTier);
  const fallback = getWebStorageByTier(fallbackTier);
  if (!preferred && !fallback) return '';

  try {
    const direct = preferred?.getItem(key) ?? '';
    if (direct) return direct;
  } catch {}

  // Migrate value between tiers if policy changed after previous app versions.
  try {
    const legacy = fallback?.getItem(key) ?? '';
    if (!legacy) return '';
    try {
      preferred?.setItem(key, legacy);
    } catch {}
    try {
      fallback?.removeItem(key);
    } catch {}
    return legacy;
  } catch {
    return '';
  }
};

const writeWebRaw = (key: string, value: string) => {
  const preferredTier = resolveWebStorageTier(key);
  const fallbackTier: WebStorageTier = preferredTier === 'session' ? 'local' : 'session';
  const preferred = getWebStorageByTier(preferredTier);
  const fallback = getWebStorageByTier(fallbackTier);
  try {
    preferred?.setItem(key, value);
  } catch {}
  try {
    fallback?.removeItem(key);
  } catch {}
};

const removeWebRaw = (key: string) => {
  const local = getWebStorageByTier('local');
  const session = getWebStorageByTier('session');
  try {
    local?.removeItem(key);
  } catch {}
  try {
    session?.removeItem(key);
  } catch {}
};

export const storage = {
  async getString(key: string) {
    if (canUseWebStorage()) {
      return readWebRaw(key);
    }
    try {
      const value = await AsyncStorage.getItem(key);
      return value ?? '';
    } catch {
      return '';
    }
  },
  async setString(key: string, value: string) {
    if (canUseWebStorage()) {
      writeWebRaw(key, value);
      return;
    }
    try {
      await AsyncStorage.setItem(key, value);
    } catch {}
  },
  async remove(key: string) {
    if (canUseWebStorage()) {
      removeWebRaw(key);
      return;
    }
    try {
      await AsyncStorage.removeItem(key);
    } catch {}
  },
  async getJson<T>(key: string): Promise<T | null> {
    if (canUseWebStorage()) {
      try {
        const raw = readWebRaw(key);
        if (!raw) return null;
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    }
    try {
      const raw = await AsyncStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },
  async setJson<T>(key: string, value: T) {
    if (canUseWebStorage()) {
      try {
        writeWebRaw(key, JSON.stringify(value));
      } catch {}
      return;
    }
    try {
      await AsyncStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

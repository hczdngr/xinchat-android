import AsyncStorage from '@react-native-async-storage/async-storage';

export const storage = {
  async getString(key: string) {
    try {
      const value = await AsyncStorage.getItem(key);
      return value ?? '';
    } catch {
      return '';
    }
  },
  async setString(key: string, value: string) {
    try {
      await AsyncStorage.setItem(key, value);
    } catch {}
  },
  async remove(key: string) {
    try {
      await AsyncStorage.removeItem(key);
    } catch {}
  },
  async getJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },
  async setJson<T>(key: string, value: T) {
    try {
      await AsyncStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

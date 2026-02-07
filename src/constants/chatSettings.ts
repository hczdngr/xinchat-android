export type ChatBackgroundKey = 'default' | 'sky' | 'mint' | 'warm';

export const CHAT_BACKGROUND_PRESETS: Array<{ key: ChatBackgroundKey; label: string }> = [
  { key: 'default', label: '默认' },
  { key: 'sky', label: '天空蓝' },
  { key: 'mint', label: '薄荷绿' },
  { key: 'warm', label: '暖米色' },
];

export const CHAT_BACKGROUND_COLORS: Record<ChatBackgroundKey, string> = {
  default: '#f5f6fa',
  sky: '#e9f4ff',
  mint: '#eef9f1',
  warm: '#f9f3e8',
};

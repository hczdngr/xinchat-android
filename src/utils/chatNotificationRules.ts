export type IncomingMessageContext = {
  selfUid: number;
  senderUid: number;
  chatUid: number;
  activeChatUid: number | null;
  muted: boolean;
  appState?: string;
};

export const shouldNotifyIncomingMessage = (context: IncomingMessageContext): boolean => {
  const selfUid = Number(context.selfUid);
  const senderUid = Number(context.senderUid);
  const chatUid = Number(context.chatUid);
  const activeChatUid = Number(context.activeChatUid);
  const muted = Boolean(context.muted);
  const appState = String(context.appState || 'active').trim().toLowerCase();

  if (!Number.isInteger(selfUid) || selfUid <= 0) return false;
  if (!Number.isInteger(senderUid) || senderUid <= 0) return false;
  if (!Number.isInteger(chatUid) || chatUid <= 0) return false;
  if (senderUid === selfUid) return false;
  if (muted) return false;
  const inForeground = appState === 'active';
  if (inForeground && Number.isInteger(activeChatUid) && activeChatUid === chatUid) return false;
  return true;
};

export const getUnreadBadgeTone = (muted: boolean): 'normal' | 'muted' =>
  muted ? 'muted' : 'normal';

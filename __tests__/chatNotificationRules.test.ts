import {
  getUnreadBadgeTone,
  shouldNotifyIncomingMessage,
} from '../src/utils/chatNotificationRules';

describe('chatNotificationRules', () => {
  test('returns false when message is sent by self', () => {
    expect(
      shouldNotifyIncomingMessage({
        selfUid: 1001,
        senderUid: 1001,
        chatUid: 2001,
        activeChatUid: null,
        muted: false,
      })
    ).toBe(false);
  });

  test('returns false when current chat is open', () => {
    expect(
      shouldNotifyIncomingMessage({
        selfUid: 1001,
        senderUid: 1002,
        chatUid: 2001,
        activeChatUid: 2001,
        muted: false,
        appState: 'active',
      })
    ).toBe(false);
  });

  test('returns false when chat is muted', () => {
    expect(
      shouldNotifyIncomingMessage({
        selfUid: 1001,
        senderUid: 1002,
        chatUid: 2001,
        activeChatUid: null,
        muted: true,
      })
    ).toBe(false);
  });

  test('returns true for incoming message in non-active non-muted chat', () => {
    expect(
      shouldNotifyIncomingMessage({
        selfUid: 1001,
        senderUid: 1002,
        chatUid: 2001,
        activeChatUid: 3001,
        muted: false,
        appState: 'active',
      })
    ).toBe(true);
  });

  test('returns true in background even when activeChatUid matches', () => {
    expect(
      shouldNotifyIncomingMessage({
        selfUid: 1001,
        senderUid: 1002,
        chatUid: 2001,
        activeChatUid: 2001,
        muted: false,
        appState: 'background',
      })
    ).toBe(true);
  });

  test('badge tone follows muted state', () => {
    expect(getUnreadBadgeTone(false)).toBe('normal');
    expect(getUnreadBadgeTone(true)).toBe('muted');
  });

  test('returns true for unknown app state when other conditions allow notify', () => {
    expect(
      shouldNotifyIncomingMessage({
        selfUid: 1001,
        senderUid: 1002,
        chatUid: 2001,
        activeChatUid: null,
        muted: false,
        appState: 'unknown_state',
      })
    ).toBe(true);
  });
});

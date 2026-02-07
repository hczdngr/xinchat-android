import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  BackHandler,
  Dimensions,
  Easing,
  Image,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import type { HomeRoute, RootNavigation } from '../navigation/types';
import Svg, { Line, Path } from 'react-native-svg';
import { API_BASE, normalizeImageUrl } from '../config';
import {
  CHAT_BACKGROUND_COLORS,
  CHAT_BACKGROUND_PRESETS,
  type ChatBackgroundKey,
} from '../constants/chatSettings';
import { STORAGE_KEYS } from '../constants/storageKeys';
import { storage } from '../storage';
import FoundFriends from './FoundFriends';

type Profile = {
  uid?: number;
  username?: string;
  nickname?: string;
  avatar?: string;
  signature?: string;
  gender?: string;
  birthday?: string;
  country?: string;
  province?: string;
  region?: string;
  hasSuicideIntent?: boolean;
};

type Friend = {
  uid: number;
  username?: string;
  nickname?: string;
  avatar?: string;
  signature?: string;
  online?: boolean;
};

type Group = {
  id: number;
  ownerUid?: number;
  name?: string;
  description?: string;
  announcement?: string;
  myNickname?: string;
  memberUids: number[];
  members: Friend[];
  createdAt?: string;
  updatedAt?: string;
};

type Message = {
  id: number | string;
  senderUid: number;
  targetUid: number;
  targetType: string;
  content: string;
  createdAt: string;
  createdAtMs: number;
  raw?: any;
};

type LatestMap = Record<number, { text: string; time: string; ts: number }>;
type ReadAtMap = Record<number, number>;
type BucketMap = Record<number, Message[]>;
type PinnedMap = Record<number, boolean>;
type HiddenMap = Record<number, boolean>;
type MutedMap = Record<number, boolean>;
type ChatBackgroundMap = Record<number, ChatBackgroundKey>;
type MessageListItem = {
  uid: number;
  targetType: 'private' | 'group';
  title: string;
  preview: string;
  latest?: { text: string; time: string; ts: number };
  pinned: boolean;
  unread: number;
  friend?: Friend;
  group?: Group;
};
type SearchChatHit = {
  key: string;
  messageId: string;
  uid: number;
  targetType: 'private' | 'group';
  title: string;
  content: string;
  createdAt: string;
  createdAtMs: number;
};
type HomeTourStep = {
  id: string;
  title: string;
  description: string;
  spotlightStyle: ViewStyle;
  cardStyle: ViewStyle;
};

const PAGE_LIMIT = 30;
const HEARTBEAT_MS = 20000;
const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 10000;
const HOME_REFRESH_DELAY_MS = 2000;
const CHAT_TIME_GAP_MS = 3 * 60 * 1000;
const CHAT_INPUT_MAX_LENGTH = 3000;
const SCENE_TRANSITION_MS = 180;
const SCENE_EDGE_SNAP_MS = 160;
const SCENE_EDGE_EXIT_MS = 180;
const SCENE_EASING = Easing.bezier(0.22, 0, 0, 1);
const SEARCH_MAX_CHAT_HITS = 120;
const EDGE_BACK_HIT_WIDTH = 28;
const EDGE_BACK_DISTANCE = 96;
const EDGE_BACK_VELOCITY = 0.55;
const surfaceShadowStyle =
  Platform.OS === 'web'
    ? { boxShadow: '0px 1px 2px rgba(0, 0, 0, 0.08)' }
    : {
        shadowColor: '#000',
        shadowOpacity: 0.02,
        shadowOffset: { width: 0, height: 1 },
        shadowRadius: 2,
        elevation: 1,
      };
const menuShadowStyle =
  Platform.OS === 'web'
    ? { boxShadow: '0px 8px 24px rgba(0, 0, 0, 0.2)' }
    : {
        shadowColor: '#000',
        shadowOpacity: 0.2,
        shadowOffset: { width: 0, height: 8 },
        shadowRadius: 24,
        elevation: 6,
      };
const quickMenuShadowStyle =
  Platform.OS === 'web'
    ? { boxShadow: '0px 14px 30px rgba(0, 0, 0, 0.35)' }
    : {
        shadowColor: '#000',
        shadowOpacity: 0.35,
        shadowOffset: { width: 0, height: 10 },
        shadowRadius: 30,
        elevation: 10,
      };
const tourCardShadowStyle =
  Platform.OS === 'web'
    ? { boxShadow: '0px 14px 30px rgba(45, 82, 133, 0.2)' }
    : {
        shadowColor: '#1f3f66',
        shadowOpacity: 0.16,
        shadowOffset: { width: 0, height: 8 },
        shadowRadius: 18,
        elevation: 7,
      };
const webInputNoOutline =
  Platform.OS === 'web' ? ({ outlineStyle: 'none', boxShadow: 'none' } as any) : null;

const normalizeFriend = (input: any): Friend | null => {
  const uid = Number(input?.uid);
  if (!Number.isInteger(uid) || uid <= 0) return null;
  return {
    uid,
    username: typeof input?.username === 'string' ? input.username : '',
    nickname: typeof input?.nickname === 'string' ? input.nickname : '',
    avatar: typeof input?.avatar === 'string' ? input.avatar : '',
    signature: typeof input?.signature === 'string' ? input.signature : '',
    online: Boolean(input?.online),
  };
};

const sanitizeFriends = (list: any[]): Friend[] => {
  const seen = new Set<number>();
  const next: Friend[] = [];
  for (const item of list) {
    const friend = normalizeFriend(item);
    if (!friend || seen.has(friend.uid)) continue;
    seen.add(friend.uid);
    next.push(friend);
  }
  return next;
};

const normalizeGroup = (input: any): Group | null => {
  const id = Number(input?.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const memberUids: number[] = Array.isArray(input?.memberUids)
    ? Array.from(
        new Set(
          input.memberUids
            .map((rawUid: any) => Number(rawUid))
            .filter((uid: number) => Number.isInteger(uid) && uid > 0)
        )
      )
    : [];
  const members = Array.isArray(input?.members) ? sanitizeFriends(input.members) : [];
  const memberCount = memberUids.length > 0 ? memberUids.length : members.length;
  const normalizedName = stripAutoGroupCountSuffix(input?.name, memberCount);
  return {
    id,
    ownerUid: Number.isInteger(Number(input?.ownerUid)) ? Number(input.ownerUid) : undefined,
    name: normalizedName,
    description: typeof input?.description === 'string' ? input.description : '',
    announcement: typeof input?.announcement === 'string' ? input.announcement : '',
    myNickname: typeof input?.myNickname === 'string' ? input.myNickname : '',
    memberUids,
    members,
    createdAt: typeof input?.createdAt === 'string' ? input.createdAt : '',
    updatedAt: typeof input?.updatedAt === 'string' ? input.updatedAt : '',
  };
};

const sanitizeGroups = (list: any[]): Group[] => {
  const seen = new Set<number>();
  const next: Group[] = [];
  for (const item of list || []) {
    const group = normalizeGroup(item);
    if (!group || seen.has(group.id)) continue;
    seen.add(group.id);
    next.push(group);
  }
  return next;
};

const sanitizeCachedMessages = (input: any): BucketMap => {
  if (!input || typeof input !== 'object') return {};
  const next: BucketMap = {};
  Object.entries(input).forEach(([rawUid, rawList]) => {
    const uid = Number(rawUid);
    if (!Number.isInteger(uid) || uid <= 0 || !Array.isArray(rawList)) return;
    const list: Message[] = rawList
      .map((entry: any) => ({
        id: entry?.id,
        senderUid: Number(entry?.senderUid),
        targetUid: Number(entry?.targetUid),
        targetType: String(entry?.targetType || ''),
        content: String(entry?.content || ''),
        createdAt: String(entry?.createdAt || ''),
        createdAtMs: Number(entry?.createdAtMs),
        raw: entry?.raw,
      }))
      .filter(
        (entry) =>
          (typeof entry.id === 'number' || typeof entry.id === 'string') &&
          Number.isInteger(entry.senderUid) &&
          Number.isInteger(entry.targetUid) &&
          Number.isFinite(entry.createdAtMs)
      )
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
    next[uid] = list;
  });
  return next;
};

const sanitizeBooleanMap = (input: any): Record<number, boolean> => {
  if (!input || typeof input !== 'object') return {};
  const next: Record<number, boolean> = {};
  Object.entries(input).forEach(([rawUid, rawValue]) => {
    const uid = Number(rawUid);
    if (!Number.isInteger(uid) || uid <= 0) return;
    if (!rawValue) return;
    next[uid] = true;
  });
  return next;
};

const CHAT_BACKGROUND_KEY_SET = new Set<ChatBackgroundKey>(
  CHAT_BACKGROUND_PRESETS.map((item) => item.key)
);

const sanitizeChatBackgroundMap = (input: any): ChatBackgroundMap => {
  if (!input || typeof input !== 'object') return {};
  const next: ChatBackgroundMap = {};
  Object.entries(input).forEach(([rawUid, rawValue]) => {
    const uid = Number(rawUid);
    if (!Number.isInteger(uid) || uid <= 0) return;
    const key = String(rawValue || '').trim() as ChatBackgroundKey;
    if (!CHAT_BACKGROUND_KEY_SET.has(key)) return;
    next[uid] = key;
  });
  return next;
};

const sanitizeGroupRemarksMap = (input: any): Record<number, string> => {
  if (!input || typeof input !== 'object') return {};
  const next: Record<number, string> = {};
  Object.entries(input).forEach(([rawUid, rawValue]) => {
    const uid = Number(rawUid);
    if (!Number.isInteger(uid) || uid <= 0) return;
    if (typeof rawValue !== 'string') return;
    const text = rawValue.trim().slice(0, 60);
    if (!text) return;
    next[uid] = text;
  });
  return next;
};

const stripAutoGroupCountSuffix = (rawName: any, memberCount: number) => {
  const text = String(rawName || '').trim();
  if (!text) return '';
  if (!Number.isInteger(memberCount) || memberCount <= 0) return text;
  const match = text.match(/\((\d+)\)$/);
  if (!match) return text;
  const suffixCount = Number(match[1]);
  if (!Number.isInteger(suffixCount) || suffixCount !== memberCount) return text;
  return text.slice(0, text.length - match[0].length).trim();
};

const getGroupDisplayName = (group?: Partial<Group> | null) => {
  if (!group) return '';
  const memberCount = Array.isArray(group.memberUids)
    ? group.memberUids.length
    : Array.isArray(group.members)
      ? group.members.length
      : 0;
  const stripped = stripAutoGroupCountSuffix(group.name, memberCount);
  if (stripped) return stripped;
  const gid = Number(group.id);
  return Number.isInteger(gid) && gid > 0 ? `群聊${gid}` : '群聊';
};

export default function Home({ profile }: { profile: Profile }) {
  const insets = useSafeAreaInsets();
  const navPad = Math.min(insets.bottom, 6);
  const tokenRef = useRef<string>('');
  const [tokenReady, setTokenReady] = useState(false);
  const [profileData, setProfileData] = useState<Profile>({
    username: '',
    nickname: '',
    avatar: '',
    uid: undefined,
    ...profile,
  });
  const [friends, setFriends] = useState<Friend[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [latestMap, setLatestMap] = useState<LatestMap>({});
  const [loadingFriends, setLoadingFriends] = useState(false);

  const [messagesByUid, setMessagesByUid] = useState<BucketMap>({});
  const [unreadMap, setUnreadMap] = useState<Record<number, number>>({});
  const [historyLoading, setHistoryLoading] = useState<Record<number, boolean>>({});
  const [historyHasMore, setHistoryHasMore] = useState<Record<number, boolean>>({});
  const [readAtMap, setReadAtMap] = useState<ReadAtMap>({});
  const [pinnedMap, setPinnedMap] = useState<PinnedMap>({});
  const [hiddenMap, setHiddenMap] = useState<HiddenMap>({});
  const [mutedMap, setMutedMap] = useState<MutedMap>({});
  const [chatBackgroundMap, setChatBackgroundMap] = useState<ChatBackgroundMap>({});
  const [groupRemarksMap, setGroupRemarksMap] = useState<Record<number, string>>({});
  const [chatMenuVisible, setChatMenuVisible] = useState(false);
  const [chatMenuTargetUid, setChatMenuTargetUid] = useState<number | null>(null);
  const [chatMenuTargetType, setChatMenuTargetType] = useState<'private' | 'group'>('private');
  const [chatMenuPosition, setChatMenuPosition] = useState({ x: 0, y: 0 });
  const [quickMenuVisible, setQuickMenuVisible] = useState(false);
  const [quickMenuMounted, setQuickMenuMounted] = useState(false);
  const quickMenuAnim = useRef(new Animated.Value(0)).current;
  const chatSceneAnim = useRef(new Animated.Value(0)).current;
  const foundSceneAnim = useRef(new Animated.Value(0)).current;
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchAnim = useRef(new Animated.Value(0)).current;
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null);
  const [avatarFailed, setAvatarFailed] = useState(false);

  const [activeChatUid, setActiveChatUid] = useState<number | null>(null);
  const [draftMessage, setDraftMessage] = useState('');
  const [activeView, setActiveView] = useState<'list' | 'found'>('list');
  const [foundFriendsInitialTab, setFoundFriendsInitialTab] = useState<'search' | 'requests'>(
    'search'
  );
  const [friendsRefreshKey, setFriendsRefreshKey] = useState(0);
  const [pendingRequestCount, setPendingRequestCount] = useState(0);
  const [homeTab, setHomeTab] = useState<'messages' | 'contacts'>('messages');
  const [tourStepIndex, setTourStepIndex] = useState(0);
  const [tourVisible, setTourVisible] = useState(false);
  const [tourSeenLoaded, setTourSeenLoaded] = useState(false);
  const [tourSeen, setTourSeen] = useState(false);

  const tourSteps = useMemo<HomeTourStep[]>(() => {
    const { width: screenWidth, height: screenHeight } = Dimensions.get('window');
    const navHeight = 55 + navPad * 2;
    const narrowCardWidth = Math.min(334, Math.max(250, Math.floor(screenWidth * 0.74)));
    const mediumCardWidth = Math.min(360, Math.max(280, Math.floor(screenWidth * 0.8)));
    const contentTop = insets.top + 88;
    const contentBottom = navHeight + 8;
    const listHeight = Math.max(120, screenHeight - contentTop - contentBottom);
    return [
      {
        id: 'profile',
        title: '\u4e2a\u4eba\u4e2d\u5fc3',
        description:
          '\u70b9\u51fb\u5934\u50cf\u53ef\u8fdb\u5165\u4e2a\u4eba\u4e3b\u9875\uff0c\u4fee\u6539\u5934\u50cf\u3001\u6635\u79f0\u548c\u4e2a\u4eba\u8d44\u6599\u3002',
        spotlightStyle: {
          top: insets.top + 2,
          left: 10,
          width: 220,
          height: 44,
          borderRadius: 22,
        },
        cardStyle: {
          top: insets.top + 64,
          left: 14,
          width: narrowCardWidth,
          minHeight: 126,
        },
      },
      {
        id: 'quick-menu',
        title: '\u5feb\u6377\u5165\u53e3',
        description:
          '\u53f3\u4e0a\u89d2 + \u53ef\u5feb\u901f\u6253\u5f00\u83dc\u5355\uff0c\u652f\u6301\u52a0\u597d\u53cb/\u7fa4\u3001\u626b\u4e00\u626b\u7b49\u529f\u80fd\u3002',
        spotlightStyle: {
          top: insets.top + 3,
          right: 8,
          width: 40,
          height: 40,
          borderRadius: 20,
        },
        cardStyle: {
          top: insets.top + 64,
          right: 14,
          width: narrowCardWidth,
          minHeight: 126,
        },
      },
      {
        id: 'list',
        title: '\u4f1a\u8bdd\u5217\u8868',
        description:
          '\u8fd9\u91cc\u662f\u6700\u65b0\u6d88\u606f\uff0c\u70b9\u51fb\u8fdb\u5165\u804a\u5929\uff0c\u957f\u6309\u4f1a\u8bdd\u53ef\u7f6e\u9876\u6216\u5220\u9664\u3002',
        spotlightStyle: {
          top: insets.top + 88,
          left: 8,
          right: 8,
          bottom: navHeight + 6,
          borderRadius: 14,
        },
        cardStyle: {
          top: contentTop + Math.max(8, Math.floor(listHeight * 0.46)),
          right: 14,
          width: mediumCardWidth,
          minHeight: 134,
        },
      },
      {
        id: 'tabs',
        title: '\u5e95\u90e8\u5bfc\u822a',
        description:
          '\u5e95\u90e8\u53ef\u5207\u6362\u6d88\u606f\u4e0e\u8054\u7cfb\u4eba\uff0c\u7528\u6765\u5feb\u901f\u5728\u4f1a\u8bdd\u89c6\u56fe\u548c\u597d\u53cb\u89c6\u56fe\u4e4b\u95f4\u5207\u6362\u3002',
        spotlightStyle: {
          left: 0,
          right: 0,
          bottom: 0,
          height: navHeight + 2,
          borderRadius: 0,
        },
        cardStyle: {
          bottom: navHeight + 14,
          left: 14,
          right: 14,
          minHeight: 130,
        },
      },
    ];
  }, [insets.top, navPad]);

  const navigation = useNavigation<RootNavigation>();
  const route = useRoute<HomeRoute>();
  const messageIdSetsRef = useRef<Map<number, Set<number | string>>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const messagesByUidRef = useRef<BucketMap>({});
  const readAtMapRef = useRef<ReadAtMap>({});
  const mutedMapRef = useRef<MutedMap>({});
  const groupsRef = useRef<Group[]>([]);
  const historyLoadingRef = useRef<Record<number, boolean>>({});
  const historyHasMoreRef = useRef<Record<number, boolean>>({});
  const messageOffsetMapRef = useRef<Map<number, Map<string, number>>>(new Map());
  const messageFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeChatUidRef = useRef<number | null>(null);
  const contentHeightRef = useRef(0);
  const messageListRef = useRef<ScrollView | null>(null);
  const chatInputRef = useRef<TextInput | null>(null);
  const searchInputRef = useRef<TextInput | null>(null);
  const connectWsRef = useRef<() => void>(() => {});
  const cacheWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const homeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const homeCacheHydratedRef = useRef(false);

  useEffect(() => {
    if (!activeChatUid) {
      chatSceneAnim.setValue(0);
      return;
    }
    chatSceneAnim.setValue(16);
    Animated.timing(chatSceneAnim, {
      toValue: 0,
      duration: SCENE_TRANSITION_MS,
      easing: SCENE_EASING,
      useNativeDriver: true,
    }).start();
  }, [activeChatUid, chatSceneAnim]);

  useEffect(() => {
    const showingFoundView = activeView === 'found' && !activeChatUid;
    if (!showingFoundView) {
      foundSceneAnim.setValue(0);
      return;
    }
    foundSceneAnim.setValue(16);
    Animated.timing(foundSceneAnim, {
      toValue: 0,
      duration: SCENE_TRANSITION_MS,
      easing: SCENE_EASING,
      useNativeDriver: true,
    }).start();
  }, [activeChatUid, activeView, foundSceneAnim]);

  useEffect(() => {
    activeChatUidRef.current = activeChatUid;
  }, [activeChatUid]);

  useEffect(() => {
    messagesByUidRef.current = messagesByUid;
  }, [messagesByUid]);

  useEffect(() => {
    readAtMapRef.current = readAtMap;
  }, [readAtMap]);

  useEffect(() => {
    mutedMapRef.current = mutedMap;
  }, [mutedMap]);

  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  useEffect(() => {
    historyLoadingRef.current = historyLoading;
  }, [historyLoading]);

  useEffect(() => {
    historyHasMoreRef.current = historyHasMore;
  }, [historyHasMore]);

  useEffect(
    () => () => {
      if (messageFocusTimerRef.current) {
        clearTimeout(messageFocusTimerRef.current);
        messageFocusTimerRef.current = null;
      }
    },
    []
  );

  useEffect(() => {
    if (profile) {
      setProfileData((prev) => ({ ...prev, ...profile }));
    }
  }, [profile]);

  useEffect(() => {
    const loadToken = async () => {
      tokenRef.current = (await storage.getString(STORAGE_KEYS.token)) || '';
      setTokenReady(true);
    };
    loadToken().catch(() => undefined);
  }, []);

  useEffect(() => {
    const loadProfile = async () => {
      if (!tokenReady || !tokenRef.current) return;
      try {
        const response = await fetch(API_BASE + '/api/profile', {
          headers: { Authorization: `Bearer ${tokenRef.current}` },
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok && data?.success && data?.user) {
          setProfileData((prev) => ({ ...prev, ...data.user }));
          await storage.setJson(STORAGE_KEYS.profile, {
            uid: data.user.uid,
            username: data.user.username,
            nickname: data.user.nickname,
            avatar: data.user.avatar,
            signature: data.user.signature,
            gender: data.user.gender,
            birthday: data.user.birthday,
            country: data.user.country,
            province: data.user.province,
            region: data.user.region,
            hasSuicideIntent: data.user.hasSuicideIntent === true,
          });
        }
      } catch (error) {
        console.warn('Profile request failed', error);
      }
    };
    loadProfile().catch(() => undefined);
  }, [tokenReady]);

  useEffect(() => {
    const loadReadAt = async () => {
      const stored = await storage.getJson<ReadAtMap>(STORAGE_KEYS.readAt);
      if (stored) {
        setReadAtMap(stored);
      }
    };
    loadReadAt().catch(() => undefined);
  }, []);

  useEffect(() => {
    const loadPinned = async () => {
      const stored = await storage.getJson<PinnedMap>(STORAGE_KEYS.pinned);
      setPinnedMap(sanitizeBooleanMap(stored));
    };
    const loadHidden = async () => {
      const stored = await storage.getJson<HiddenMap>(STORAGE_KEYS.hiddenChats);
      setHiddenMap(sanitizeBooleanMap(stored));
    };
    const loadMuted = async () => {
      const stored = await storage.getJson<MutedMap>(STORAGE_KEYS.chatMuted);
      setMutedMap(sanitizeBooleanMap(stored));
    };
    const loadChatBackground = async () => {
      const stored = await storage.getJson<ChatBackgroundMap>(STORAGE_KEYS.chatBackground);
      setChatBackgroundMap(sanitizeChatBackgroundMap(stored));
    };
    loadPinned().catch(() => undefined);
    loadHidden().catch(() => undefined);
    loadMuted().catch(() => undefined);
    loadChatBackground().catch(() => undefined);
  }, []);

  useEffect(() => {
    const loadHomeTourState = async () => {
      const seen = await storage.getString(STORAGE_KEYS.homeTourSeen);
      setTourSeen(seen === '1');
      setTourSeenLoaded(true);
    };
    loadHomeTourState();
  }, []);

  const displayName = useMemo(
    () => profileData.nickname || profileData.username || '加载中...',
    [profileData.nickname, profileData.username]
  );
  const avatarUrl = useMemo(
    () => normalizeImageUrl(profileData.avatar),
    [profileData.avatar]
  );
  const avatarVersion = useMemo(() => {
    const clean = avatarUrl.split('?')[0].replace(/\/+$/, '');
    const name = clean.split('/').pop();
    return name || String(profileData.avatar || '1');
  }, [avatarUrl, profileData.avatar]);
  const avatarSrc = useMemo(() => {
    if (!avatarUrl) return '';
    if (avatarUrl.startsWith('data:')) return avatarUrl;
    const joiner = avatarUrl.includes('?') ? '&' : '?';
    return encodeURI(`${avatarUrl}${joiner}v=${encodeURIComponent(avatarVersion)}`);
  }, [avatarUrl, avatarVersion]);
  const avatarText = useMemo(() => displayName.slice(0, 2), [displayName]);
  const canShowMainHome = !activeChatUid && activeView !== 'found';
  const currentTourStep = tourSteps[tourStepIndex] || null;
  const quickMenuPanelAnimatedStyle = useMemo(
    () => ({
      opacity: quickMenuAnim,
      transform: [
        {
          translateY: quickMenuAnim.interpolate({
            inputRange: [0, 1],
            outputRange: [-6, 0],
          }),
        },
        {
          scale: quickMenuAnim.interpolate({
            inputRange: [0, 1],
            outputRange: [0.98, 1],
          }),
        },
      ],
    }),
    [quickMenuAnim]
  );

  const closeQuickMenu = useCallback(() => {
    if (!quickMenuMounted) {
      setQuickMenuVisible(false);
      return;
    }
    setQuickMenuVisible(false);
    quickMenuAnim.stopAnimation();
    Animated.timing(quickMenuAnim, {
      toValue: 0,
      duration: 130,
      useNativeDriver: true,
    }).start(() => {
      setQuickMenuMounted(false);
    });
  }, [quickMenuAnim, quickMenuMounted]);

  const openQuickMenu = useCallback(() => {
    if (!quickMenuMounted) {
      quickMenuAnim.setValue(0);
      setQuickMenuMounted(true);
    }
    setQuickMenuVisible(true);
    quickMenuAnim.stopAnimation();
    Animated.timing(quickMenuAnim, {
      toValue: 1,
      duration: 170,
      useNativeDriver: true,
    }).start();
  }, [quickMenuAnim, quickMenuMounted]);

  useEffect(() => {
    setAvatarFailed(false);
  }, [avatarUrl]);

  useEffect(() => {
    if (!avatarSrc || avatarSrc.startsWith('data:')) return;
    Image.getSize(
      avatarSrc,
      () => setAvatarFailed(false),
      () => setAvatarFailed(true)
    );
  }, [avatarSrc]);

  useEffect(() => {
    if (!tourSeenLoaded || tourSeen || tourVisible) return;
    if (!canShowMainHome) return;
    setTourStepIndex(0);
    setTourVisible(true);
  }, [canShowMainHome, tourSeen, tourSeenLoaded, tourVisible]);

  useEffect(() => {
    if (!tourVisible) return;
    closeQuickMenu();
    setChatMenuVisible(false);
  }, [closeQuickMenu, tourVisible]);

  const activeChatFriend = useMemo(() => {
    if (!activeChatUid) return null;
    return friends.find((item) => Number(item?.uid) === activeChatUid) || null;
  }, [activeChatUid, friends]);
  const activeChatGroup = useMemo(() => {
    if (!activeChatUid) return null;
    return groups.find((item) => Number(item?.id) === activeChatUid) || null;
  }, [activeChatUid, groups]);
  const activeChatMessages = useMemo(() => {
    if (!activeChatUid) return [];
    return messagesByUid[activeChatUid] || [];
  }, [activeChatUid, messagesByUid]);
  const selfUid = useMemo(() => profileData.uid, [profileData.uid]);
  const canSend = useMemo(() => draftMessage.trim().length > 0, [draftMessage]);
  const activeChatTitle = useMemo(() => {
    if (activeChatGroup) return getGroupDisplayName(activeChatGroup);
    return activeChatFriend?.nickname || activeChatFriend?.username || '聊天';
  }, [activeChatFriend?.nickname, activeChatFriend?.username, activeChatGroup]);
  const activeChatStatusText = useMemo(() => {
    if (activeChatGroup) {
      const remark = String(groupRemarksMap[activeChatGroup.id] || '').trim();
      if (remark) return remark;
      const myNickname = String(activeChatGroup.myNickname || '').trim();
      return myNickname;
    }
    return activeChatFriend?.online ? '在线' : '离线';
  }, [activeChatFriend?.online, activeChatGroup, groupRemarksMap]);
  const activeChatFriendAvatar = useMemo(
    () => normalizeImageUrl(activeChatFriend?.avatar),
    [activeChatFriend?.avatar]
  );
  const selfChatAvatar = useMemo(() => normalizeImageUrl(profileData.avatar), [profileData.avatar]);
  const activeChatBackgroundColor = useMemo(() => {
    if (!activeChatUid) return CHAT_BACKGROUND_COLORS.default;
    const key = chatBackgroundMap[activeChatUid] || 'default';
    return CHAT_BACKGROUND_COLORS[key] || CHAT_BACKGROUND_COLORS.default;
  }, [activeChatUid, chatBackgroundMap]);

  const getAvatarText = useCallback((value?: string) => {
    const text = String(value || '').trim();
    if (!text) return '??';
    return text.slice(0, 2);
  }, []);

  const findUserByUid = useCallback(
    (uid: number) => {
      if (!Number.isInteger(uid) || uid <= 0) return null;
      if (selfUid && uid === selfUid) {
        return {
          uid,
          username: profileData.username,
          nickname: profileData.nickname,
          avatar: profileData.avatar,
        };
      }
      if (activeChatGroup?.members?.length) {
        const member = activeChatGroup.members.find((item) => Number(item?.uid) === uid);
        if (member) return member;
      }
      const friend = friends.find((item) => Number(item?.uid) === uid);
      if (friend) return friend;
      return null;
    },
    [
      activeChatGroup?.members,
      friends,
      profileData.avatar,
      profileData.nickname,
      profileData.username,
      selfUid,
    ]
  );

  const authHeaders = useCallback((): Record<string, string> => {
    const token = tokenRef.current;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, []);

  const hydrateHomeCache = useCallback(async () => {
    const [
      cachedFriends,
      cachedGroups,
      cachedMessages,
      cachedLatest,
      cachedUnread,
      cachedPending,
      cachedGroupRemarks,
    ] =
      await Promise.all([
        storage.getJson<Friend[]>(STORAGE_KEYS.homeFriendsCache),
        storage.getJson<Group[]>(STORAGE_KEYS.homeGroupsCache),
        storage.getJson<BucketMap>(STORAGE_KEYS.homeMessagesCache),
        storage.getJson<LatestMap>(STORAGE_KEYS.homeLatestCache),
        storage.getJson<Record<number, number>>(STORAGE_KEYS.homeUnreadCache),
        storage.getJson<number>(STORAGE_KEYS.homePendingRequestsCache),
        storage.getJson<Record<number, string>>(STORAGE_KEYS.groupRemarks),
      ]);

    const nextFriends = sanitizeFriends(Array.isArray(cachedFriends) ? cachedFriends : []);
    const nextGroups = sanitizeGroups(Array.isArray(cachedGroups) ? cachedGroups : []);
    const nextMessages = sanitizeCachedMessages(cachedMessages);

    const nextLatest: LatestMap = {};
    if (cachedLatest && typeof cachedLatest === 'object') {
      Object.entries(cachedLatest).forEach(([rawUid, rawItem]) => {
        const uid = Number(rawUid);
        if (!Number.isInteger(uid) || uid <= 0) return;
        const text = String((rawItem as any)?.text || '');
        const time = String((rawItem as any)?.time || '');
        const ts = Number((rawItem as any)?.ts);
        if (!Number.isFinite(ts)) return;
        nextLatest[uid] = { text, time, ts };
      });
    }

    const nextUnread: Record<number, number> = {};
    if (cachedUnread && typeof cachedUnread === 'object') {
      Object.entries(cachedUnread).forEach(([rawUid, rawValue]) => {
        const uid = Number(rawUid);
        if (!Number.isInteger(uid) || uid <= 0) return;
        const count = Number(rawValue);
        nextUnread[uid] = Number.isFinite(count) ? Math.max(0, count) : 0;
      });
    }

    const nextIdSets = new Map<number, Set<number | string>>();
    Object.entries(nextMessages).forEach(([rawUid, list]) => {
      const uid = Number(rawUid);
      if (!Number.isInteger(uid) || uid <= 0) return;
      const set = new Set<number | string>();
      list.forEach((item) => {
        if (typeof item.id === 'number' || typeof item.id === 'string') {
          set.add(item.id);
        }
      });
      nextIdSets.set(uid, set);
    });

    messageIdSetsRef.current = nextIdSets;
    setFriends(nextFriends);
    setGroups(nextGroups);
    setMessagesByUid(nextMessages);
    setLatestMap(nextLatest);
    setUnreadMap(nextUnread);
    setPendingRequestCount(Number.isFinite(Number(cachedPending)) ? Math.max(0, Number(cachedPending)) : 0);
    setGroupRemarksMap(sanitizeGroupRemarksMap(cachedGroupRemarks));
    homeCacheHydratedRef.current = true;

    return (
      nextFriends.length > 0 ||
      nextGroups.length > 0 ||
      Object.keys(nextMessages).length > 0 ||
      Object.keys(nextLatest).length > 0 ||
      Object.keys(nextUnread).length > 0 ||
      Math.max(0, Number(cachedPending) || 0) > 0
    );
  }, []);

  const normalizeMessage = useCallback((entry: any): Message => {
    const createdAt = entry?.createdAt || '';
    const createdAtMs = Number(entry?.createdAtMs);
    const parsedMs = Number.isFinite(createdAtMs)
      ? createdAtMs
      : Number.isFinite(Date.parse(createdAt))
        ? Date.parse(createdAt)
        : Date.now();
    return {
      id: entry.id,
      senderUid: entry.senderUid,
      targetUid: entry.targetUid,
      targetType: entry.targetType,
      content: entry?.data?.content || entry?.data?.text || '',
      createdAt,
      createdAtMs: parsedMs,
      raw: entry,
    };
  }, []);

  const formatMessage = useCallback((msg: any) => {
    if (!msg) return '';
    if (msg.type === 'text') return msg.data?.content || msg.data?.text || '';
    if (msg.type === 'image') return '[图片]';
    if (msg.type === 'file') return '[文件]';
    if (msg.type === 'voice') return '[语音]';
    return '[消息]';
  }, []);

  const formatTime = useCallback((value?: string, fallbackMs?: number) => {
    if (!value && !Number.isFinite(fallbackMs)) return '';
    const date = value ? new Date(value) : new Date(fallbackMs || 0);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }, []);

  const ensureMessageBucket = useCallback((uid: number) => {
    if (!uid) return;
    setMessagesByUid((prev) => (prev[uid] ? prev : { ...prev, [uid]: [] }));
    if (!messageIdSetsRef.current.has(uid)) {
      messageIdSetsRef.current.set(uid, new Set());
    }
    setUnreadMap((prev) => (typeof prev[uid] === 'number' ? prev : { ...prev, [uid]: 0 }));
    setHistoryLoading((prev) =>
      typeof prev[uid] === 'boolean' ? prev : { ...prev, [uid]: false }
    );
    setHistoryHasMore((prev) =>
      typeof prev[uid] === 'boolean' ? prev : { ...prev, [uid]: true }
    );
  }, []);

  const persistReadAtMap = useCallback(async (nextMap: ReadAtMap) => {
    await storage.setJson(STORAGE_KEYS.readAt, nextMap);
  }, []);

  const persistPinnedMap = useCallback(async (nextMap: PinnedMap) => {
    await storage.setJson(STORAGE_KEYS.pinned, nextMap);
  }, []);

  const persistHiddenMap = useCallback(async (nextMap: HiddenMap) => {
    await storage.setJson(STORAGE_KEYS.hiddenChats, nextMap);
  }, []);

  const getReadAt = useCallback((uid: number) => {
    const value = Number(readAtMapRef.current[uid]);
    return Number.isFinite(value) ? value : 0;
  }, []);

  const setReadAt = useCallback(
    (uid: number, ts: number) => {
      if (!uid) return;
      setReadAtMap((prev) => {
        const next = { ...prev, [uid]: ts };
        persistReadAtMap(next).catch(() => undefined);
        return next;
      });
    },
    [persistReadAtMap]
  );

  const recalcUnread = useCallback(
    (uid: number, list?: Message[]) => {
      if (mutedMapRef.current[uid]) {
        setUnreadMap((prev) => ({ ...prev, [uid]: 0 }));
        return;
      }
      const bucket = list || messagesByUidRef.current[uid] || [];
      const readAt = getReadAt(uid);
      const count = bucket.filter(
        (item) => item.senderUid !== selfUid && item.createdAtMs > readAt
      ).length;
      setUnreadMap((prev) => ({ ...prev, [uid]: count }));
    },
    [getReadAt, selfUid]
  );

  useEffect(() => {
    Object.keys(messagesByUidRef.current).forEach((rawUid) => {
      const uid = Number(rawUid);
      if (!Number.isInteger(uid) || uid <= 0) return;
      recalcUnread(uid, messagesByUidRef.current[uid] || []);
    });
  }, [mutedMap, recalcUnread]);

  const updateLatest = useCallback(
    (uid: number, entry: any) => {
      if (!uid || !entry) return;
      const messageText = entry?.content || formatMessage(entry?.raw || entry);
      setLatestMap((prev) => ({
        ...prev,
        [uid]: {
          text: messageText || '暂无消息',
          time: formatTime(entry?.createdAt || entry?.raw?.createdAt, entry?.createdAtMs),
          ts: Number.isFinite(entry?.createdAtMs)
            ? entry.createdAtMs
            : Number.isFinite(Date.parse(entry?.createdAt))
              ? Date.parse(entry?.createdAt)
              : Date.now(),
        },
      }));
    },
    [formatMessage, formatTime]
  );

  const unhideChat = useCallback(
    (uid: number) => {
      if (!hiddenMap[uid]) return;
      setHiddenMap((prev) => {
        const next = { ...prev };
        delete next[uid];
        persistHiddenMap(next).catch(() => undefined);
        return next;
      });
    },
    [hiddenMap, persistHiddenMap]
  );

  const insertMessages = useCallback(
    (uid: number, list: any[], { prepend }: { prepend?: boolean } = {}) => {
      if (!uid) return;
      ensureMessageBucket(uid);
      unhideChat(uid);
      const bucket = messagesByUidRef.current[uid] || [];
      let idSet = messageIdSetsRef.current.get(uid);
      if (!idSet) {
        idSet = new Set();
        messageIdSetsRef.current.set(uid, idSet);
      }
      const incoming = list
        .map(normalizeMessage)
        .filter((entry) => entry.id && !idSet?.has(entry.id))
        .sort((a, b) => a.createdAtMs - b.createdAtMs);
      if (!incoming.length) return;
      incoming.forEach((entry) => idSet?.add(entry.id));
      const nextBucket = prepend ? [...incoming, ...bucket] : [...bucket, ...incoming];
      setMessagesByUid((prev) => ({ ...prev, [uid]: nextBucket }));

      const last = nextBucket[nextBucket.length - 1];
      if (last) {
        updateLatest(uid, last);
      }
      recalcUnread(uid, nextBucket);
    },
    [ensureMessageBucket, normalizeMessage, recalcUnread, unhideChat, updateLatest]
  );

  const loadPendingRequestCount = useCallback(async () => {
    if (!tokenRef.current) {
      setPendingRequestCount(0);
      return;
    }
    try {
      const response = await fetch(`${API_BASE}/api/friends/requests`, {
        headers: { ...authHeaders() },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) return;
      const incoming = Array.isArray(data?.incoming) ? data.incoming : [];
      const pending = incoming.filter((entry: any) => String(entry?.status || 'pending') === 'pending');
      setPendingRequestCount(Math.max(0, pending.length));
    } catch {}
  }, [authHeaders]);

  const loadGroups = useCallback(async () => {
    if (!tokenRef.current) return;
    try {
      const response = await fetch(`${API_BASE}/api/groups/list`, {
        headers: { ...authHeaders() },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success || !Array.isArray(data?.groups)) {
        return;
      }
      const nextGroups = sanitizeGroups(data.groups);
      setGroups(nextGroups);
      nextGroups.forEach((group) => {
        ensureMessageBucket(group.id);
      });
    } catch {}
  }, [authHeaders, ensureMessageBucket]);

  const loadOverview = useCallback(async () => {
    if (!tokenRef.current) return;
    try {
      const response = await fetch(`${API_BASE}/api/chat/overview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ readAt: readAtMapRef.current }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success || !Array.isArray(data?.data)) {
        return;
      }
      const latestPatch: LatestMap = {};
      const unreadPatch: Record<number, number> = {};
      data.data.forEach((entry: any) => {
        const uid = Number(entry?.uid);
        if (!Number.isInteger(uid)) return;
        ensureMessageBucket(uid);
        const nextUnread = Number.isFinite(Number(entry?.unread))
          ? Math.min(Math.max(Number(entry.unread), 0), 99)
          : 0;
        unreadPatch[uid] = mutedMapRef.current[uid] ? 0 : nextUnread;
        if (entry?.latest) {
          const normalized = normalizeMessage(entry.latest);
          latestPatch[uid] = {
            text: normalized.content || formatMessage(normalized.raw || normalized) || '暂无消息',
            time: formatTime(normalized.createdAt, normalized.createdAtMs),
            ts: normalized.createdAtMs,
          };
        }
      });
      setUnreadMap((prev) => ({ ...prev, ...unreadPatch }));
      if (Object.keys(latestPatch).length > 0) {
        setLatestMap((prev) => ({ ...prev, ...latestPatch }));
      }
    } catch {}
  }, [authHeaders, ensureMessageBucket, formatMessage, formatTime, normalizeMessage]);

  const loadFriends = useCallback(async ({ silent = true }: { silent?: boolean } = {}) => {
    if (!tokenRef.current) return;
    if (!silent) {
      setLoadingFriends(true);
    }
    try {
      const response = await fetch(`${API_BASE}/api/friends/list`, {
        headers: { ...authHeaders() },
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.success && Array.isArray(data?.friends)) {
        const nextFriends = sanitizeFriends(data.friends);
        setFriends(nextFriends);
        nextFriends.forEach((friend) => {
          ensureMessageBucket(friend.uid);
        });
        await Promise.all([loadOverview(), loadPendingRequestCount(), loadGroups()]);
      }
    } catch {}
    if (!silent) {
      setLoadingFriends(false);
    }
  }, [authHeaders, ensureMessageBucket, loadGroups, loadOverview, loadPendingRequestCount]);

  const loadHistory = useCallback(
    async (uid: number, { beforeId }: { beforeId?: number | string } = {}) => {
      if (!tokenRef.current) return;
      ensureMessageBucket(uid);
      if (historyLoading[uid]) return;
      setHistoryLoading((prev) => ({ ...prev, [uid]: true }));
      try {
        const targetType = groupsRef.current.some((item) => item.id === uid) ? 'group' : 'private';
        const params = new URLSearchParams({
          targetType,
          targetUid: String(uid),
          type: 'text',
          limit: String(PAGE_LIMIT),
        });
        if (beforeId) {
          params.set('beforeId', String(beforeId));
        }
        const response = await fetch(`${API_BASE}/api/chat/get?${params.toString()}`, {
          headers: { ...authHeaders() },
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok && data?.success && Array.isArray(data?.data)) {
          insertMessages(uid, data.data, { prepend: Boolean(beforeId) });
          if (data.data.length < PAGE_LIMIT) {
            setHistoryHasMore((prev) => ({ ...prev, [uid]: false }));
          }
        }
      } catch {}
      setHistoryLoading((prev) => ({ ...prev, [uid]: false }));
    },
    [authHeaders, ensureMessageBucket, historyLoading, insertMessages]
  );


  const markChatRead = useCallback(
    (uid: number) => {
      if (!uid) return;
      const list = messagesByUidRef.current[uid] || [];
      const last = list[list.length - 1];
      const lastTime = last ? last.createdAtMs : Date.now();
      setReadAt(uid, lastTime);
      setUnreadMap((prev) => ({ ...prev, [uid]: 0 }));
    },
    [setReadAt]
  );

  const scrollToBottom = useCallback(() => {
    if (!messageListRef.current) return;
    messageListRef.current.scrollToEnd({ animated: false });
  }, []);

  const focusChatInput = useCallback(() => {
    setTimeout(() => {
      chatInputRef.current?.focus();
    }, 0);
  }, []);

  const sleep = useCallback((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)), []);

  const flashMessageFocus = useCallback((messageId: string) => {
    if (!messageId) return;
    setFocusedMessageId(messageId);
    if (messageFocusTimerRef.current) {
      clearTimeout(messageFocusTimerRef.current);
    }
    messageFocusTimerRef.current = setTimeout(() => {
      setFocusedMessageId(null);
      messageFocusTimerRef.current = null;
    }, 1800);
  }, []);

  const recordMessageOffset = useCallback((uid: number, messageId: string, y: number) => {
    if (!uid || !messageId || !Number.isFinite(y)) return;
    const key = String(messageId);
    const bucketMap = messageOffsetMapRef.current.get(uid) || new Map<string, number>();
    bucketMap.set(key, y);
    messageOffsetMapRef.current.set(uid, bucketMap);
  }, []);

  const scrollToMessageById = useCallback((uid: number, messageId: string, animated = true) => {
    if (!uid || !messageId || !messageListRef.current) return false;
    const key = String(messageId);
    const bucketMap = messageOffsetMapRef.current.get(uid);
    const measuredY = bucketMap?.get(key);
    if (typeof measuredY === 'number' && Number.isFinite(measuredY)) {
      messageListRef.current.scrollTo({ y: Math.max(0, measuredY - 12), animated });
      return true;
    }
    const bucket = messagesByUidRef.current[uid] || [];
    const fallbackIndex = bucket.findIndex((item) => String(item.id) === key);
    if (fallbackIndex === -1) return false;
    const estimatedY = Math.max(0, fallbackIndex * 66);
    messageListRef.current.scrollTo({ y: estimatedY, animated });
    return true;
  }, []);

  const locateChatMessage = useCallback(
    async (uid: number, messageId: string) => {
      if (!uid || !messageId) return;
      const normalizedId = String(messageId);
      let guard = 0;
      while (guard < 60) {
        guard += 1;
        const bucket = messagesByUidRef.current[uid] || [];
        const found = bucket.some((item) => String(item.id) === normalizedId);
        if (found) {
          for (let i = 0; i < 8; i += 1) {
            const done = scrollToMessageById(uid, normalizedId, true);
            if (done) {
              flashMessageFocus(normalizedId);
              return;
            }
            await sleep(50);
          }
          flashMessageFocus(normalizedId);
          return;
        }

        if (historyLoadingRef.current[uid]) {
          await sleep(120);
          continue;
        }

        const first = bucket[0];
        if (!first) {
          await loadHistory(uid);
          await sleep(60);
          continue;
        }

        if (!historyHasMoreRef.current[uid]) {
          break;
        }

        await loadHistory(uid, { beforeId: first.id });
        await sleep(60);
      }
    },
    [flashMessageFocus, loadHistory, scrollToMessageById, sleep]
  );

  const openChat = useCallback(
    async (friend: Friend) => {
      if (!friend) return;
      closeQuickMenu();
      setActiveChatUid(friend.uid);
      ensureMessageBucket(friend.uid);
      if ((messagesByUidRef.current[friend.uid] || []).length === 0) {
        await loadHistory(friend.uid);
      }
      setTimeout(scrollToBottom, 0);
      focusChatInput();
      markChatRead(friend.uid);
    },
    [closeQuickMenu, ensureMessageBucket, focusChatInput, loadHistory, markChatRead, scrollToBottom]
  );

  const openChatFromPayload = useCallback(
    (targetUid: number, paramFriend?: Partial<Friend>, options?: { targetType?: 'private' | 'group'; group?: Partial<Group> }) => {
      if (!Number.isFinite(targetUid) || targetUid <= 0) return;
      if (options?.targetType === 'group') {
        const payloadGroup =
          options?.group && Number.isInteger(Number(options.group.id || targetUid))
            ? normalizeGroup({ ...options.group, id: targetUid })
            : null;
        if (payloadGroup) {
          setGroups((prev) =>
            prev.some((item) => item.id === payloadGroup.id)
              ? prev.map((item) => (item.id === payloadGroup.id ? { ...item, ...payloadGroup } : item))
              : [payloadGroup, ...prev]
          );
          ensureMessageBucket(payloadGroup.id);
        }
        setActiveChatUid(targetUid);
        ensureMessageBucket(targetUid);
        if ((messagesByUidRef.current[targetUid] || []).length === 0) {
          loadHistory(targetUid).catch(() => undefined);
        }
        setTimeout(scrollToBottom, 0);
        focusChatInput();
        markChatRead(targetUid);
        return;
      }
      const existing = friends.find((item) => item.uid === targetUid);
      const payloadFriend =
        paramFriend && paramFriend.uid
          ? {
              uid: Number(paramFriend.uid),
              username: paramFriend.username,
              nickname: paramFriend.nickname,
              avatar: paramFriend.avatar,
              online: paramFriend.online,
            }
          : null;

      if (!existing && payloadFriend?.uid) {
        setFriends((prev) =>
          prev.some((item) => item.uid === payloadFriend.uid) ? prev : [payloadFriend, ...prev]
        );
      }

      if (existing) {
        openChat(existing);
      } else if (payloadFriend?.uid) {
        openChat(payloadFriend);
      } else {
        setActiveChatUid(targetUid);
      }
    },
    [ensureMessageBucket, focusChatInput, friends, loadHistory, markChatRead, openChat, scrollToBottom]
  );

  const openContactProfile = useCallback(
    (friend: Friend) => {
      if (!friend) return;
      navigation.navigate('FriendProfile', { uid: friend.uid, friend });
    },
    [navigation]
  );

  const closeChat = useCallback(() => {
    if (activeChatUidRef.current) {
      markChatRead(activeChatUidRef.current);
    }
    setActiveChatUid(null);
  }, [markChatRead]);

  const openFoundFriends = useCallback(
    (initialTab: 'search' | 'requests' = 'search') => {
      closeQuickMenu();
      setFoundFriendsInitialTab(initialTab);
      setActiveView('found');
    },
    [closeQuickMenu]
  );

  const closeFoundFriends = useCallback(() => {
    setFoundFriendsInitialTab('search');
    setActiveView('list');
  }, []);

  const resetSceneAnim = useCallback((sceneAnim: Animated.Value) => {
    Animated.timing(sceneAnim, {
      toValue: 0,
      duration: SCENE_EDGE_SNAP_MS,
      easing: SCENE_EASING,
      useNativeDriver: true,
    }).start();
  }, []);

  const exitScene = useCallback(
    (sceneAnim: Animated.Value, onDone: () => void) => {
      Animated.timing(sceneAnim, {
        toValue: Dimensions.get('window').width,
        duration: SCENE_EDGE_EXIT_MS,
        easing: SCENE_EASING,
        useNativeDriver: true,
      }).start(() => {
        onDone();
      });
    },
    []
  );

  const chatEdgePanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: (event) =>
          Boolean(activeChatUidRef.current) && Number(event?.nativeEvent?.pageX || 0) <= EDGE_BACK_HIT_WIDTH,
        onMoveShouldSetPanResponder: (event, gestureState) => {
          if (!activeChatUidRef.current) return false;
          const startX = Number(event?.nativeEvent?.pageX || 0);
          const horizontal = Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 1.2;
          return startX <= EDGE_BACK_HIT_WIDTH && horizontal && gestureState.dx > 6;
        },
        onPanResponderMove: (_, gestureState) => {
          chatSceneAnim.setValue(Math.max(0, gestureState.dx));
        },
        onPanResponderRelease: (_, gestureState) => {
          const shouldBack =
            gestureState.dx > EDGE_BACK_DISTANCE || gestureState.vx > EDGE_BACK_VELOCITY;
          if (!shouldBack) {
            resetSceneAnim(chatSceneAnim);
            return;
          }
          exitScene(chatSceneAnim, closeChat);
        },
        onPanResponderTerminate: () => {
          resetSceneAnim(chatSceneAnim);
        },
      }),
    [chatSceneAnim, closeChat, exitScene, resetSceneAnim]
  );

  const foundEdgePanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: (event) =>
          activeView === 'found' && Number(event?.nativeEvent?.pageX || 0) <= EDGE_BACK_HIT_WIDTH,
        onMoveShouldSetPanResponder: (event, gestureState) => {
          if (activeView !== 'found') return false;
          const startX = Number(event?.nativeEvent?.pageX || 0);
          const horizontal = Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 1.2;
          return startX <= EDGE_BACK_HIT_WIDTH && horizontal && gestureState.dx > 6;
        },
        onPanResponderMove: (_, gestureState) => {
          foundSceneAnim.setValue(Math.max(0, gestureState.dx));
        },
        onPanResponderRelease: (_, gestureState) => {
          const shouldBack =
            gestureState.dx > EDGE_BACK_DISTANCE || gestureState.vx > EDGE_BACK_VELOCITY;
          if (!shouldBack) {
            resetSceneAnim(foundSceneAnim);
            return;
          }
          exitScene(foundSceneAnim, closeFoundFriends);
        },
        onPanResponderTerminate: () => {
          resetSceneAnim(foundSceneAnim);
        },
      }),
    [activeView, closeFoundFriends, exitScene, foundSceneAnim, resetSceneAnim]
  );

  const onPressChatBack = useCallback(() => {
    if (!activeChatUidRef.current) return;
    exitScene(chatSceneAnim, closeChat);
  }, [chatSceneAnim, closeChat, exitScene]);

  const onPressFoundBack = useCallback(() => {
    if (activeView !== 'found') return;
    exitScene(foundSceneAnim, closeFoundFriends);
  }, [activeView, closeFoundFriends, exitScene, foundSceneAnim]);

  const markTourSeen = useCallback(() => {
    storage.setString(STORAGE_KEYS.homeTourSeen, '1');
    setTourSeen(true);
  }, []);

  const closeTour = useCallback(
    (markSeen = true) => {
      setTourVisible(false);
      setTourStepIndex(0);
      closeQuickMenu();
      if (markSeen) {
        markTourSeen();
      }
    },
    [closeQuickMenu, markTourSeen]
  );

  const nextTourStep = useCallback(() => {
    if (tourStepIndex >= tourSteps.length - 1) {
      closeTour(true);
      return;
    }
    setTourStepIndex((prev) => prev + 1);
  }, [closeTour, tourStepIndex, tourSteps.length]);

  const toggleQuickMenu = useCallback(() => {
    if (tourVisible || activeChatUid || activeView === 'found') return;
    if (quickMenuVisible) {
      closeQuickMenu();
      return;
    }
    openQuickMenu();
  }, [activeChatUid, activeView, closeQuickMenu, openQuickMenu, quickMenuVisible, tourVisible]);

  const onQuickCreateGroup = useCallback(() => {
    closeQuickMenu();
    navigation.navigate('CreateGroup');
  }, [closeQuickMenu, navigation]);

  const onQuickAdd = useCallback(() => {
    openFoundFriends('search');
  }, [openFoundFriends]);

  const onOpenNewFriends = useCallback(() => {
    openFoundFriends('requests');
  }, [openFoundFriends]);

  const onQuickScan = useCallback(() => {
    closeQuickMenu();
    navigation.navigate('QRScan');
  }, [closeQuickMenu, navigation]);

  useEffect(() => {
    const params = route.params || {};
    const targetUid = Number(params.openChatUid);
    if (!Number.isFinite(targetUid) || targetUid <= 0) return;
    const focusMessageId = String(params.openChatFocusMessageId || '').trim();
    openChatFromPayload(targetUid, params.openChatFriend, {
      targetType: params.openChatTargetType,
      group: params.openChatGroup,
    });
    if (focusMessageId) {
      setTimeout(() => {
        locateChatMessage(targetUid, focusMessageId).catch(() => undefined);
      }, 120);
    }
    navigation.setParams({
      openChatUid: undefined,
      openChatTargetType: undefined,
      openChatFriend: undefined,
      openChatGroup: undefined,
      openChatFocusMessageId: undefined,
    });
  }, [route.params, navigation, locateChatMessage, openChatFromPayload]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      const loadPending = async () => {
        const pending = await storage.getJson<{
          uid?: number;
          targetType?: 'private' | 'group';
          friend?: Partial<Friend>;
          group?: Partial<Group>;
          focusMessageId?: string | number;
        }>(STORAGE_KEYS.pendingOpenChat);
        if (cancelled || !pending?.uid) return;
        await storage.remove(STORAGE_KEYS.pendingOpenChat);
        const targetUid = Number(pending.uid);
        openChatFromPayload(targetUid, pending.friend, {
          targetType: pending.targetType,
          group: pending.group,
        });
        const focusMessageId = String(pending.focusMessageId || '').trim();
        if (focusMessageId) {
          setTimeout(() => {
            locateChatMessage(targetUid, focusMessageId).catch(() => undefined);
          }, 120);
        }
      };
      loadPending().catch(() => undefined);
      return () => {
        cancelled = true;
      };
    }, [locateChatMessage, openChatFromPayload])
  );

  useFocusEffect(
    useCallback(() => {
      if (!tokenReady || !tokenRef.current) return undefined;
      loadPendingRequestCount().catch(() => undefined);
      return undefined;
    }, [loadPendingRequestCount, tokenReady])
  );

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      const syncFromSettings = async () => {
        const [storedPinned, storedMuted, storedBackground, storedGroupRemarks, pendingAction] =
          await Promise.all([
            storage.getJson<PinnedMap>(STORAGE_KEYS.pinned),
            storage.getJson<MutedMap>(STORAGE_KEYS.chatMuted),
            storage.getJson<ChatBackgroundMap>(STORAGE_KEYS.chatBackground),
            storage.getJson<Record<number, string>>(STORAGE_KEYS.groupRemarks),
            storage.getJson<{
              type?: string;
              uid?: number;
              group?: Partial<Group>;
            }>(STORAGE_KEYS.pendingChatSettingsAction),
          ]);
        if (cancelled) return;

        setPinnedMap(sanitizeBooleanMap(storedPinned));
        setMutedMap(sanitizeBooleanMap(storedMuted));
        setChatBackgroundMap(sanitizeChatBackgroundMap(storedBackground));
        setGroupRemarksMap(sanitizeGroupRemarksMap(storedGroupRemarks));

        const actionUid = Number(pendingAction?.uid);
        if (pendingAction?.type === 'group_update' && Number.isInteger(actionUid) && actionUid > 0) {
          await storage.remove(STORAGE_KEYS.pendingChatSettingsAction);
          const payload = pendingAction.group || {};
          setGroups((prev) => {
            const existing = prev.find((item) => item.id === actionUid);
            const merged = normalizeGroup({
              ...(existing || {
                id: actionUid,
                memberUids: [],
                members: [],
              }),
              ...payload,
              id: actionUid,
            });
            if (!merged) return prev;
            if (existing) {
              return prev.map((item) => (item.id === actionUid ? { ...item, ...merged } : item));
            }
            return [merged, ...prev];
          });
          return;
        }

        if (pendingAction?.type === 'delete_chat' && Number.isInteger(actionUid) && actionUid > 0) {
          await storage.remove(STORAGE_KEYS.pendingChatSettingsAction);
          messageIdSetsRef.current.delete(actionUid);
          setMessagesByUid((prev) => {
            const next = { ...prev };
            delete next[actionUid];
            return next;
          });
          setLatestMap((prev) => {
            const next = { ...prev };
            delete next[actionUid];
            return next;
          });
          setUnreadMap((prev) => ({ ...prev, [actionUid]: 0 }));
          setHiddenMap((prev) => {
            const next = { ...prev, [actionUid]: true };
            persistHiddenMap(next).catch(() => undefined);
            return next;
          });
          if (activeChatUidRef.current === actionUid) {
            setActiveChatUid(null);
          }
          return;
        }

        if (pendingAction?.type === 'group_delete_chat' && Number.isInteger(actionUid) && actionUid > 0) {
          await storage.remove(STORAGE_KEYS.pendingChatSettingsAction);
          messageIdSetsRef.current.delete(actionUid);
          setMessagesByUid((prev) => {
            const next = { ...prev };
            delete next[actionUid];
            return next;
          });
          setLatestMap((prev) => {
            const next = { ...prev };
            delete next[actionUid];
            return next;
          });
          setUnreadMap((prev) => ({ ...prev, [actionUid]: 0 }));
          return;
        }

        if (pendingAction?.type === 'group_leave' && Number.isInteger(actionUid) && actionUid > 0) {
          await storage.remove(STORAGE_KEYS.pendingChatSettingsAction);
          messageIdSetsRef.current.delete(actionUid);
          setGroups((prev) => prev.filter((group) => group.id !== actionUid));
          setMessagesByUid((prev) => {
            const next = { ...prev };
            delete next[actionUid];
            return next;
          });
          setLatestMap((prev) => {
            const next = { ...prev };
            delete next[actionUid];
            return next;
          });
          setUnreadMap((prev) => {
            const next = { ...prev };
            delete next[actionUid];
            return next;
          });
          setPinnedMap((prev) => {
            if (!prev[actionUid]) return prev;
            const next = { ...prev };
            delete next[actionUid];
            storage.setJson(STORAGE_KEYS.pinned, next).catch(() => undefined);
            return next;
          });
          setMutedMap((prev) => {
            if (!prev[actionUid]) return prev;
            const next = { ...prev };
            delete next[actionUid];
            storage.setJson(STORAGE_KEYS.chatMuted, next).catch(() => undefined);
            return next;
          });
          setChatBackgroundMap((prev) => {
            if (!prev[actionUid]) return prev;
            const next = { ...prev };
            delete next[actionUid];
            storage.setJson(STORAGE_KEYS.chatBackground, next).catch(() => undefined);
            return next;
          });
          setGroupRemarksMap((prev) => {
            if (!prev[actionUid]) return prev;
            const next = { ...prev };
            delete next[actionUid];
            storage.setJson(STORAGE_KEYS.groupRemarks, next).catch(() => undefined);
            return next;
          });
          if (activeChatUidRef.current === actionUid) {
            setActiveChatUid(null);
          }
        }
      };
      syncFromSettings().catch(() => undefined);
      return () => {
        cancelled = true;
      };
    }, [persistHiddenMap])
  );

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (searchVisible) {
        searchInputRef.current?.blur();
        Animated.timing(searchAnim, {
          toValue: 0,
          duration: 140,
          easing: SCENE_EASING,
          useNativeDriver: true,
        }).start(() => {
          setSearchVisible(false);
          setSearchQuery('');
        });
        return true;
      }
      if (tourVisible) {
        closeTour(true);
        return true;
      }
      if (!quickMenuVisible) return false;
      closeQuickMenu();
      return true;
    });
    return () => sub.remove();
  }, [closeQuickMenu, closeTour, quickMenuVisible, searchAnim, searchVisible, tourVisible]);

  const onChatScroll = useCallback(
    async (event: any) => {
      const uid = activeChatUidRef.current;
      if (!uid) return;
      const offsetY = event?.nativeEvent?.contentOffset?.y ?? 0;
      if (offsetY > 40) return;
      if (!historyHasMore[uid] || historyLoading[uid]) return;
      const first = (messagesByUidRef.current[uid] || [])[0];
      if (!first) return;
      const prevHeight = contentHeightRef.current;
      await loadHistory(uid, { beforeId: first.id });
      setTimeout(() => {
        const nextHeight = contentHeightRef.current;
        if (messageListRef.current) {
          messageListRef.current.scrollTo({ y: nextHeight - prevHeight, animated: false });
        }
      }, 0);
    },
    [historyHasMore, historyLoading, loadHistory]
  );

  const sendText = useCallback(async () => {
    if (!canSend || !activeChatUidRef.current || !selfUid) return;
    const content = draftMessage.trim().slice(0, CHAT_INPUT_MAX_LENGTH);
    if (!content) return;
    const targetType = groupsRef.current.some((group) => group.id === activeChatUidRef.current)
      ? 'group'
      : 'private';
    focusChatInput();
    const payload = {
      senderUid: selfUid,
      targetUid: activeChatUidRef.current,
      targetType,
      type: 'text',
      content,
    };
    try {
      const response = await fetch(`${API_BASE}/api/chat/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.success && data?.data) {
        insertMessages(activeChatUidRef.current, [data.data]);
        setDraftMessage('');
        setTimeout(scrollToBottom, 0);
        focusChatInput();
      }
    } catch {}
  }, [authHeaders, canSend, draftMessage, focusChatInput, insertMessages, scrollToBottom, selfUid]);

  const buildWsUrl = useCallback(() => {
    try {
      const base = new URL(API_BASE);
      const protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${base.host}/ws?token=${encodeURIComponent(tokenRef.current)}`;
    } catch {
      return '';
    }
  }, []);

  const startHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) return;
    heartbeatTimerRef.current = setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'heartbeat' }));
      }
    }, HEARTBEAT_MS);
  }, []);

  const stopHeartbeat = useCallback(() => {
    if (!heartbeatTimerRef.current) return;
    clearInterval(heartbeatTimerRef.current);
    heartbeatTimerRef.current = null;
  }, []);

  const updatePresence = useCallback((uid: number, online: boolean) => {
    setFriends((prev) => {
      const idx = prev.findIndex((item) => Number(item?.uid) === uid);
      if (idx === -1) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], online: Boolean(online) };
      return next;
    });
  }, []);

  const requestFriendsRefresh = useCallback(() => {
    setFriendsRefreshKey((prev) => prev + 1);
    Promise.all([loadFriends(), loadGroups()]).catch(() => undefined);
  }, [loadFriends, loadGroups]);

  const handleWsMessage = useCallback(
    (payload: any) => {
      if (!payload || typeof payload !== 'object') return;
      if (payload.type === 'chat') {
        const entry = payload.data;
        if (!entry?.id) return;
        const message = normalizeMessage(entry);
        const targetUid =
          message.targetType === 'group'
            ? message.targetUid
            : message.senderUid === selfUid
              ? message.targetUid
              : message.senderUid;
        insertMessages(targetUid, [entry]);
        if (
          message.targetType === 'group' &&
          !groupsRef.current.some((group) => Number(group.id) === targetUid)
        ) {
          loadGroups().catch(() => undefined);
        }

        if (activeChatUidRef.current === targetUid) {
          markChatRead(targetUid);
          setTimeout(scrollToBottom, 0);
        }
        return;
      }
      if (payload.type === 'friends') {
        requestFriendsRefresh();
        return;
      }
      if (payload.type === 'requests') {
        setFriendsRefreshKey((prev) => prev + 1);
        loadPendingRequestCount().catch(() => undefined);
        return;
      }
      if (payload.type === 'presence') {
        const uid = Number(payload?.data?.uid);
        if (Number.isInteger(uid)) {
          updatePresence(uid, payload?.data?.online);
        }
        return;
      }
      if (payload.type === 'presence_snapshot') {
        const list = Array.isArray(payload?.data) ? payload.data : [];
        list.forEach((entry: any) => {
          const uid = Number(entry?.uid);
          if (Number.isInteger(uid)) {
            updatePresence(uid, entry?.online);
          }
        });
      }
    },
    [
      insertMessages,
      loadGroups,
      markChatRead,
      normalizeMessage,
      loadPendingRequestCount,
      requestFriendsRefresh,
      scrollToBottom,
      selfUid,
      updatePresence,
    ]
  );

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * (1 + reconnectAttemptsRef.current),
      RECONNECT_MAX_MS
    );
    reconnectAttemptsRef.current += 1;
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connectWsRef.current();
    }, delay);
  }, []);

  const connectWs = useCallback(() => {
    if (!tokenRef.current) return;
    if (
      wsRef.current &&
      (wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    const wsUrl = buildWsUrl();
    if (!wsUrl) return;
    try {
      wsRef.current = new WebSocket(wsUrl);
    } catch {
      scheduleReconnect();
      return;
    }

    wsRef.current.onopen = () => {
      reconnectAttemptsRef.current = 0;
      startHeartbeat();
    };
    wsRef.current.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        handleWsMessage(payload);
      } catch {}
    };
    wsRef.current.onclose = () => {
      stopHeartbeat();
      scheduleReconnect();
    };
    wsRef.current.onerror = () => {
      stopHeartbeat();
      scheduleReconnect();
    };
  }, [buildWsUrl, handleWsMessage, scheduleReconnect, startHeartbeat, stopHeartbeat]);

  useEffect(() => {
    connectWsRef.current = connectWs;
  }, [connectWs]);

  useEffect(() => {
    if (!homeCacheHydratedRef.current) return;
    if (cacheWriteTimerRef.current) {
      clearTimeout(cacheWriteTimerRef.current);
      cacheWriteTimerRef.current = null;
    }
    cacheWriteTimerRef.current = setTimeout(() => {
      cacheWriteTimerRef.current = null;
      storage.setJson(STORAGE_KEYS.homeFriendsCache, friends).catch(() => undefined);
      storage.setJson(STORAGE_KEYS.homeGroupsCache, groups).catch(() => undefined);
      storage.setJson(STORAGE_KEYS.homeMessagesCache, messagesByUid).catch(() => undefined);
      storage.setJson(STORAGE_KEYS.homeLatestCache, latestMap).catch(() => undefined);
      storage.setJson(STORAGE_KEYS.homeUnreadCache, unreadMap).catch(() => undefined);
      storage.setJson(STORAGE_KEYS.homePendingRequestsCache, pendingRequestCount).catch(() => undefined);
    }, 220);
  }, [friends, groups, latestMap, messagesByUid, pendingRequestCount, unreadMap]);

  const teardownWs = useCallback(() => {
    stopHeartbeat();
    if (homeRefreshTimerRef.current) {
      clearTimeout(homeRefreshTimerRef.current);
      homeRefreshTimerRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }
  }, [stopHeartbeat]);

  useEffect(() => {
    if (!tokenReady || !tokenRef.current) return;
    let cancelled = false;
    const bootstrapHome = async () => {
      setLoadingFriends(true);
      const hasCache = await hydrateHomeCache().catch(() => {
        homeCacheHydratedRef.current = true;
        return false;
      });
      if (cancelled) return;
      setLoadingFriends(!hasCache);
      connectWs();
      homeRefreshTimerRef.current = setTimeout(() => {
        if (cancelled) return;
        Promise.all([loadFriends({ silent: hasCache }), loadGroups()]).catch(() => undefined);
      }, HOME_REFRESH_DELAY_MS);
    };
    bootstrapHome().catch(() => undefined);
    return () => {
      cancelled = true;
      if (cacheWriteTimerRef.current) {
        clearTimeout(cacheWriteTimerRef.current);
        cacheWriteTimerRef.current = null;
      }
      teardownWs();
    };
  }, [connectWs, hydrateHomeCache, loadFriends, loadGroups, teardownWs, tokenReady]);

  const messageItems = useMemo<MessageListItem[]>(() => {
    const privateItems: MessageListItem[] = friends
      .filter((friend) => Number.isInteger(Number(friend?.uid)) && !hiddenMap[Number(friend.uid)])
      .map((friend) => {
        const uid = Number(friend.uid);
        const latest = latestMap[uid];
        return {
          uid,
          targetType: 'private',
          title: friend.nickname || friend.username || '联系人',
          preview: latest?.text || '暂无消息',
          latest,
          pinned: Boolean(pinnedMap[uid]),
          unread: unreadMap[uid] || 0,
          friend,
        };
      });
    const groupItems: MessageListItem[] = groups
      .filter((group) => Number.isInteger(Number(group?.id)) && !hiddenMap[Number(group.id)])
      .map((group) => {
        const uid = Number(group.id);
        const latest = latestMap[uid];
        return {
          uid,
          targetType: 'group',
          title: getGroupDisplayName(group),
          preview: latest?.text || '暂无消息',
          latest,
          pinned: Boolean(pinnedMap[uid]),
          unread: unreadMap[uid] || 0,
          group,
        };
      });
    return [...privateItems, ...groupItems].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const ta = a.latest?.ts || 0;
      const tb = b.latest?.ts || 0;
      return tb - ta;
    });
  }, [friends, groups, hiddenMap, latestMap, pinnedMap, unreadMap]);
  const totalUnreadCount = useMemo(
    () => messageItems.reduce((sum, item) => sum + Math.max(0, Number(item.unread) || 0), 0),
    [messageItems]
  );

  const normalizedSearchQuery = useMemo(
    () => searchQuery.trim().toLowerCase(),
    [searchQuery]
  );
  const hasSearchQuery = normalizedSearchQuery.length > 0;
  const searchFriends = useMemo(() => {
    if (!hasSearchQuery) return [] as Friend[];
    return friends.filter((friend) => {
      const username = String(friend.username || '').toLowerCase();
      const nickname = String(friend.nickname || '').toLowerCase();
      const uidText = String(friend.uid);
      return (
        username.includes(normalizedSearchQuery) ||
        nickname.includes(normalizedSearchQuery) ||
        uidText.includes(normalizedSearchQuery)
      );
    });
  }, [friends, hasSearchQuery, normalizedSearchQuery]);
  const searchGroups = useMemo(() => {
    if (!hasSearchQuery) return [] as Group[];
    return groups.filter((group) => {
      const rawName = String(group.name || '').toLowerCase();
      const groupDisplayName = getGroupDisplayName(group).toLowerCase();
      return rawName.includes(normalizedSearchQuery) || groupDisplayName.includes(normalizedSearchQuery);
    });
  }, [groups, hasSearchQuery, normalizedSearchQuery]);
  const searchChatHits = useMemo<SearchChatHit[]>(() => {
    if (!hasSearchQuery) return [];
    const groupMap = new Map<number, Group>();
    groups.forEach((group) => groupMap.set(group.id, group));
    const friendMap = new Map<number, Friend>();
    friends.forEach((friend) => friendMap.set(friend.uid, friend));
    const hits: SearchChatHit[] = [];
    Object.entries(messagesByUid).forEach(([rawUid, list]) => {
      const uid = Number(rawUid);
      if (!Number.isInteger(uid) || uid <= 0 || !Array.isArray(list)) return;
      const maybeGroup = groupMap.get(uid);
      const maybeFriend = friendMap.get(uid);
      const targetType: 'private' | 'group' = maybeGroup ? 'group' : 'private';
      const title =
        targetType === 'group'
          ? getGroupDisplayName(maybeGroup)
          : maybeFriend?.nickname || maybeFriend?.username || `用户${uid}`;
      list.forEach((message) => {
        const content = String(message?.content || '').trim();
        if (!content) return;
        if (!content.toLowerCase().includes(normalizedSearchQuery)) return;
        const createdAtMs = Number(message?.createdAtMs);
        hits.push({
          key: `${uid}:${String(message?.id)}`,
          messageId: String(message?.id),
          uid,
          targetType,
          title,
          content,
          createdAt: String(message?.createdAt || ''),
          createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
        });
      });
    });
    hits.sort((a, b) => b.createdAtMs - a.createdAtMs);
    if (hits.length > SEARCH_MAX_CHAT_HITS) {
      return hits.slice(0, SEARCH_MAX_CHAT_HITS);
    }
    return hits;
  }, [friends, groups, hasSearchQuery, messagesByUid, normalizedSearchQuery]);

  const searchTranslateY = useMemo(
    () =>
      searchAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [14, 0],
      }),
    [searchAnim]
  );

  const openSearchPanel = useCallback(() => {
    if (activeChatUid || activeView === 'found') return;
    if (searchVisible) return;
    closeQuickMenu();
    setSearchVisible(true);
    searchAnim.setValue(0);
    Animated.timing(searchAnim, {
      toValue: 1,
      duration: 180,
      easing: SCENE_EASING,
      useNativeDriver: true,
    }).start();
    setTimeout(() => {
      searchInputRef.current?.focus();
    }, 0);
  }, [activeChatUid, activeView, closeQuickMenu, searchAnim, searchVisible]);

  const closeSearchPanel = useCallback(
    (clearQuery = true) => {
      if (!searchVisible) {
        if (clearQuery) setSearchQuery('');
        return;
      }
      searchInputRef.current?.blur();
      Animated.timing(searchAnim, {
        toValue: 0,
        duration: 140,
        easing: SCENE_EASING,
        useNativeDriver: true,
      }).start(() => {
        setSearchVisible(false);
        if (clearQuery) setSearchQuery('');
      });
    },
    [searchAnim, searchVisible]
  );

  const onSelectSearchFriend = useCallback(
    (friend: Friend) => {
      closeSearchPanel();
      openChat(friend);
    },
    [closeSearchPanel, openChat]
  );

  const onSelectSearchGroup = useCallback(
    (group: Group) => {
      closeSearchPanel();
      openChatFromPayload(group.id, undefined, { targetType: 'group', group });
    },
    [closeSearchPanel, openChatFromPayload]
  );

  const onSelectSearchChatHit = useCallback(
    (hit: SearchChatHit) => {
      closeSearchPanel();
      const scheduleLocate = () => {
        setTimeout(() => {
          locateChatMessage(hit.uid, hit.messageId).catch(() => undefined);
        }, 80);
      };
      if (hit.targetType === 'group') {
        const group = groups.find((item) => item.id === hit.uid);
        openChatFromPayload(hit.uid, undefined, { targetType: 'group', group });
        scheduleLocate();
        return;
      }
      const friend = friends.find((item) => item.uid === hit.uid);
      if (friend) {
        openChat(friend);
        scheduleLocate();
        return;
      }
      openChatFromPayload(hit.uid);
      scheduleLocate();
    },
    [closeSearchPanel, friends, groups, locateChatMessage, openChat, openChatFromPayload]
  );

  const closeChatMenu = useCallback(() => {
    setChatMenuVisible(false);
    setChatMenuTargetUid(null);
    setChatMenuTargetType('private');
  }, []);

  const openChatMenu = useCallback((event: any, uid: number, targetType: 'private' | 'group') => {
    const { width, height } = Dimensions.get('window');
    const menuWidth = 160;
    const menuHeight = 96;
    const x = Math.min(event.nativeEvent.pageX, width - menuWidth - 10);
    const y = Math.min(event.nativeEvent.pageY, height - menuHeight - 10);
    setChatMenuPosition({ x, y });
    setChatMenuTargetUid(uid);
    setChatMenuTargetType(targetType);
    setChatMenuVisible(true);
  }, []);

  const toggleChatPin = useCallback(() => {
    if (!chatMenuTargetUid) return;
    setPinnedMap((prev) => {
      const next = { ...prev, [chatMenuTargetUid]: !prev[chatMenuTargetUid] };
      if (!next[chatMenuTargetUid]) {
        delete next[chatMenuTargetUid];
      }
      persistPinnedMap(next).catch(() => undefined);
      return next;
    });
    closeChatMenu();
  }, [chatMenuTargetUid, closeChatMenu, persistPinnedMap]);

  const deleteChat = useCallback(async () => {
    if (!chatMenuTargetUid) return;
    const uid = chatMenuTargetUid;
    closeChatMenu();

    const deleteBatch = async (beforeId?: number | string) => {
      const params = new URLSearchParams({
        targetType: chatMenuTargetType,
        targetUid: String(uid),
        limit: String(PAGE_LIMIT),
      });
      if (beforeId) {
        params.set('beforeId', String(beforeId));
      }
      const response = await fetch(`${API_BASE}/api/chat/get?${params.toString()}`, {
        headers: { ...authHeaders() },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success || !Array.isArray(data?.data)) {
        return { done: true, lastId: null as null | number | string };
      }
      const list = data.data;
      for (const item of list) {
        if (!item?.id) continue;
        await fetch(`${API_BASE}/api/chat/del`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ id: String(item.id) }),
        }).catch(() => undefined);
      }
      if (list.length < PAGE_LIMIT) {
        return { done: true, lastId: null as null | number | string };
      }
      return { done: false, lastId: list[0]?.id || null };
    };

    let beforeId: number | string | null = null;
    for (;;) {
      const result = await deleteBatch(beforeId || undefined);
      if (result.done || !result.lastId) break;
      beforeId = result.lastId;
    }

    setHiddenMap((prev) => {
      const next = { ...prev, [uid]: true };
      persistHiddenMap(next).catch(() => undefined);
      return next;
    });
    setMessagesByUid((prev) => {
      const next = { ...prev };
      delete next[uid];
      return next;
    });
    setLatestMap((prev) => {
      const next = { ...prev };
      delete next[uid];
      return next;
    });
    setUnreadMap((prev) => ({ ...prev, [uid]: 0 }));
  }, [authHeaders, chatMenuTargetType, chatMenuTargetUid, closeChatMenu, persistHiddenMap]);

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      {activeView === 'found' && !activeChatUid ? (
        <Animated.View
          style={[styles.sceneContainer, { transform: [{ translateX: foundSceneAnim }] }]}
          {...foundEdgePanResponder.panHandlers}
        >
          <FoundFriends
            friends={friends}
            selfUid={selfUid || null}
            refreshKey={friendsRefreshKey}
            initialTab={foundFriendsInitialTab}
            onBack={onPressFoundBack}
            onRefreshFriends={requestFriendsRefresh}
          />
        </Animated.View>
      ) : null}

      {activeChatUid ? (
        <Animated.View
          style={[styles.sceneContainer, { transform: [{ translateX: chatSceneAnim }] }]}
          {...chatEdgePanResponder.panHandlers}
        >
          <View style={styles.chatHeader}>
            <View style={styles.chatHeaderLeft}>
              <Pressable style={styles.chatBack} onPress={onPressChatBack}>
                <BackIcon />
              </Pressable>
              {totalUnreadCount > 0 ? (
                <View style={styles.chatHeaderUnread}>
                  <Text style={styles.chatHeaderUnreadText}>
                    {totalUnreadCount > 99 ? '99+' : totalUnreadCount}
                  </Text>
                </View>
              ) : null}
            </View>
            <View style={styles.chatHeaderCenter}>
              <Text style={styles.chatName} numberOfLines={1}>
                {activeChatTitle}
              </Text>
              {activeChatStatusText ? (
                <Text style={[styles.chatStatus, !activeChatGroup && activeChatFriend?.online && styles.chatOnline]}>
                  {activeChatStatusText}
                </Text>
              ) : null}
            </View>
            <Pressable
              style={styles.chatHeaderMenu}
              onPress={() => {
                if (!activeChatUid) return;
                if (activeChatGroup) {
                  navigation.navigate('GroupChatSettings', {
                    uid: activeChatUid,
                    group: {
                      id: activeChatGroup.id,
                      ownerUid: activeChatGroup.ownerUid,
                      name: activeChatGroup.name,
                      description: activeChatGroup.description,
                      announcement: activeChatGroup.announcement,
                      myNickname: activeChatGroup.myNickname,
                      memberUids: activeChatGroup.memberUids,
                      members: activeChatGroup.members,
                    },
                  });
                  return;
                }
                navigation.navigate('ChatSettings', {
                  uid: activeChatUid,
                  friend: activeChatFriend
                    ? {
                        uid: activeChatFriend.uid,
                        username: activeChatFriend.username,
                        nickname: activeChatFriend.nickname,
                        avatar: activeChatFriend.avatar,
                        signature: activeChatFriend.signature,
                        online: activeChatFriend.online,
                      }
                    : undefined,
                });
              }}
            >
              <ChatSettingsIcon />
            </Pressable>
          </View>

          <ScrollView
            ref={messageListRef}
            style={[styles.chatBody, { backgroundColor: activeChatBackgroundColor }]}
            onScroll={onChatScroll}
            scrollEventThrottle={16}
            onContentSizeChange={(_, height) => {
              contentHeightRef.current = height;
            }}
          >
            {historyLoading[activeChatUid] && activeChatMessages.length === 0 ? (
              <Text style={styles.empty}>正在加载消息...</Text>
            ) : null}
            {!historyLoading[activeChatUid] && activeChatMessages.length === 0 ? (
              <Text style={styles.empty}>还没有消息，先聊几句吧。</Text>
            ) : null}
            {activeChatMessages.map((item, idx) => {
              const isSelf = item.senderUid === selfUid;
              const itemId = String(item.id);
              const isFocused = focusedMessageId === itemId;
              const prev = idx > 0 ? activeChatMessages[idx - 1] : null;
              const prevMs = Number(prev?.createdAtMs);
              const currentMs = Number(item.createdAtMs);
              const showTime =
                idx === 0 ||
                !Number.isFinite(prevMs) ||
                !Number.isFinite(currentMs) ||
                currentMs - prevMs > CHAT_TIME_GAP_MS;
              const senderProfile = !isSelf ? findUserByUid(item.senderUid) : null;
              const senderName = senderProfile?.nickname || senderProfile?.username || `用户${item.senderUid}`;
              const senderAvatarUrl = isSelf
                ? selfChatAvatar
                : normalizeImageUrl(senderProfile?.avatar || activeChatFriendAvatar);
              const avatarLabel = isSelf
                ? getAvatarText(profileData.nickname || profileData.username || '我')
                : getAvatarText(senderName || '群友');
              const showSender = Boolean(activeChatGroup && !isSelf);
              return (
                <React.Fragment key={itemId}>
                  {showTime ? (
                    <Text style={styles.chatTimeDivider}>
                      {formatTime(item.createdAt, item.createdAtMs)}
                    </Text>
                  ) : null}
                  <View
                    style={[styles.messageRow, isSelf && styles.selfRow]}
                    onLayout={(event) =>
                      recordMessageOffset(
                        activeChatUid,
                        itemId,
                        Number(event?.nativeEvent?.layout?.y) || 0
                      )
                    }
                  >
                    <View style={[styles.msgAvatarWrap, isSelf && styles.selfMsgAvatarWrap]}>
                      {senderAvatarUrl ? (
                        <Image source={{ uri: senderAvatarUrl }} style={styles.msgAvatarImage} />
                      ) : (
                        <View style={styles.msgAvatarFallbackCircle}>
                          <Text style={styles.msgAvatarFallbackText}>{avatarLabel}</Text>
                        </View>
                      )}
                    </View>
                    <View style={[styles.bubbleWrap, isSelf && styles.selfBubbleWrap]}>
                      {showSender ? <Text style={styles.groupSenderName}>{senderName}</Text> : null}
                      <View
                        style={[
                          styles.bubble,
                          isSelf && styles.selfBubble,
                          isFocused && !isSelf && styles.bubbleFocused,
                          isFocused && isSelf && styles.selfBubbleFocused,
                        ]}
                      >
                        <Text style={[styles.messageText, isSelf && styles.selfText]}>
                          {item.content}
                        </Text>
                      </View>
                    </View>
                  </View>
                </React.Fragment>
              );
            })}
          </ScrollView>

          <View style={[styles.chatComposer, { paddingBottom: 8 + insets.bottom }]}>
            <View style={styles.chatInputRow}>
              <TextInput
                ref={chatInputRef}
                value={draftMessage}
                placeholder="输入消息..."
                placeholderTextColor="#b0b0b0"
                onChangeText={setDraftMessage}
                maxLength={CHAT_INPUT_MAX_LENGTH}
                style={[styles.chatInputField, webInputNoOutline]}
                onSubmitEditing={sendText}
                blurOnSubmit={false}
                returnKeyType="send"
              />
              <Pressable
                style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
                onPress={sendText}
                disabled={!canSend}
              >
                <Text style={styles.sendText}>发送</Text>
              </Pressable>
            </View>
            <View style={styles.chatToolRow}>
              <Pressable style={styles.chatToolBtn} onPress={() => undefined}>
                <ToolMicIcon />
              </Pressable>
              <Pressable style={styles.chatToolBtn} onPress={() => undefined}>
                <ToolImageIcon />
              </Pressable>
              <Pressable style={styles.chatToolBtn} onPress={() => undefined}>
                <ToolCameraIcon />
              </Pressable>
              <Pressable style={styles.chatToolBtn} onPress={() => undefined}>
                <ToolEmojiIcon />
              </Pressable>
              <Pressable style={styles.chatToolBtn} onPress={() => undefined}>
                <ToolPlusIcon />
              </Pressable>
            </View>
          </View>
        </Animated.View>
      ) : null}

      {!activeChatUid && activeView !== 'found' ? (
        <View style={styles.home}>
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <Pressable
                style={styles.avatarContainer}
                onPress={() => navigation.navigate('Profile')}
              >
                {avatarSrc && !avatarFailed ? (
                  <Image
                    key={avatarSrc}
                    source={{
                      uri: avatarSrc,
                      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
                    }}
                    style={styles.avatarImg}
                    onError={() => setAvatarFailed(true)}
                  />
                ) : (
                  <Text style={styles.avatarFallback}>{avatarText}</Text>
                )}
              </Pressable>
              <Text style={styles.username}>{displayName}</Text>
            </View>
            <Pressable style={styles.headerRight} onPress={toggleQuickMenu}>
              <Svg viewBox="0 0 24 24" width={26} height={26} fill="none" stroke="#1a1a1a" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <Line x1="12" y1="5" x2="12" y2="19" />
                <Line x1="5" y1="12" x2="19" y2="12" />
              </Svg>
            </Pressable>
          </View>

          <View style={styles.searchContainer}>
            <Pressable style={styles.searchBox} onPress={openSearchPanel}>
              <Svg viewBox="0 0 24 24" width={16} height={16}>
                <Path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" fill="#a0a0a0" />
              </Svg>
              <Text style={styles.searchText}>搜索</Text>
            </Pressable>
          </View>

          {homeTab === 'messages' ? (
            <ScrollView style={styles.msgList} contentContainerStyle={styles.msgListInner}>
              {loadingFriends ? <Text style={styles.empty}>正在加载消息...</Text> : null}
              {!loadingFriends && messageItems.length === 0 ? (
                <Text style={styles.empty}>暂无消息</Text>
              ) : null}
              {!loadingFriends &&
                messageItems.map((item) => (
                  <Pressable
                    key={`${item.targetType}:${item.uid}`}
                    style={[styles.msgItem, item.pinned && styles.msgItemPinned]}
                    onPress={() => {
                      if (item.targetType === 'group') {
                        openChatFromPayload(item.uid, undefined, {
                          targetType: 'group',
                          group: item.group,
                        });
                        return;
                      }
                      if (item.friend) {
                        openChat(item.friend);
                      }
                    }}
                    onLongPress={(event) => openChatMenu(event, item.uid, item.targetType)}
                  >
                    <View style={styles.avatarBox}>
                      {item.targetType === 'group' && item.group ? (
                        <GroupAvatarGrid
                          members={item.group.members}
                          fallbackText={getAvatarText(item.title)}
                          size={48}
                        />
                      ) : normalizeImageUrl(item.friend?.avatar) ? (
                        <Image source={{ uri: normalizeImageUrl(item.friend?.avatar) }} style={styles.msgAvatar} />
                      ) : (
                        <View style={styles.msgAvatarFallback}>
                          <Text style={styles.msgAvatarText}>
                            {getAvatarText(item.friend?.nickname || item.friend?.username)}
                          </Text>
                        </View>
                      )}
                      {item.unread > 0 ? (
                        <View style={styles.badge}>
                          <Text style={styles.badgeText}>
                            {item.unread > 99 ? '99+' : item.unread}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    <View style={styles.msgContentWrapper}>
                      <View style={styles.msgTopRow}>
                        <Text style={styles.msgNickname} numberOfLines={1}>
                          {item.title}
                        </Text>
                        <Text style={styles.msgTime}>{item.latest?.time || ''}</Text>
                      </View>
                      <Text style={styles.msgPreview} numberOfLines={1}>
                        {item.preview}
                      </Text>
                    </View>
                  </Pressable>
                ))}
            </ScrollView>
          ) : (
            <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
              {loadingFriends ? <Text style={styles.empty}>正在加载联系人...</Text> : null}
              {!loadingFriends && friends.length === 0 ? (
                <Text style={styles.empty}>暂无联系人</Text>
              ) : null}
              <Pressable style={styles.newFriendItem} onPress={onOpenNewFriends}>
                <View style={styles.newFriendIcon}>
                  <Text style={styles.newFriendIconText}>新</Text>
                </View>
                <View style={styles.newFriendInfo}>
                  <Text style={styles.newFriendTitle}>新朋友</Text>
                  <Text style={styles.newFriendSub}>好友申请</Text>
                </View>
                {pendingRequestCount > 0 ? (
                  <View style={styles.newFriendBadge}>
                    <Text style={styles.newFriendBadgeText}>
                      {pendingRequestCount > 99 ? '99+' : pendingRequestCount}
                    </Text>
                  </View>
                ) : null}
                <View style={styles.newFriendArrowIcon}>
                  <ForwardIndicatorIcon />
                </View>
              </Pressable>
              {!loadingFriends && friends.length > 0
                ? friends.map((friend) => (
                    <Pressable
                      key={friend.uid}
                      style={styles.contactItem}
                      onPress={() => openContactProfile(friend)}
                    >
                      <View style={styles.contactAvatar}>
                        <Text style={styles.avatarText}>
                          {getAvatarText(friend.nickname || friend.username)}
                        </Text>
                        <View style={[styles.presence, friend.online && styles.presenceOnline]} />
                      </View>
                      <View style={styles.contactInfo}>
                        <Text style={styles.contactName}>
                          {friend.nickname || friend.username || '联系人'}
                        </Text>
                        {friend.signature ? (
                          <Text style={styles.contactSub} numberOfLines={1}>
                            {friend.signature}
                          </Text>
                        ) : null}
                      </View>
                    </Pressable>
                  ))
                : null}
            </ScrollView>
          )}

          <View
            style={[
              styles.bottomNav,
              { paddingTop: navPad, paddingBottom: navPad },
            ]}
          >
            <Pressable
              style={[
                styles.navItem,
                homeTab === 'messages' && styles.navItemActive,
              ]}
              onPress={() => setHomeTab('messages')}
            >
              <View style={styles.navIconWrap}>
                <Svg viewBox="0 0 24 24" width={28} height={28} fill={homeTab === 'messages' ? '#0099ff' : '#7d7d7d'}>
                  <Path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
                </Svg>
                {totalUnreadCount > 0 ? (
                  <View style={styles.navBadge}>
                    <Text style={styles.navBadgeText}>
                      {totalUnreadCount > 99 ? '99+' : totalUnreadCount}
                    </Text>
                  </View>
                ) : null}
              </View>
              <Text style={[styles.navText, homeTab === 'messages' && styles.navTextActive]}>消息</Text>
            </Pressable>
            <Pressable
              style={[
                styles.navItem,
                homeTab === 'contacts' && styles.navItemActive,
              ]}
              onPress={() => setHomeTab('contacts')}
            >
              <View style={styles.navIconWrap}>
                <Svg viewBox="0 0 24 24" width={28} height={28} fill={homeTab === 'contacts' ? '#0099ff' : '#7d7d7d'}>
                  <Path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                </Svg>
                {pendingRequestCount > 0 ? (
                  <View style={styles.navBadge}>
                    <Text style={styles.navBadgeText}>
                      {pendingRequestCount > 99 ? '99+' : pendingRequestCount}
                    </Text>
                  </View>
                ) : null}
              </View>
              <Text style={[styles.navText, homeTab === 'contacts' && styles.navTextActive]}>联系人</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {searchVisible && !activeChatUid && activeView !== 'found' ? (
        <Animated.View
          style={[
            styles.searchOverlayPanel,
            {
              opacity: searchAnim,
              transform: [{ translateY: searchTranslateY }],
            },
          ]}
        >
          <View style={[styles.searchOverlayHeader, { paddingTop: insets.top + 6 }]}>
            <View style={styles.searchOverlayInputWrap}>
              <Svg viewBox="0 0 24 24" width={18} height={18}>
                <Path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" fill="#99a3b1" />
              </Svg>
              <TextInput
                ref={searchInputRef}
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="搜索用户名/昵称/UID/聊天记录/群昵称"
                placeholderTextColor="#99a3b1"
                style={[styles.searchOverlayInput, webInputNoOutline]}
                returnKeyType="search"
                autoCorrect={false}
                autoCapitalize="none"
              />
            </View>
            <Pressable style={styles.searchOverlayCancelBtn} onPress={() => closeSearchPanel()}>
              <Text style={styles.searchOverlayCancelText}>取消</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.searchOverlayScroll} contentContainerStyle={styles.searchOverlayInner}>
            {hasSearchQuery ? (
              <>
                <View style={styles.searchSection}>
                  <Text style={styles.searchSectionTitle}>用户 ({searchFriends.length})</Text>
                  {searchFriends.length === 0 ? (
                    <Text style={styles.searchSectionEmpty}>没有匹配的用户</Text>
                  ) : (
                    searchFriends.map((friend) => (
                      <Pressable
                        key={`search-friend-${friend.uid}`}
                        style={styles.searchResultRow}
                        onPress={() => onSelectSearchFriend(friend)}
                      >
                        <View style={styles.searchResultAvatar}>
                          <Text style={styles.searchResultAvatarText}>
                            {getAvatarText(friend.nickname || friend.username)}
                          </Text>
                        </View>
                        <View style={styles.searchResultInfo}>
                          <Text style={styles.searchResultTitle}>
                            {friend.nickname || friend.username || `用户${friend.uid}`}
                          </Text>
                          <Text style={styles.searchResultSub} numberOfLines={1}>
                            @{friend.username || '-'}  UID:{friend.uid}
                          </Text>
                        </View>
                      </Pressable>
                    ))
                  )}
                </View>

                <View style={styles.searchSection}>
                  <Text style={styles.searchSectionTitle}>群聊 ({searchGroups.length})</Text>
                  {searchGroups.length === 0 ? (
                    <Text style={styles.searchSectionEmpty}>没有匹配的群昵称</Text>
                  ) : (
                    searchGroups.map((group) => (
                      <Pressable
                        key={`search-group-${group.id}`}
                        style={styles.searchResultRow}
                        onPress={() => onSelectSearchGroup(group)}
                      >
                        <GroupAvatarGrid
                          members={group.members}
                          fallbackText={getAvatarText(getGroupDisplayName(group))}
                          size={36}
                        />
                        <View style={styles.searchResultInfo}>
                          <Text style={styles.searchResultTitle}>{getGroupDisplayName(group)}</Text>
                          <Text style={styles.searchResultSub}>群ID: {group.id}</Text>
                        </View>
                      </Pressable>
                    ))
                  )}
                </View>

                <View style={styles.searchSection}>
                  <Text style={styles.searchSectionTitle}>聊天记录 ({searchChatHits.length})</Text>
                  {searchChatHits.length === 0 ? (
                    <Text style={styles.searchSectionEmpty}>没有匹配的聊天记录</Text>
                  ) : (
                    searchChatHits.map((hit) => (
                      <Pressable
                        key={hit.key}
                        style={styles.searchResultRow}
                        onPress={() => onSelectSearchChatHit(hit)}
                      >
                        <View style={styles.searchRecordBadge}>
                          <Text style={styles.searchRecordBadgeText}>
                            {hit.targetType === 'group' ? '群' : '聊'}
                          </Text>
                        </View>
                        <View style={styles.searchResultInfo}>
                          <View style={styles.searchRecordTopRow}>
                            <Text style={styles.searchResultTitle} numberOfLines={1}>
                              {hit.title}
                            </Text>
                            <Text style={styles.searchRecordTime}>
                              {formatTime(hit.createdAt, hit.createdAtMs)}
                            </Text>
                          </View>
                          <Text style={styles.searchResultSub} numberOfLines={2}>
                            {hit.content}
                          </Text>
                        </View>
                      </Pressable>
                    ))
                  )}
                </View>
              </>
            ) : null}
          </ScrollView>
        </Animated.View>
      ) : null}

      {tourVisible && canShowMainHome && currentTourStep ? (
        <View style={styles.tourOverlay}>
          <View style={styles.tourMask} />
          <View style={[styles.tourSpotlight, currentTourStep.spotlightStyle]} />
          <View style={[styles.tourCard, currentTourStep.cardStyle]}>
            <Text style={styles.tourTitle}>{currentTourStep.title}</Text>
            <Text style={styles.tourDescription}>{currentTourStep.description}</Text>
            <View style={styles.tourProgress}>
              {tourSteps.map((step, idx) => (
                <View
                  key={step.id}
                  style={[styles.tourDot, idx === tourStepIndex && styles.tourDotActive]}
                />
              ))}
            </View>
            <View style={styles.tourActions}>
              <Pressable
                style={[styles.tourBtn, styles.tourSkipBtn]}
                onPress={() => closeTour(true)}
              >
                <Text style={styles.tourSkipText}>{'\u8df3\u8fc7'}</Text>
              </Pressable>
              <Pressable style={[styles.tourBtn, styles.tourNextBtn]} onPress={nextTourStep}>
                <Text style={styles.tourNextText}>
                  {tourStepIndex >= tourSteps.length - 1 ? '\u5b8c\u6210' : '\u4e0b\u4e00\u6b65'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}

      {quickMenuMounted && !activeChatUid && activeView !== 'found' ? (
        <Animated.View style={[styles.quickMenuOverlay, { opacity: quickMenuAnim }]}>
          <Pressable style={styles.quickMenuBackdrop} onPress={closeQuickMenu} />
          <Animated.View
            style={[styles.quickMenuPanel, styles.quickMenuPanelPosition, quickMenuPanelAnimatedStyle]}
          >
            <Pressable style={styles.quickMenuItem} onPress={onQuickCreateGroup}>
              <View style={styles.quickMenuIcon}>
                <QuickGroupIcon />
              </View>
              <Text style={styles.quickMenuText}>创建群聊</Text>
            </Pressable>
            <View style={styles.quickMenuDivider} />
            <Pressable style={styles.quickMenuItem} onPress={onQuickAdd}>
              <View style={styles.quickMenuIcon}>
                <QuickAddIcon />
              </View>
              <Text style={styles.quickMenuText}>加好友/群</Text>
            </Pressable>
            <View style={styles.quickMenuDivider} />
            <Pressable style={styles.quickMenuItem} onPress={onQuickScan}>
              <View style={styles.quickMenuIcon}>
                <QuickScanIcon />
              </View>
              <Text style={styles.quickMenuText}>扫一扫</Text>
            </Pressable>
          </Animated.View>
        </Animated.View>
      ) : null}

      {chatMenuVisible && chatMenuTargetUid ? (
        <View style={styles.menuOverlay}>
          <Pressable style={styles.menuBackdrop} onPress={closeChatMenu} />
          <View style={[styles.menuPanel, { left: chatMenuPosition.x, top: chatMenuPosition.y }]}>
            <Pressable style={styles.menuItem} onPress={toggleChatPin}>
              <Text style={styles.menuText}>
                {pinnedMap[chatMenuTargetUid] ? '取消置顶' : '置顶该聊天'}
              </Text>
            </Pressable>
            <View style={styles.menuDivider} />
            <Pressable style={styles.menuItem} onPress={deleteChat}>
              <Text style={[styles.menuText, styles.menuDanger]}>删除聊天</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    flexGrow: 1,
    minHeight: '100%',
    backgroundColor: '#f5f6fa',
  },
  home: {
    flex: 1,
    minHeight: 0,
  },
  sceneContainer: {
    flex: 1,
    minHeight: 0,
  },
  header: {
    paddingHorizontal: 15,
    paddingBottom: 6,
    paddingTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'transparent',
    zIndex: 10,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  avatarContainer: {
    width: 38,
    height: 38,
    borderRadius: 19,
    overflow: 'hidden',
    backgroundColor: '#e0e0e0',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarImg: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  avatarFallback: {
    fontSize: 16,
    fontWeight: '700',
    color: '#2f6bd9',
  },
  username: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1a1a1a',
    letterSpacing: 0.5,
  },
  headerRight: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchContainer: {
    paddingHorizontal: 15,
    paddingTop: 5,
    paddingBottom: 10,
  },
  searchBox: {
    backgroundColor: '#fff',
    height: 36,
    borderRadius: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    ...surfaceShadowStyle,
  },
  searchText: {
    fontSize: 15,
    color: '#8a8a8a',
  },
  searchOverlayPanel: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 170,
    backgroundColor: '#f6f7fb',
  },
  searchOverlayHeader: {
    paddingHorizontal: 14,
    paddingBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e8edf4',
    backgroundColor: '#f6f7fb',
  },
  searchOverlayInputWrap: {
    flex: 1,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e3e9f2',
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  searchOverlayInput: {
    flex: 1,
    minHeight: 36,
    fontSize: 15,
    color: '#24364f',
    paddingVertical: 0,
  },
  searchOverlayCancelBtn: {
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  searchOverlayCancelText: {
    fontSize: 16,
    color: '#4f84cf',
    fontWeight: '500',
  },
  searchOverlayScroll: {
    flex: 1,
  },
  searchOverlayInner: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
    paddingBottom: 28,
  },
  searchSection: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e4eaf3',
    borderRadius: 12,
    overflow: 'hidden',
  },
  searchSectionTitle: {
    fontSize: 13,
    color: '#5f728a',
    fontWeight: '600',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 8,
  },
  searchSectionEmpty: {
    fontSize: 13,
    color: '#9aabc0',
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
  searchResultRow: {
    minHeight: 56,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: '#edf2f8',
  },
  searchResultAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#e6edf7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchResultAvatarText: {
    color: '#2f6bd9',
    fontSize: 12,
    fontWeight: '700',
  },
  searchResultInfo: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  searchResultTitle: {
    fontSize: 14,
    color: '#203246',
    fontWeight: '600',
  },
  searchResultSub: {
    fontSize: 12,
    color: '#7e90a6',
  },
  searchRecordBadge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#eaf1fb',
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchRecordBadgeText: {
    color: '#41699c',
    fontSize: 12,
    fontWeight: '700',
  },
  searchRecordTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  searchRecordTime: {
    fontSize: 11,
    color: '#97a7bc',
  },
  content: {
    flex: 1,
    minHeight: 0,
  },
  contentInner: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  msgList: {
    flex: 1,
    minHeight: 0,
    backgroundColor: '#f5f6fa',
  },
  msgListInner: {
    paddingBottom: 20,
  },
  msgItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 15,
    backgroundColor: 'transparent',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.03)',
  },
  msgItemPinned: {
    backgroundColor: '#e6e6e6',
  },
  avatarBox: {
    position: 'relative',
    marginRight: 12,
  },
  msgAvatar: {
    width: 48,
    height: 48,
    borderRadius: 8,
    resizeMode: 'cover',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.03)',
  },
  groupAvatarGrid: {
    width: 48,
    height: 48,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#eef3fa',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.03)',
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  groupAvatarCell: {
    width: '50%',
    height: '50%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  groupAvatarImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  groupAvatarFallbackText: {
    fontSize: 9,
    color: '#2f6bd9',
    fontWeight: '700',
  },
  msgAvatarFallback: {
    width: 48,
    height: 48,
    borderRadius: 8,
    backgroundColor: '#f0f2f5',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.03)',
  },
  msgAvatarText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#4a9df8',
  },
  badge: {
    position: 'absolute',
    top: -5,
    right: -5,
    backgroundColor: '#ff4d4f',
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    borderWidth: 1,
    borderColor: '#fff',
  },
  badgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
  },
  msgContentWrapper: {
    flex: 1,
    overflow: 'hidden',
    gap: 4,
  },
  msgTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  msgNickname: {
    fontSize: 16,
    color: '#1a1a1a',
    fontWeight: '500',
    flexShrink: 1,
    paddingRight: 8,
  },
  msgTime: {
    fontSize: 12,
    color: '#b2b2b2',
  },
  msgPreview: {
    fontSize: 14,
    color: '#999',
  },
  bottomNav: {
    minHeight: 55,
    marginTop: 'auto',
    flexShrink: 0,
    backgroundColor: '#f9f9f9',
    borderTopWidth: 1,
    borderTopColor: 'rgba(0,0,0,0.05)',
    flexDirection: 'row',
  },
  navItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  navIconWrap: {
    position: 'relative',
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navBadge: {
    position: 'absolute',
    top: -4,
    right: -10,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#ff4d4f',
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#fff',
  },
  navBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  navItemActive: {},
  navText: {
    fontSize: 10,
    color: '#7d7d7d',
    fontWeight: '500',
  },
  navTextActive: {
    color: '#0099ff',
  },
  newFriendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
  },
  newFriendIcon: {
    width: 42,
    height: 42,
    borderRadius: 10,
    backgroundColor: '#e8f2ff',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  newFriendIconText: {
    color: '#2f6bd9',
    fontSize: 16,
    fontWeight: '700',
  },
  newFriendInfo: {
    flex: 1,
    gap: 2,
  },
  newFriendTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  newFriendSub: {
    fontSize: 12,
    color: '#8a8a8a',
  },
  newFriendBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#ff4d4f',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
    marginRight: 8,
  },
  newFriendBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  newFriendArrowIcon: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contactItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  contactAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#f0f2f5',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  avatarText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#2f6bd9',
  },
  presence: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 5,
    right: 0,
    bottom: 0,
    backgroundColor: '#c8c8c8',
    borderWidth: 2,
    borderColor: '#fff',
  },
  presenceOnline: {
    backgroundColor: '#30c67c',
  },
  contactInfo: {
    flex: 1,
    gap: 4,
  },
  contactName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  contactSub: {
    fontSize: 12,
    color: '#8a8a8a',
  },
  empty: {
    textAlign: 'center',
    color: '#9a9a9a',
    fontSize: 12,
    paddingVertical: 12,
  },
  tourOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 160,
  },
  tourMask: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(6, 10, 18, 0.68)',
  },
  tourSpotlight: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: '#35a4ff',
    backgroundColor: 'rgba(53, 164, 255, 0.12)',
  },
  tourCard: {
    position: 'absolute',
    backgroundColor: '#f8fbff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(82, 137, 204, 0.24)',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
    ...tourCardShadowStyle,
  },
  tourTitle: {
    color: '#1f2f46',
    fontSize: 16,
    fontWeight: '600',
  },
  tourDescription: {
    marginTop: 6,
    color: '#4c5f78',
    fontSize: 13,
    lineHeight: 18,
  },
  tourProgress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
  },
  tourDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: 'rgba(103, 156, 219, 0.35)',
  },
  tourDotActive: {
    width: 18,
    borderRadius: 6,
    backgroundColor: '#5fb3ff',
  },
  tourActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  tourBtn: {
    flex: 1,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tourSkipBtn: {
    backgroundColor: '#eaf2fb',
    borderWidth: 1,
    borderColor: '#d4e4f7',
  },
  tourNextBtn: {
    backgroundColor: '#dff0ff',
    borderWidth: 1,
    borderColor: '#b8dbff',
  },
  tourSkipText: {
    color: '#516177',
    fontSize: 13,
    fontWeight: '600',
  },
  tourNextText: {
    color: '#1f66aa',
    fontSize: 13,
    fontWeight: '600',
  },
  quickMenuOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 130,
  },
  quickMenuBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(21, 33, 51, 0.06)',
  },
  quickMenuPanel: {
    position: 'absolute',
    width: 196,
    backgroundColor: '#ffffff',
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e5ebf3',
    ...quickMenuShadowStyle,
  },
  quickMenuPanelPosition: {
    top: 44,
    right: 12,
  },
  quickMenuItem: {
    height: 52,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#f7f9fc',
  },
  quickMenuIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#e9f0fb',
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickMenuText: {
    color: '#24364f',
    fontSize: 15,
    fontWeight: '600',
  },
  quickMenuDivider: {
    height: 1,
    backgroundColor: '#e5ebf3',
    marginHorizontal: 12,
  },
  menuOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
  },
  menuBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  menuPanel: {
    position: 'absolute',
    width: 160,
    backgroundColor: 'rgba(255,255,255,0.96)',
    borderRadius: 12,
    overflow: 'hidden',
    ...menuShadowStyle,
  },
  menuItem: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  menuText: {
    fontSize: 14,
    color: '#333',
  },
  menuDivider: {
    height: 1,
    backgroundColor: '#e5e5e5',
  },
  menuDanger: {
    color: '#ff4d4f',
  },
  chatHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#f5f6fa',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.05)',
  },
  chatHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  chatHeaderCenter: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 8,
  },
  chatHeaderUnread: {
    height: 24,
    borderRadius: 12,
    paddingHorizontal: 10,
    backgroundColor: '#ecf2fb',
    borderWidth: 1,
    borderColor: '#d3e1f5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatHeaderUnreadText: {
    color: '#45658f',
    fontSize: 12,
    fontWeight: '600',
  },
  chatHeaderMenu: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatBack: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: '#e8edf4',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  chatStatus: {
    fontSize: 11,
    color: '#9a9a9a',
  },
  chatOnline: {
    color: '#30c67c',
  },
  chatBody: {
    flex: 1,
    backgroundColor: '#f5f6fa',
    paddingHorizontal: 12,
    paddingTop: 12,
  },
  chatTimeDivider: {
    alignSelf: 'center',
    marginBottom: 8,
    fontSize: 12,
    color: '#8a8f96',
  },
  messageRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    width: '100%',
    gap: 8,
    marginBottom: 12,
  },
  selfRow: {
    flexDirection: 'row-reverse',
  },
  bubbleWrap: {
    maxWidth: '78%',
    minWidth: 44,
    alignItems: 'flex-start',
    gap: 3,
  },
  selfBubbleWrap: {
    alignItems: 'flex-end',
  },
  groupSenderName: {
    fontSize: 11,
    color: '#8391a6',
    paddingHorizontal: 4,
  },
  msgAvatarWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    overflow: 'hidden',
    backgroundColor: '#dbe3ef',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  selfMsgAvatarWrap: {
    backgroundColor: '#d7e7ff',
  },
  msgAvatarImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  msgAvatarFallbackCircle: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  msgAvatarFallbackText: {
    color: '#2f6bd9',
    fontSize: 12,
    fontWeight: '700',
  },
  bubble: {
    maxWidth: '100%',
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)',
  },
  selfBubble: {
    backgroundColor: '#4a9df8',
    borderColor: '#4a9df8',
  },
  bubbleFocused: {
    borderColor: '#f7b84b',
    backgroundColor: '#fff8e8',
  },
  selfBubbleFocused: {
    borderColor: '#ffd487',
  },
  messageText: {
    fontSize: 14,
    color: '#1a1a1a',
    lineHeight: 20,
    textAlign: 'left',
    includeFontPadding: false,
  },
  selfText: {
    color: '#fff',
  },
  chatComposer: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(0,0,0,0.06)',
    backgroundColor: '#ffffff',
    paddingHorizontal: 10,
    paddingTop: 8,
  },
  chatInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  chatToolRow: {
    height: 42,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#edf0f6',
    backgroundColor: '#f9fafc',
    paddingHorizontal: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  chatToolBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatInputField: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#e1e1e1',
    borderRadius: 12,
    paddingHorizontal: 14,
    height: 40,
    fontSize: 14,
    color: '#333',
    backgroundColor: '#f8f9fb',
  },
  sendBtn: {
    backgroundColor: '#4a9df8',
    borderRadius: 12,
    paddingHorizontal: 14,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: {
    opacity: 0.6,
  },
  sendText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});

function GroupAvatarGrid({
  members,
  fallbackText,
  size = 48,
}: {
  members?: Friend[];
  fallbackText: string;
  size?: number;
}) {
  const list = Array.isArray(members) ? members.slice(0, 4) : [];
  const cells = [...list];
  while (cells.length < 4) {
    cells.push(null as any);
  }
  return (
    <View style={[styles.groupAvatarGrid, { width: size, height: size }]}>
      {cells.map((member, index) => {
        if (!member) {
          return <View key={`empty-${index}`} style={styles.groupAvatarCell} />;
        }
        const avatarUrl = normalizeImageUrl(member.avatar);
        const label = (member.nickname || member.username || fallbackText || '群').slice(0, 2);
        return (
          <View key={`${member.uid}-${index}`} style={styles.groupAvatarCell}>
            {avatarUrl ? (
              <Image source={{ uri: avatarUrl }} style={styles.groupAvatarImage} />
            ) : (
              <Text style={styles.groupAvatarFallbackText}>{label}</Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

function BackIcon() {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      <Path
        d="M15 18L9 12L15 6"
        stroke="#314458"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function ForwardIndicatorIcon() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Path
        d="M15 18L9 12L15 6"
        stroke="#9aa7b8"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        transform="rotate(180 12 12)"
      />
    </Svg>
  );
}

function ChatSettingsIcon() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path d="M5 7H19" stroke="#314458" strokeWidth={2} strokeLinecap="round" />
      <Path d="M5 12H19" stroke="#314458" strokeWidth={2} strokeLinecap="round" />
      <Path d="M5 17H19" stroke="#314458" strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

function ToolMicIcon() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 4a2 2 0 0 1 2 2v6a2 2 0 1 1-4 0V6a2 2 0 0 1 2-2Z"
        stroke="#2f3a48"
        strokeWidth={2}
      />
      <Path d="M7 11a5 5 0 1 0 10 0" stroke="#2f3a48" strokeWidth={2} strokeLinecap="round" />
      <Path d="M12 16V20" stroke="#2f3a48" strokeWidth={2} strokeLinecap="round" />
      <Path d="M9 20H15" stroke="#2f3a48" strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

function ToolImageIcon() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <RectLikeFrame />
      <Path d="M8 15L11 12L14 15L16 13L19 16" stroke="#2f3a48" strokeWidth={2} strokeLinecap="round" />
      <Path d="M9 9.5H9.01" stroke="#2f3a48" strokeWidth={2.4} strokeLinecap="round" />
    </Svg>
  );
}

function ToolCameraIcon() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path
        d="M9 6L10.2 4.8A2 2 0 0 1 11.6 4H12.4A2 2 0 0 1 13.8 4.8L15 6H18A2 2 0 0 1 20 8V17A2 2 0 0 1 18 19H6A2 2 0 0 1 4 17V8A2 2 0 0 1 6 6H9Z"
        stroke="#2f3a48"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <Path d="M12 15.5A3.5 3.5 0 1 0 12 8.5A3.5 3.5 0 0 0 12 15.5Z" stroke="#2f3a48" strokeWidth={2} />
    </Svg>
  );
}

function ToolEmojiIcon() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path d="M12 20A8 8 0 1 0 12 4A8 8 0 0 0 12 20Z" stroke="#2f3a48" strokeWidth={2} />
      <Path d="M9 10H9.01" stroke="#2f3a48" strokeWidth={2.6} strokeLinecap="round" />
      <Path d="M15 10H15.01" stroke="#2f3a48" strokeWidth={2.6} strokeLinecap="round" />
      <Path d="M8.5 14C9.3 15.2 10.5 16 12 16C13.5 16 14.7 15.2 15.5 14" stroke="#2f3a48" strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

function ToolPlusIcon() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path d="M12 5V19" stroke="#2f3a48" strokeWidth={2} strokeLinecap="round" />
      <Path d="M5 12H19" stroke="#2f3a48" strokeWidth={2} strokeLinecap="round" />
      <Path d="M12 22A10 10 0 1 0 12 2A10 10 0 0 0 12 22Z" stroke="#2f3a48" strokeWidth={2} />
    </Svg>
  );
}

function RectLikeFrame() {
  return <Path d="M5 6H19A2 2 0 0 1 21 8V16A2 2 0 0 1 19 18H5A2 2 0 0 1 3 16V8A2 2 0 0 1 5 6Z" stroke="#2f3a48" strokeWidth={2} strokeLinejoin="round" />;
}

function QuickGroupIcon() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 7.5A2.5 2.5 0 0 1 6.5 5h8A2.5 2.5 0 0 1 17 7.5V12a2.5 2.5 0 0 1-2.5 2.5h-4l-3 3v-3A2.5 2.5 0 0 1 5 12V7.5Z"
        stroke="#31527f"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <Path d="M19 7v4M17 9h4" stroke="#31527f" strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

function QuickAddIcon() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Path
        d="M8.5 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2.5 19a6 6 0 0 1 12 0"
        stroke="#31527f"
        strokeWidth={2}
        strokeLinecap="round"
      />
      <Path d="M18 11v6M15 14h6" stroke="#31527f" strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

function QuickScanIcon() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Path d="M7 4H4v3M17 4h3v3M4 17v3h3M20 17v3h-3" stroke="#31527f" strokeWidth={2} strokeLinecap="round" />
      <Path d="M7 12h10" stroke="#31527f" strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}








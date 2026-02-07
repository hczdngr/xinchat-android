import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {

  BackHandler,
  InteractionManager,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Dimensions,
  Animated,
  Image,
  Pressable,

  ScrollView,

  StyleSheet,

  Text,

  TextInput,

  View,

} from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';

import Svg, { Line, Path } from 'react-native-svg';

import { API_BASE, normalizeImageUrl } from '../config';

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

};



type Friend = {

  uid: number;

  username?: string;

  nickname?: string;

  avatar?: string;

  online?: boolean;

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



const READ_AT_KEY = 'xinchat.readAt';

const PINNED_KEY = 'xinchat.pinned';

const HIDDEN_KEY = 'xinchat.hiddenChats';

const PAGE_LIMIT = 30;

const UNREAD_LIMIT = 200;

const HEARTBEAT_MS = 20000;

const RECONNECT_BASE_MS = 1500;

const RECONNECT_MAX_MS = 10000;
const BUBBLE_MENU_WIDTH = 240;
const BUBBLE_MENU_GAP = 8;
const FRIENDS_CACHE_KEY = 'xinchat.cache.friends';
const MESSAGES_CACHE_KEY = 'xinchat.cache.messagesByUid';
const LATEST_CACHE_KEY = 'xinchat.cache.latestMap';
const PENDING_OPEN_CHAT_KEY = 'xinchat.pendingOpenChat';
const REMOTE_BOOTSTRAP_DELAY_MS = 2000;
const MESSAGE_CACHE_LIMIT = 60;

const normalizeCachedBuckets = (value: any): BucketMap => {
  if (!value || typeof value !== 'object') return {};
  const result: BucketMap = {};
  Object.entries(value).forEach(([key, items]) => {
    const uid = Number(key);
    if (!Number.isInteger(uid) || !Array.isArray(items)) return;
    const nextItems: Message[] = items
      .filter((item: any) => item && item.id !== undefined && item.id !== null)
      .slice(-MESSAGE_CACHE_LIMIT)
      .map((item: any) => ({
        id: item.id,
        senderUid: Number(item.senderUid) || 0,
        targetUid: Number(item.targetUid) || 0,
        targetType: String(item.targetType || 'private'),
        content: String(item.content || ''),
        createdAt: String(item.createdAt || ''),
        createdAtMs: Number(item.createdAtMs) || Date.now(),
      }));
    result[uid] = nextItems;
  });
  return result;
};



export default function Home({ profile }: { profile: Profile }) {

  const insets = useSafeAreaInsets();

  const navPad = Math.min(insets.bottom, 6);

  const [keyboardHeight, setKeyboardHeight] = useState(0);

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

  const [latestMap, setLatestMap] = useState<LatestMap>({});

  const [loadingFriends, setLoadingFriends] = useState(false);



  const [messagesByUid, setMessagesByUid] = useState<BucketMap>({});

  const [unreadMap, setUnreadMap] = useState<Record<number, number>>({});

  const [historyLoading, setHistoryLoading] = useState<Record<number, boolean>>({});

  const [historyHasMore, setHistoryHasMore] = useState<Record<number, boolean>>({});

  const [readAtMap, setReadAtMap] = useState<ReadAtMap>({});

  const [pinnedMap, setPinnedMap] = useState<PinnedMap>({});

  const [hiddenMap, setHiddenMap] = useState<HiddenMap>({});

  const [menuVisible, setMenuVisible] = useState(false);

  const [menuTargetUid, setMenuTargetUid] = useState<number | null>(null);

  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const [bubbleMenuVisible, setBubbleMenuVisible] = useState(false);
  const [bubbleMenuMessage, setBubbleMenuMessage] = useState<Message | null>(null);
  const [bubbleMenuPosition, setBubbleMenuPosition] = useState({ x: 0, y: 0 });
  const bubbleMenuAnim = useRef(new Animated.Value(0)).current;
  const bubbleMenuHeightRef = useRef(0);
  const bubbleMenuAnchorRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const bubbleMenuVisibleRef = useRef(false);
  const bubbleRefMap = useRef<Map<string, any>>(new Map());

  const [avatarFailed, setAvatarFailed] = useState(false);



  const [activeChatUid, setActiveChatUid] = useState<number | null>(null);

  const [draftMessage, setDraftMessage] = useState('');

  const [activeView, setActiveView] = useState<'list' | 'found'>('list');

  const [friendsRefreshKey, setFriendsRefreshKey] = useState(0);

  const [homeTab, setHomeTab] = useState<'messages' | 'contacts'>('messages');
  const [bootstrapDone, setBootstrapDone] = useState(false);
  const [cacheReady, setCacheReady] = useState(false);

  const listAnim = useRef(new Animated.Value(1)).current;



  const navigation = useNavigation<any>();

  const route = useRoute<any>();

  const messageIdSetsRef = useRef<Map<number, Set<number | string>>>(new Map());

  const wsRef = useRef<WebSocket | null>(null);

  const heartbeatTimerRef = useRef<NodeJS.Timeout | null>(null);

  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);

  const reconnectAttemptsRef = useRef(0);

  const messagesByUidRef = useRef<BucketMap>({});

  const readAtMapRef = useRef<ReadAtMap>({});

  const activeChatUidRef = useRef<number | null>(null);
  const autoLoadedChatUidRef = useRef<number | null>(null);

  const activeViewRef = useRef<'list' | 'found'>('list');

  const contentHeightRef = useRef(0);

  const messageListRef = useRef<ScrollView | null>(null);

  const messageAnimMapRef = useRef<Map<string, Animated.Value>>(new Map());



  useEffect(() => {

    activeChatUidRef.current = activeChatUid;

  }, [activeChatUid]);

  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', (event) => {
      const height = event?.endCoordinates?.height || 0;
      setKeyboardHeight(height);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fallbackTimer = setTimeout(() => {
      if (!cancelled) {
        setBootstrapDone(true);
      }
    }, 220);
    const task = InteractionManager.runAfterInteractions(() => {
      if (cancelled) return;
      clearTimeout(fallbackTimer);
      setBootstrapDone(true);
    });
    return () => {
      cancelled = true;
      clearTimeout(fallbackTimer);
      task.cancel();
    };
  }, []);

  useEffect(() => {

    activeViewRef.current = activeView;

  }, [activeView]);

  useEffect(() => {
    bubbleMenuVisibleRef.current = bubbleMenuVisible;
  }, [bubbleMenuVisible]);

  const computeBubbleMenuPosition = useCallback(
    (anchor: { x: number; y: number; width: number; height: number }, menuHeight: number) => {
      const screenWidth = Dimensions.get('window').width;
      const left = Math.min(
        screenWidth - BUBBLE_MENU_WIDTH - 12,
        Math.max(12, anchor.x + anchor.width / 2 - BUBBLE_MENU_WIDTH / 2),
      );
      const top = Math.max(insets.top + 6, anchor.y - BUBBLE_MENU_GAP - menuHeight);
      return { x: left, y: top };
    },
    [insets.top],
  );

  const openBubbleMenu = useCallback(
    (message: Message) => {
      const node = bubbleRefMap.current.get(String(message.id));
      if (!node || typeof node.measureInWindow !== 'function') {
        return;
      }
      node.measureInWindow((x: number, y: number, width: number, height: number) => {
        const anchor = { x, y, width, height };
        bubbleMenuAnchorRef.current = anchor;
        const menuHeight = bubbleMenuHeightRef.current || 44;
        setBubbleMenuPosition(computeBubbleMenuPosition(anchor, menuHeight));
        setBubbleMenuMessage(message);
        setBubbleMenuVisible(true);
        bubbleMenuAnim.setValue(0);
        requestAnimationFrame(() => {
          Animated.spring(bubbleMenuAnim, {
            toValue: 1,
            useNativeDriver: true,
            friction: 6,
            tension: 70,
          }).start();
        });
      });
    },
    [bubbleMenuAnim, computeBubbleMenuPosition],
  );

  const closeBubbleMenu = useCallback(() => {
    if (!bubbleMenuVisibleRef.current) {
      return;
    }
    Animated.timing(bubbleMenuAnim, {
      toValue: 0,
      duration: 140,
      useNativeDriver: true,
    }).start(() => {
      setBubbleMenuVisible(false);
      setBubbleMenuMessage(null);
    });
  }, [bubbleMenuAnim]);

  const handleBubbleMenuLayout = useCallback(
    (event: any) => {
      const height = event?.nativeEvent?.layout?.height || 0;
      if (!height) return;
      if (height !== bubbleMenuHeightRef.current) {
        bubbleMenuHeightRef.current = height;
        if (bubbleMenuVisible && bubbleMenuAnchorRef.current) {
          setBubbleMenuPosition(
            computeBubbleMenuPosition(bubbleMenuAnchorRef.current, height),
          );
        }
      }
    },
    [bubbleMenuVisible, computeBubbleMenuPosition],
  );

  useFocusEffect(
    useCallback(() => {
      const onBackPress = () => {
        if (bubbleMenuVisibleRef.current) {
          closeBubbleMenu();
          return true;
        }
        if (activeChatUidRef.current) {
          setActiveChatUid(null);
          return true;
        }
        if (activeViewRef.current === 'found') {
          setActiveView('list');
          return true;
        }
        return true;
      };
      const sub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
      return () => sub.remove();
    }, [closeBubbleMenu])
  );

  const getMessageAnim = useCallback((id: number | string) => {
    const key = String(id);
    const map = messageAnimMapRef.current;
    let value = map.get(key);
    if (!value) {
      value = new Animated.Value(0);
      map.set(key, value);
      Animated.timing(value, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }).start();
    }
    return value;
  }, []);



  useEffect(() => {

    messagesByUidRef.current = messagesByUid;

  }, [messagesByUid]);



  useEffect(() => {

    listAnim.setValue(0);

    Animated.timing(listAnim, {

      toValue: 1,

      duration: 220,

      useNativeDriver: true,

    }).start();

  }, [homeTab, activeChatUid, activeView, listAnim]);

  useEffect(() => {
    if (!activeChatUid) {
      closeBubbleMenu();
    }
  }, [activeChatUid, closeBubbleMenu]);



  useEffect(() => {

    readAtMapRef.current = readAtMap;

  }, [readAtMap]);



  useEffect(() => {

    if (profile) {

      setProfileData((prev) => ({ ...prev, ...profile }));

    }

  }, [profile]);



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

    const loadToken = async () => {

      tokenRef.current = (await storage.getString('xinchat.token')) || '';

      setTokenReady(true);

    };

    void loadToken();

  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadCachedData = async () => {
      const [cachedFriends, cachedBuckets, cachedLatest] = await Promise.all([
        storage.getJson<Friend[]>(FRIENDS_CACHE_KEY),
        storage.getJson<any>(MESSAGES_CACHE_KEY),
        storage.getJson<LatestMap>(LATEST_CACHE_KEY),
      ]);
      if (cancelled) return;

      if (Array.isArray(cachedFriends) && cachedFriends.length > 0) {
        setFriends(cachedFriends);
      }

      const normalizedBuckets = normalizeCachedBuckets(cachedBuckets);
      const bucketUids = Object.keys(normalizedBuckets).map((key) => Number(key));
      if (bucketUids.length > 0) {
        setMessagesByUid((prev) => ({ ...normalizedBuckets, ...prev }));
        const idMap = new Map<number, Set<number | string>>();
        bucketUids.forEach((uid) => {
          const ids = new Set<number | string>();
          (normalizedBuckets[uid] || []).forEach((item) => ids.add(item.id));
          idMap.set(uid, ids);
        });
        messageIdSetsRef.current = idMap;
        setHistoryLoading((prev) => {
          const next = { ...prev };
          bucketUids.forEach((uid) => {
            next[uid] = false;
          });
          return next;
        });
        setHistoryHasMore((prev) => {
          const next = { ...prev };
          bucketUids.forEach((uid) => {
            next[uid] = false;
          });
          return next;
        });
        setUnreadMap((prev) => {
          const next = { ...prev };
          bucketUids.forEach((uid) => {
            if (typeof next[uid] !== 'number') next[uid] = 0;
          });
          return next;
        });
      }

      if (cachedLatest && typeof cachedLatest === 'object') {
        setLatestMap((prev) => ({ ...cachedLatest, ...prev }));
      }

      setCacheReady(true);
    };

    void loadCachedData();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!cacheReady) return;
    const timer = setTimeout(() => {
      const friendsToSave = friends.map((friend) => ({
        uid: friend.uid,
        username: friend.username,
        nickname: friend.nickname,
        avatar: friend.avatar,
        online: friend.online,
      }));
      const bucketsToSave: BucketMap = {};
      Object.entries(messagesByUid).forEach(([key, items]) => {
        const uid = Number(key);
        if (!Number.isInteger(uid) || !Array.isArray(items)) return;
        bucketsToSave[uid] = items.slice(-MESSAGE_CACHE_LIMIT).map((item) => ({
          id: item.id,
          senderUid: item.senderUid,
          targetUid: item.targetUid,
          targetType: item.targetType,
          content: item.content,
          createdAt: item.createdAt,
          createdAtMs: item.createdAtMs,
        }));
      });
      void Promise.all([
        storage.setJson(FRIENDS_CACHE_KEY, friendsToSave),
        storage.setJson(MESSAGES_CACHE_KEY, bucketsToSave),
        storage.setJson(LATEST_CACHE_KEY, latestMap),
      ]);
    }, 300);
    return () => clearTimeout(timer);
  }, [cacheReady, friends, latestMap, messagesByUid]);



  useEffect(() => {

    const loadReadAt = async () => {
      if (!bootstrapDone) return;

      const stored = await storage.getJson<ReadAtMap>(READ_AT_KEY);

      if (stored) {

        setReadAtMap(stored);

      }

    };

    void loadReadAt();

  }, [bootstrapDone]);



  useEffect(() => {

    const loadPinned = async () => {
      if (!bootstrapDone) return;

      const stored = await storage.getJson<PinnedMap>(PINNED_KEY);

      if (stored) {

        setPinnedMap(stored);

      }

    };

    const loadHidden = async () => {
      if (!bootstrapDone) return;

      const stored = await storage.getJson<HiddenMap>(HIDDEN_KEY);

      if (stored) {

        setHiddenMap(stored);

      }

    };

    void loadPinned();

    void loadHidden();

  }, [bootstrapDone]);



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

  const activeChatFriend = useMemo(() => {

    if (!activeChatUid) return null;

    return friends.find((item) => item.uid === activeChatUid) || null;

  }, [activeChatUid, friends]);

  const activeChatMessages = useMemo(() => {

    if (!activeChatUid) return [];

    return messagesByUid[activeChatUid] || [];

  }, [activeChatUid, messagesByUid]);

  const selfUid = useMemo(() => profileData.uid, [profileData.uid]);

  const canSend = useMemo(() => draftMessage.trim().length > 0, [draftMessage]);



  const getAvatarText = useCallback((value?: string) => {

    const text = String(value || '').trim();

    if (!text) return '??';

    return text.slice(0, 2);

  }, []);



  const authHeaders = useCallback(() => {

    const token = tokenRef.current;

    return token ? { Authorization: `Bearer ${token}` } : {};

  }, []);



  const loadProfile = useCallback(async () => {

    if (!tokenRef.current) return;

    try {

      const response = await fetch(`${API_BASE}/api/profile`, {

        headers: { ...authHeaders() },

      });

      const data = await response.json().catch(() => ({}));

      if (response.ok && data?.success && data?.user) {

        setProfileData((prev) => ({ ...prev, ...data.user }));

      }

    } catch {}

  }, [authHeaders]);



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

      typeof prev[uid] === 'boolean' ? prev : { ...prev, [uid]: false }

    );

  }, []);



  const persistReadAtMap = useCallback(async (nextMap: ReadAtMap) => {

    await storage.setJson(READ_AT_KEY, nextMap);

  }, []);



  const persistPinnedMap = useCallback(async (nextMap: PinnedMap) => {

    await storage.setJson(PINNED_KEY, nextMap);

  }, []);



  const persistHiddenMap = useCallback(async (nextMap: HiddenMap) => {

    await storage.setJson(HIDDEN_KEY, nextMap);

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

        void persistReadAtMap(next);

        return next;

      });

    },

    [persistReadAtMap]

  );



  const recalcUnread = useCallback(

    (uid: number, list?: Message[]) => {

      const bucket = list || messagesByUidRef.current[uid] || [];

      const readAt = getReadAt(uid);

      const count = bucket.filter(

        (item) => item.senderUid !== selfUid && item.createdAtMs > readAt

      ).length;

      setUnreadMap((prev) => ({ ...prev, [uid]: count }));

    },

    [getReadAt, selfUid]

  );



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

        void persistHiddenMap(next);

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

        const friendUid = last.senderUid === selfUid ? last.targetUid : last.senderUid;

        updateLatest(friendUid, last);

      }

      recalcUnread(uid, nextBucket);

    },

    [ensureMessageBucket, normalizeMessage, recalcUnread, selfUid, unhideChat, updateLatest]

  );



  const loadLatestForFriend = useCallback(

    async (uid: number) => {

      try {

        const params = new URLSearchParams({

          targetType: 'private',

          targetUid: String(uid),

          type: 'text',

          limit: '1',

        });

        const response = await fetch(`${API_BASE}/api/chat/get?${params.toString()}`, {

          headers: { ...authHeaders() },

        });

        const data = await response.json().catch(() => ({}));

        if (response.ok && data?.success && Array.isArray(data?.data)) {

          const last = data.data[data.data.length - 1];

          if (last) {

            updateLatest(uid, normalizeMessage(last));

          }

        }

      } catch {}

    },

    [authHeaders, normalizeMessage, updateLatest]

  );



  const loadUnreadCount = useCallback(

    async (uid: number) => {

      const sinceTs = getReadAt(uid);

      try {

        const params = new URLSearchParams({

          targetType: 'private',

          targetUid: String(uid),

          type: 'text',

          limit: String(UNREAD_LIMIT),

        });

        if (sinceTs > 0) {

          params.set('sinceTs', String(sinceTs));

        }

        const response = await fetch(`${API_BASE}/api/chat/get?${params.toString()}`, {

          headers: { ...authHeaders() },

        });

        const data = await response.json().catch(() => ({}));

        if (response.ok && data?.success && Array.isArray(data?.data)) {

          const count = data.data.filter((item: any) => item.senderUid !== selfUid).length;

          setUnreadMap((prev) => ({ ...prev, [uid]: Math.min(count, 99) }));

        }

      } catch {}

    },

    [authHeaders, getReadAt, selfUid]

  );



  const loadFriends = useCallback(async () => {

    if (!tokenRef.current) return;

    setLoadingFriends(true);

    try {

      const response = await fetch(`${API_BASE}/api/friends/list`, {

        headers: { ...authHeaders() },

      });

      const data = await response.json().catch(() => ({}));

      if (response.ok && data?.success && Array.isArray(data?.friends)) {

        setFriends(data.friends);

        await Promise.all(

          data.friends.map(async (friend: Friend) => {

            ensureMessageBucket(friend.uid);
            await Promise.all([
              loadLatestForFriend(friend.uid),
              loadUnreadCount(friend.uid),
            ]);

          })

        );

      }

    } catch {}

    setLoadingFriends(false);

  }, [authHeaders, ensureMessageBucket, loadLatestForFriend, loadUnreadCount]);



  const loadHistory = useCallback(

    async (uid: number, { beforeId }: { beforeId?: number | string } = {}) => {

      if (!tokenRef.current) return;

      ensureMessageBucket(uid);

      if (historyLoading[uid]) return;

      setHistoryLoading((prev) => ({ ...prev, [uid]: true }));

      try {

        const params = new URLSearchParams({

          targetType: 'private',

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
          setHistoryHasMore((prev) => ({ ...prev, [uid]: data.data.length >= PAGE_LIMIT }));

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



  const openChat = useCallback(

    async (friend: Friend) => {

      if (!friend) return;

      setActiveChatUid(friend.uid);

      ensureMessageBucket(friend.uid);

      if ((messagesByUidRef.current[friend.uid] || []).length === 0) {

        await loadHistory(friend.uid);

      }

      setTimeout(scrollToBottom, 0);

      markChatRead(friend.uid);

    },

    [ensureMessageBucket, loadHistory, markChatRead, scrollToBottom]

  );

  const openChatFromPayload = useCallback(
    (targetUid: number, paramFriend?: Partial<Friend>) => {
      if (!Number.isFinite(targetUid) || targetUid <= 0) return;
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
          prev.some((item) => item.uid === payloadFriend.uid)
            ? prev
            : [payloadFriend, ...prev],
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
    [friends, openChat],
  );

  useEffect(() => {
    if (!activeChatUid || !bootstrapDone || !tokenReady) return;
    if (autoLoadedChatUidRef.current === activeChatUid) return;
    autoLoadedChatUidRef.current = activeChatUid;
    ensureMessageBucket(activeChatUid);
    void loadHistory(activeChatUid);
    markChatRead(activeChatUid);
  }, [activeChatUid, bootstrapDone, tokenReady, ensureMessageBucket, loadHistory, markChatRead]);

  useEffect(() => {
    if (!activeChatUid) {
      autoLoadedChatUidRef.current = null;
    }
  }, [activeChatUid]);



  useEffect(() => {
    const params = route.params || {};
    const targetUid = Number(params.openChatUid);
    if (!Number.isFinite(targetUid) || targetUid <= 0) return;
    openChatFromPayload(targetUid, params.openChatFriend);
    navigation.setParams({ openChatUid: undefined, openChatFriend: undefined });
  }, [route.params, navigation, openChatFromPayload]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      const loadPending = async () => {
        const pending = await storage.getJson<{
          uid?: number;
          friend?: Partial<Friend>;
        }>(PENDING_OPEN_CHAT_KEY);
        if (cancelled || !pending?.uid) return;
        await storage.remove(PENDING_OPEN_CHAT_KEY);
        openChatFromPayload(Number(pending.uid), pending.friend);
      };
      void loadPending();
      return () => {
        cancelled = true;
      };
    }, [openChatFromPayload]),
  );


  const openContactProfile = useCallback(

    (friend: Friend) => {

      if (!friend) return;

      navigation.navigate('FriendProfile', { uid: friend.uid, friend });

    },

    [navigation]

  );



  const listAnimStyle = useMemo(

    () => ({

      opacity: listAnim,

      transform: [

        {

          translateY: listAnim.interpolate({

            inputRange: [0, 1],

            outputRange: [10, 0],

          }),

        },

      ],

    }),

    [listAnim]

  );



  const closeChat = useCallback(() => {

    if (activeChatUidRef.current) {

      markChatRead(activeChatUidRef.current);

    }

    setActiveChatUid(null);

  }, [markChatRead]);



  const openFoundFriends = useCallback(() => {

    setActiveView('found');

  }, []);



  const closeFoundFriends = useCallback(() => {

    setActiveView('list');

  }, []);



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

    const content = draftMessage.trim();

    if (!content) return;

    const payload = {

      senderUid: selfUid,

      targetUid: activeChatUidRef.current,

      targetType: 'private',

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

      }

    } catch {}

  }, [authHeaders, canSend, draftMessage, insertMessages, scrollToBottom, selfUid]);



  const deleteMessage = useCallback(

    async (uid: number, message: Message) => {

      if (!message?.id) return;

      try {

        const response = await fetch(`${API_BASE}/api/chat/del`, {

          method: 'DELETE',

          headers: { 'Content-Type': 'application/json', ...authHeaders() },

          body: JSON.stringify({ id: message.id }),

        });

        const data = await response.json().catch(() => ({}));

        if (response.ok && data?.success) {

          const currentBucket = messagesByUidRef.current[uid] || [];

          const nextBucket = currentBucket.filter((item) => item.id !== message.id);

          setMessagesByUid((prev) => ({ ...prev, [uid]: nextBucket }));

          const idSet = messageIdSetsRef.current.get(uid);

          if (idSet) {

            idSet.delete(message.id);

          }

          const last = nextBucket[nextBucket.length - 1];

          if (last) {

            updateLatest(uid, last);

          }

          recalcUnread(uid, nextBucket);

        }

      } catch {}

    },

    [authHeaders, recalcUnread, updateLatest]

  );



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

      const idx = prev.findIndex((item) => item.uid === uid);

      if (idx === -1) return prev;

      const next = [...prev];

      next[idx] = { ...next[idx], online: Boolean(online) };

      return next;

    });

  }, []);



  const requestFriendsRefresh = useCallback(() => {

    setFriendsRefreshKey((prev) => prev + 1);

    void loadFriends();

  }, [loadFriends]);



  const handleWsMessage = useCallback(

    (payload: any) => {

      if (!payload || typeof payload !== 'object') return;

      if (payload.type === 'chat') {

        const entry = payload.data;

        if (!entry?.id) return;

        const message = normalizeMessage(entry);

        const friendUid =

          message.senderUid === selfUid ? message.targetUid : message.senderUid;

        insertMessages(friendUid, [entry]);



        if (activeChatUidRef.current === friendUid) {

          markChatRead(friendUid);

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

      markChatRead,

      normalizeMessage,

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

      connectWs();

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



  const teardownWs = useCallback(() => {

    stopHeartbeat();

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

    if (!bootstrapDone || !tokenReady || !tokenRef.current) return;
    const timer = setTimeout(() => {
      void loadProfile();
      void loadFriends();
      connectWs();
    }, REMOTE_BOOTSTRAP_DELAY_MS);

    return () => {
      clearTimeout(timer);
      teardownWs();

    };

  }, [bootstrapDone, tokenReady, connectWs, loadFriends, loadProfile, teardownWs]);



  const messageItems = useMemo(() => {

    const filtered = friends.filter((friend) => !hiddenMap[friend.uid]);

    return filtered

      .map((friend) => {

        const latest = latestMap[friend.uid];

        return {

          friend,

          latest,

          pinned: Boolean(pinnedMap[friend.uid]),

          unread: unreadMap[friend.uid] || 0,

        };

      })

      .sort((a, b) => {

        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;

        const ta = a.latest?.ts || 0;

        const tb = b.latest?.ts || 0;

        return tb - ta;

      });

  }, [friends, hiddenMap, latestMap, pinnedMap, unreadMap]);



  const closeMenu = useCallback(() => {

    setMenuVisible(false);

    setMenuTargetUid(null);

  }, []);



  const openMenu = useCallback((event: any, uid: number) => {

    const { width, height } = Dimensions.get('window');

    const menuWidth = 160;

    const menuHeight = 96;

    const x = Math.min(event.nativeEvent.pageX, width - menuWidth - 10);

    const y = Math.min(event.nativeEvent.pageY, height - menuHeight - 10);

    setMenuPosition({ x, y });

    setMenuTargetUid(uid);

    setMenuVisible(true);

  }, []);



  const togglePin = useCallback(() => {

    if (!menuTargetUid) return;

    setPinnedMap((prev) => {

      const next = { ...prev, [menuTargetUid]: !prev[menuTargetUid] };

      if (!next[menuTargetUid]) {

        delete next[menuTargetUid];

      }

      void persistPinnedMap(next);

      return next;

    });

    closeMenu();

  }, [closeMenu, menuTargetUid, persistPinnedMap]);



  const deleteChat = useCallback(async () => {

    if (!menuTargetUid) return;

    const uid = menuTargetUid;

    closeMenu();



    const deleteBatch = async (beforeId?: number | string) => {

      const params = new URLSearchParams({

        targetType: 'private',

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

      if (!response.ok || !data?.success || !Array.isArray(data?.data)) {

        return { done: true, lastId: null as null | number | string };

      }

      const list = data.data;

      for (const item of list) {

        if (!item?.id) continue;

        await fetch(`${API_BASE}/api/chat/del`, {

          method: 'DELETE',

          headers: { 'Content-Type': 'application/json', ...authHeaders() },

          body: JSON.stringify({ id: item.id }),

        }).catch(() => undefined);

      }

      if (list.length < PAGE_LIMIT) {

        return { done: true, lastId: null as null | number | string };

      }

      return { done: false, lastId: list[0]?.id || null };

    };



    let beforeId: number | string | null = undefined;

    for (;;) {

      const result = await deleteBatch(beforeId || undefined);

      if (result.done || !result.lastId) break;

      beforeId = result.lastId;

    }



    setHiddenMap((prev) => {

      const next = { ...prev, [uid]: true };

      void persistHiddenMap(next);

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

  }, [authHeaders, closeMenu, menuTargetUid, persistHiddenMap]);



  return (

    <View style={[styles.page, { paddingTop: insets.top }]}>

      {activeView === 'found' && !activeChatUid ? (
        <Animated.View style={[styles.foundWrapper, listAnimStyle]}>
          <FoundFriends
            friends={friends}
            selfUid={selfUid || null}
            refreshKey={friendsRefreshKey}
            onBack={closeFoundFriends}
            onRefreshFriends={requestFriendsRefresh}
          />
        </Animated.View>
      ) : null}



      {activeChatUid ? (
        <Animated.View style={[styles.chatScreen, listAnimStyle]}>
          <KeyboardAvoidingView
            style={[styles.chatScreen, { paddingBottom: Platform.OS === 'android' ? keyboardHeight : 0 }]}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 44 : 0}
          >
            <View style={styles.chatHeader}>

            <Pressable style={styles.chatBack} onPress={closeChat}>

              <BackIcon />

            </Pressable>

            <View>

              <Text style={styles.chatName}>

                {activeChatFriend?.nickname || activeChatFriend?.username || '聊天'}

              </Text>

              <Text style={[styles.chatStatus, activeChatFriend?.online && styles.chatOnline]}>

                {activeChatFriend?.online ? '在线' : '离线'}

              </Text>

            </View>

          </View>



          <ScrollView

            ref={messageListRef}

            style={styles.chatBody}

            onScroll={onChatScroll}
            onScrollBeginDrag={closeBubbleMenu}

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

            {historyHasMore[activeChatUid] ? (

              <Text style={styles.loadMore}>

                {historyLoading[activeChatUid] ? '加载更多...' : '上拉加载更多'}

              </Text>

            ) : null}

            {activeChatMessages.map((item) => {

              const isSelf = item.senderUid === selfUid;

              const anim = getMessageAnim(item.id);
              const bubbleAnimStyle = {
                opacity: anim,
                transform: [
                  {
                    translateY: anim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [8, 0],
                    }),
                  },
                  {
                    scale: anim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.98, 1],
                    }),
                  },
                ],
              };

              return (

                <Animated.View key={String(item.id)} style={bubbleAnimStyle}>
                  <View style={[styles.messageRow, isSelf && styles.selfRow]}>

                  <Pressable
                    ref={(node) => {
                      if (node) {
                        bubbleRefMap.current.set(String(item.id), node);
                      } else {
                        bubbleRefMap.current.delete(String(item.id));
                      }
                    }}
                    delayLongPress={260}
                    onLongPress={() => openBubbleMenu(item)}
                    style={[styles.bubble, isSelf && styles.selfBubble]}
                  >

                    <Text style={[styles.messageText, isSelf && styles.selfText]}>

                      {item.content}

                    </Text>

                    <View style={styles.meta}>

                      <Text style={[styles.metaText, isSelf && styles.selfMeta]}>

                        {formatTime(item.createdAt, item.createdAtMs)}

                      </Text>

                    </View>

                  </Pressable>

                </View>
              </Animated.View>

              );

            })}

          </ScrollView>



            <View style={[styles.chatInput, { paddingBottom: 12 + insets.bottom }]}>

            <TextInput

              value={draftMessage}

              placeholder="输入消息..."

              placeholderTextColor="#b0b0b0"

              onChangeText={setDraftMessage}

              style={styles.chatInputField}

              onSubmitEditing={sendText}

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

            {bubbleMenuVisible && bubbleMenuMessage ? (
              <View style={styles.bubbleMenuOverlay}>
                <Pressable style={styles.bubbleMenuBackdrop} onPress={closeBubbleMenu} />
                <Animated.View
                  onLayout={handleBubbleMenuLayout}
                  style={[
                    styles.bubbleMenuPanel,
                    {
                      left: bubbleMenuPosition.x,
                      top: bubbleMenuPosition.y,
                      opacity: bubbleMenuAnim,
                      transform: [
                        {
                          scale: bubbleMenuAnim.interpolate({
                            inputRange: [0, 1],
                            outputRange: [0.9, 1],
                          }),
                        },
                      ],
                    },
                  ]}
                >
                  <Pressable style={styles.bubbleMenuItem} onPress={closeBubbleMenu}>
                    <Text style={styles.bubbleMenuText}>复制</Text>
                  </Pressable>
                  <View style={styles.bubbleMenuDivider} />
                  <Pressable
                    style={styles.bubbleMenuItem}
                    onPress={() => {
                      const uid = activeChatUidRef.current;
                      if (uid && bubbleMenuMessage) {
                        deleteMessage(uid, bubbleMenuMessage);
                      }
                      closeBubbleMenu();
                    }}
                  >
                    <Text style={[styles.bubbleMenuText, styles.bubbleMenuDangerText]}>删除</Text>
                  </Pressable>
                  <View style={styles.bubbleMenuDivider} />
                  <Pressable style={styles.bubbleMenuItem} onPress={closeBubbleMenu}>
                    <Text style={styles.bubbleMenuText}>取消</Text>
                  </Pressable>
                </Animated.View>
              </View>
            ) : null}
          </KeyboardAvoidingView>
        </Animated.View>
      ) : null}



      {!activeChatUid && activeView !== 'found' ? (

        <Animated.View style={[styles.home, listAnimStyle]}>

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

            <Pressable style={styles.headerRight} onPress={openFoundFriends}>

              <Svg viewBox="0 0 24 24" width={26} height={26} fill="none" stroke="#1a1a1a" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">

                <Line x1="12" y1="5" x2="12" y2="19" />

                <Line x1="5" y1="12" x2="19" y2="12" />

              </Svg>

            </Pressable>

          </View>



          <View style={styles.searchContainer}>

            <View style={styles.searchBox}>

              <Svg viewBox="0 0 24 24" width={16} height={16}>

                <Path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" fill="#a0a0a0" />

              </Svg>

              <Text style={styles.searchText}>搜索</Text>

            </View>

          </View>



          {homeTab === 'messages' ? (

            <Animated.ScrollView

              style={styles.msgList}

              contentContainerStyle={styles.msgListInner}

            >

              {!bootstrapDone ? <Text style={styles.empty}>Loading...</Text> : null}
              {bootstrapDone && loadingFriends && messageItems.length === 0 ? (
                <Text style={styles.empty}>正在加载消息...</Text>
              ) : null}

              {bootstrapDone && !loadingFriends && messageItems.length === 0 ? (

                <Text style={styles.empty}>暂无消息</Text>

              ) : null}

              {bootstrapDone &&
                messageItems.map(({ friend, latest, pinned, unread }) => (

                  <Pressable

                    key={friend.uid}

                    style={[styles.msgItem, pinned && styles.msgItemPinned]}

                    onPress={() => openChat(friend)}

                    onLongPress={(event) => openMenu(event, friend.uid)}

                  >

                    <View style={styles.avatarBox}>

                      <View style={styles.contactAvatar}>

                        {normalizeImageUrl(friend.avatar) ? (

                          <Image

                            source={{ uri: normalizeImageUrl(friend.avatar) }}

                            style={styles.contactAvatarImg}

                          />

                        ) : (

                          <Text style={styles.avatarText}>

                            {getAvatarText(friend.nickname || friend.username)}

                          </Text>

                        )}

                        <View style={[styles.presence, friend.online && styles.presenceOnline]} />

                      </View>

                      {unread > 0 ? (

                        <View style={styles.badge}>

                          <Text style={styles.badgeText}>

                            {unread > 99 ? '99+' : unread}

                          </Text>

                        </View>

                      ) : null}

                    </View>

                    <View style={styles.msgContentWrapper}>

                      <View style={styles.msgTopRow}>

                        <Text style={styles.msgNickname} numberOfLines={1}>

                          {friend.nickname || friend.username || '联系人'}

                        </Text>

                        <Text style={styles.msgTime}>{latest?.time || ''}</Text>

                      </View>

                      <Text style={styles.msgPreview} numberOfLines={1}>

                        {latest?.text || '暂无消息'}

                      </Text>

                    </View>

                  </Pressable>

                ))}

            </Animated.ScrollView>

          ) : (

            <Animated.ScrollView

              style={styles.content}

              contentContainerStyle={styles.contentInner}

            >

              {!bootstrapDone ? <Text style={styles.empty}>Loading...</Text> : null}
              {bootstrapDone && loadingFriends && friends.length === 0 ? (
                <Text style={styles.empty}>正在加载联系人...</Text>
              ) : null}

              {bootstrapDone && !loadingFriends && friends.length === 0 ? (

                <Text style={styles.empty}>暂无联系人</Text>

              ) : null}

              {bootstrapDone && friends.length > 0

                ? friends.map((friend) => (

                    <Pressable

                      key={friend.uid}

                      style={styles.contactItem}

                      onPress={() => openContactProfile(friend)}

                    >

                      <View style={styles.contactAvatar}>

                        {normalizeImageUrl(friend.avatar) ? (

                          <Image

                            source={{ uri: normalizeImageUrl(friend.avatar) }}

                            style={styles.contactAvatarImg}

                          />

                        ) : (

                          <Text style={styles.avatarText}>

                            {getAvatarText(friend.nickname || friend.username)}

                          </Text>

                        )}

                        <View style={[styles.presence, friend.online && styles.presenceOnline]} />

                      </View>

                      <View style={styles.contactInfo}>

                        <Text style={styles.contactName}>

                          {friend.nickname || friend.username || '联系人'}

                        </Text>

                      </View>

                    </Pressable>

                  ))

                : null}

            </Animated.ScrollView>

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

              <Svg viewBox="0 0 24 24" width={28} height={28} fill={homeTab === 'messages' ? '#0099ff' : '#7d7d7d'}>

                <Path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />

              </Svg>

              <Text style={[styles.navText, homeTab === 'messages' && styles.navTextActive]}>消息</Text>

            </Pressable>

            <Pressable

              style={[

                styles.navItem,

                homeTab === 'contacts' && styles.navItemActive,

              ]}

              onPress={() => setHomeTab('contacts')}

            >

              <Svg viewBox="0 0 24 24" width={28} height={28} fill={homeTab === 'contacts' ? '#0099ff' : '#7d7d7d'}>

                <Path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />

              </Svg>

              <Text style={[styles.navText, homeTab === 'contacts' && styles.navTextActive]}>联系人</Text>

            </Pressable>

          </View>

        </Animated.View>

      ) : null}



      {menuVisible && menuTargetUid ? (

        <View style={styles.menuOverlay}>

          <Pressable style={styles.menuBackdrop} onPress={closeMenu} />

          <View style={[styles.menuPanel, { left: menuPosition.x, top: menuPosition.y }]}>

            <Pressable style={styles.menuItem} onPress={togglePin}>

              <Text style={styles.menuText}>

                {pinnedMap[menuTargetUid] ? '取消置顶' : '置顶该聊天'}

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

    backgroundColor: '#f5f6fa',

  },
  chatScreen: {

    flex: 1,

  },

  foundWrapper: {

    flex: 1,

  },

  home: {

    flex: 1,

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

  },

  searchText: {

    fontSize: 15,

    color: '#8a8a8a',

  },

  content: {

    flex: 1,

  },

  contentInner: {

    paddingHorizontal: 16,

    paddingBottom: 12,

  },

  msgList: {

    flex: 1,

    backgroundColor: '#f5f6fa',

  },

  msgListInner: {
    paddingBottom: 20,
    paddingHorizontal: 16,
  },
  msgItem: {

    flexDirection: 'row',

    alignItems: 'center',

    padding: 12,

    marginBottom: 10,

    backgroundColor: '#fff',

    borderRadius: 12,

  },

  msgItemPinned: {

    backgroundColor: '#eef2f6',

  },

  avatarBox: {

    position: 'relative',

    marginRight: 12,

  },

  msgAvatar: {

    width: 42,

    height: 42,

    borderRadius: 21,

    resizeMode: 'cover',

    borderWidth: 1,

    borderColor: 'rgba(0,0,0,0.03)',

  },

  msgAvatarFallback: {

    width: 42,

    height: 42,

    borderRadius: 21,

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

  navItemActive: {},

  navText: {

    fontSize: 10,

    color: '#7d7d7d',

    fontWeight: '500',

  },

  navTextActive: {

    color: '#0099ff',

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

    overflow: 'hidden',

  },

  contactAvatarImg: {

    width: 42,

    height: 42,

    borderRadius: 21,

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

  contactMeta: {

    alignItems: 'flex-end',

    gap: 6,

  },

  contactTime: {

    fontSize: 11,

    color: '#9a9a9a',

  },

  unreadBadge: {

    backgroundColor: '#ff4d4f',

    borderRadius: 10,

    paddingHorizontal: 6,

    paddingVertical: 2,

  },

  unreadText: {

    color: '#fff',

    fontSize: 10,

    fontWeight: '700',

  },

  empty: {

    textAlign: 'center',

    color: '#9a9a9a',

    fontSize: 12,

    paddingVertical: 12,

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

    shadowColor: '#000',

    shadowOpacity: 0.2,

    shadowOffset: { width: 0, height: 8 },

    shadowRadius: 24,

    elevation: 6,

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

  bubbleMenuOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 120,
  },

  bubbleMenuBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },

  bubbleMenuPanel: {
    position: 'absolute',
    width: BUBBLE_MENU_WIDTH,
    backgroundColor: '#fff',
    borderRadius: 12,
    overflow: 'hidden',
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: '#e6e6e6',
  },

  bubbleMenuItem: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
  },

  bubbleMenuText: {
    fontSize: 14,
    color: '#1a1a1a',
    fontWeight: '600',
  },

  bubbleMenuDangerText: {
    color: '#ff4d4f',
  },

  bubbleMenuDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: '#e6e6e6',
    marginVertical: 6,
  },

  chatHeader: {

    flexDirection: 'row',

    alignItems: 'center',

    gap: 12,

    paddingHorizontal: 16,

    paddingVertical: 12,

    backgroundColor: '#f5f6fa',

  },

  chatBack: {

    width: 32,

    height: 32,

    alignItems: 'center',

    justifyContent: 'center',

  },

  backChevron: {

    fontSize: 26,

    color: '#333',

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

    paddingHorizontal: 16,

    paddingTop: 10,

  },

  loadMore: {

    textAlign: 'center',

    fontSize: 11,

    color: '#9a9a9a',

    marginBottom: 10,

  },

  messageRow: {

    flexDirection: 'row',

    alignItems: 'flex-end',

    gap: 8,

    marginBottom: 12,

  },

  selfRow: {

    flexDirection: 'row-reverse',

  },

  bubble: {

    maxWidth: '70%',

    backgroundColor: '#fff',

    borderRadius: 12,

    padding: 10,

  },

  selfBubble: {

    backgroundColor: '#4a9df8',

  },

  messageText: {

    fontSize: 14,

    color: '#1a1a1a',

  },

  selfText: {

    color: '#fff',

  },

  meta: {

    marginTop: 6,

    flexDirection: 'row',

    gap: 8,

  },

  metaText: {

    fontSize: 10,

    color: 'rgba(0,0,0,0.45)',

  },

  selfMeta: {

    color: 'rgba(255,255,255,0.7)',

  },

  readState: {

    fontSize: 10,

    color: '#2f6bd9',

    fontWeight: '600',

  },


  chatInput: {

    flexDirection: 'row',

    gap: 8,

    padding: 12,

    borderTopWidth: 1,

    borderTopColor: 'rgba(0,0,0,0.05)',

    backgroundColor: '#fff',

  },

  chatInputField: {

    flex: 1,

    borderWidth: 1,

    borderColor: '#e1e1e1',

    borderRadius: 20,

    paddingHorizontal: 14,

    paddingVertical: 6,

    fontSize: 14,

    color: '#333',

  },

  sendBtn: {

    backgroundColor: '#4a9df8',

    borderRadius: 16,

    paddingHorizontal: 14,

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



function BackIcon() {

  return (

    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">

      <Path

        d="M15 18L9 12L15 6"

        stroke="currentColor"

        strokeWidth={2}

        strokeLinecap="round"

        strokeLinejoin="round"

      />

    </Svg>

  );

}










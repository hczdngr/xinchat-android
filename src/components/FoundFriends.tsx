import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  BackHandler,
  Dimensions,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { API_BASE } from '../config';
import { STORAGE_KEYS } from '../constants/storageKeys';
import { storage } from '../storage';

type Friend = {
  uid: number;
  username?: string;
  nickname?: string;
  avatar?: string;
  online?: boolean;
};

type Request = {
  uid: number;
  username?: string;
  avatar?: string;
  status?: string;
};

type Props = {
  friends: Friend[];
  selfUid: number | null;
  refreshKey: number;
  onBack: () => void;
  onRefreshFriends: () => void;
};

export default function FoundFriends({
  friends,
  selfUid,
  refreshKey,
  onBack,
  onRefreshFriends,
}: Props) {
  const appear = useRef(new Animated.Value(0)).current;
  const isLeaving = useRef(false);
  const [activeTab, setActiveTab] = useState<'search' | 'requests'>('search');
  const [searchUid, setSearchUid] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchResult, setSearchResult] = useState<any>(null);
  const [requestStatus, setRequestStatus] = useState('');

  const [requestsLoading, setRequestsLoading] = useState(false);
  const [incomingRequests, setIncomingRequests] = useState<Request[]>([]);
  const [outgoingRequests, setOutgoingRequests] = useState<Request[]>([]);
  const [requestsError, setRequestsError] = useState('');

  const runExit = useCallback(() => {
    if (isLeaving.current) return;
    isLeaving.current = true;
    Animated.timing(appear, {
      toValue: 0,
      duration: 180,
      useNativeDriver: true,
    }).start(() => {
      onBack();
    });
  }, [appear, onBack]);
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (evt, gestureState) => {
        const { width } = Dimensions.get('window');
        const edgeSize = 20;
        const x = evt.nativeEvent.pageX;
        const isEdge = x <= edgeSize || x >= width - edgeSize;
        return isEdge && Math.abs(gestureState.dx) > 12 && Math.abs(gestureState.dy) < 24;
      },
      onPanResponderRelease: (_, gestureState) => {
        if (Math.abs(gestureState.dx) >= 30) {
          runExit();
        }
      },
    })
  ).current;

  const friendUidSet = useMemo(() => new Set((friends || []).map((f) => f.uid)), [friends]);
  const outgoingPendingSet = useMemo(
    () =>
      new Set(
        (outgoingRequests || [])
          .filter((item) => item.status === 'pending')
          .map((item) => item.uid)
      ),
    [outgoingRequests]
  );
  const incomingPendingSet = useMemo(
    () =>
      new Set(
        (incomingRequests || [])
          .filter((item) => item.status === 'pending')
          .map((item) => item.uid)
      ),
    [incomingRequests]
  );

  const searchHint = useMemo(() => {
    if (!searchResult) return '';
    const uid = searchResult.uid;
    if (friendUidSet.has(uid)) return '已是好友';
    if (outgoingPendingSet.has(uid)) return '请求已发送';
    if (incomingPendingSet.has(uid)) return '对方已请求你';
    return '';
  }, [friendUidSet, incomingPendingSet, outgoingPendingSet, searchResult]);

  const authHeaders = useCallback(async () => {
    const token = await storage.getString(STORAGE_KEYS.token);
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, []);

  const resetSearch = () => {
    setSearchError('');
    setRequestStatus('');
    setSearchResult(null);
  };

  const loadRequests = useCallback(async () => {
    setRequestsLoading(true);
    setRequestsError('');
    try {
      const response = await fetch(`${API_BASE}/api/friends/requests`, {
        headers: { ...(await authHeaders()) },
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.success) {
        setIncomingRequests(Array.isArray(data?.incoming) ? data.incoming : []);
        setOutgoingRequests(Array.isArray(data?.outgoing) ? data.outgoing : []);
      } else {
        setRequestsError(data?.message || '请求列表加载失败。');
      }
    } catch {
      setRequestsError('网络错误，请稍后重试。');
    }
    setRequestsLoading(false);
  }, [authHeaders]);

  const onSearch = async () => {
    const raw = searchUid.trim();
    resetSearch();
    if (!raw) {
      setSearchError('请输入 UID。');
      return;
    }
    const uid = Number(raw);
    if (!Number.isInteger(uid)) {
      setSearchError('UID 需要是数字。');
      return;
    }
    setSearching(true);
    try {
      const params = new URLSearchParams({ uid: String(uid) });
      const response = await fetch(`${API_BASE}/api/friends/search?${params.toString()}`, {
        headers: { ...(await authHeaders()) },
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.success && data?.user) {
        setSearchResult(data.user);
        if (data.user.uid === selfUid) {
          setSearchError('不能添加自己。');
        }
      } else {
        setSearchError(data?.message || '未找到该用户。');
      }
    } catch {
      setSearchError('网络错误，请稍后重试。');
    }
    setSearching(false);
  };

  const sendRequest = async () => {
    if (!searchResult) return;
    setRequestStatus('');
    const uid = searchResult.uid;
    if (uid === selfUid) {
      setRequestStatus('不能添加自己。');
      return;
    }
    if (friendUidSet.has(uid)) {
      setRequestStatus('已经是好友了。');
      return;
    }
    if (outgoingPendingSet.has(uid)) {
      setRequestStatus('请求已发送。');
      return;
    }
    try {
      const response = await fetch(`${API_BASE}/api/friends/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ friendUid: uid }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.success) {
        if (data.status === 'accepted') {
          setRequestStatus('已互为好友。');
          onRefreshFriends();
        } else if (data.status === 'pending') {
          setRequestStatus('请求已发送。');
        } else if (data.status === 'already_friends') {
          setRequestStatus('已经是好友了。');
        } else {
          setRequestStatus('已提交请求。');
        }
        await loadRequests();
      } else {
        setRequestStatus(data?.message || '发送失败。');
      }
    } catch {
      setRequestStatus('网络错误，请稍后重试。');
    }
  };

  const respondRequest = async (uid: number, action: 'accept' | 'reject') => {
    try {
      const response = await fetch(`${API_BASE}/api/friends/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ requesterUid: uid, action }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.success) {
        await loadRequests();
        onRefreshFriends();
      } else {
        setRequestsError(data?.message || '处理失败。');
      }
    } catch {
      setRequestsError('网络错误，请稍后重试。');
    }
  };


  useEffect(() => {
    loadRequests().catch(() => undefined);
  }, [loadRequests, refreshKey]);

  useEffect(() => {
    Animated.timing(appear, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [appear]);

  useEffect(() => {
    const handler = () => {
      runExit();
      return true;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', handler);
    return () => sub.remove();
  }, [runExit]);

  return (
    <Animated.View
      style={[
        styles.page,
        {
          opacity: appear,
          transform: [
            {
              translateX: appear.interpolate({
                inputRange: [0, 1],
                outputRange: [18, 0],
              }),
            },
          ],
        },
      ]}
      {...panResponder.panHandlers}
    >
      <Pressable style={styles.edgeLeft} onPress={runExit} />
      <Pressable style={styles.edgeRight} onPress={runExit} />
      <View style={styles.header}>
        <Pressable onPress={runExit} style={styles.backBtn}>
          <BackIcon />
        </Pressable>
        <Text style={styles.title}>发现好友</Text>
      </View>

      <View style={styles.tabs}>
        <Pressable
          onPress={() => setActiveTab('search')}
          style={[styles.tab, activeTab === 'search' && styles.tabActive]}
        >
          <Text style={[styles.tabText, activeTab === 'search' && styles.tabTextActive]}>
            搜索
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setActiveTab('requests')}
          style={[styles.tab, activeTab === 'requests' && styles.tabActive]}
        >
          <Text style={[styles.tabText, activeTab === 'requests' && styles.tabTextActive]}>
            请求
          </Text>
        </Pressable>
      </View>

      <ScrollView style={styles.panel}>
        {activeTab === 'search' ? (
          <>
            <View style={styles.searchCard}>
              <TextInput
                value={searchUid}
                placeholder="输入好友 UID"
                placeholderTextColor="#999"
                selectionColor="#333"
                onChangeText={setSearchUid}
                style={styles.searchInput}
                keyboardType="numeric"
              />
              <Pressable style={styles.searchBtn} onPress={onSearch} disabled={searching}>
                <Text style={styles.searchBtnText}>{searching ? '搜索中...' : '搜索'}</Text>
              </Pressable>
            </View>
            {searchError ? <Text style={styles.error}>{searchError}</Text> : null}
            {searchResult ? (
              <View style={styles.resultCard}>
                <View style={styles.resultInfo}>
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>
                      {String(searchResult.username || searchResult.uid).slice(0, 2)}
                    </Text>
                  </View>
                  <View>
                    <Text style={styles.resultName}>{searchResult.username}</Text>
                    <Text style={styles.resultId}>UID {searchResult.uid}</Text>
                    {searchHint ? <Text style={styles.hint}>{searchHint}</Text> : null}
                  </View>
                </View>
                <Pressable
                  style={styles.actionBtn}
                  onPress={sendRequest}
                  disabled={Boolean(searchHint) || searchResult.uid === selfUid}
                >
                  <Text style={styles.actionText}>发送请求</Text>
                </Pressable>
                {requestStatus ? <Text style={styles.success}>{requestStatus}</Text> : null}
              </View>
            ) : null}
          </>
        ) : null}

        {activeTab === 'requests' ? (
          <>
            <Text style={styles.sectionTitle}>待处理</Text>
            {requestsError ? <Text style={styles.error}>{requestsError}</Text> : null}
            {requestsLoading ? <Text style={styles.empty}>正在加载请求...</Text> : null}
            {!requestsLoading && incomingRequests.length === 0 ? (
              <Text style={styles.empty}>暂无待处理请求</Text>
            ) : null}
            {!requestsLoading &&
              incomingRequests.map((item) => (
                <View key={item.uid} style={styles.row}>
                  <View>
                    <Text style={styles.rowName}>{item.username}</Text>
                    <Text style={styles.rowSub}>UID {item.uid}</Text>
                  </View>
                  <View style={styles.rowActions}>
                    <Pressable onPress={() => respondRequest(item.uid, 'accept')}>
                      <Text style={styles.primaryBtn}>同意</Text>
                    </Pressable>
                    <Pressable onPress={() => respondRequest(item.uid, 'reject')}>
                      <Text style={styles.ghostBtn}>拒绝</Text>
                    </Pressable>
                  </View>
                </View>
              ))}

            <Text style={styles.sectionTitle}>我发出的</Text>
            {outgoingRequests.length === 0 ? (
              <Text style={styles.empty}>暂无已发送请求</Text>
            ) : null}
            {outgoingRequests.map((item) => (
              <View key={item.uid} style={styles.row}>
                <View>
                  <Text style={styles.rowName}>{item.username}</Text>
                  <Text style={styles.rowSub}>UID {item.uid}</Text>
                </View>
                <Text style={styles.rowSub}>
                  {item.status === 'pending'
                    ? '等待处理'
                    : item.status === 'rejected'
                      ? '已拒绝'
                      : '已处理'}
                </Text>
              </View>
            ))}
          </>
        ) : null}

      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: '#f5f6fa',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#f5f6fa',
  },
  backBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backText: {
    fontSize: 24,
    color: '#333',
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  tabs: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  tab: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingVertical: 8,
    alignItems: 'center',
  },
  tabActive: {
    backgroundColor: '#4a9df8',
  },
  tabText: {
    color: '#666',
    fontSize: 13,
  },
  tabTextActive: {
    color: '#fff',
    fontWeight: '600',
  },
  panel: {
    flex: 1,
    paddingHorizontal: 16,
  },
  searchCard: {
    flexDirection: 'row',
    gap: 10,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 12,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: '#333',
  },
  searchBtn: {
    backgroundColor: '#4a9df8',
    borderRadius: 10,
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  searchBtnText: {
    color: '#fff',
    fontSize: 13,
  },
  resultCard: {
    marginTop: 16,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    gap: 10,
  },
  resultInfo: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#e6eaf0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#4a9df8',
  },
  resultName: {
    fontSize: 14,
    fontWeight: '600',
  },
  resultId: {
    fontSize: 12,
    color: '#888',
  },
  hint: {
    fontSize: 11,
    color: '#ff7a45',
  },
  actionBtn: {
    backgroundColor: '#4a9df8',
    borderRadius: 10,
    paddingVertical: 8,
    alignItems: 'center',
  },
  actionText: {
    color: '#fff',
    fontSize: 13,
  },
  sectionTitle: {
    marginTop: 10,
    marginBottom: 8,
    fontSize: 13,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  row: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 10,
    marginBottom: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  rowName: {
    fontSize: 13,
    fontWeight: '600',
  },
  rowSub: {
    fontSize: 11,
    color: '#888',
  },
  rowActions: {
    flexDirection: 'row',
    gap: 8,
  },
  primaryBtn: {
    color: '#4a9df8',
    fontWeight: '600',
  },
  ghostBtn: {
    color: '#666',
  },
  error: {
    color: '#b5482b',
    fontSize: 12,
    marginTop: 6,
  },
  success: {
    color: '#2f6bd9',
    fontSize: 12,
    marginTop: 6,
  },
  empty: {
    textAlign: 'center',
    color: '#9a9a9a',
    fontSize: 12,
    paddingVertical: 12,
  },
  edgeLeft: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 20,
    zIndex: 5,
  },
  edgeRight: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 20,
    zIndex: 5,
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

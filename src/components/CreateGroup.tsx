import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { API_BASE } from '../config';
import { STORAGE_KEYS } from '../constants/storageKeys';
import type { CreateGroupRoute, RootNavigation } from '../navigation/types';
import { storage } from '../storage';

type Friend = {
  uid: number;
  username?: string;
  nickname?: string;
  avatar?: string;
  signature?: string;
  online?: boolean;
};

type GroupPreview = {
  id: number;
  name?: string;
  ownerUid?: number;
  memberUids?: number[];
  members?: Friend[];
};

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
  (Array.isArray(list) ? list : []).forEach((item) => {
    const friend = normalizeFriend(item);
    if (!friend || seen.has(friend.uid)) return;
    seen.add(friend.uid);
    next.push(friend);
  });
  return next;
};

export default function CreateGroup() {
  const navigation = useNavigation<RootNavigation>();
  const route = useRoute<CreateGroupRoute>();
  const insets = useSafeAreaInsets();
  const preselectedUids = useMemo(() => {
    const raw = Array.isArray(route.params?.preselectedMemberUids)
      ? route.params?.preselectedMemberUids
      : [];
    const set = new Set<number>();
    raw.forEach((item) => {
      const uid = Number(item);
      if (!Number.isInteger(uid) || uid <= 0) return;
      set.add(uid);
    });
    return Array.from(set);
  }, [route.params?.preselectedMemberUids]);
  const requiredUidSet = useMemo(() => new Set(preselectedUids), [preselectedUids]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [selectedUids, setSelectedUids] = useState<number[]>(preselectedUids);

  const selectedSet = useMemo(() => new Set(selectedUids), [selectedUids]);

  useEffect(() => {
    if (preselectedUids.length === 0) return;
    setSelectedUids((prev) => {
      const nextSet = new Set(prev);
      preselectedUids.forEach((uid) => nextSet.add(uid));
      return Array.from(nextSet);
    });
  }, [preselectedUids]);

  const loadFriends = useCallback(async () => {
    setLoading(true);
    const token = (await storage.getString(STORAGE_KEYS.token)) || '';
    if (!token) {
      setFriends([]);
      setLoading(false);
      return;
    }
    try {
      const response = await fetch(`${API_BASE}/api/friends/list`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.success && Array.isArray(data?.friends)) {
        const nextFriends = sanitizeFriends(data.friends);
        setFriends(nextFriends);
        const friendUidSet = new Set(nextFriends.map((item) => item.uid));
        setSelectedUids((prev) => {
          const nextSet = new Set<number>();
          prev.forEach((uid) => {
            if (friendUidSet.has(uid)) nextSet.add(uid);
          });
          preselectedUids.forEach((uid) => {
            if (friendUidSet.has(uid)) nextSet.add(uid);
          });
          return Array.from(nextSet);
        });
      } else {
        setFriends([]);
      }
    } catch {
      setFriends([]);
    }
    setLoading(false);
  }, [preselectedUids]);

  useEffect(() => {
    loadFriends().catch(() => undefined);
  }, [loadFriends]);

  const toggleUid = useCallback((uid: number) => {
    setSelectedUids((prev) => {
      if (requiredUidSet.has(uid)) {
        return prev;
      }
      if (prev.includes(uid)) {
        return prev.filter((item) => item !== uid);
      }
      return [...prev, uid];
    });
  }, [requiredUidSet]);

  const createGroup = useCallback(async () => {
    const submitMemberUids = Array.from(new Set([...selectedUids, ...preselectedUids]));
    if (creating || submitMemberUids.length === 0) return;
    setCreating(true);
    const token = (await storage.getString(STORAGE_KEYS.token)) || '';
    if (!token) {
      setCreating(false);
      Alert.alert('创建失败', '请先登录后再试。');
      return;
    }
    try {
      const response = await fetch(`${API_BASE}/api/groups/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ memberUids: submitMemberUids }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success || !data?.group) {
        Alert.alert('创建失败', data?.message || '创建群聊失败，请稍后重试。');
        return;
      }
      const group: GroupPreview = data.group;
      await storage.setJson(STORAGE_KEYS.pendingOpenChat, {
        uid: group.id,
        targetType: 'group',
        group,
      });
      navigation.goBack();
    } catch {
      Alert.alert('创建失败', '网络异常，请稍后重试。');
    } finally {
      setCreating(false);
    }
  }, [creating, navigation, preselectedUids, selectedUids]);

  return (
    <View style={[styles.page, { paddingTop: insets.top, paddingBottom: insets.bottom + 10 }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => navigation.goBack()}>
          <BackIcon />
        </Pressable>
        <Text style={styles.title}>创建群聊</Text>
        <View style={styles.rightSpace} />
      </View>

      <View style={styles.tipWrap}>
        <Text style={styles.tipText}>按加入顺序命名，默认群名自动生成</Text>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listInner}>
        {loading ? <ActivityIndicator size="small" color="#3a9bff" /> : null}
        {!loading && friends.length === 0 ? <Text style={styles.empty}>暂无可选好友</Text> : null}
        {!loading &&
          friends.map((friend) => {
            const checked = selectedSet.has(friend.uid);
            const required = requiredUidSet.has(friend.uid);
            return (
              <Pressable
                key={friend.uid}
                style={[
                  styles.item,
                  checked && !required && styles.itemChecked,
                  checked && required && styles.itemRequiredChecked,
                ]}
                onPress={() => toggleUid(friend.uid)}
              >
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>
                    {(friend.nickname || friend.username || '友').slice(0, 2)}
                  </Text>
                </View>
                <View style={styles.info}>
                  <Text style={styles.name}>{friend.nickname || friend.username || `用户${friend.uid}`}</Text>
                  {friend.signature ? (
                    <Text style={styles.signature} numberOfLines={1}>
                      {friend.signature}
                    </Text>
                  ) : null}
                </View>
                <View
                  style={[
                    styles.checkOuter,
                    checked && !required && styles.checkOuterOn,
                    checked && required && styles.checkOuterRequiredOn,
                  ]}
                >
                  {checked ? (
                    <View style={[styles.checkInner, required && styles.checkInnerRequired]} />
                  ) : null}
                </View>
              </Pressable>
            );
          })}
      </ScrollView>

      <View style={styles.footer}>
        <Text style={styles.countText}>已选择 {selectedUids.length} 人</Text>
        <Pressable
          style={[styles.createBtn, (selectedUids.length === 0 || creating) && styles.createBtnDisabled]}
          disabled={selectedUids.length === 0 || creating}
          onPress={createGroup}
        >
          <Text style={styles.createBtnText}>{creating ? '创建中...' : '创建群聊'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function BackIcon() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path
        d="M15 18L9 12L15 6"
        stroke="#2f3a48"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: '#f4f6fb',
  },
  header: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
  },
  backBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 16,
    color: '#253244',
    fontWeight: '600',
  },
  rightSpace: {
    width: 34,
    height: 34,
  },
  tipWrap: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  tipText: {
    fontSize: 12,
    color: '#8090a6',
  },
  list: {
    flex: 1,
  },
  listInner: {
    paddingHorizontal: 12,
    gap: 8,
    paddingBottom: 10,
  },
  empty: {
    textAlign: 'center',
    color: '#96a1b2',
    fontSize: 13,
    paddingVertical: 16,
  },
  item: {
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#edf1f6',
  },
  itemChecked: {
    borderColor: '#8ec2ff',
    backgroundColor: '#f5f9ff',
  },
  itemRequiredChecked: {
    borderColor: '#d7dde8',
    backgroundColor: '#f6f7fa',
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#e6edf7',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  avatarText: {
    color: '#2f6bd9',
    fontSize: 13,
    fontWeight: '700',
  },
  info: {
    flex: 1,
    gap: 2,
  },
  name: {
    color: '#1f2c3f',
    fontSize: 15,
    fontWeight: '600',
  },
  signature: {
    color: '#8794a8',
    fontSize: 12,
  },
  checkOuter: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#c4cfdd',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOuterOn: {
    borderColor: '#2f8cff',
  },
  checkOuterRequiredOn: {
    borderColor: '#b8c1cf',
  },
  checkInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#2f8cff',
  },
  checkInnerRequired: {
    backgroundColor: '#a9b3c2',
  },
  footer: {
    borderTopWidth: 1,
    borderTopColor: '#e4e9f1',
    backgroundColor: '#fff',
    paddingHorizontal: 14,
    paddingTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  countText: {
    color: '#6b7b90',
    fontSize: 13,
  },
  createBtn: {
    height: 38,
    borderRadius: 12,
    backgroundColor: '#3a9bff',
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  createBtnDisabled: {
    opacity: 0.55,
  },
  createBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});

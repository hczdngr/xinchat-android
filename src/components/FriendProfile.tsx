import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { API_BASE } from '../config';
import { STORAGE_KEYS } from '../constants/storageKeys';
import type { FriendProfileRoute, RootNavigation } from '../navigation/types';
import { storage } from '../storage';
import Profile from './Profile';

type ProfileData = {
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

type RequestItem = {
  uid?: number;
  status?: string;
};

type RelationState = 'friend' | 'not_friend' | 'pending_outgoing' | 'pending_incoming';

const isValidUid = (value: any) => Number.isInteger(Number(value)) && Number(value) > 0;

const hasUid = (list: any, uid: number) => {
  if (!Array.isArray(list)) return false;
  return list.some((item) => Number(item?.uid) === uid);
};

const hasPendingForUid = (list: RequestItem[] | any, uid: number) => {
  if (!Array.isArray(list)) return false;
  return list.some((item) => Number(item?.uid) === uid && String(item?.status || '') === 'pending');
};

export default function FriendProfile() {
  const navigation = useNavigation<RootNavigation>();
  const route = useRoute<FriendProfileRoute>();
  const uid = useMemo(() => Number(route.params?.uid), [route.params?.uid]);
  const initialFriend = route.params?.friend;
  const [profile, setProfile] = useState<ProfileData>(() => ({
    uid: initialFriend?.uid || route.params?.uid,
    username: initialFriend?.username,
    nickname: initialFriend?.nickname,
    avatar: initialFriend?.avatar,
    signature: initialFriend?.signature,
  }));
  const [relation, setRelation] = useState<RelationState>('not_friend');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSendMessage = useCallback(async () => {
    if (!profile?.uid) return;
    await storage.setJson(STORAGE_KEYS.pendingOpenChat, {
      uid: profile.uid,
      friend: {
        uid: profile.uid,
        username: profile.username,
        nickname: profile.nickname,
        avatar: profile.avatar,
      },
    });
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.navigate('Home');
    }
  }, [navigation, profile]);

  const loadProfile = useCallback(async () => {
    if (!isValidUid(uid)) {
      setError('无效的用户');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError('');
    const token = (await storage.getString(STORAGE_KEYS.token)) || '';
    if (!token) {
      setError('未登录');
      setLoading(false);
      return;
    }

    const headers = { Authorization: `Bearer ${token}` };
    try {
      const [profileResp, listResp, requestResp, searchResp] = await Promise.all([
        fetch(`${API_BASE}/api/friends/profile?uid=${uid}`, { headers }),
        fetch(`${API_BASE}/api/friends/list`, { headers }),
        fetch(`${API_BASE}/api/friends/requests`, { headers }),
        fetch(`${API_BASE}/api/friends/search?uid=${uid}`, { headers }),
      ]);
      const [profileData, listData, requestData, searchData] = await Promise.all([
        profileResp.json().catch(() => ({})),
        listResp.json().catch(() => ({})),
        requestResp.json().catch(() => ({})),
        searchResp.json().catch(() => ({})),
      ]);

      const nextProfile: ProfileData = {
        uid,
        username: initialFriend?.username,
        nickname: initialFriend?.nickname,
        avatar: initialFriend?.avatar,
        signature: initialFriend?.signature,
      };

      if (searchResp.ok && searchData?.success && searchData?.user) {
        nextProfile.uid = Number(searchData.user.uid) || nextProfile.uid;
        nextProfile.username = String(searchData.user.username || nextProfile.username || '');
        nextProfile.avatar = String(searchData.user.avatar || nextProfile.avatar || '');
      }

      if (profileResp.ok && profileData?.success && profileData?.user) {
        Object.assign(nextProfile, profileData.user);
      }

      if (!isValidUid(nextProfile.uid)) {
        setError('用户不存在');
        return;
      }

      const friendList = Array.isArray(listData?.friends) ? listData.friends : [];
      const incoming = Array.isArray(requestData?.incoming) ? requestData.incoming : [];
      const outgoing = Array.isArray(requestData?.outgoing) ? requestData.outgoing : [];

      if (hasUid(friendList, uid)) {
        setRelation('friend');
      } else if (hasPendingForUid(outgoing, uid)) {
        setRelation('pending_outgoing');
      } else if (hasPendingForUid(incoming, uid)) {
        setRelation('pending_incoming');
      } else {
        setRelation('not_friend');
      }

      setProfile((prev) => ({ ...prev, ...nextProfile }));
      setError('');
    } catch {
      setError('网络错误，请稍后重试');
    } finally {
      setLoading(false);
    }
  }, [initialFriend?.avatar, initialFriend?.nickname, initialFriend?.signature, initialFriend?.username, uid]);

  const handleAddFriend = useCallback(async () => {
    if (!isValidUid(uid) || actionLoading) return;
    if (relation === 'pending_outgoing') {
      Alert.alert('提示', '已发送好友申请，请等待对方处理');
      return;
    }

    const token = (await storage.getString(STORAGE_KEYS.token)) || '';
    if (!token) {
      Alert.alert('提示', '请先登录');
      return;
    }

    setActionLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/friends/add`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ friendUid: uid }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        Alert.alert('提示', data?.message || '发送好友申请失败');
        return;
      }

      if (data?.status === 'accepted' || data?.status === 'already_friends') {
        setRelation('friend');
        await loadProfile();
        Alert.alert('提示', data?.status === 'accepted' ? '已添加为好友' : '你们已经是好友');
        return;
      }

      setRelation('pending_outgoing');
      Alert.alert('提示', '好友申请已发送');
    } catch {
      Alert.alert('提示', '网络错误，请稍后重试');
    } finally {
      setActionLoading(false);
    }
  }, [actionLoading, loadProfile, relation, uid]);

  const actionLabel = useMemo(() => {
    if (actionLoading) return '处理中...';
    if (relation === 'friend') return '发消息';
    if (relation === 'pending_outgoing') return '已发送';
    return '加好友';
  }, [actionLoading, relation]);

  const onPrimaryAction = useCallback(async () => {
    if (relation === 'friend') {
      await handleSendMessage();
      return;
    }
    await handleAddFriend();
  }, [handleAddFriend, handleSendMessage, relation]);

  useEffect(() => {
    loadProfile().catch(() => undefined);
  }, [loadProfile]);

  const hasRenderableProfile = isValidUid(profile?.uid);

  if (loading && !hasRenderableProfile) {
    return (
      <View style={styles.page}>
        <ActivityIndicator size="small" color="#0099ff" />
        <Text style={styles.tip}>正在加载...</Text>
      </View>
    );
  }

  if (error && !hasRenderableProfile) {
    return (
      <View style={styles.page}>
        <Text style={styles.error}>{error}</Text>
        <Pressable onPress={loadProfile} style={styles.retryBtn}>
          <Text style={styles.retryText}>重新加载</Text>
        </Pressable>
        <Pressable onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={styles.backText}>返回</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <Profile
      profile={profile}
      onBack={() => navigation.goBack()}
      title="个人资料"
      onAction={onPrimaryAction}
      actionLabel={actionLabel}
    />
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: '#f5f6fa',
    paddingHorizontal: 24,
  },
  tip: {
    color: '#666',
    fontSize: 14,
  },
  error: {
    color: '#b5482b',
    fontSize: 14,
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: 4,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#0099ff',
  },
  retryText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  backBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  backText: {
    color: '#4b6fa7',
    fontSize: 13,
  },
});

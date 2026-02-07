import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { API_BASE } from '../config';
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

type RouteParams = {
  uid?: number;
  friend?: Partial<ProfileData>;
};

export default function FriendProfile() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const pendingChatKey = 'xinchat.pendingOpenChat';
  const params = (route.params || {}) as RouteParams;
  const uid = useMemo(() => Number(params.uid), [params.uid]);
  const [profile, setProfile] = useState<ProfileData>(() => ({
    uid: params.friend?.uid || params.uid,
    username: params.friend?.username,
    nickname: params.friend?.nickname,
    avatar: params.friend?.avatar,
  }));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const handleSendMessage = useCallback(async () => {
    if (!profile?.uid) return;
    await storage.setJson(pendingChatKey, {
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
  }, [navigation, pendingChatKey, profile]);

  const loadProfile = useCallback(async () => {
    if (!Number.isInteger(uid)) {
      setError('无效的用户');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    const token = (await storage.getString('xinchat.token')) || '';
    if (!token) {
      setError('未登录');
      setLoading(false);
      return;
    }
    try {
      const response = await fetch(`${API_BASE}/api/friends/profile?uid=${uid}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.success && data?.user) {
        setProfile(data.user);
      } else {
        setError(data?.message || '加载失败，请稍后再试');
      }
    } catch {
      setError('网络错误，请稍后再试');
    }
    setLoading(false);
  }, [uid]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  if (loading) {
    return (
      <View style={styles.page}>
        <ActivityIndicator size="small" color="#0099ff" />
        <Text style={styles.tip}>正在加载...</Text>
      </View>
    );
  }

  if (error) {
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
      onAction={handleSendMessage}
      actionLabel="发消息"
      actionVariant="primary"
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

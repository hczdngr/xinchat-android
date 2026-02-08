import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { API_BASE, normalizeImageUrl } from '../config';
import { STORAGE_KEYS } from '../constants/storageKeys';
import type { GroupChatSettingsRoute, RootNavigation } from '../navigation/types';
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
  ownerUid?: number;
  name?: string;
  description?: string;
  announcement?: string;
  myNickname?: string;
  memberUids?: number[];
  members?: Friend[];
};

type BoolMap = Record<number, boolean>;
type GroupRemarkMap = Record<number, string>;
type EditorField = 'name' | 'announcement' | 'myNickname' | 'groupRemark';

const PAGE_LIMIT = 30;

const sanitizeBoolMap = (input: any): BoolMap => {
  if (!input || typeof input !== 'object') return {};
  const next: BoolMap = {};
  Object.entries(input).forEach(([rawUid, rawValue]) => {
    const uid = Number(rawUid);
    if (!Number.isInteger(uid) || uid <= 0) return;
    if (!rawValue) return;
    next[uid] = true;
  });
  return next;
};

const sanitizeGroupRemarks = (input: any): GroupRemarkMap => {
  if (!input || typeof input !== 'object') return {};
  const next: GroupRemarkMap = {};
  Object.entries(input).forEach(([rawUid, rawText]) => {
    const uid = Number(rawUid);
    if (!Number.isInteger(uid) || uid <= 0) return;
    if (typeof rawText !== 'string') return;
    const text = rawText.trim().slice(0, 60);
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

const normalizeGroup = (input: any): GroupPreview | null => {
  const id = Number(input?.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const memberUids = Array.isArray(input?.memberUids)
    ? input.memberUids
        .map((rawUid: any) => Number(rawUid))
        .filter((uid: number) => Number.isInteger(uid) && uid > 0)
    : [];
  const members = Array.isArray(input?.members)
    ? input.members
        .map((member: any) => ({
          uid: Number(member?.uid),
          username: typeof member?.username === 'string' ? member.username : '',
          nickname: typeof member?.nickname === 'string' ? member.nickname : '',
          avatar: typeof member?.avatar === 'string' ? member.avatar : '',
          signature: typeof member?.signature === 'string' ? member.signature : '',
          online: Boolean(member?.online),
        }))
        .filter((member: Friend) => Number.isInteger(member.uid) && member.uid > 0)
    : [];
  const memberCount = memberUids.length > 0 ? memberUids.length : members.length;
  return {
    id,
    ownerUid: Number.isInteger(Number(input?.ownerUid)) ? Number(input.ownerUid) : undefined,
    name: stripAutoGroupCountSuffix(input?.name, memberCount),
    description: typeof input?.description === 'string' ? input.description : '',
    announcement: typeof input?.announcement === 'string' ? input.announcement : '',
    myNickname: typeof input?.myNickname === 'string' ? input.myNickname : '',
    memberUids,
    members,
  };
};

export default function GroupChatSettings() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<RootNavigation>();
  const route = useRoute<GroupChatSettingsRoute>();
  const uid = Number(route.params?.uid || 0);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [muted, setMuted] = useState(false);
  const [groupRemark, setGroupRemark] = useState('');
  const [group, setGroup] = useState<GroupPreview | null>(() =>
    normalizeGroup(route.params?.group)
  );
  const [qrVisible, setQrVisible] = useState(false);
  const [leaveConfirmVisible, setLeaveConfirmVisible] = useState(false);
  const [editorVisible, setEditorVisible] = useState(false);
  const [editorTitle, setEditorTitle] = useState('');
  const [editorPlaceholder, setEditorPlaceholder] = useState('');
  const [editorValue, setEditorValue] = useState('');
  const [editorField, setEditorField] = useState<EditorField>('name');
  const [editorMaxLength, setEditorMaxLength] = useState(80);

  const displayName = useMemo(
    () => String(group?.name || '').trim() || (uid > 0 ? `群聊${uid}` : '群聊'),
    [group?.name, uid]
  );
  const displayDescription = useMemo(
    () => String(group?.description || '').trim() || '暂无群简介',
    [group?.description]
  );
  const displayAnnouncement = useMemo(
    () => String(group?.announcement || '').trim() || '未设置',
    [group?.announcement]
  );
  const displayMyNickname = useMemo(
    () => String(group?.myNickname || '').trim() || '未设置',
    [group?.myNickname]
  );
  const displayGroupRemark = useMemo(
    () => String(groupRemark || '').trim() || '未设置',
    [groupRemark]
  );
  const joinPayload = useMemo(
    () => JSON.stringify({ type: 'group_invite', groupId: uid }),
    [uid]
  );
  const qrUri = useMemo(
    () =>
      `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(joinPayload)}`,
    [joinPayload]
  );
  const groupMembers = useMemo(() => {
    if (!Array.isArray(group?.members)) return [];
    return group.members.filter((member): member is Friend => {
      const memberUid = Number(member?.uid);
      return Number.isInteger(memberUid) && memberUid > 0;
    });
  }, [group?.members]);
  const memberCount = useMemo(() => {
    const uidCount = Array.isArray(group?.memberUids) ? group.memberUids.length : 0;
    return uidCount > 0 ? uidCount : groupMembers.length;
  }, [group?.memberUids, groupMembers.length]);

  const openMemberProfile = useCallback(
    (member: Friend) => {
      const memberUid = Number(member?.uid);
      if (!Number.isInteger(memberUid) || memberUid <= 0) return;
      navigation.navigate('FriendProfile', { uid: memberUid, friend: member });
    },
    [navigation]
  );

  const loadLocalSettings = useCallback(async () => {
    if (!Number.isInteger(uid) || uid <= 0) {
      setReady(true);
      return;
    }
    const [storedMuted, storedRemarks] = await Promise.all([
      storage.getJson<BoolMap>(STORAGE_KEYS.chatMuted),
      storage.getJson<GroupRemarkMap>(STORAGE_KEYS.groupRemarks),
    ]);
    const mutedMap = sanitizeBoolMap(storedMuted);
    const remarksMap = sanitizeGroupRemarks(storedRemarks);
    setMuted(Boolean(mutedMap[uid]));
    setGroupRemark(String(remarksMap[uid] || ''));
    setReady(true);
  }, [uid]);

  const loadDetail = useCallback(async () => {
    if (!Number.isInteger(uid) || uid <= 0) return;
    const token = (await storage.getString(STORAGE_KEYS.token)) || '';
    if (!token) return;
    try {
      const response = await fetch(`${API_BASE}/api/groups/detail?groupId=${uid}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success || !data?.group) return;
      const nextGroup = normalizeGroup(data.group);
      if (nextGroup) {
        setGroup(nextGroup);
      }
    } catch {}
  }, [uid]);

  useEffect(() => {
    loadLocalSettings().catch(() => setReady(true));
    loadDetail().catch(() => undefined);
  }, [loadDetail, loadLocalSettings]);

  const saveMuted = useCallback(
    async (nextValue: boolean) => {
      const current = sanitizeBoolMap(await storage.getJson<BoolMap>(STORAGE_KEYS.chatMuted));
      if (nextValue) {
        current[uid] = true;
      } else {
        delete current[uid];
      }
      await storage.setJson(STORAGE_KEYS.chatMuted, current);
    },
    [uid]
  );

  const saveGroupRemark = useCallback(
    async (nextValue: string) => {
      const current = sanitizeGroupRemarks(
        await storage.getJson<GroupRemarkMap>(STORAGE_KEYS.groupRemarks)
      );
      const text = String(nextValue || '').trim().slice(0, 60);
      if (text) {
        current[uid] = text;
      } else {
        delete current[uid];
      }
      await storage.setJson(STORAGE_KEYS.groupRemarks, current);
    },
    [uid]
  );

  const updateGroup = useCallback(
    async (payload: Record<string, any>) => {
      if (!Number.isInteger(uid) || uid <= 0) return false;
      const token = (await storage.getString(STORAGE_KEYS.token)) || '';
      if (!token) {
        Alert.alert('操作失败', '请先登录后再试。');
        return false;
      }
      const baseGroup = group || {
        id: uid,
        memberUids: [],
        members: [],
      };
      const optimistic = normalizeGroup({ ...baseGroup, ...payload, id: uid });
      const commitGroupUpdate = async (nextGroup: GroupPreview | null) => {
        if (!nextGroup) return;
        setGroup(nextGroup);
        await storage.setJson(STORAGE_KEYS.pendingChatSettingsAction, {
          type: 'group_update',
          uid,
          group: nextGroup,
          at: Date.now(),
        });
      };
      try {
        const response = await fetch(`${API_BASE}/api/groups/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ groupId: uid, ...payload }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data?.success || !data?.group) {
          if (response.status === 404 && optimistic) {
            await commitGroupUpdate(optimistic);
            return true;
          }
          Alert.alert('保存失败', data?.message || '保存失败，请稍后再试。');
          return false;
        }
        const nextGroup = normalizeGroup(data.group);
        await commitGroupUpdate(nextGroup || optimistic);
        return true;
      } catch {
        if (optimistic) {
          await commitGroupUpdate(optimistic);
          return true;
        }
        Alert.alert('保存失败', '网络异常，请稍后再试。');
        return false;
      }
    },
    [group, uid]
  );

  const onToggleMuted = useCallback(async () => {
    if (!ready || uid <= 0) return;
    const next = !muted;
    setMuted(next);
    try {
      await saveMuted(next);
    } catch {
      setMuted(!next);
    }
  }, [muted, ready, saveMuted, uid]);

  const openEditor = useCallback(
    (field: EditorField) => {
      if (!Number.isInteger(uid) || uid <= 0) return;
      if (field === 'name') {
        setEditorField('name');
        setEditorTitle('群聊名称');
        setEditorPlaceholder('请输入群聊名称');
        setEditorValue(String(group?.name || '').trim());
        setEditorMaxLength(80);
      } else if (field === 'announcement') {
        setEditorField('announcement');
        setEditorTitle('群公告');
        setEditorPlaceholder('请输入群公告');
        setEditorValue(String(group?.announcement || '').trim());
        setEditorMaxLength(300);
      } else if (field === 'myNickname') {
        setEditorField('myNickname');
        setEditorTitle('我在本群昵称');
        setEditorPlaceholder('请输入本群昵称');
        setEditorValue(String(group?.myNickname || '').trim());
        setEditorMaxLength(40);
      } else {
        setEditorField('groupRemark');
        setEditorTitle('群聊备注');
        setEditorPlaceholder('请输入群聊备注');
        setEditorValue(String(groupRemark || '').trim());
        setEditorMaxLength(60);
      }
      setEditorVisible(true);
    },
    [group?.announcement, group?.myNickname, group?.name, groupRemark, uid]
  );

  const submitEditor = useCallback(async () => {
    if (!editorVisible || saving) return;
    const value = editorValue.trim();
    setSaving(true);
    try {
      if (editorField === 'groupRemark') {
        await saveGroupRemark(value);
        setGroupRemark(value);
      } else if (editorField === 'name') {
        const ok = await updateGroup({ name: value });
        if (!ok) return;
      } else if (editorField === 'announcement') {
        const ok = await updateGroup({ announcement: value });
        if (!ok) return;
      } else if (editorField === 'myNickname') {
        const ok = await updateGroup({ myNickname: value });
        if (!ok) return;
      }
      setEditorVisible(false);
    } finally {
      setSaving(false);
    }
  }, [editorField, editorValue, editorVisible, saveGroupRemark, saving, updateGroup]);

  const clearLocalGroupCaches = useCallback(async () => {
    const [cachedMessages, cachedLatest, cachedUnread, hiddenChats, readAtMap] = await Promise.all([
      storage.getJson<Record<number, any>>(STORAGE_KEYS.homeMessagesCache),
      storage.getJson<Record<number, any>>(STORAGE_KEYS.homeLatestCache),
      storage.getJson<Record<number, any>>(STORAGE_KEYS.homeUnreadCache),
      storage.getJson<Record<number, any>>(STORAGE_KEYS.hiddenChats),
      storage.getJson<Record<number, number>>(STORAGE_KEYS.readAt),
    ]);
    const nextMessages = { ...(cachedMessages || {}) };
    const nextLatest = { ...(cachedLatest || {}) };
    const nextUnread = { ...(cachedUnread || {}) };
    const nextHidden = sanitizeBoolMap(hiddenChats);
    const nextReadAt = { ...(readAtMap || {}) };
    delete nextMessages[uid];
    delete nextLatest[uid];
    delete nextUnread[uid];
    delete nextHidden[uid];
    delete nextReadAt[uid];
    await Promise.all([
      storage.setJson(STORAGE_KEYS.homeMessagesCache, nextMessages),
      storage.setJson(STORAGE_KEYS.homeLatestCache, nextLatest),
      storage.setJson(STORAGE_KEYS.homeUnreadCache, nextUnread),
      storage.setJson(STORAGE_KEYS.hiddenChats, nextHidden),
      storage.setJson(STORAGE_KEYS.readAt, nextReadAt),
    ]);
  }, [uid]);

  const deleteChatHistory = useCallback(async () => {
    if (deleting || !Number.isInteger(uid) || uid <= 0) return;
    const token = (await storage.getString(STORAGE_KEYS.token)) || '';
    if (!token) {
      Alert.alert('删除失败', '请先登录后再试。');
      return;
    }
    setDeleting(true);
    try {
      const authHeaders = { Authorization: `Bearer ${token}` };
      const deleteBatch = async (beforeId?: number | string) => {
        const params = new URLSearchParams({
          targetType: 'group',
          targetUid: String(uid),
          limit: String(PAGE_LIMIT),
        });
        if (beforeId) {
          params.set('beforeId', String(beforeId));
        }
        const response = await fetch(`${API_BASE}/api/chat/get?${params.toString()}`, {
          headers: authHeaders,
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
            headers: { 'Content-Type': 'application/json', ...authHeaders },
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
      await clearLocalGroupCaches();
      await storage.setJson(STORAGE_KEYS.pendingChatSettingsAction, {
        type: 'group_delete_chat',
        uid,
        at: Date.now(),
      });
      Alert.alert('已完成', '群聊记录已删除。');
      navigation.goBack();
    } catch {
      Alert.alert('删除失败', '请稍后重试。');
    } finally {
      setDeleting(false);
    }
  }, [clearLocalGroupCaches, deleting, navigation, uid]);

  const onDeleteChatHistory = useCallback(() => {
    if (!ready || uid <= 0) return;
    Alert.alert('删除聊天记录', '确认删除该群的聊天记录？', [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => deleteChatHistory() },
    ]);
  }, [deleteChatHistory, ready, uid]);

  const confirmLeaveGroup = useCallback(async () => {
    if (leaving) return;
    if (!Number.isInteger(uid) || uid <= 0) {
      Alert.alert('退出失败', '群ID无效。');
      return;
    }
    setLeaveConfirmVisible(false);
    const commitLeave = async () => {
      await clearLocalGroupCaches();
      await storage.setJson(STORAGE_KEYS.pendingChatSettingsAction, {
        type: 'group_leave',
        uid,
        at: Date.now(),
      });
      navigation.goBack();
    };
    const token = (await storage.getString(STORAGE_KEYS.token)) || '';
    if (!token) {
      Alert.alert('操作失败', '请先登录后再试。');
      return;
    }
    setLeaving(true);
    try {
      const response = await fetch(`${API_BASE}/api/groups/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ groupId: uid }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        if (response.status === 404 || response.status === 403) {
          await commitLeave();
          return;
        }
        Alert.alert('退出失败', data?.message || '请稍后重试。');
        return;
      }
      await commitLeave();
    } catch {
      Alert.alert('退出失败', '网络异常，请稍后重试。');
    } finally {
      setLeaving(false);
    }
  }, [clearLocalGroupCaches, leaving, navigation, uid]);

  const onLeaveGroup = useCallback(() => {
    if (leaving) return;
    if (!Number.isInteger(uid) || uid <= 0) {
      Alert.alert('退出失败', '群ID无效。');
      return;
    }
    setLeaveConfirmVisible(true);
  }, [leaving, uid]);

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => navigation.goBack()}>
          <BackIcon />
        </Pressable>
        <Text style={styles.headerTitle}>群聊设置</Text>
        <View style={styles.headerRightSpace} />
      </View>

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyInner}>
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={styles.groupHeadLeft}>
              <GroupAvatarGrid
                members={group?.members}
                fallbackText={displayName}
                size={52}
              />
              <View style={styles.groupHeadInfo}>
                <Text style={styles.groupHeadName} numberOfLines={1}>
                  {displayName}
                </Text>
                <Text style={styles.groupHeadDesc} numberOfLines={2}>
                  {displayDescription}
                </Text>
              </View>
            </View>
            <View style={styles.arrowIcon}>
              <ForwardIndicatorIcon />
            </View>
          </View>
        </View>

        <View style={styles.sectionTitleWrap}>
          <Text style={styles.sectionTitle}>群聊成员</Text>
        </View>
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.label}>群聊成员</Text>
            <View style={styles.rowRight}>
              <Text style={styles.subLabel}>{`查看${memberCount}名群成员`}</Text>
              <View style={styles.arrowIcon}>
                <ForwardIndicatorIcon />
              </View>
            </View>
          </View>
          <View style={styles.divider} />
          {groupMembers.length > 0 ? (
            <View style={styles.memberList}>
              {groupMembers.map((member) => (
                <Pressable
                  key={`member-${member.uid}`}
                  style={styles.memberItem}
                  onPress={() => openMemberProfile(member)}
                >
                  <MemberAvatar member={member} />
                  <Text style={styles.memberName} numberOfLines={1}>
                    {String(member.nickname || member.username || `用户${member.uid}`)}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : (
            <Text style={styles.memberEmpty}>暂无成员</Text>
          )}
        </View>

        <View style={styles.sectionTitleWrap}>
          <Text style={styles.sectionTitle}>群功能</Text>
        </View>
        <View style={styles.card}>
          <Pressable style={styles.row} onPress={() => openEditor('name')}>
            <Text style={styles.label}>群聊名称</Text>
            <View style={styles.rowRight}>
              <Text style={styles.subLabel} numberOfLines={1}>
                {displayName}
              </Text>
              <View style={styles.arrowIcon}>
                <ForwardIndicatorIcon />
              </View>
            </View>
          </Pressable>
          <View style={styles.divider} />
          <Pressable style={styles.row} onPress={() => setQrVisible(true)}>
            <Text style={styles.label}>群号和二维码</Text>
            <View style={styles.rowRight}>
              <Text style={styles.subLabel}>群号 {uid}</Text>
              <View style={styles.arrowIcon}>
                <ForwardIndicatorIcon />
              </View>
            </View>
          </Pressable>
          <View style={styles.divider} />
          <Pressable style={styles.row} onPress={() => openEditor('announcement')}>
            <Text style={styles.label}>群公告</Text>
            <View style={styles.rowRight}>
              <Text style={styles.subLabel} numberOfLines={1}>
                {displayAnnouncement}
              </Text>
              <View style={styles.arrowIcon}>
                <ForwardIndicatorIcon />
              </View>
            </View>
          </Pressable>
          <View style={styles.divider} />
          <Pressable style={styles.row} onPress={() => openEditor('myNickname')}>
            <Text style={styles.label}>我的本群昵称</Text>
            <View style={styles.rowRight}>
              <Text style={styles.subLabel} numberOfLines={1}>
                {displayMyNickname}
              </Text>
              <View style={styles.arrowIcon}>
                <ForwardIndicatorIcon />
              </View>
            </View>
          </Pressable>
          <View style={styles.divider} />
          <Pressable style={styles.row} onPress={() => openEditor('groupRemark')}>
            <Text style={styles.label}>群聊备注</Text>
            <View style={styles.rowRight}>
              <Text style={styles.subLabel} numberOfLines={1}>
                {displayGroupRemark}
              </Text>
              <View style={styles.arrowIcon}>
                <ForwardIndicatorIcon />
              </View>
            </View>
          </Pressable>
        </View>

        <View style={styles.sectionTitleWrap}>
          <Text style={styles.sectionTitle}>聊天会话</Text>
        </View>
        <View style={styles.card}>
          <Pressable
            style={styles.row}
            onPress={() =>
              navigation.navigate('GroupChatSearch', {
                uid,
                targetType: 'group',
                title: displayName,
                group: group
                  ? {
                      id: group.id,
                      ownerUid: group.ownerUid,
                      name: group.name,
                      memberUids: group.memberUids,
                      members: group.members,
                      description: group.description,
                      announcement: group.announcement,
                      myNickname: group.myNickname,
                    }
                  : undefined,
              })
            }
          >
            <Text style={styles.label}>查找聊天记录</Text>
            <View style={styles.rowRight}>
              <Text style={styles.subLabel}>按类型查找</Text>
              <View style={styles.arrowIcon}>
                <ForwardIndicatorIcon />
              </View>
            </View>
          </Pressable>
          <View style={styles.divider} />
          <View style={styles.row}>
            <Text style={styles.label}>消息免打扰</Text>
            <Switch value={muted} onToggle={onToggleMuted} />
          </View>
          <View style={styles.divider} />
          <Pressable style={styles.row} onPress={onDeleteChatHistory} disabled={deleting}>
            <Text style={styles.label}>{deleting ? '正在删除...' : '删除聊天记录'}</Text>
          </Pressable>
          <View style={styles.divider} />
          <Pressable style={styles.row} onPress={onLeaveGroup} disabled={leaving}>
            <Text style={styles.dangerText}>{leaving ? '正在退出...' : '退出该群'}</Text>
          </Pressable>
        </View>
      </ScrollView>

      <Modal transparent visible={qrVisible} animationType="fade" onRequestClose={() => setQrVisible(false)}>
        <Pressable style={styles.modalMask} onPress={() => setQrVisible(false)}>
          <Pressable style={styles.qrCard} onPress={() => undefined}>
            <Text style={styles.qrTitle}>群二维码</Text>
            <Text style={styles.qrSub}>群号：{uid}</Text>
            <Image source={{ uri: qrUri }} style={styles.qrImage} />
            <Text style={styles.qrHint}>扫码可加入该群</Text>
            <Pressable style={styles.qrCloseBtn} onPress={() => setQrVisible(false)}>
              <Text style={styles.qrCloseText}>关闭</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        transparent
        visible={leaveConfirmVisible}
        animationType="fade"
        onRequestClose={() => {
          if (leaving) return;
          setLeaveConfirmVisible(false);
        }}
      >
        <Pressable
          style={styles.modalMask}
          onPress={() => {
            if (leaving) return;
            setLeaveConfirmVisible(false);
          }}
        >
          <Pressable style={styles.leaveConfirmCard} onPress={() => undefined}>
            <Text style={styles.leaveConfirmTitle}>退出该群</Text>
            <Text style={styles.leaveConfirmDesc}>确认退出当前群聊？</Text>
            <View style={styles.leaveConfirmActions}>
              <Pressable
                style={styles.leaveConfirmBtn}
                onPress={() => setLeaveConfirmVisible(false)}
                disabled={leaving}
              >
                <Text style={styles.leaveConfirmBtnText}>取消</Text>
              </Pressable>
              <Pressable
                style={[styles.leaveConfirmBtn, styles.leaveConfirmDangerBtn]}
                onPress={() => {
                  confirmLeaveGroup().catch(() => undefined);
                }}
                disabled={leaving}
              >
                <Text style={styles.leaveConfirmDangerText}>{leaving ? '退出中...' : '确认'}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        transparent
        visible={editorVisible}
        animationType="fade"
        onRequestClose={() => setEditorVisible(false)}
      >
        <Pressable style={styles.modalMask} onPress={() => setEditorVisible(false)}>
          <Pressable style={styles.editorCard} onPress={() => undefined}>
            <Text style={styles.editorTitle}>{editorTitle}</Text>
            <TextInput
              value={editorValue}
              onChangeText={(text) => setEditorValue(text.slice(0, editorMaxLength))}
              placeholder={editorPlaceholder}
              placeholderTextColor="#9aa4b2"
              style={styles.editorInput}
              maxLength={editorMaxLength}
              multiline={editorField === 'announcement'}
              autoFocus
            />
            <Text style={styles.editorCounter}>
              {editorValue.length}/{editorMaxLength}
            </Text>
            <View style={styles.editorActions}>
              <Pressable style={styles.editorBtn} onPress={() => setEditorVisible(false)}>
                <Text style={styles.editorBtnText}>取消</Text>
              </Pressable>
              <Pressable
                style={[styles.editorBtn, styles.editorPrimaryBtn]}
                onPress={submitEditor}
                disabled={saving}
              >
                <Text style={styles.editorPrimaryText}>{saving ? '保存中...' : '保存'}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

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

function MemberAvatar({ member }: { member: Friend }) {
  const avatarUrl = normalizeImageUrl(member.avatar);
  const label = String(member.nickname || member.username || member.uid || 'U').slice(0, 2);
  return (
    <View style={styles.memberAvatar}>
      {avatarUrl ? (
        <Image source={{ uri: avatarUrl }} style={styles.memberAvatarImage} />
      ) : (
        <View style={styles.memberAvatarFallback}>
          <Text style={styles.memberAvatarText}>{label}</Text>
        </View>
      )}
    </View>
  );
}

function Switch({ value, onToggle }: { value: boolean; onToggle: () => void }) {
  return (
    <Pressable
      onPress={onToggle}
      style={[styles.switchBase, value && styles.switchBaseOn]}
      hitSlop={6}
    >
      <View style={[styles.switchKnob, value && styles.switchKnobOn]} />
    </Pressable>
  );
}

function BackIcon() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path
        d="M15 18L9 12L15 6"
        stroke="#30435a"
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
        stroke="#b4becd"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        transform="rotate(180 12 12)"
      />
    </Svg>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: '#f3f4f7',
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
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 20,
    color: '#222933',
    fontWeight: '600',
  },
  headerRightSpace: {
    width: 34,
    height: 34,
  },
  body: {
    flex: 1,
  },
  bodyInner: {
    paddingHorizontal: 10,
    paddingBottom: 18,
    gap: 10,
  },
  sectionTitleWrap: {
    paddingHorizontal: 4,
    paddingTop: 2,
  },
  sectionTitle: {
    fontSize: 13,
    color: '#9ca6b5',
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#eceff4',
  },
  row: {
    minHeight: 54,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  groupHeadLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  groupHeadInfo: {
    flex: 1,
    gap: 3,
  },
  groupHeadName: {
    fontSize: 18,
    color: '#202833',
    fontWeight: '600',
  },
  groupHeadDesc: {
    fontSize: 12,
    color: '#8592a4',
  },
  memberList: {
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 4,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  memberItem: {
    width: 72,
    alignItems: 'center',
    marginBottom: 12,
  },
  memberAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    overflow: 'hidden',
    backgroundColor: '#dfe9f8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberAvatarImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  memberAvatarFallback: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberAvatarText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#2f6bd9',
  },
  memberName: {
    marginTop: 6,
    maxWidth: 68,
    fontSize: 12,
    color: '#4f5c6e',
    textAlign: 'center',
  },
  memberEmpty: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 13,
    color: '#9aa4b2',
  },
  rowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  label: {
    fontSize: 16,
    color: '#252d38',
    fontWeight: '500',
  },
  subLabel: {
    fontSize: 14,
    color: '#9aa4b2',
    maxWidth: 176,
  },
  arrowIcon: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  divider: {
    height: 1,
    backgroundColor: '#eff2f6',
    marginLeft: 14,
  },
  dangerText: {
    fontSize: 16,
    color: '#e14d4d',
    fontWeight: '500',
  },
  switchBase: {
    width: 48,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#e0e3e8',
    padding: 2,
    justifyContent: 'center',
  },
  switchBaseOn: {
    backgroundColor: '#6ab5ff',
  },
  switchKnob: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#fff',
  },
  switchKnobOn: {
    transform: [{ translateX: 20 }],
  },
  modalMask: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  leaveConfirmCard: {
    width: '100%',
    maxWidth: 340,
    borderRadius: 14,
    backgroundColor: '#f8fbff',
    borderWidth: 1,
    borderColor: '#dce9f8',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    gap: 10,
  },
  leaveConfirmTitle: {
    fontSize: 17,
    color: '#24364a',
    fontWeight: '700',
  },
  leaveConfirmDesc: {
    fontSize: 14,
    color: '#5e6f84',
    lineHeight: 20,
  },
  leaveConfirmActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  leaveConfirmBtn: {
    minWidth: 72,
    height: 34,
    borderRadius: 9,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#edf3fb',
    borderWidth: 1,
    borderColor: '#d5e1f0',
  },
  leaveConfirmBtnText: {
    fontSize: 14,
    color: '#49607a',
    fontWeight: '500',
  },
  leaveConfirmDangerBtn: {
    backgroundColor: '#eaf4ff',
    borderColor: '#bddaff',
  },
  leaveConfirmDangerText: {
    fontSize: 14,
    color: '#2e86f6',
    fontWeight: '600',
  },
  qrCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 16,
    alignItems: 'center',
    gap: 8,
  },
  qrTitle: {
    fontSize: 17,
    color: '#232c38',
    fontWeight: '700',
  },
  qrSub: {
    fontSize: 13,
    color: '#7f8c9f',
  },
  qrImage: {
    width: 220,
    height: 220,
    borderRadius: 12,
    backgroundColor: '#fff',
  },
  qrHint: {
    fontSize: 12,
    color: '#8e99a9',
  },
  qrCloseBtn: {
    marginTop: 4,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#3092ff',
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrCloseText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  editorCard: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 14,
    backgroundColor: '#fff',
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  editorTitle: {
    color: '#233043',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  editorInput: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e7ef',
    backgroundColor: '#f8fafd',
    color: '#1e2a39',
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    textAlignVertical: 'top',
  },
  editorCounter: {
    marginTop: 6,
    textAlign: 'right',
    color: '#8f9bad',
    fontSize: 12,
  },
  editorActions: {
    marginTop: 12,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  editorBtn: {
    height: 34,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d5dde8',
    backgroundColor: '#fff',
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editorPrimaryBtn: {
    borderColor: '#3092ff',
    backgroundColor: '#3092ff',
  },
  editorBtnText: {
    color: '#4b5a6d',
    fontSize: 14,
    fontWeight: '500',
  },
  editorPrimaryText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  groupAvatarGrid: {
    borderRadius: 12,
    overflow: 'hidden',
    flexDirection: 'row',
    flexWrap: 'wrap',
    backgroundColor: '#dfe8f7',
  },
  groupAvatarCell: {
    width: '50%',
    height: '50%',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.8)',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#d7e4f8',
  },
  groupAvatarImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  groupAvatarFallbackText: {
    color: '#2f6bd9',
    fontSize: 11,
    fontWeight: '700',
  },
});

<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import FoundFriends from './FoundFriends.vue'

const apiBase = import.meta.env.VITE_API_BASE || 'http://192.168.0.6:3001'
const token = localStorage.getItem('xinchat.token') || ''
const READ_AT_KEY = 'xinchat.readAt'
const PAGE_LIMIT = 30
const UNREAD_LIMIT = 200
const HEARTBEAT_MS = 20000
const RECONNECT_BASE_MS = 1500
const RECONNECT_MAX_MS = 10000

const profileData = ref({
  username: '',
  nickname: '',
  avatar: '',
  uid: null,
})
const friends = ref([])
const latestMap = ref({})
const loadingFriends = ref(false)

const messagesByUid = reactive({})
const unreadMap = reactive({})
const historyLoading = reactive({})
const historyHasMore = reactive({})
const readAtMap = reactive(loadReadAtMap())

const activeChatUid = ref(null)
const messageListRef = ref(null)
const draftMessage = ref('')
const activeView = ref('list')
const friendsRefreshKey = ref(0)

let ws = null
let heartbeatTimer = null
let reconnectTimer = null
let reconnectAttempts = 0
const messageIdSets = new Map()

const displayName = computed(
  () => profileData.value.nickname || profileData.value.username || '加载中...'
)
const avatarUrl = computed(() => profileData.value.avatar || '')
const avatarText = computed(() => displayName.value.slice(0, 2))
const activeChatFriend = computed(() => {
  if (!activeChatUid.value) return null
  return friends.value.find((item) => item.uid === activeChatUid.value) || null
})
const activeChatMessages = computed(() => {
  if (!activeChatUid.value) return []
  return messagesByUid[activeChatUid.value] || []
})
const selfUid = computed(() => profileData.value.uid)
const canSend = computed(() => draftMessage.value.trim().length > 0)

const getAvatarText = (value) => {
  const text = String(value || '').trim()
  if (!text) return '??'
  return text.slice(0, 2)
}

const authHeaders = () => (token ? { Authorization: `Bearer ${token}` } : {})

const loadProfile = async () => {
  if (!token) return
  try {
    const response = await fetch(`${apiBase}/api/profile`, {
      headers: { ...authHeaders() },
    })
    const data = await response.json().catch(() => ({}))
    if (response.ok && data?.success && data?.user) {
      profileData.value = { ...profileData.value, ...data.user }
    }
  } catch {}
}

const normalizeMessage = (entry) => {
  const createdAt = entry?.createdAt || ''
  const createdAtMs = Number(entry?.createdAtMs)
  const parsedMs = Number.isFinite(createdAtMs)
    ? createdAtMs
    : Number.isFinite(Date.parse(createdAt))
      ? Date.parse(createdAt)
      : Date.now()
  return {
    id: entry.id,
    senderUid: entry.senderUid,
    targetUid: entry.targetUid,
    targetType: entry.targetType,
    content: entry?.data?.content || entry?.data?.text || '',
    createdAt,
    createdAtMs: parsedMs,
    raw: entry,
  }
}

const formatMessage = (msg) => {
  if (!msg) return ''
  if (msg.type === 'text') return msg.data?.content || msg.data?.text || ''
  if (msg.type === 'image') return '[图片]'
  if (msg.type === 'file') return '[文件]'
  if (msg.type === 'voice') return '[语音]'
  return '[消息]'
}

const formatTime = (value) => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

const ensureMessageBucket = (uid) => {
  if (!messagesByUid[uid]) {
    messagesByUid[uid] = []
  }
  if (!messageIdSets.has(uid)) {
    messageIdSets.set(uid, new Set())
  }
  if (typeof unreadMap[uid] !== 'number') {
    unreadMap[uid] = 0
  }
  if (typeof historyLoading[uid] !== 'boolean') {
    historyLoading[uid] = false
  }
  if (typeof historyHasMore[uid] !== 'boolean') {
    historyHasMore[uid] = true
  }
}

function loadReadAtMap() {
  try {
    const raw = localStorage.getItem(READ_AT_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const persistReadAtMap = () => {
  try {
    localStorage.setItem(READ_AT_KEY, JSON.stringify(readAtMap))
  } catch {}
}

const getReadAt = (uid) => {
  const value = Number(readAtMap[uid])
  return Number.isFinite(value) ? value : 0
}

const setReadAt = (uid, ts) => {
  if (!uid) return
  readAtMap[uid] = ts
  persistReadAtMap()
}

const recalcUnread = (uid) => {
  const list = messagesByUid[uid] || []
  const readAt = getReadAt(uid)
  const count = list.filter(
    (item) => item.senderUid !== selfUid.value && item.createdAtMs > readAt
  ).length
  unreadMap[uid] = count
}

const updateLatest = (uid, entry) => {
  if (!uid || !entry) return
  const messageText = entry?.content || formatMessage(entry?.raw || entry)
  latestMap.value = {
    ...latestMap.value,
    [uid]: {
      text: messageText || '暂无消息',
      time: formatTime(entry?.createdAt || entry?.raw?.createdAt),
    },
  }
}

const insertMessages = (uid, list, { prepend } = {}) => {
  ensureMessageBucket(uid)
  const bucket = messagesByUid[uid]
  const idSet = messageIdSets.get(uid)
  const incoming = list
    .map(normalizeMessage)
    .filter((entry) => entry.id && !idSet.has(entry.id))
    .sort((a, b) => a.createdAtMs - b.createdAtMs)

  if (!incoming.length) return
  incoming.forEach((entry) => idSet.add(entry.id))

  if (prepend) {
    bucket.unshift(...incoming)
  } else {
    bucket.push(...incoming)
  }

  const last = bucket[bucket.length - 1]
  if (last) {
    const friendUid =
      last.senderUid === selfUid.value ? last.targetUid : last.senderUid
    updateLatest(friendUid, last)
  }
  recalcUnread(uid)
}

const loadLatestForFriend = async (uid) => {
  try {
    const params = new URLSearchParams({
      targetType: 'private',
      targetUid: String(uid),
      limit: '1',
    })
    const response = await fetch(`${apiBase}/api/chat/get?${params.toString()}`,
      {
        headers: { ...authHeaders() },
      }
    )
    const data = await response.json().catch(() => ({}))
    if (response.ok && data?.success && Array.isArray(data?.data)) {
      const last = data.data[data.data.length - 1]
      if (last) {
        updateLatest(uid, normalizeMessage(last))
      }
    }
  } catch {}
}

const loadUnreadCount = async (uid) => {
  const sinceTs = getReadAt(uid)
  if (!sinceTs) return
  try {
    const params = new URLSearchParams({
      targetType: 'private',
      targetUid: String(uid),
      limit: String(UNREAD_LIMIT),
      sinceTs: String(sinceTs),
    })
    const response = await fetch(`${apiBase}/api/chat/get?${params.toString()}`,
      {
        headers: { ...authHeaders() },
      }
    )
    const data = await response.json().catch(() => ({}))
    if (response.ok && data?.success && Array.isArray(data?.data)) {
      const count = data.data.filter(
        (item) => item.senderUid !== selfUid.value
      ).length
      unreadMap[uid] = Math.min(count, 99)
    }
  } catch {}
}

const loadFriends = async () => {
  if (!token) return
  loadingFriends.value = true
  try {
    const response = await fetch(`${apiBase}/api/friends/list`, {
      headers: { ...authHeaders() },
    })
    const data = await response.json().catch(() => ({}))
    if (response.ok && data?.success && Array.isArray(data?.friends)) {
      friends.value = data.friends
      await Promise.all(
        data.friends.map(async (friend) => {
          ensureMessageBucket(friend.uid)
          await loadLatestForFriend(friend.uid)
          await loadUnreadCount(friend.uid)
        })
      )
    }
  } catch {}
  loadingFriends.value = false
}

const loadHistory = async (uid, { beforeId } = {}) => {
  if (!token) return
  ensureMessageBucket(uid)
  if (historyLoading[uid]) return
  historyLoading[uid] = true
  try {
    const params = new URLSearchParams({
      targetType: 'private',
      targetUid: String(uid),
      limit: String(PAGE_LIMIT),
    })
    if (beforeId) {
      params.set('beforeId', beforeId)
    }
    const response = await fetch(`${apiBase}/api/chat/get?${params.toString()}`,
      {
        headers: { ...authHeaders() },
      }
    )
    const data = await response.json().catch(() => ({}))
    if (response.ok && data?.success && Array.isArray(data?.data)) {
      insertMessages(uid, data.data, { prepend: Boolean(beforeId) })
      if (data.data.length < PAGE_LIMIT) {
        historyHasMore[uid] = false
      }
    }
  } catch {}
  historyLoading[uid] = false
}

const markChatRead = (uid) => {
  if (!uid) return
  const list = messagesByUid[uid] || []
  const last = list[list.length - 1]
  const lastTime = last ? last.createdAtMs : Date.now()
  setReadAt(uid, lastTime)
  unreadMap[uid] = 0
}

const openChat = async (friend) => {
  if (!friend) return
  activeChatUid.value = friend.uid
  ensureMessageBucket(friend.uid)
  if ((messagesByUid[friend.uid] || []).length === 0) {
    await loadHistory(friend.uid)
  }
  await nextTick()
  scrollToBottom()
  markChatRead(friend.uid)
}

const closeChat = () => {
  if (activeChatUid.value) {
    markChatRead(activeChatUid.value)
  }
  activeChatUid.value = null
}

const openFoundFriends = () => {
  activeView.value = 'found'
}

const closeFoundFriends = () => {
  activeView.value = 'list'
}

const scrollToBottom = () => {
  const el = messageListRef.value
  if (!el) return
  el.scrollTop = el.scrollHeight
}

const onChatScroll = async () => {
  const uid = activeChatUid.value
  if (!uid) return
  const el = messageListRef.value
  if (!el) return
  if (el.scrollTop > 40) return
  if (!historyHasMore[uid] || historyLoading[uid]) return
  const first = (messagesByUid[uid] || [])[0]
  if (!first) return
  const prevHeight = el.scrollHeight
  await loadHistory(uid, { beforeId: first.id })
  await nextTick()
  const nextHeight = el.scrollHeight
  el.scrollTop = nextHeight - prevHeight
}

const sendText = async () => {
  if (!canSend.value || !activeChatUid.value || !selfUid.value) return
  const content = draftMessage.value.trim()
  if (!content) return
  const payload = {
    senderUid: selfUid.value,
    targetUid: activeChatUid.value,
    targetType: 'private',
    type: 'text',
    content,
  }
  try {
    const response = await fetch(`${apiBase}/api/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(payload),
    })
    const data = await response.json().catch(() => ({}))
    if (response.ok && data?.success && data?.data) {
      insertMessages(activeChatUid.value, [data.data])
      draftMessage.value = ''
      await nextTick()
      scrollToBottom()
    }
  } catch {}
}

const deleteMessage = async (uid, message) => {
  if (!message?.id) return
  const actionLabel =
    message.senderUid === selfUid.value ? '撤回这条消息？' : '删除这条消息？'
  if (!window.confirm(actionLabel)) return
  try {
    const response = await fetch(`${apiBase}/api/chat/del`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ id: message.id }),
    })
    const data = await response.json().catch(() => ({}))
    if (response.ok && data?.success) {
      const bucket = messagesByUid[uid] || []
      messagesByUid[uid] = bucket.filter((item) => item.id !== message.id)
      const idSet = messageIdSets.get(uid)
      if (idSet) {
        idSet.delete(message.id)
      }
      const last = messagesByUid[uid][messagesByUid[uid].length - 1]
      if (last) {
        updateLatest(uid, last)
      }
      recalcUnread(uid)
    }
  } catch {}
}

const buildWsUrl = () => {
  try {
    const base = new URL(apiBase)
    const protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${base.host}/ws?token=${encodeURIComponent(token)}`
  } catch {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`
  }
}

const startHeartbeat = () => {
  if (heartbeatTimer) return
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'heartbeat' }))
    }
  }, HEARTBEAT_MS)
}

const stopHeartbeat = () => {
  if (!heartbeatTimer) return
  clearInterval(heartbeatTimer)
  heartbeatTimer = null
}

const updatePresence = (uid, online) => {
  const idx = friends.value.findIndex((item) => item.uid === uid)
  if (idx === -1) return
  friends.value[idx] = { ...friends.value[idx], online: Boolean(online) }
}

const requestFriendsRefresh = () => {
  friendsRefreshKey.value += 1
  void loadFriends()
}

const handleWsMessage = (payload) => {
  if (!payload || typeof payload !== 'object') return
  if (payload.type === 'chat') {
    const entry = payload.data
    if (!entry?.id) return
    const message = normalizeMessage(entry)
    const friendUid =
      message.senderUid === selfUid.value ? message.targetUid : message.senderUid
    insertMessages(friendUid, [entry])

    if (activeChatUid.value === friendUid) {
      markChatRead(friendUid)
      nextTick().then(scrollToBottom)
    }
    return
  }
  if (payload.type === 'friends') {
    requestFriendsRefresh()
    return
  }
  if (payload.type === 'requests') {
    friendsRefreshKey.value += 1
    return
  }
  if (payload.type === 'presence') {
    const uid = Number(payload?.data?.uid)
    if (Number.isInteger(uid)) {
      updatePresence(uid, payload?.data?.online)
    }
    return
  }
  if (payload.type === 'presence_snapshot') {
    const list = Array.isArray(payload?.data) ? payload.data : []
    list.forEach((entry) => {
      const uid = Number(entry?.uid)
      if (Number.isInteger(uid)) {
        updatePresence(uid, entry?.online)
      }
    })
  }
}

const scheduleReconnect = () => {
  if (reconnectTimer) return
  const delay = Math.min(
    RECONNECT_BASE_MS * (1 + reconnectAttempts),
    RECONNECT_MAX_MS
  )
  reconnectAttempts += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectWs()
  }, delay)
}

const connectWs = () => {
  if (!token) return
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return
  }
  try {
    ws = new WebSocket(buildWsUrl())
  } catch {
    scheduleReconnect()
    return
  }

  ws.onopen = () => {
    reconnectAttempts = 0
    startHeartbeat()
  }
  ws.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data)
      handleWsMessage(payload)
    } catch {}
  }
  ws.onclose = () => {
    stopHeartbeat()
    scheduleReconnect()
  }
  ws.onerror = () => {
    stopHeartbeat()
    scheduleReconnect()
  }
}

const teardownWs = () => {
  stopHeartbeat()
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (ws) {
    try {
      ws.close()
    } catch {}
    ws = null
  }
}

onMounted(async () => {
  await loadProfile()
  await loadFriends()
  connectWs()
})

onUnmounted(() => {
  teardownWs()
})
</script>

<template>
  <div class="page">
    <template v-if="activeView === 'found' && !activeChatUid">
      <FoundFriends
        :friends="friends"
        :self-uid="selfUid"
        :refresh-key="friendsRefreshKey"
        @back="closeFoundFriends"
        @refresh-friends="requestFriendsRefresh"
      />
    </template>

    <template v-else-if="activeChatUid">
      <header class="chat-header">
        <button class="chat-back" type="button" @click="closeChat">
          <span class="chevron"></span>
        </button>
        <div class="chat-title">
          <div class="chat-name">
            {{ activeChatFriend?.nickname || activeChatFriend?.username || '聊天' }}
          </div>
          <div class="chat-status" :class="{ online: activeChatFriend?.online }">
            {{ activeChatFriend?.online ? '在线' : '离线' }}
          </div>
        </div>
      </header>

      <div class="chat-body" ref="messageListRef" @scroll="onChatScroll">
        <div v-if="historyLoading[activeChatUid] && activeChatMessages.length === 0" class="empty">
          正在加载消息...
        </div>
        <div v-else-if="activeChatMessages.length === 0" class="empty">
          还没有消息，先聊几句吧。
        </div>
        <div v-else class="message-list">
          <div v-if="historyHasMore[activeChatUid]" class="load-more">
            {{ historyLoading[activeChatUid] ? '加载更多...' : '上拉加载更多' }}
          </div>
          <div
            v-for="item in activeChatMessages"
            :key="item.id"
            class="message-row"
            :class="{ self: item.senderUid === selfUid }"
          >
            <div class="bubble">
              <div class="text">{{ item.content }}</div>
              <div class="meta">
                <span class="time">{{ formatTime(item.createdAt) }}</span>
                <span
                  v-if="item.senderUid !== selfUid"
                  class="read"
                >
                  {{ item.createdAtMs <= getReadAt(activeChatUid) ? '已读' : '未读' }}
                </span>
              </div>
            </div>
            <button
              class="delete-btn"
              type="button"
              @click="deleteMessage(activeChatUid, item)"
            >
              {{ item.senderUid === selfUid ? '撤回' : '删除' }}
            </button>
          </div>
        </div>
      </div>

      <div class="chat-input">
        <input
          v-model="draftMessage"
          type="text"
          placeholder="输入消息..."
          @keydown.enter.prevent="sendText"
        />
        <button type="button" :disabled="!canSend" @click="sendText">发送</button>
      </div>
    </template>

    <template v-else>
      <header class="header">
        <div class="user-info">
          <div class="avatar">
            <img v-if="avatarUrl" :src="avatarUrl" alt="avatar" />
            <span v-else>{{ avatarText }}</span>
          </div>

          <div class="username">{{ displayName }}</div>
        </div>

        <button class="add-btn" type="button" @click="openFoundFriends">
          <div class="icon-plus"></div>
        </button>
      </header>

      <div class="search-container">
        <div class="search-box">
          <svg class="search-icon-svg" viewBox="0 0 24 24">
            <path
              d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"
            />
          </svg>
          <span>搜索</span>
        </div>
      </div>

      <div class="content">
        <div v-if="loadingFriends" class="empty">正在加载联系人...</div>
        <div v-else-if="friends.length === 0" class="empty">暂无联系人</div>
        <div v-else class="contacts">
          <button
            v-for="friend in friends"
            :key="friend.uid"
            class="contact-item"
            type="button"
            @click="openChat(friend)"
          >
            <div class="contact-avatar">
              <img v-if="friend.avatar" :src="friend.avatar" alt="avatar" />
              <span v-else>{{ getAvatarText(friend.nickname || friend.username) }}</span>
              <span class="presence" :class="{ online: friend.online }"></span>
            </div>
            <div class="contact-info">
              <div class="contact-name">
                {{ friend.nickname || friend.username }}
              </div>
              <div class="contact-sub">
                {{ latestMap[friend.uid]?.text || '暂无消息' }}
              </div>
            </div>
            <div class="contact-meta">
              <div class="contact-time">
                {{ latestMap[friend.uid]?.time || '' }}
              </div>
              <div v-if="unreadMap[friend.uid] > 0" class="unread-badge">
                {{ unreadMap[friend.uid] > 99 ? '99+' : unreadMap[friend.uid] }}
              </div>
            </div>
          </button>
        </div>
      </div>

      <nav class="bottom-nav">
        <div class="nav-item active">
          <svg class="nav-icon" viewBox="0 0 24 24">
            <path
              d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"
            />
          </svg>
          <span class="nav-text">消息</span>
        </div>
        <div class="nav-item">
          <svg class="nav-icon" viewBox="0 0 24 24">
            <path
              d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"
            />
          </svg>
          <span class="nav-text">联系人</span>
        </div>
      </nav>
    </template>
  </div>
</template>

<style scoped>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
  -webkit-tap-highlight-color: transparent;
}

.page {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background-color: #f5f6fa;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding-top: env(safe-area-inset-top);
  box-sizing: border-box;
}

.header {
  background-color: #f5f6fa;
  padding: 12px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 64px;
  z-index: 100;
}

.user-info {
  display: flex;
  align-items: center;
  gap: 14px;
}

.avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  overflow: hidden;
  border: 1px solid rgba(0, 0, 0, 0.05);
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
}

.avatar svg,
.avatar img,
.contact-avatar img {
  width: 100%;
  height: 100%;
}

.avatar span,
.contact-avatar span {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 16px;
  font-weight: 700;
  color: #2f6bd9;
  letter-spacing: 0.04em;
  text-align: center;
  line-height: 1;
}

.username {
  font-size: 19px;
  font-weight: 600;
  color: #1a1a1a;
  letter-spacing: 0.5px;
  line-height: 1;
}

.add-btn {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
}

.icon-plus {
  position: relative;
  width: 20px;
  height: 20px;
}

.icon-plus::before,
.icon-plus::after {
  content: '';
  position: absolute;
  background-color: #1a1a1a;
  border-radius: 2px;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
}

.icon-plus::before {
  width: 2px;
  height: 20px;
}

.icon-plus::after {
  width: 20px;
  height: 2px;
}

.search-container {
  padding: 6px 16px 12px;
  background-color: #f5f6fa;
}

.search-box {
  background-color: #ffffff;
  height: 38px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: #8a8a8a;
  font-size: 15px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.02);
}

.search-icon-svg {
  width: 18px;
  height: 18px;
  fill: #a0a0a0;
}

.content {
  flex: 1;
  overflow-y: auto;
  padding: 0 16px 16px;
}

.contacts {
  display: grid;
  gap: 10px;
}

.contact-item {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 12px;
  align-items: center;
  background: #ffffff;
  border-radius: 12px;
  padding: 10px 12px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.03);
  border: none;
  width: 100%;
  text-align: left;
  cursor: pointer;
}

.contact-avatar {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  overflow: hidden;
  border: 1px solid rgba(0, 0, 0, 0.06);
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  color: #0099ff;
  position: relative;
}

.contact-avatar span {
  font-size: 16px;
}

.presence {
  position: absolute;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  right: 0;
  bottom: 0;
  border: 2px solid #fff;
  background: #c8c8c8;
}

.presence.online {
  background: #30c67c;
}

.contact-info {
  display: grid;
  gap: 4px;
}

.contact-name {
  font-size: 15px;
  font-weight: 600;
  color: #1a1a1a;
}

.contact-sub {
  font-size: 12px;
  color: #8a8a8a;
  line-height: 1.2;
}

.contact-meta {
  display: grid;
  gap: 6px;
  justify-items: end;
}

.contact-time {
  font-size: 11px;
  color: #9a9a9a;
}

.unread-badge {
  min-width: 18px;
  padding: 2px 6px;
  border-radius: 999px;
  background: #ff4d4f;
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  text-align: center;
}

.empty {
  font-size: 12px;
  color: #9a9a9a;
  padding: 12px 0;
  text-align: center;
}

.bottom-nav {
  height: 68px;
  background-color: #f9f9f9;
  border-top: 1px solid rgba(0, 0, 0, 0.08);
  display: flex;
  align-items: center;
  padding-bottom: constant(safe-area-inset-bottom);
  padding-bottom: env(safe-area-inset-bottom);
  padding-top: 6px;
  box-sizing: border-box;
}

.nav-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 100%;
}

.nav-text {
  font-size: 11px;
  color: #7d7d7d;
  font-weight: 500;
}

.nav-icon {
  width: 28px;
  height: 28px;
  fill: #7d7d7d;
}

.nav-item.active .nav-text {
  color: #0099ff;
  font-weight: 600;
}

.nav-item.active .nav-icon {
  fill: #0099ff;
}

.chat-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: #f5f6fa;
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);
}

.chat-back {
  border: none;
  background: none;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.chevron {
  width: 10px;
  height: 10px;
  border-left: 2px solid #333;
  border-bottom: 2px solid #333;
  transform: rotate(45deg);
  margin-left: 4px;
}

.chat-title {
  display: grid;
  gap: 4px;
}

.chat-name {
  font-size: 16px;
  font-weight: 600;
  color: #1a1a1a;
}

.chat-status {
  font-size: 11px;
  color: #9a9a9a;
}

.chat-status.online {
  color: #30c67c;
}

.chat-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  background: #f2f3f5;
}

.message-list {
  display: grid;
  gap: 12px;
}

.load-more {
  text-align: center;
  font-size: 11px;
  color: #9a9a9a;
}

.message-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.message-row.self {
  flex-direction: row-reverse;
}

.bubble {
  max-width: 70%;
  padding: 10px 12px;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.04);
}

.message-row.self .bubble {
  background: #4a9df8;
  color: #fff;
}

.text {
  font-size: 14px;
  line-height: 1.4;
  word-break: break-word;
}

.meta {
  margin-top: 6px;
  display: flex;
  gap: 8px;
  font-size: 10px;
  color: rgba(0, 0, 0, 0.45);
}

.message-row.self .meta {
  color: rgba(255, 255, 255, 0.7);
}

.read {
  font-weight: 600;
}

.delete-btn {
  border: none;
  background: none;
  color: #888;
  font-size: 11px;
  cursor: pointer;
}

.message-row.self .delete-btn {
  color: rgba(255, 255, 255, 0.7);
}

.chat-input {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid rgba(0, 0, 0, 0.05);
  background: #fff;
}

.chat-input input {
  flex: 1;
  border: 1px solid #e1e1e1;
  border-radius: 20px;
  padding: 8px 14px;
  font-size: 14px;
  outline: none;
}

.chat-input button {
  border: none;
  background: #4a9df8;
  color: #fff;
  padding: 8px 14px;
  border-radius: 16px;
  font-size: 14px;
  cursor: pointer;
}

.chat-input button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>

<script setup>
import { computed, onMounted, ref } from 'vue'

const apiBase = import.meta.env.VITE_API_BASE || 'http://localhost:3001'
const token = localStorage.getItem('xinchat.token') || ''

const profileData = ref({
  username: '',
  nickname: '',
  avatar: '',
  uid: null,
})
const friends = ref([])
const latestMap = ref({})
const loadingFriends = ref(false)

const displayName = computed(
  () => profileData.value.nickname || profileData.value.username || '加载中...'
)
const avatarUrl = computed(() => profileData.value.avatar || '')
const avatarText = computed(() => displayName.value.slice(0, 2))

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

const loadLatestForFriend = async (uid) => {
  try {
    const params = new URLSearchParams({
      targetType: 'private',
      targetUid: String(uid),
      limit: '1',
    })
    const response = await fetch(`${apiBase}/api/chat/get?${params.toString()}`, {
      headers: { ...authHeaders() },
    })
    const data = await response.json().catch(() => ({}))
    if (response.ok && data?.success && Array.isArray(data?.data)) {
      const last = data.data[data.data.length - 1]
      if (last) {
        latestMap.value = {
          ...latestMap.value,
          [uid]: {
            text: formatMessage(last),
            time: formatTime(last.createdAt),
          },
        }
      }
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
        data.friends.map((friend) => loadLatestForFriend(friend.uid))
      )
    }
  } catch {}
  loadingFriends.value = false
}

onMounted(async () => {
  await loadProfile()
  await loadFriends()
})
</script>

<template>
  <div class="page">
    <header class="header">
      <div class="user-info">
        <div class="avatar">
          <img v-if="avatarUrl" :src="avatarUrl" alt="avatar" />
          <span v-else>{{ avatarText }}</span>
        </div>

        <div class="username">{{ displayName }}</div>
      </div>

      <div class="add-btn">
        <div class="icon-plus"></div>
      </div>
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
        <div v-for="friend in friends" :key="friend.uid" class="contact-item">
          <div class="contact-avatar">
            <img v-if="friend.avatar" :src="friend.avatar" alt="avatar" />
            <span v-else>{{ getAvatarText(friend.nickname || friend.username) }}</span>
          </div>
          <div class="contact-info">
            <div class="contact-name">
              {{ friend.nickname || friend.username }}
            </div>
            <div class="contact-sub">
              {{ latestMap[friend.uid]?.text || '暂无消息' }}
            </div>
          </div>
          <div class="contact-time">
            {{ latestMap[friend.uid]?.time || '' }}
          </div>
        </div>
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
}

.contact-avatar span {
  font-size: 16px;
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

.contact-time {
  font-size: 11px;
  color: #9a9a9a;
}

.empty {
  font-size: 12px;
  color: #9a9a9a;
  padding: 12px 0;
}

.bottom-nav {
  height: 60px;
  background-color: #f9f9f9;
  border-top: 1px solid rgba(0, 0, 0, 0.08);
  display: flex;
  align-items: center;
  padding-bottom: constant(safe-area-inset-bottom);
  padding-bottom: env(safe-area-inset-bottom);
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
</style>

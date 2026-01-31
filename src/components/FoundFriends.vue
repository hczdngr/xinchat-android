<script setup>
import { computed, onMounted, ref, watch } from 'vue'

const props = defineProps({
  friends: {
    type: Array,
    default: () => [],
  },
  selfUid: {
    type: Number,
    default: null,
  },
  refreshKey: {
    type: Number,
    default: 0,
  },
})

const emit = defineEmits(['back', 'refresh-friends'])

const apiBase = import.meta.env.VITE_API_BASE || 'http://192.168.0.6:3001'
const token = localStorage.getItem('xinchat.token') || ''

const activeTab = ref('search')
const searchUid = ref('')
const searching = ref(false)
const searchError = ref('')
const searchResult = ref(null)
const requestStatus = ref('')

const requestsLoading = ref(false)
const incomingRequests = ref([])
const outgoingRequests = ref([])
const requestsError = ref('')

const friendsLoading = ref(false)
const friendsError = ref('')

const authHeaders = () => (token ? { Authorization: `Bearer ${token}` } : {})

const friendUidSet = computed(() =>
  new Set((props.friends || []).map((friend) => friend.uid))
)
const outgoingPendingSet = computed(() =>
  new Set(
    (outgoingRequests.value || [])
      .filter((item) => item.status === 'pending')
      .map((item) => item.uid)
  )
)
const incomingPendingSet = computed(() =>
  new Set(
    (incomingRequests.value || [])
      .filter((item) => item.status === 'pending')
      .map((item) => item.uid)
  )
)

const searchHint = computed(() => {
  if (!searchResult.value) return ''
  const uid = searchResult.value.uid
  if (friendUidSet.value.has(uid)) return '已是好友'
  if (outgoingPendingSet.value.has(uid)) return '请求已发送'
  if (incomingPendingSet.value.has(uid)) return '对方已请求你'
  return ''
})

const resetSearch = () => {
  searchError.value = ''
  requestStatus.value = ''
  searchResult.value = null
}

const loadRequests = async () => {
  if (!token) return
  requestsLoading.value = true
  requestsError.value = ''
  try {
    const response = await fetch(`${apiBase}/api/friends/requests`, {
      headers: { ...authHeaders() },
    })
    const data = await response.json().catch(() => ({}))
    if (response.ok && data?.success) {
      incomingRequests.value = Array.isArray(data?.incoming) ? data.incoming : []
      outgoingRequests.value = Array.isArray(data?.outgoing) ? data.outgoing : []
    } else {
      requestsError.value = data?.message || '请求列表加载失败。'
    }
  } catch {
    requestsError.value = '网络错误，请稍后重试。'
  }
  requestsLoading.value = false
}

const onSearch = async () => {
  const raw = searchUid.value.trim()
  resetSearch()
  if (!raw) {
    searchError.value = '请输入 UID。'
    return
  }
  const uid = Number(raw)
  if (!Number.isInteger(uid)) {
    searchError.value = 'UID 需要是数字。'
    return
  }
  searching.value = true
  try {
    const params = new URLSearchParams({ uid: String(uid) })
    const response = await fetch(
      `${apiBase}/api/friends/search?${params.toString()}`,
      { headers: { ...authHeaders() } }
    )
    const data = await response.json().catch(() => ({}))
    if (response.ok && data?.success && data?.user) {
      searchResult.value = data.user
      if (data.user.uid === props.selfUid) {
        searchError.value = '不能添加自己。'
      }
    } else {
      searchError.value = data?.message || '未找到该用户。'
    }
  } catch {
    searchError.value = '网络错误，请稍后重试。'
  }
  searching.value = false
}

const sendRequest = async () => {
  if (!searchResult.value) return
  requestStatus.value = ''
  const uid = searchResult.value.uid
  if (uid === props.selfUid) {
    requestStatus.value = '不能添加自己。'
    return
  }
  if (friendUidSet.value.has(uid)) {
    requestStatus.value = '已经是好友了。'
    return
  }
  if (outgoingPendingSet.value.has(uid)) {
    requestStatus.value = '请求已发送。'
    return
  }
  try {
    const response = await fetch(`${apiBase}/api/friends/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ friendUid: uid }),
    })
    const data = await response.json().catch(() => ({}))
    if (response.ok && data?.success) {
      if (data.status === 'accepted') {
        requestStatus.value = '已互为好友。'
        emit('refresh-friends')
      } else if (data.status === 'pending') {
        requestStatus.value = '请求已发送。'
      } else if (data.status === 'already_friends') {
        requestStatus.value = '已经是好友了。'
      } else {
        requestStatus.value = '已提交请求。'
      }
      await loadRequests()
    } else {
      requestStatus.value = data?.message || '发送失败。'
    }
  } catch {
    requestStatus.value = '网络错误，请稍后重试。'
  }
}

const respondRequest = async (uid, action) => {
  if (!uid) return
  try {
    const response = await fetch(`${apiBase}/api/friends/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ requesterUid: uid, action }),
    })
    const data = await response.json().catch(() => ({}))
    if (response.ok && data?.success) {
      await loadRequests()
      emit('refresh-friends')
    } else {
      requestsError.value = data?.message || '处理失败。'
    }
  } catch {
    requestsError.value = '网络错误，请稍后重试。'
  }
}

const removeFriend = async (uid) => {
  if (!uid) return
  if (!window.confirm('确定删除好友吗？')) return
  friendsLoading.value = true
  friendsError.value = ''
  try {
    const response = await fetch(`${apiBase}/api/friends/remove`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ friendUid: uid }),
    })
    const data = await response.json().catch(() => ({}))
    if (response.ok && data?.success) {
      emit('refresh-friends')
    } else {
      friendsError.value = data?.message || '删除失败。'
    }
  } catch {
    friendsError.value = '网络错误，请稍后重试。'
  }
  friendsLoading.value = false
}

watch(
  () => props.refreshKey,
  () => {
    void loadRequests()
  }
)

onMounted(async () => {
  await loadRequests()
})
</script>

<template>
  <div class="found-page">
    <header class="found-header">
      <button class="back-btn" type="button" @click="emit('back')">
        <span class="chevron"></span>
      </button>
      <div class="title">发现好友</div>
    </header>

    <div class="tabs">
      <button
        class="tab"
        :class="{ active: activeTab === 'search' }"
        type="button"
        @click="activeTab = 'search'"
      >
        搜索
      </button>
      <button
        class="tab"
        :class="{ active: activeTab === 'requests' }"
        type="button"
        @click="activeTab = 'requests'"
      >
        请求
      </button>
      <button
        class="tab"
        :class="{ active: activeTab === 'friends' }"
        type="button"
        @click="activeTab = 'friends'"
      >
        好友
      </button>
    </div>

    <section v-if="activeTab === 'search'" class="panel">
      <div class="search-card">
        <input
          v-model="searchUid"
          type="text"
          placeholder="输入好友 UID"
        />
        <button type="button" :disabled="searching" @click="onSearch">
          {{ searching ? '搜索中...' : '搜索' }}
        </button>
      </div>
      <p v-if="searchError" class="message error">{{ searchError }}</p>

      <div v-if="searchResult" class="result-card">
        <div class="result-info">
          <div class="avatar">
            <img v-if="searchResult.avatar" :src="searchResult.avatar" alt="avatar" />
            <span v-else>{{ String(searchResult.username || searchResult.uid).slice(0, 2) }}</span>
          </div>
          <div>
            <div class="result-name">{{ searchResult.username }}</div>
            <div class="result-id">UID {{ searchResult.uid }}</div>
            <div v-if="searchHint" class="hint">{{ searchHint }}</div>
          </div>
        </div>
        <button
          type="button"
          class="action-btn"
          :disabled="searchHint || searchResult.uid === props.selfUid"
          @click="sendRequest"
        >
          发送请求
        </button>
        <p v-if="requestStatus" class="message success">{{ requestStatus }}</p>
      </div>
    </section>

    <section v-else-if="activeTab === 'requests'" class="panel">
      <div class="section-title">待处理</div>
      <p v-if="requestsError" class="message error">{{ requestsError }}</p>
      <div v-if="requestsLoading" class="empty">正在加载请求...</div>
      <div v-else-if="incomingRequests.length === 0" class="empty">暂无待处理请求</div>
      <div v-else class="list">
        <div v-for="item in incomingRequests" :key="item.uid" class="row">
          <div class="row-info">
            <div class="avatar small">
              <img v-if="item.avatar" :src="item.avatar" alt="avatar" />
              <span v-else>{{ String(item.username || item.uid).slice(0, 2) }}</span>
            </div>
            <div>
              <div class="row-name">{{ item.username }}</div>
              <div class="row-sub">UID {{ item.uid }}</div>
            </div>
          </div>
          <div class="row-actions">
            <button type="button" @click="respondRequest(item.uid, 'accept')">同意</button>
            <button type="button" class="ghost" @click="respondRequest(item.uid, 'reject')">
              拒绝
            </button>
          </div>
        </div>
      </div>

      <div class="section-title">我发出的</div>
      <div v-if="outgoingRequests.length === 0" class="empty">暂无已发送请求</div>
      <div v-else class="list">
        <div v-for="item in outgoingRequests" :key="item.uid" class="row">
          <div class="row-info">
            <div class="avatar small">
              <img v-if="item.avatar" :src="item.avatar" alt="avatar" />
              <span v-else>{{ String(item.username || item.uid).slice(0, 2) }}</span>
            </div>
            <div>
              <div class="row-name">{{ item.username }}</div>
              <div class="row-sub">UID {{ item.uid }}</div>
            </div>
          </div>
          <div class="row-status">
            {{ item.status === 'pending' ? '等待处理' : item.status === 'rejected' ? '已拒绝' : '已处理' }}
          </div>
        </div>
      </div>
    </section>

    <section v-else class="panel">
      <div class="section-title">好友列表</div>
      <p v-if="friendsError" class="message error">{{ friendsError }}</p>
      <div v-if="friendsLoading" class="empty">更新中...</div>
      <div v-else-if="props.friends.length === 0" class="empty">暂无好友</div>
      <div v-else class="list">
        <div v-for="friend in props.friends" :key="friend.uid" class="row">
          <div class="row-info">
            <div class="avatar small">
              <img v-if="friend.avatar" :src="friend.avatar" alt="avatar" />
              <span v-else>{{ String(friend.username || friend.uid).slice(0, 2) }}</span>
            </div>
            <div>
              <div class="row-name">{{ friend.nickname || friend.username }}</div>
              <div class="row-sub">UID {{ friend.uid }}</div>
            </div>
          </div>
          <button type="button" class="ghost" @click="removeFriend(friend.uid)">删除</button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
* {
  box-sizing: border-box;
}

.found-page {
  min-height: 100vh;
  background: #f5f6fa;
  display: flex;
  flex-direction: column;
}

.found-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  background: #f5f6fa;
}

.back-btn {
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

.title {
  font-size: 16px;
  font-weight: 600;
  color: #1a1a1a;
}

.tabs {
  display: flex;
  gap: 10px;
  padding: 10px 16px;
}

.tab {
  flex: 1;
  border: none;
  background: #fff;
  border-radius: 10px;
  padding: 8px 0;
  font-size: 13px;
  color: #666;
  cursor: pointer;
}

.tab.active {
  background: #4a9df8;
  color: #fff;
  font-weight: 600;
}

.panel {
  flex: 1;
  padding: 12px 16px 24px;
  overflow-y: auto;
}

.search-card {
  display: flex;
  gap: 10px;
  background: #fff;
  border-radius: 12px;
  padding: 12px;
}

.search-card input {
  flex: 1;
  border: none;
  outline: none;
  font-size: 14px;
}

.search-card button {
  border: none;
  background: #4a9df8;
  color: #fff;
  border-radius: 10px;
  padding: 0 16px;
  font-size: 13px;
  cursor: pointer;
}

.result-card {
  margin-top: 16px;
  background: #fff;
  border-radius: 12px;
  padding: 14px;
  display: grid;
  gap: 10px;
}

.result-info {
  display: flex;
  gap: 12px;
  align-items: center;
}

.avatar {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: #e6eaf0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  font-weight: 600;
  color: #4a9df8;
}

.avatar.small {
  width: 36px;
  height: 36px;
}

.result-name {
  font-size: 14px;
  font-weight: 600;
}

.result-id {
  font-size: 12px;
  color: #888;
}

.hint {
  font-size: 11px;
  color: #ff7a45;
}

.action-btn {
  border: none;
  background: #4a9df8;
  color: #fff;
  border-radius: 10px;
  padding: 8px 12px;
  font-size: 13px;
  cursor: pointer;
}

.action-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.section-title {
  margin-top: 6px;
  margin-bottom: 10px;
  font-size: 13px;
  font-weight: 600;
  color: #1a1a1a;
}

.list {
  display: grid;
  gap: 10px;
  margin-bottom: 16px;
}

.row {
  background: #fff;
  border-radius: 12px;
  padding: 10px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.row-info {
  display: flex;
  gap: 10px;
  align-items: center;
}

.row-name {
  font-size: 13px;
  font-weight: 600;
}

.row-sub {
  font-size: 11px;
  color: #888;
}

.row-actions {
  display: flex;
  gap: 8px;
}

.row-actions button {
  border: none;
  background: #4a9df8;
  color: #fff;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  cursor: pointer;
}

.row-actions .ghost {
  background: #f0f2f5;
  color: #666;
}

.row-status {
  font-size: 12px;
  color: #999;
}

.ghost {
  border: none;
  background: #f0f2f5;
  color: #666;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  cursor: pointer;
}

.message {
  font-size: 12px;
  margin-top: 8px;
}

.message.error {
  color: #b5482b;
}

.message.success {
  color: #2f6bd9;
}

.empty {
  font-size: 12px;
  color: #9a9a9a;
  padding: 12px 0;
  text-align: center;
}
</style>

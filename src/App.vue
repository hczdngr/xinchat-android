<script setup>
import { computed, ref } from 'vue'

const username = ref('')
const password = ref('')
const showPassword = ref(false)
const loading = ref(false)
const error = ref('')
const status = ref('')

const apiBase = import.meta.env.VITE_API_BASE || 'http://localhost:3001'
const token = ref(localStorage.getItem('xinchat.token') || '')
const profile = ref(
  JSON.parse(localStorage.getItem('xinchat.profile') || 'null') || {}
)

const canSubmit = computed(() => username.value.trim() && password.value)
const isAuthed = computed(() => Boolean(token.value))

const submit = async () => {
  error.value = ''
  status.value = ''

  if (!canSubmit.value) {
    error.value = 'Please enter username and password.'
    return
  }

  loading.value = true
  try {
    const response = await fetch(`${apiBase}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: username.value.trim(),
        password: password.value,
      }),
    })

    const data = await response.json().catch(() => ({}))
    if (!response.ok || !data?.success) {
      error.value = data?.message || 'Login failed. Please try again.'
      return
    }

    localStorage.setItem('xinchat.token', data.token || '')
    localStorage.setItem(
      'xinchat.profile',
      JSON.stringify({
        uid: data.uid,
        username: data.username,
        nickname: data.nickname,
        avatar: data.avatar,
        signature: data.signature,
        gender: data.gender,
        birthday: data.birthday,
        country: data.country,
        province: data.province,
        region: data.region,
        tokenExpiresAt: data.tokenExpiresAt,
      })
    )

    token.value = data.token || ''
    profile.value = {
      uid: data.uid,
      username: data.username,
      nickname: data.nickname,
      avatar: data.avatar,
      signature: data.signature,
    }
    status.value = data?.message || 'Login success.'
  } catch (err) {
    error.value = 'Network error. Check the server and try again.'
  } finally {
    loading.value = false
  }
}

const logout = () => {
  localStorage.removeItem('xinchat.token')
  localStorage.removeItem('xinchat.profile')
  token.value = ''
  profile.value = {}
}
</script>

<template>
  <div class="page">
    <div v-if="!isAuthed" class="login">
      <div class="hero">
        <div class="brand">
          <div class="brand-mark">XC</div>
          <div class="brand-text">
            <p class="brand-title">XinChat</p>
            <p class="brand-subtitle">Message, connect, stay close.</p>
          </div>
        </div>
        <div class="hero-copy">
          <h1>Welcome back</h1>
          <p>Sign in to continue your conversations.</p>
        </div>
      </div>

      <div class="card">
        <form class="form" @submit.prevent="submit">
          <label class="field">
            <span>Username</span>
            <input
              v-model="username"
              type="text"
              name="username"
              autocomplete="username"
              placeholder="Enter username"
            />
          </label>

          <label class="field">
            <span>Password</span>
            <div class="password">
              <input
                v-model="password"
                :type="showPassword ? 'text' : 'password'"
                name="password"
                autocomplete="current-password"
                placeholder="Enter password"
              />
              <button
                type="button"
                class="ghost"
                @click="showPassword = !showPassword"
              >
                {{ showPassword ? 'Hide' : 'Show' }}
              </button>
            </div>
          </label>

          <button class="primary" type="submit" :disabled="!canSubmit || loading">
            {{ loading ? 'Signing in...' : 'Sign in' }}
          </button>

          <p v-if="error" class="message error">{{ error }}</p>
          <p v-else-if="status" class="message success">{{ status }}</p>

          <div class="meta">
            <span>Server</span>
            <code>{{ apiBase }}</code>
          </div>
        </form>
      </div>
    </div>

    <div v-else class="home">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">XC</div>
          <div class="brand-text">
            <p class="brand-title">XinChat</p>
            <p class="brand-subtitle">Online</p>
          </div>
        </div>
        <div class="user">
          <div class="avatar">{{ (profile.nickname || 'U')[0] }}</div>
          <div>
            <p class="user-name">{{ profile.nickname || profile.username || 'User' }}</p>
            <p class="user-id">UID {{ profile.uid || '100000000' }}</p>
          </div>
          <button class="ghost" type="button" @click="logout">Logout</button>
        </div>
      </header>

      <div class="content">
        <aside class="sidebar">
          <div class="icon-pill active">💬</div>
          <div class="icon-pill">👥</div>
          <div class="icon-pill">⭐</div>
          <div class="icon-pill">⚙️</div>
        </aside>

        <section class="panel list">
          <div class="search">
            <input type="text" placeholder="Search chats or friends" />
            <button class="primary small" type="button">+</button>
          </div>
          <div class="list-block">
            <p class="list-title">Private chats</p>
            <div class="list-item active">
              <div class="avatar">RW</div>
              <div>
                <p class="list-name">rw0ter</p>
                <p class="list-sub">UID 100000000</p>
              </div>
            </div>
            <div class="list-item">
              <div class="avatar">DE</div>
              <div>
                <p class="list-name">demo_user</p>
                <p class="list-sub">UID 100000001</p>
              </div>
            </div>
          </div>
        </section>

        <section class="panel chat">
          <div class="chat-header">
            <div>
              <p class="chat-title">rw0ter</p>
              <p class="chat-sub">Private · Online</p>
            </div>
            <div class="chat-status">
              <span class="badge">PRIVATE</span>
              <span class="badge ghost">ONLINE</span>
            </div>
          </div>
          <div class="chat-body">
            <div class="bubble">
              <p>Welcome to XinChat mobile.</p>
              <span>14:17</span>
            </div>
            <div class="bubble me">
              <p>Let us build the next view.</p>
              <span>14:18</span>
            </div>
          </div>
          <div class="chat-input">
            <div class="tools">
              <span>😊</span>
              <span>📎</span>
              <span>🖼️</span>
              <span>🎙️</span>
            </div>
            <div class="send-row">
              <input type="text" placeholder="Type a message" />
              <button class="primary" type="button">Send</button>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  padding: 1.5rem;
  position: relative;
  z-index: 1;
}

.login {
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 1.5rem;
  padding: 1rem;
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.55);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.8);
}

.hero {
  display: grid;
  gap: 1.25rem;
}

.brand {
  display: flex;
  gap: 0.75rem;
  align-items: center;
}

.brand-mark {
  width: 48px;
  height: 48px;
  border-radius: 16px;
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: 1.1rem;
  color: var(--ice-900);
  background: linear-gradient(140deg, #d0e4ff, #79b1ff);
  box-shadow: 0 12px 24px rgba(35, 80, 150, 0.25);
}

.brand-title {
  font-size: 1.1rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.brand-subtitle {
  font-size: 0.9rem;
  color: var(--ice-600);
}

.hero-copy h1 {
  font-size: clamp(1.6rem, 5vw, 2.2rem);
  margin-bottom: 0.3rem;
}

.hero-copy p {
  color: var(--ice-600);
}

.card {
  background: rgba(240, 246, 255, 0.92);
  border: 1px solid rgba(110, 164, 242, 0.45);
  border-radius: 24px;
  padding: 1.6rem;
  box-shadow: 0 18px 40px rgba(30, 68, 120, 0.18);
  backdrop-filter: blur(16px);
}

.form {
  display: grid;
  gap: 1.2rem;
}

.field {
  display: grid;
  gap: 0.45rem;
  font-size: 0.95rem;
  color: var(--ice-800);
}

.field input {
  width: 100%;
  padding: 0.85rem 0.9rem;
  border-radius: 14px;
  border: 1px solid rgba(110, 145, 196, 0.3);
  background: #f4f8ff;
  font-size: 1rem;
  color: var(--ice-900);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.field input:focus {
  outline: none;
  border-color: #6ea4f2;
  box-shadow: 0 0 0 3px rgba(110, 164, 242, 0.2);
}

.password {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.5rem;
  align-items: center;
}

.ghost {
  border: 1px solid rgba(120, 158, 212, 0.35);
  background: transparent;
  color: var(--ice-900);
  padding: 0.55rem 0.9rem;
  border-radius: 12px;
  font-size: 0.85rem;
}

.primary {
  background: #2f6bd9;
  color: #eef5ff;
  border: none;
  padding: 0.9rem 1rem;
  border-radius: 14px;
  font-weight: 600;
  font-size: 1rem;
  box-shadow: 0 12px 28px rgba(38, 90, 170, 0.25);
  transition: transform 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease;
}

.primary:disabled {
  opacity: 0.6;
  box-shadow: none;
}

.primary:not(:disabled):active {
  transform: translateY(1px);
  box-shadow: 0 6px 16px rgba(38, 98, 85, 0.18);
}

.message {
  font-size: 0.9rem;
  margin: 0;
}

.error {
  color: #b5482b;
}

.success {
  color: #2f6bd9;
}

.meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #e9f1ff;
  padding: 0.7rem 0.9rem;
  border-radius: 12px;
  font-size: 0.85rem;
  color: var(--ice-600);
}

.meta code {
  font-family: 'Space Grotesk', sans-serif;
  color: var(--ice-900);
}

.home {
  display: grid;
  gap: 1.2rem;
}

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding: 1rem 1.2rem;
  background: rgba(255, 255, 255, 0.7);
  border-radius: 20px;
  box-shadow: 0 10px 20px rgba(30, 68, 120, 0.15);
  backdrop-filter: blur(16px);
}

.user {
  display: flex;
  align-items: center;
  gap: 0.8rem;
}

.user-name {
  font-weight: 600;
}

.user-id {
  font-size: 0.8rem;
  color: var(--ice-600);
}

.content {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 1rem;
}

.sidebar {
  display: grid;
  gap: 0.9rem;
  padding: 1rem 0.6rem;
  background: rgba(255, 255, 255, 0.7);
  border-radius: 20px;
  box-shadow: 0 10px 20px rgba(30, 68, 120, 0.12);
}

.icon-pill {
  width: 44px;
  height: 44px;
  border-radius: 16px;
  display: grid;
  place-items: center;
  background: #e9f1ff;
  color: #2f6bd9;
  font-size: 1.1rem;
}

.icon-pill.active {
  background: #2f6bd9;
  color: #eef5ff;
  box-shadow: 0 12px 24px rgba(47, 107, 217, 0.35);
}

.panel {
  background: rgba(255, 255, 255, 0.85);
  border-radius: 24px;
  padding: 1.2rem;
  box-shadow: 0 18px 36px rgba(28, 66, 118, 0.16);
  backdrop-filter: blur(14px);
}

.list {
  display: grid;
  gap: 1rem;
}

.search {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.6rem;
}

.search input {
  border-radius: 14px;
  border: 1px solid rgba(110, 145, 196, 0.3);
  padding: 0.75rem 0.9rem;
  background: #f4f8ff;
}

.primary.small {
  padding: 0.6rem 0.9rem;
  font-size: 0.9rem;
  border-radius: 12px;
}

.list-title {
  font-size: 0.9rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--ice-600);
  margin-bottom: 0.5rem;
}

.list-item {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  padding: 0.8rem;
  border-radius: 16px;
  background: #f6f9ff;
}

.list-item.active {
  border: 1px solid rgba(110, 164, 242, 0.5);
  background: #edf4ff;
}

.list-name {
  font-weight: 600;
}

.list-sub {
  font-size: 0.8rem;
  color: var(--ice-600);
}

.chat {
  display: grid;
  grid-template-rows: auto 1fr auto;
  min-height: 65vh;
}

.chat-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
}

.chat-title {
  font-weight: 700;
  font-size: 1.1rem;
}

.chat-sub {
  color: var(--ice-600);
  font-size: 0.85rem;
}

.chat-status {
  display: flex;
  gap: 0.5rem;
}

.badge {
  padding: 0.35rem 0.7rem;
  border-radius: 999px;
  background: #2f6bd9;
  color: #eef5ff;
  font-size: 0.75rem;
  letter-spacing: 0.06em;
}

.badge.ghost {
  background: #e7f0ff;
  color: #2f6bd9;
}

.chat-body {
  display: grid;
  gap: 0.8rem;
  padding: 1rem 0;
  overflow-y: auto;
}

.bubble {
  max-width: 70%;
  background: #f2f6ff;
  padding: 0.8rem 1rem;
  border-radius: 16px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.6);
  color: var(--ice-900);
}

.bubble span {
  display: block;
  font-size: 0.75rem;
  color: var(--ice-600);
  margin-top: 0.4rem;
}

.bubble.me {
  justify-self: end;
  background: #2f6bd9;
  color: #eef5ff;
}

.bubble.me span {
  color: rgba(238, 245, 255, 0.8);
}

.chat-input {
  display: grid;
  gap: 0.8rem;
  border-top: 1px solid rgba(110, 145, 196, 0.2);
  padding-top: 1rem;
}

.tools {
  display: flex;
  gap: 0.7rem;
  color: var(--ice-600);
}

.send-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.6rem;
}

.send-row input {
  border-radius: 14px;
  border: 1px solid rgba(110, 145, 196, 0.3);
  padding: 0.75rem 0.9rem;
  background: #f4f8ff;
}

@media (min-width: 900px) {
  .login {
    grid-template-columns: 1fr 1.1fr;
    grid-template-rows: none;
    align-items: center;
    padding: 3rem 6vw;
  }

  .hero {
    gap: 2rem;
  }

  .card {
    padding: 2rem;
  }

  .content {
    grid-template-columns: auto 320px 1fr;
  }
}

@media (max-width: 900px) {
  .content {
    grid-template-columns: 1fr;
  }

  .sidebar {
    grid-auto-flow: column;
    grid-template-columns: repeat(4, 1fr);
    justify-items: center;
  }

  .chat {
    min-height: 50vh;
  }
}
</style>

<script setup>
import { computed, ref } from 'vue'

const username = ref('')
const password = ref('')
const showPassword = ref(false)
const loading = ref(false)
const error = ref('')
const status = ref('')

const apiBase = import.meta.env.VITE_API_BASE || 'http://localhost:3001'

const canSubmit = computed(() => username.value.trim() && password.value)

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

    status.value = data?.message || 'Login success.'
  } catch (err) {
    error.value = 'Network error. Check the server and try again.'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="hero">
      <div class="brand">
        <div class="brand-mark">XC</div>
        <div class="brand-text">
          <p class="brand-title">XinChat</p>
          <p class="brand-subtitle">Secure, fast, and calm chat for mobile.</p>
        </div>
      </div>
      <div class="hero-copy">
        <h1>Welcome back</h1>
        <p>Sign in with your account to continue your conversations.</p>
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
</template>

<style scoped>
.page {
  min-height: 100vh;
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 1.5rem;
  padding: 1.5rem;
  position: relative;
  z-index: 1;
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
  color: var(--sand-900);
  background: linear-gradient(135deg, #f4d39b, #f1b675);
  box-shadow: 0 10px 24px rgba(136, 73, 20, 0.2);
}

.brand-title {
  font-size: 1.1rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.brand-subtitle {
  font-size: 0.9rem;
  color: var(--sand-700);
}

.hero-copy h1 {
  font-size: clamp(1.6rem, 5vw, 2.2rem);
  margin-bottom: 0.3rem;
}

.hero-copy p {
  color: var(--sand-700);
}

.card {
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid rgba(187, 150, 104, 0.25);
  border-radius: 24px;
  padding: 1.6rem;
  box-shadow: 0 18px 40px rgba(88, 52, 20, 0.12);
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
  color: var(--sand-800);
}

.field input {
  width: 100%;
  padding: 0.85rem 0.9rem;
  border-radius: 14px;
  border: 1px solid rgba(144, 106, 64, 0.2);
  background: #fffaf3;
  font-size: 1rem;
  color: var(--sand-900);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.field input:focus {
  outline: none;
  border-color: #d38c4f;
  box-shadow: 0 0 0 3px rgba(211, 140, 79, 0.2);
}

.password {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.5rem;
  align-items: center;
}

.ghost {
  border: 1px solid rgba(144, 106, 64, 0.25);
  background: transparent;
  color: var(--sand-900);
  padding: 0.55rem 0.9rem;
  border-radius: 12px;
  font-size: 0.85rem;
}

.primary {
  background: #2e7f6d;
  color: #fef6ea;
  border: none;
  padding: 0.9rem 1rem;
  border-radius: 14px;
  font-weight: 600;
  font-size: 1rem;
  box-shadow: 0 12px 28px rgba(38, 98, 85, 0.25);
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
  color: #2b6a5b;
}

.meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #f8efe4;
  padding: 0.7rem 0.9rem;
  border-radius: 12px;
  font-size: 0.85rem;
  color: var(--sand-700);
}

.meta code {
  font-family: 'Space Grotesk', sans-serif;
  color: var(--sand-900);
}

@media (min-width: 900px) {
  .page {
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
}
</style>

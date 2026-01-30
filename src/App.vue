<script setup>
import { computed, ref } from 'vue'
import Login from './components/Login.vue'
import Home from './components/Home.vue'

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
    <Login
      v-if="!isAuthed"
      v-model:username="username"
      v-model:password="password"
      :show-password="showPassword"
      :loading="loading"
      :error="error"
      :status="status"
      :can-submit="canSubmit"
      @submit="submit"
      @toggle-password="showPassword = !showPassword"
    />
    <Home v-else :profile="profile" @logout="logout" />
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  background: #f2f3f5;
}
</style>

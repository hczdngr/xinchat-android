<script setup>
import { computed, ref } from 'vue'
import Login from './components/Login.vue'
import Register from './components/Register.vue'
import Home from './components/Home.vue'

const username = ref('')
const password = ref('')
const showPassword = ref(false)
const loading = ref(false)
const error = ref('')
const status = ref('')
const view = ref('login')

const registerUsername = ref('')
const registerPassword = ref('')
const registerLoading = ref(false)
const registerError = ref('')
const registerStatus = ref('')

const apiBase = import.meta.env.VITE_API_BASE || 'http://localhost:3001'
const token = ref(localStorage.getItem('xinchat.token') || '')
const profile = ref(
  JSON.parse(localStorage.getItem('xinchat.profile') || 'null') || {}
)

const canSubmit = computed(() => username.value.trim() && password.value)
const canRegister = computed(
  () => registerUsername.value.trim() && registerPassword.value
)
const isAuthed = computed(() => Boolean(token.value))

const setAuthSession = (data) => {
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
}

const submit = async () => {
  error.value = ''
  status.value = ''

  if (!canSubmit.value) {
    error.value = '请输入昵称和密码。'
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
      error.value = data?.message || '登录失败，请重试。'
      return
    }

    setAuthSession(data)
    status.value = data?.message || '登录成功。'
  } catch (err) {
    error.value = '网络错误，请检查服务器后重试。'
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

const goRegister = () => {
  registerError.value = ''
  registerStatus.value = ''
  view.value = 'register'
}

const goLogin = () => {
  error.value = ''
  status.value = ''
  view.value = 'login'
}

const register = async () => {
  registerError.value = ''
  registerStatus.value = ''

  if (!canRegister.value) {
    registerError.value = '请输入昵称和密码。'
    return
  }

  registerLoading.value = true
  try {
    const response = await fetch(`${apiBase}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: registerUsername.value.trim(),
        password: registerPassword.value,
      }),
    })

    const data = await response.json().catch(() => ({}))
    if (!response.ok || !data?.success) {
      registerError.value = data?.message || '注册失败，请重试。'
      return
    }

    registerStatus.value = data?.message || '注册成功。'

    const loginResponse = await fetch(`${apiBase}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: registerUsername.value.trim(),
        password: registerPassword.value,
      }),
    })

    const loginData = await loginResponse.json().catch(() => ({}))
    if (!loginResponse.ok || !loginData?.success) {
      registerError.value = loginData?.message || '自动登录失败，请手动登录。'
      return
    }

    setAuthSession(loginData)
    view.value = 'login'
  } catch (err) {
    registerError.value = '网络错误，请检查服务器后重试。'
  } finally {
    registerLoading.value = false
  }
}
</script>

<template>
  <div class="page">
    <Login
      v-if="!isAuthed && view === 'login'"
      v-model:username="username"
      v-model:password="password"
      :show-password="showPassword"
      :loading="loading"
      :error="error"
      :status="status"
      :can-submit="canSubmit"
      @submit="submit"
      @toggle-password="showPassword = !showPassword"
      @go-register="goRegister"
    />
    <Register
      v-else-if="!isAuthed && view === 'register'"
      v-model:username="registerUsername"
      v-model:password="registerPassword"
      :loading="registerLoading"
      :error="registerError"
      :status="registerStatus"
      :can-submit="canRegister"
      @submit="register"
      @back="goLogin"
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

<script setup>
const props = defineProps({
  username: {
    type: String,
    default: '',
  },
  password: {
    type: String,
    default: '',
  },
  showPassword: {
    type: Boolean,
    default: false,
  },
  loading: {
    type: Boolean,
    default: false,
  },
  error: {
    type: String,
    default: '',
  },
  status: {
    type: String,
    default: '',
  },
  canSubmit: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits([
  'update:username',
  'update:password',
  'toggle-password',
  'submit',
  'go-register',
])
</script>

<template>
  <div class="login-qq">
    <!-- <header class="header">
      <svg
        class="back-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#000"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <polyline points="15 18 9 12 15 6"></polyline>
      </svg>
    </header> -->

    <div class="title-area">
      <h1>添加账号</h1>
    </div>

    <form class="form-container" @submit.prevent="emit('submit')">
      <div class="input-group">
        <input
          :value="props.username"
          type="text"
          name="username"
          autocomplete="username"
          placeholder="输入昵称"
          @input="emit('update:username', $event.target.value)"
        />
      </div>

      <div class="input-group">
        <input
          :value="props.password"
          :type="props.showPassword ? 'text' : 'password'"
          name="password"
          autocomplete="current-password"
          placeholder="输入信聊密码"
          @input="emit('update:password', $event.target.value)"
        />
      </div>

      <button class="login-btn" type="submit" :disabled="!props.canSubmit || props.loading">
        {{ props.loading ? '登录中...' : '登录' }}
      </button>

      <p v-if="props.error" class="message error">{{ props.error }}</p>
      <p v-else-if="props.status" class="message success">{{ props.status }}</p>

      <label class="agreement">
        <input class="agreement-input" type="checkbox" checked />
        <span class="checkbox-custom"></span>
        <span>
          已阅读并同意
          <a href="#">服务协议</a>
          和
          <a href="#">信聊隐私保护指引</a>
        </span>
      </label>
    </form>

    <nav class="bottom-nav">
      <button class="nav-item nav-button" type="button" @click="emit('go-register')">
        <div class="icon-circle">
          <svg
            class="icon-svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </div>
        <span>注册</span>
      </button>
    </nav>

    <footer class="footer">Copyright © 2025-2026 WebClass All Rights Reserved.</footer>
  </div>
</template>

<style scoped>
.login-qq {
  min-height: 100vh;
  height: 100vh;
  display: flex;
  flex-direction: column;
  padding-top: env(safe-area-inset-top);
  box-sizing: border-box;
  overflow: hidden;
}

.header {
  padding: 15px 20px;
  height: 50px;
  display: flex;
  align-items: center;
}

.back-icon {
  width: 24px;
  height: 24px;
  cursor: pointer;
}

.title-area {
  margin-top: 40px;
  margin-bottom: 40px;
  text-align: center;
}

.title-area h1 {
  font-size: 24px;
  font-weight: 500;
  color: #1a1a1a;
  letter-spacing: 1px;
}

.form-container {
  padding: 0 30px;
  display: flex;
  flex-direction: column;
  gap: 15px;
}

.input-group {
  background: #ffffff;
  border-radius: 12px;
  height: 55px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.02);
}

.input-group input {
  width: 100%;
  height: 100%;
  border: none;
  outline: none;
  background: transparent;
  text-align: center;
  font-size: 16px;
  color: #333;
}

.input-group input::placeholder {
  color: #c0c4cc;
}

.login-btn {
  margin-top: 30px;
  height: 50px;
  background-color: #4a9df8;
  color: white;
  border: none;
  border-radius: 10px;
  font-size: 17px;
  font-weight: 500;
  letter-spacing: 1px;
  cursor: pointer;
  width: 100%;
}

.login-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.login-btn:active {
  background-color: #3b8cd6;
}

.agreement {
  margin-top: 20px;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  font-size: 12px;
  color: #888;
  line-height: 1.5;
  gap: 6px;
}

.agreement-input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.checkbox-custom {
  width: 16px;
  height: 16px;
  border: 1px solid #ccc;
  border-radius: 50%;
  margin-top: 1px;
  position: relative;
  flex-shrink: 0;
}

.agreement-input:checked + .checkbox-custom {
  border-color: #4a9df8;
  background: #4a9df8;
}

.agreement-input:checked + .checkbox-custom::after {
  content: '';
  position: absolute;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #fff;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}

.agreement a {
  color: #5d6b85;
  text-decoration: none;
}

.bottom-nav {
  margin-top: auto;
  padding-bottom: 40px;
  display: flex;
  justify-content: center;
  padding-left: 20px;
  padding-right: 20px;
}

.nav-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: #666;
  font-size: 12px;
}

.nav-button {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
}

.icon-circle {
  width: 48px;
  height: 48px;
  background: #ffffff;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #e5e5e5;
  color: #333;
}

.icon-svg {
  width: 24px;
  height: 24px;
  fill: #333;
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

.footer {
  margin-bottom: 20px;
  text-align: center;
  font-size: 11px;
  color: #999;
  width: 100%;
  padding: 0 20px;
  line-height: 1.5;
}
</style>

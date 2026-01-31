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
  'submit',
  'back',
])
</script>

<template>
  <div class="page">
    <h1 class="title">欢迎注册信聊</h1>

    <form class="form-container" @submit.prevent="emit('submit')">
      <div class="input-group">
        <input
          :value="props.username"
          type="text"
          placeholder="输入昵称"
          @input="emit('update:username', $event.target.value)"
        />
      </div>

      <div class="input-group">
        <input
          :value="props.password"
          type="password"
          placeholder="输入信聊密码"
          @input="emit('update:password', $event.target.value)"
        />
      </div>

      <label class="agreement">
        <input class="agreement-input" type="checkbox" checked />
        <span class="checkbox-circle"></span>
        <span>
          已阅读并同意
          <a href="#">服务协议</a>
          和
          <a href="#">信聊隐私保护指引</a>
        </span>
      </label>

      <button class="register-btn" type="submit" :disabled="!props.canSubmit || props.loading">
        {{ props.loading ? '提交中...' : '立即注册' }}
      </button>

      <p v-if="props.error" class="message error">{{ props.error }}</p>
      <p v-else-if="props.status" class="message success">{{ props.status }}</p>

      <button class="back-link" type="button" @click="emit('back')">返回登录</button>
    </form>

    <footer class="footer">Copyright © 2025-2026 WebClass All Rights Reserved.</footer>
  </div>
</template>

<style scoped>
* {
  box-sizing: border-box;
}

.page {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background-color: #f0f2f5;
  padding-top: 80px;
}

.title {
  text-align: center;
  font-size: 32px;
  font-weight: 400;
  color: #000;
  margin-bottom: 40px;
  letter-spacing: 1px;
}

.form-container {
  padding: 0 35px;
  display: flex;
  flex-direction: column;
  gap: 15px;
}

.input-group {
  background: #ffffff;
  border-radius: 10px;
  height: 52px;
  display: flex;
  align-items: center;
  padding: 0 15px;
}

.input-group input {
  flex: 1;
  height: 100%;
  border: none;
  outline: none;
  background: transparent;
  font-size: 16px;
  color: #333;
}

.input-group input::placeholder {
  color: #ccc;
}

.agreement {
  margin-top: 15px;
  display: flex;
  align-items: center;
  font-size: 13px;
  color: #666;
  gap: 8px;
  cursor: pointer;
}

.agreement-input {
  width: 18px;
  height: 18px;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.checkbox-circle {
  width: 18px;
  height: 18px;
  border: 1px solid #c0c4cc;
  border-radius: 50%;
  flex-shrink: 0;
  position: relative;
  pointer-events: none;
}

.agreement-input:checked + .checkbox-circle {
  border-color: #0099ff;
  background: #0099ff;
}

.agreement-input:checked + .checkbox-circle::after {
  content: '';
  position: absolute;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #fff;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}

.agreement a {
  color: #4b6fa7;
  text-decoration: none;
  margin: 0 2px;
}

.register-btn {
  margin-top: 25px;
  height: 50px;
  background-color: #0099ff;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 17px;
  font-weight: 600;
  width: 100%;
  cursor: pointer;
}

.register-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.register-btn:active {
  opacity: 0.8;
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

.back-link {
  margin-top: 12px;
  background: none;
  border: none;
  color: #4b6fa7;
  font-size: 13px;
  cursor: pointer;
}

.footer {
  margin-top: auto;
  margin-bottom: 20px;
  text-align: center;
  font-size: 11px;
  color: #999;
  width: 100%;
  padding: 0 20px;
  line-height: 1.5;
}
</style>

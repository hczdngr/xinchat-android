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
])
</script>

<template>
  <div class="login-qq">
    <header class="header">
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
    </header>

    <div class="title-area">
      <h1>&#x6DFB;&#x52A0;&#x8D26;&#x53F7;</h1>
    </div>

    <form class="form-container" @submit.prevent="emit('submit')">
      <div class="input-group">
        <input
          :value="props.username"
          type="text"
          name="username"
          autocomplete="username"
          placeholder="&#x8F93;&#x5165;QQ&#x53F7;"
          @input="emit('update:username', $event.target.value)"
        />
      </div>

      <div class="input-group">
        <input
          :value="props.password"
          :type="props.showPassword ? 'text' : 'password'"
          name="password"
          autocomplete="current-password"
          placeholder="&#x8F93;&#x5165;QQ&#x5BC6;&#x7801;"
          @input="emit('update:password', $event.target.value)"
        />
      </div>

      <button class="login-btn" type="submit" :disabled="!props.canSubmit || props.loading">
        {{ props.loading ? 'µÇÂ¼ÖÐ...' : 'µÇÂ¼' }}
      </button>

      <p v-if="props.error" class="message error">{{ props.error }}</p>
      <p v-else-if="props.status" class="message success">{{ props.status }}</p>

      <label class="agreement">
        <input class="agreement-input" type="checkbox" checked />
        <span class="checkbox-custom"></span>
        <span>
          &#x5DF2;&#x9605;&#x8BFB;&#x5E76;&#x540C;&#x610F;
          <a href="#">&#x670D;&#x52A1;&#x534F;&#x8BAE;</a>
          &#x548C;
          <a href="#">QQ&#x9690;&#x79C1;&#x4FDD;&#x62A4;&#x6307;&#x5F15;</a>
        </span>
      </label>
    </form>

    <nav class="bottom-nav">
      <div class="nav-item">
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
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect>
            <line x1="12" y1="18" x2="12.01" y2="18"></line>
          </svg>
        </div>
        <span>&#x624B;&#x673A;&#x53F7;&#x767B;&#x5F55;</span>
      </div>

      <div class="nav-item">
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
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
            <circle cx="12" cy="7" r="4"></circle>
          </svg>
        </div>
        <span>&#x5176;&#x4ED6;&#x65B9;&#x5F0F;&#x767B;&#x5F55;</span>
      </div>

      <div class="nav-item">
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
        <span>&#x6CE8;&#x518C;</span>
      </div>

      <div class="nav-item">
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
            <circle cx="12" cy="12" r="1"></circle>
            <circle cx="19" cy="12" r="1"></circle>
            <circle cx="5" cy="12" r="1"></circle>
          </svg>
        </div>
        <span>&#x66F4;&#x591A;</span>
      </div>
    </nav>
  </div>
</template>

<style scoped>
.login-qq {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
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
  justify-content: space-around;
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
</style>

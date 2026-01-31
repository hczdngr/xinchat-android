import './assets/main.css'

import { createApp } from 'vue'
import App from './App.vue'
import { Clipboard } from '@capacitor/clipboard'

const app = createApp(App)
app.mount('#app')
document.body.classList.add('app-ready')

const isEditable = (target) =>
  target &&
  (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

const menuId = 'xinchat-input-menu'
let menuEl = null
let activeInput = null
let longPressTimer = null
let touchStart = null

const ensureMenu = () => {
  if (menuEl) return menuEl
  menuEl = document.createElement('div')
  menuEl.id = menuId
  menuEl.className = 'input-menu'
  menuEl.innerHTML = `
    <button type="button" data-action="copy">复制</button>
    <button type="button" data-action="paste">粘贴</button>
    <button type="button" data-action="selectall">全选</button>
    <button type="button" data-action="clear">清空</button>
    <button type="button" data-action="done">收起</button>
  `
  menuEl.addEventListener('click', async (event) => {
    const action = event.target?.dataset?.action
    if (!action || !activeInput) return
    if (action === 'copy') {
      try {
        const start = activeInput.selectionStart ?? 0
        const end = activeInput.selectionEnd ?? activeInput.value.length
        const text = activeInput.value.slice(start, end)
        if (text) {
          await Clipboard.write({ string: text })
        }
      } catch {}
    } else if (action === 'paste') {
      try {
        const { value } = await Clipboard.read()
        const text = value || ''
        const start = activeInput.selectionStart ?? activeInput.value.length
        const end = activeInput.selectionEnd ?? activeInput.value.length
        activeInput.setRangeText(text, start, end, 'end')
        activeInput.dispatchEvent(new Event('input', { bubbles: true }))
      } catch {}
    } else if (action === 'selectall') {
      try {
        activeInput.focus()
        activeInput.setSelectionRange(0, activeInput.value.length)
      } catch {}
    } else if (action === 'clear') {
      activeInput.value = ''
      activeInput.dispatchEvent(new Event('input', { bubbles: true }))
    } else if (action === 'done') {
      activeInput.blur()
    }
    hideMenu()
  })
  document.body.appendChild(menuEl)
  return menuEl
}

const showMenu = (input) => {
  const menu = ensureMenu()
  activeInput = input
  const rect = input.getBoundingClientRect()
  const menuWidth = 200
  const left = Math.max(12, Math.min(rect.left + rect.width / 2 - menuWidth / 2, window.innerWidth - menuWidth - 12))
  const top = Math.max(12, rect.top - 50)
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
  menu.style.display = 'flex'
}

const hideMenu = () => {
  if (!menuEl) return
  menuEl.style.display = 'none'
  activeInput = null
}

const clearLongPress = () => {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
  touchStart = null
}

document.addEventListener('contextmenu', (event) => {
  event.preventDefault()
})

document.addEventListener('selectstart', (event) => {
  if (isEditable(event.target)) {
    event.preventDefault()
  }
})

document.addEventListener('dragstart', (event) => {
  event.preventDefault()
})

document.addEventListener('pointerdown', (event) => {
  if (menuEl && menuEl.style.display === 'flex' && !menuEl.contains(event.target)) {
    hideMenu()
  }
  if (!isEditable(event.target)) {
    return
  }
  touchStart = { x: event.clientX, y: event.clientY }
  clearLongPress()
  longPressTimer = setTimeout(() => {
    showMenu(event.target)
  }, 450)
})

document.addEventListener('pointermove', (event) => {
  if (!touchStart) return
  const dx = Math.abs(event.clientX - touchStart.x)
  const dy = Math.abs(event.clientY - touchStart.y)
  if (dx > 8 || dy > 8) {
    clearLongPress()
  }
})

document.addEventListener('pointerup', clearLongPress)
document.addEventListener('pointercancel', clearLongPress)
document.addEventListener('scroll', hideMenu, true)

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import './i18n'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// PWA Service Worker 注册 + 自动更新
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // 周期性主动检查更新（默认浏览器只在导航时检查）
      const checkInterval = setInterval(() => {
        reg.update().catch(() => { /* offline ok */ })
      }, 60 * 60 * 1000) // 每小时

      // 监听新版本就绪
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing
        if (!installing) return
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            // 已经有 controller 说明是「更新」而非首装
            installing.postMessage({ type: 'SKIP_WAITING' })
          }
        })
      })

      let refreshing = false
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return
        refreshing = true
        window.location.reload()
      })

      window.addEventListener('beforeunload', () => clearInterval(checkInterval))
    }).catch(() => { /* SW failures are non-fatal */ })
  })
}

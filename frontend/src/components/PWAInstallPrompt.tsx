import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'

/**
 * PWA 安装提示
 *
 * - Android Chrome / Edge / Samsung Browser：监听 beforeinstallprompt，给一键安装按钮
 * - iOS Safari：beforeinstallprompt 不存在，给「分享 → 添加到主屏幕」的人工指引
 * - 已经在 standalone 运行 / 已 dismiss / 30 天内点过「不再提示」→ 隐藏
 *
 * 不打扰原则:
 *   - 首次访问 30 秒后才显示
 *   - 用户关闭后 7 天不再弹
 *   - 永不阻塞下载主流程
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const DISMISS_KEY = 'orange_pwa_install_dismissed_at'
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 天

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true
  if ((navigator as any).standalone) return true
  return false
}

function isIOSSafari(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !(window as any).MSStream
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)
  return isIOS && isSafari
}

function recentlyDismissed(): boolean {
  try {
    const ts = parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10)
    if (!ts) return false
    return Date.now() - ts < DISMISS_TTL_MS
  } catch {
    return false
  }
}

export default function PWAInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [showIosHint, setShowIosHint] = useState(false)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (isStandalone() || recentlyDismissed()) return

    const onBeforeInstall = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
      setTimeout(() => setVisible(true), 30_000)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall)

    const onInstalled = () => {
      setVisible(false)
      setDeferredPrompt(null)
      try { localStorage.removeItem(DISMISS_KEY) } catch { /* noop */ }
    }
    window.addEventListener('appinstalled', onInstalled)

    // iOS Safari：30 秒后给「添加到主屏幕」指引
    if (isIOSSafari()) {
      const t = setTimeout(() => {
        if (!isStandalone() && !recentlyDismissed()) {
          setShowIosHint(true)
          setVisible(true)
        }
      }, 30_000)
      return () => {
        clearTimeout(t)
        window.removeEventListener('beforeinstallprompt', onBeforeInstall)
        window.removeEventListener('appinstalled', onInstalled)
      }
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const dismiss = () => {
    setVisible(false)
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())) } catch { /* noop */ }
  }

  const install = async () => {
    if (!deferredPrompt) return
    try {
      await deferredPrompt.prompt()
      const choice = await deferredPrompt.userChoice
      if (choice.outcome === 'dismissed') dismiss()
      setDeferredPrompt(null)
      setVisible(false)
    } catch {
      dismiss()
    }
  }

  if (!visible) return null

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 max-w-md mx-auto">
      <div className="bg-dark-card border border-orange/40 rounded-2xl p-4 shadow-2xl shadow-black/50 backdrop-blur">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-gradient-to-br from-orange to-orange-light flex items-center justify-center">
            <Download className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-text-primary">
              {showIosHint ? '添加到主屏幕 / Add to Home Screen' : '安装橙子下载器 / Install Orange'}
            </div>
            <div className="text-sm text-text-tertiary mt-1">
              {showIosHint
                ? '点击底部 分享 按钮 → 「添加到主屏幕」即可。 Tap the Share button → "Add to Home Screen".'
                : '装到桌面，离线可用、启动更快、像 App 一样使用。 Install for offline access and a native-app feel.'}
            </div>
            {!showIosHint && deferredPrompt && (
              <button
                onClick={install}
                className="mt-3 px-4 py-2 rounded-lg bg-gradient-to-r from-orange to-orange-light text-white font-semibold text-sm hover:shadow-lg hover:shadow-orange/40 transition-all"
              >
                立即安装 / Install Now
              </button>
            )}
          </div>
          <button
            onClick={dismiss}
            aria-label="dismiss"
            className="flex-shrink-0 p-1 rounded-lg hover:bg-dark-border text-text-tertiary"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  )
}

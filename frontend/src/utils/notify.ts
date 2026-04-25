/**
 * Web 通知工具（替代 Capacitor LocalNotifications）
 *
 * - 用浏览器原生 Notification API
 * - PWA 已安装时也走这里（PWA Notification 体验等同原生）
 * - 用户拒绝授权 / 浏览器不支持 → 静默降级，不抛错
 */

let permissionAsked = false

export async function initNotifications(): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  if (permissionAsked) return Notification.permission === 'granted'
  permissionAsked = true
  try {
    const result = await Notification.requestPermission()
    return result === 'granted'
  } catch {
    return false
  }
}

function canNotify(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    Notification.permission === 'granted'
  )
}

function truncate(str: string, max = 60): string {
  if (!str) return 'Untitled'
  return str.length > max ? str.substring(0, max) + '…' : str
}

/**
 * 与 Capacitor 旧版 API 兼容的签名
 *   showDownloadComplete(taskId, title, hasError?)
 */
export async function showDownloadComplete(
  taskId: string,
  title: string,
  hasError = false,
): Promise<void> {
  if (!canNotify()) return
  try {
    const n = new Notification(hasError ? 'Download Failed' : 'Download Complete', {
      body: hasError ? `${truncate(title)} - Failed` : truncate(title),
      tag: taskId,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      silent: hasError,
    })
    // 5 秒后自动关闭，避免堆积
    setTimeout(() => { try { n.close() } catch { /* noop */ } }, 5000)
  } catch {
    /* notification creation can fail in private/locked-down contexts */
  }
}

export async function showDownloadProgress(
  _taskId: string,
  _title: string,
  _progress: number,
): Promise<void> {
  /* 浏览器 Notification API 不支持「持续进度通知」，
     页面内进度条已经够用，这里保留空实现以兼容旧调用点 */
}

export async function cancelNotification(_taskId: string): Promise<void> {
  /* 同上：浏览器 Notification 没有可靠的按 tag 取消接口（Service Worker 可以，
     但 orange 当前用页面级 Notification API），保留空实现 */
}

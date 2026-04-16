import { useState, useEffect, useCallback, useRef } from 'react'
import axios from 'axios'
import { useTranslation } from 'react-i18next'
import { Share } from '@capacitor/share'
import AuthModal from './components/AuthModal'
import SubscriptionPage from './components/SubscriptionPage'
import GallerySaver from './plugins/GallerySaver'
import { initNotifications, showDownloadComplete } from './plugins/Notifications'
import api from './api/auth'
import {
  Download, Link2, CheckCircle2, XCircle, Loader2,
  Video, FileText, Image as ImageIcon, Mic, Languages,
  Trash2, ChevronDown, ChevronUp, Clock, Copy, Check,
  X, Zap, AlertCircle, Eraser, FolderOpen, HardDrive, Smartphone,
  Play, Search, Clipboard, Crown, Sun, Moon, Keyboard,
} from 'lucide-react'

const API = 'https://orange-production-95b9.up.railway.app/api'
const BASE_URL = API.replace('/api', '')

// Share file using native share sheet (Android: shows save to Photos/Files option)
const isNativeApp = () => {
  try {
    return (window as any).Capacitor?.isNativePlatform?.() ?? false
  } catch { return false }
}

// 检测 iOS Safari
const isIOS = () => {
  try {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  } catch { return false }
}

const shareFile = async (url: string, title: string, fileType: 'video' | 'audio' | 'image' = 'video') => {
  const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`
  
  if (isNativeApp() && GallerySaver) {
    try {
      console.log('[GallerySaver] Calling native plugin, fileType: ' + fileType)
      // 使用原生插件直接保存到相册
      let result
      if (fileType === 'audio') {
        result = await GallerySaver.saveAudio({ url: fullUrl, filename: title || 'audio' })
      } else if (fileType === 'image') {
        result = await GallerySaver.saveImage({ url: fullUrl, filename: title || 'image' })
      } else {
        result = await GallerySaver.saveVideo({ url: fullUrl, filename: title || 'video' })
      }
      
      console.log('[GallerySaver] Result:', result)
      if (result.success) {
        return { success: true }
      } else {
        console.error('Gallery save failed:', result.error)
        // 降级到分享功能
        await Share.share({
          title: title || 'Orange Video',
          url: fullUrl,
        })
        return { success: true }
      }
    } catch (e: any) {
      console.error('[GallerySaver] Error:', e?.message || e)
      // 如果用户取消了分享，不算错误
      if (e?.message?.includes('cancel') || e?.message?.includes('canceled')) {
        return { success: true }
      }
      // 降级到分享功能
      try {
        await Share.share({
          title: title || 'Orange Video',
          url: fullUrl,
        })
        return { success: true }
      } catch (e2: any) {
        if (e2?.message?.includes('cancel')) return { success: true }
        return { success: false, error: String(e) }
      }
    }
  } else {
    // Web: iOS Safari special handling
    if (isIOS()) {
      // iOS Safari: 打开新窗口，让用户用分享菜单保存到照片
      const a = document.createElement('a')
      a.href = fullUrl
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      return { success: true }
    }
    
    // Other browsers: fetch as blob → force download
    try {
      const resp = await fetch(fullUrl)
      const blob = await resp.blob()
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = title || 'video.mp4'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(blobUrl)
      return { success: true }
    } catch (e) {
      window.open(fullUrl, '_blank')
      return { success: false, error: String(e) }
    }
  }
}

interface Task {
  taskId: string; status: string; progress: number
  title?: string; platform?: string; thumbnailUrl?: string
  downloadUrl?: string; audioUrl?: string; asrText?: string; copyText?: string
  coverUrl?: string; isNote?: boolean
  imageFiles?: Array<{ filename: string; url: string }>
  subtitleFiles?: Array<{ filename: string; url: string }>
  error?: string; createdAt: string | number
  directLink?: boolean; quality?: string; width?: number; height?: number
  downloadedBytes?: number; totalBytes?: number
  speed?: string; eta?: string
  qualityAdjusted?: string // 'downgrade' | 'upgrade' | null
}
interface HistoryItem {
  taskId: string; status: string; title?: string
  platform?: string; thumbnailUrl?: string; createdAt: string | number
}

const PLATFORMS = [
  { id: 'douyin', label: '抖音', icon: '📱' },
  { id: 'tiktok', label: 'TikTok', icon: '🎵' },
  { id: 'youtube', label: 'YouTube', icon: '▶️' },
  { id: 'x', label: 'X/Twitter', icon: '🐦' },
  // { id: 'bilibili', label: 'Bilibili', icon: '📺' },
  { id: 'instagram', label: 'Instagram', icon: '📸' },
  { id: 'xiaohongshu', label: '小紅書', icon: '📕' },
]

const OPTIONS: { id: string; label: string; icon: typeof Video }[] = [
  { id: 'video', label: 'Video 视频', icon: Video },
  { id: 'audio_only', label: 'Audio 音频', icon: Mic },
  { id: 'copywriting', label: 'Copywriting 文案', icon: FileText },
  { id: 'cover', label: 'Cover 封面', icon: ImageIcon },
  { id: 'asr', label: 'Audio 音轉文字', icon: Languages },
  { id: 'subtitle', label: 'Subtitle 字幕', icon: Languages },
]

const ASR_LANGUAGE_OPTIONS = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'auto', label: '自动检测' },
]

const QUALITY_OPTIONS = [
  { value: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', label: 'Best 最高画质', vipOnly: true },
  { value: 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]', label: '1080p', vipOnly: true },
  { value: 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]', label: '720p', vipOnly: false },
]

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function detectPlatform(url: string): string {
  if (/douyin\.com|iesdouyin\.com/i.test(url)) return 'douyin'
  if (/tiktok\.com/i.test(url)) return 'tiktok'
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube'
  if (/twitter\.com|x\.com/i.test(url)) return 'x'
  // if (/bilibili\.com|b23\.tv/i.test(url)) return 'bilibili'
  if (/instagram\.com/i.test(url)) return 'instagram'
  if (/xiaohongshu\.com|xhslink\.com/i.test(url)) return 'xiaohongshu'
  return ''
}

export default function App() {
  const [url, setUrl] = useState('')
  useEffect(() => { initNotifications().catch(console.error); }, []);
  const [detected, setDetected] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set(['video']))
  const [task, setTask] = useState<Task | null>(null)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [showDupConfirm, setShowDupConfirm] = useState(false)
  const [dupUrl, setDupUrl] = useState('')
  const [pendingDownload, setPendingDownload] = useState<(() => void) | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [batchMode, setBatchMode] = useState(false)
  const [quality, setQuality] = useState('')
  const [asrLanguage, setAsrLanguage] = useState('zh')
  const [availableQualities, setAvailableQualities] = useState<Array<{quality: string, format: string, width: number, height: number, hasVideo: boolean, hasAudio: boolean}>>([])
  const [showQualityPicker, setShowQualityPicker] = useState(false)
  const [pendingUrl, setPendingUrl] = useState('')
  const [batchUrls, setBatchUrls] = useState('')

  // Auth state
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [authToken, setAuthToken] = useState<string | null>(localStorage.getItem('orange_token'))
  const [authUser, setAuthUser] = useState<any>(JSON.parse(localStorage.getItem('orange_user') || 'null'))
  const [showSubscription, setShowSubscription] = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [showResetPwd, setShowResetPwd] = useState(false)
  const [resetEmail, setResetEmail] = useState('')
  const [resetPwdStep, setResetPwdStep] = useState(false) // false=发送邮件, true=设置新密码
  const [resetPwdToken, setResetPwdToken] = useState('')
  const [resetPwd, setResetPwd] = useState('')
  const [resetPwdMsg, setResetPwdMsg] = useState('')
  const [resetPwdLoading, setResetPwdLoading] = useState(false)
  const [isVip, setIsVip] = useState(false)
  const [remainingDownloads, setRemainingDownloads] = useState(-1) // -1 = unlimited/no display, 0 = 0次, n = 剩余n次
  const GUEST_DAILY_LIMIT = 3
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem('orange_theme')
    return saved ? saved === 'dark' : true
  })
  const { t, i18n } = useTranslation()
  const [showLangMenu, setShowLangMenu] = useState(false)
  const changeLanguage = (lng: string) => {
    i18n.changeLanguage(lng)
    localStorage.setItem('orange_language', lng)
    setShowLangMenu(false)
  }

  // 检查 URL 是否有重置密码 token
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const resetToken = params.get('token') || params.get('reset')
    if (resetToken) {
      setResetPwdToken(resetToken)
      setResetPwdStep(true)
      setShowResetPwd(true)
      // 清除 URL 参数
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  // 切换主题
  const toggleTheme = () => {
    setIsDark(!isDark)
    localStorage.setItem('orange_theme', !isDark ? 'dark' : 'light')
  }

  // 键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl/Cmd + V: 自动聚焦到输入框
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        if (document.activeElement?.tagName !== 'INPUT') {
          e.preventDefault()
          document.querySelector<HTMLInputElement>('input[type="url"]')?.focus()
        }
      }
      // Ctrl/Cmd + Enter: 触發下载
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        if (url.trim() && !loading) {
          doSingleDownload()
        }
      }
      // Escape: 关闭弹窗
      if (e.key === 'Escape') {
        setShowUserMenu(false)
        setShowDupConfirm(false)
        setShowResetPwd(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [url, loading])

  // Check VIP status and remaining downloads
  useEffect(() => {
    if (authToken) {
      api.getSubscriptionStatus(authToken).then(status => {
        const isPro = status?.subscriptionStatus === 'active'
        setIsVip(isPro)
        // VIP用户显示无限制（-1），非VIP显示剩余次数
        if (isPro) {
          setRemainingDownloads(-1) // VIP无限制
        } else {
          setRemainingDownloads(status?.usage?.remaining ?? GUEST_DAILY_LIMIT)
        }
      }).catch((err) => { 
        // API 失败时不要把会员当游客处理，隐藏次数提示即可
        console.error('[VIP] getSubscriptionStatus failed:', err);
        setIsVip(false);
        setRemainingDownloads(-1);
      })
    } else {
      setIsVip(false)
      // Check localStorage for guest remaining downloads
      const today = new Date().toISOString().split('T')[0]
      const guestData = localStorage.getItem('orange_guest_downloads')
      if (guestData) {
        const parsed = JSON.parse(guestData)
        if (parsed.date === today) {
          setRemainingDownloads(Math.max(0, GUEST_DAILY_LIMIT - parsed.count))
        } else {
          setRemainingDownloads(GUEST_DAILY_LIMIT)
        }
      } else {
        setRemainingDownloads(GUEST_DAILY_LIMIT)
      }
    }
  }, [authToken])
  const [historySearch, setHistorySearch] = useState('')
  const [historyFilter, setHistoryFilter] = useState<'all' | 'completed' | 'error'>('all')
  const [favorites, setFavorites] = useState<Set<string>>(new Set(JSON.parse(localStorage.getItem('orange_favorites') || '[]')))
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set())

  const filteredHistory = history.filter(item => {
    if (historyFilter === 'favorites' && !favorites.has(item.taskId)) return false
    if (historyFilter !== 'all' && historyFilter !== 'favorites' && item.status !== historyFilter) return false
    if (historySearch && !(item.title || '').toLowerCase().includes(historySearch.toLowerCase())) return false
    return true
  })

  const toggleFavorite = (taskId: string) => {
    const nf = new Set(favorites)
    nf.has(taskId) ? nf.delete(taskId) : nf.add(taskId)
    setFavorites(nf)
    localStorage.setItem('orange_favorites', JSON.stringify([...nf]))
  }

  const handleAuthSuccess = (token: string, user: any) => {
    setAuthToken(token)
    setAuthUser(user)
    localStorage.setItem('orange_token', token)
    localStorage.setItem('orange_user', JSON.stringify(user))
  }

  // 忘记密码 - 发送重置邮件
  const handleForgotPassword = async () => {
    if (!resetEmail) return
    setResetPwdLoading(true)
    setResetPwdMsg('')
    try {
      const result = await api.forgotPassword(resetEmail)
      if (result.resetToken) {
        // 演示模式：直接显示token让用户重置
        setResetPwdToken(result.resetToken)
        setResetPwdStep(true)
        setResetPwdMsg('演示模式：使用以下令牌重置密码')
      } else {
        setResetPwdMsg('重置链接已发送到邮箱')
      }
    } catch (err: any) {
      setResetPwdMsg(err.message || '发送失败')
    } finally {
      setResetPwdLoading(false)
    }
  }

  // 重置密码
  const handleResetPassword = async () => {
    if (!resetPwd || !resetPwdToken) return
    setResetPwdLoading(true)
    setResetPwdMsg('')
    try {
      await api.resetPassword(resetPwdToken, resetPwd)
      setResetPwdMsg('密码已重置！请使用新密码登录')
      setTimeout(() => {
        setShowResetPwd(false)
        setResetPwdStep(false)
        setResetEmail('')
        setResetPwd('')
        setResetPwdToken('')
        setResetPwdMsg('')
      }, 1500)
    } catch (err: any) {
      setResetPwdMsg(err.message || '重置失败')
    } finally {
      setResetPwdLoading(false)
    }
  }

  const handleLogout = () => {
    localStorage.removeItem('orange_token')
    localStorage.removeItem('orange_user')
    setAuthToken(null)
    setAuthUser(null)
  }

  // 从文本中提取所有链接
  const extractUrls = (text: string): string[] => {
    // 更宽松的 URL 正则
    const urlRegex = /https?:\/\/[^\s\n,，、；;）)】"']+/g
    
    let matches = text.match(urlRegex) || []
    
    // 清理和补全
    const urls = matches.map(u => {
      // 移除末尾的标点符号
      let cleaned = u.trim().replace(/[，。、,.\s;；）)】"']+$/g, '')
      // 补全短链
      if (!cleaned.startsWith('http')) {
        cleaned = `https://${cleaned}`
      }
      return cleaned
    })
    
    // 去重
    return [...new Set(urls)]
  }

  // 处理粘贴事件 - 自动提取链接
  const [batchQueue, setBatchQueue] = useState<Array<{url: string, status: string, progress: number, title?: string}>>([])
  const [batchIndex, setBatchIndex] = useState(0)
  const [saveLocation, setSaveLocation] = useState<string>('album')

  // 读取保存的位置偏好
  useEffect(() => {
    const saved = localStorage.getItem('xiaodianlv_saveLocation')
    if (saved) setSaveLocation(saved)
  }, [])

  // Save Location 保存位置偏好
  const handleLocationChange = (loc: string) => {
    setSaveLocation(loc)
    localStorage.setItem('xiaodianlv_saveLocation', loc)
  }

  const locationLabels: Record<string, { label: string; icon: typeof Smartphone; desc: string }> = {
    album: { label: '手机相册', icon: Smartphone, desc: '默认保存到相册' },
    downloads: { label: 'Download Folder 下載文件夾', icon: HardDrive, desc: '浏览器默认下载位置' },
    desktop: { label: 'Desktop 桌面', icon: HardDrive, desc: '保存到桌面' },
    documents: { label: 'Documents', icon: FolderOpen, desc: '保存到Documents文件夹' },
  }

  // 批量下载：自动处理下一个（完成或失败都继续）
  useEffect(() => {
    if ((task?.status === 'completed' || task?.status === 'error') && batchMode && batchQueue.length > 0) {
      // 更新当前任务状态
      setBatchQueue(prev => prev.map((item, idx) => 
        idx === batchIndex ? { ...item, status: task.status } : item
      ))
      
      // 完成后从链接框删除已处理的链接
      if (task?.status === 'completed') {
        setBatchUrls(prev => {
          const lines = prev.split('\n').filter(u => u.trim())
          lines.shift()
          return lines.join('\n')
        })
      }
      
      const currentIdx = batchIndex
      const nextIdx = currentIdx + 1
      if (nextIdx < batchQueue.length) {
        const nextUrl = batchQueue[nextIdx].url
        
        setTimeout(() => {
          setBatchIndex(nextIdx)
          setLoading(true)
          setUrl(nextUrl)
          autoDownloaded.current = false  // 重置自动下载标记
          showDownloadComplete(`start-${Date.now()}`, nextUrl, false).catch(console.error)
          axios.post(`${API}/download`, {
            url: nextUrl, platform: detectPlatform(nextUrl) || 'auto',
            needAsr: selected.has('asr'), options: [...selected], quality, asrLanguage,
          }, { timeout: 180000, headers: authToken ? { Authorization: `Bearer ${authToken}` } : {} }).then(r => {
            setTask(r.data.data)
          }).catch((e) => {
            console.error('[batch] 下载失败:', e.message)
            showDownloadComplete(`error-${Date.now()}`, 'Download Failed', true).catch(console.error)
            setTask({ 
              taskId: `error-${Date.now()}`, 
              status: 'error', 
              progress: 0, 
              error: e.response?.data?.message || e.message || 'Download failed',
              createdAt: Date.now()
            })
          }).finally(() => setLoading(false))
        }, 3000)
      } else {
        // 所有任务完成 - 保留队列显示结果
        setLoading(false)
      }
    }
  }, [task?.status, batchMode])

  // Poll task status
  useEffect(() => {
    if (!task || ['completed', 'error'].includes(task.status)) return
    const t = setInterval(async () => {
      try {
        const r = await axios.get(`${API}/status/${task.taskId}`)
        if (r.data.data) {
          setTask(r.data.data)
          if (['completed', 'error'].includes(r.data.data.status)) { 
            clearInterval(t)
            fetchHistory()
          }
        }
      } catch {}
    }, 1500)
    return () => clearInterval(t)
  }, [task?.taskId])

  // 播放提示音
  const playNotificationSound = () => {
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
      const oscillator = audioContext.createOscillator()
      const gainNode = audioContext.createGain()
      oscillator.connect(gainNode)
      gainNode.connect(audioContext.destination)
      oscillator.frequency.value = 800
      oscillator.type = 'sine'
      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime)
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3)
      oscillator.start(audioContext.currentTime)
      oscillator.stop(audioContext.currentTime + 0.3)
    } catch {}
  }

  // 自动下载：当下载完成时自动触发保存 + 播放提示音
  // 使用 ref 追踪是否已自动下载过，避免重复触发
  const autoDownloaded = useRef(false)
  const autoDownloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  
  // 清理自动下载定时器
  const clearAutoDownload = () => {
    if (autoDownloadTimer.current) {
      clearTimeout(autoDownloadTimer.current)
      autoDownloadTimer.current = null
    }
  }
  
  useEffect(() => {
    // 每次 task 变化时，重置自动下载标记
    autoDownloaded.current = false
    clearAutoDownload()
    
    if (task?.status === 'completed' && task.downloadUrl && !downloading && !autoDownloaded.current) {
      autoDownloaded.current = true
      // 播放提示音
      playNotificationSound()
      // 显示完成通知
      showDownloadComplete(task.taskId, task.title || 'Download', false).catch(console.error)
      // 更新游客本地下载计数
      if (!authToken) {
        const today = new Date().toISOString().split('T')[0]
        const guestData = localStorage.getItem('orange_guest_downloads')
        const parsed = guestData ? JSON.parse(guestData) : { date: '', count: 0 }
        const newCount = parsed.date === today ? parsed.count + 1 : 1
        localStorage.setItem('orange_guest_downloads', JSON.stringify({ date: today, count: newCount }))
        setRemainingDownloads(Math.max(0, GUEST_DAILY_LIMIT - newCount))
      }
      // 延迟 500ms 后自动下载
      autoDownloadTimer.current = setTimeout(() => {
        setDownloading(true)
        shareFile(task.downloadUrl, task.title || 'video').finally(() => {
          setDownloading(false)
          // 下载完成后重新获取使用量
          if (authToken) {
            api.getUsage(authToken).then(u => {
              if (u) {
                setRemainingDownloads(u.isPro ? -1 : u.remaining)
              }
            }).catch(() => {})
          }
        })
      }, 500)
    }
    return clearAutoDownload
  }, [task?.status, task?.downloadUrl, task?.taskId, authToken])

  const fetchHistory = useCallback(async () => {
    try { 
      const r = await axios.get(`${API}/history`); 
      const data = r.data.data || {};
      setHistory(Array.isArray(data.tasks) ? data.tasks : (Array.isArray(data) ? data : [])) 
    } catch {}
  }, [])
  useEffect(() => { fetchHistory() }, [fetchHistory])

  const handleUrlChange = (value: string) => {
    // 检测是否有嵌入文字的链接
    const urls = extractUrls(value)
    const finalUrl = urls.length === 1 ? urls[0] : value.trim()
    const platform = detectPlatform(finalUrl)
    
    setUrl(finalUrl)
    setDetected(platform)
  }

  // 点击粘贴按钮 - 从剪贴板粘贴
  const handlePasteClick = async () => {
    try {
      const text = await navigator.clipboard.readText()
      const urls = text.match(/https?:\/\/[^\s\n,，、；;）)】"']+/g) || []
      if (urls.length > 1) {
        setBatchMode(true)
        setBatchUrls(urls.map((url, idx) => `${idx + 1}. ${url}`).join('\n'))
      } else if (urls.length === 1) {
        setUrl(urls[0])
        setDetected(detectPlatform(urls[0]))
      } else if (text) {
        setUrl(text)
        setDetected(detectPlatform(text))
      }
    } catch (e) {
      console.error('[paste] failed:', e)
    }
  }

  // 单个输入框粘贴处理 - 自动提取链接
  const handleSinglePaste = (e: React.ClipboardEvent) => {
    const pastedText = e.clipboardData.getData('text')
    const urls = pastedText.match(/https?:\/\/[^\s\n,，、；;）)】"']+/g) || []
    if (urls.length > 1) {
      // 多个链接 → 切换批量模式
      e.preventDefault()
      setBatchMode(true)
      setBatchUrls(urls.map((url, idx) => `${idx + 1}. ${url}`).join('\n'))
    } else if (urls.length === 1) {
      // 单个链接 → 提取链接，去除文字
      e.preventDefault()
      setUrl(urls[0])
      setDetected(detectPlatform(urls[0]))
    }
    // 没有链接则使用默认粘贴行为
  }

  // 批量输入变化处理 - 自动提取链接
  const handleBatchChange = (value: string) => {
    // 先在每个 https:// 前插入换行（除了第一个）
    let processed = value.replace(/(?<!^)https:\/\//g, '\nhttps://')
    
    // 提取所有链接
    const urlRegex = /https?:\/\/[^\s\n,，、；;）)】"']+/g
    const urls = processed.match(urlRegex) || []
    
    if (urls.length > 0) {
      // 去重、排序、换行
      const unique = [...new Set(urls)]
      setBatchUrls(unique.map((url, i) => `${i + 1}. ${url}`).join('\n'))
    } else {
      setBatchUrls(value)
    }
  }

  const fetchVideoQualities = async (videoUrl: string) => {
    try {
      const r = await axios.post(`${API}/video-info`, { url: videoUrl }, { timeout: 30000 })
      if (r.data.code === 0 && r.data.data.qualities && r.data.data.qualities.length > 0) {
        setAvailableQualities(r.data.data.qualities)
        setPendingUrl(videoUrl)
        setShowQualityPicker(true)
        return true
      }
    } catch (e) {
      console.log('[quality] Failed to fetch qualities, using default')
    }
    // 获取失败时：抖音默认给720p选项，YouTube给720p
    const defaultQualities = [
      { quality: '720p', width: 1280, height: 720, hasVideo: true, hasAudio: true },
    ]
    setAvailableQualities(defaultQualities)
    setPendingUrl(videoUrl)
    setShowQualityPicker(true)
    return true
  }

  const handleSubmit = async () => {
    autoDownloaded.current = false
    
    // 检查游客下载次数限制
    if (!isVip && remainingDownloads === 0) {
      setShowSubscription(true)
      return
    }
    
    // 批量模式
    if (batchMode) {
      const urls = batchUrls.split('\n')
        .map(u => u.trim())
        .filter(u => u)
        .map(u => u.replace(/^\d+\.\s*/, ''))
        .map(u => extractUrls(u)[0] || u)
        .filter(u => u)
      if (urls.length === 0) { setError('Please enter a video link'); return }
      
      // 检查第一个链接是否已下载
      const firstUrl = urls[0]
      const dupItem = history.find(h => h.url === firstUrl || h.title && firstUrl.includes(h.taskId))
      if (dupItem && dupItem.status === 'completed') {
        setDupUrl(firstUrl)
        setPendingDownload(() => () => doBatchDownload(urls))
        setShowDupConfirm(true)
        return
      }
      doBatchDownload(urls)
      return
    }
    
    // 单G模式
    if (!url.trim()) { setError('Please enter a video link'); return }
    
    // 检查是否已下载
    const dupItem = history.find(h => h.url === url.trim() || h.title && url.trim().includes(h.taskId))
    if (dupItem && dupItem.status === 'completed') {
      setDupUrl(url.trim())
      setPendingDownload(() => () => doSingleDownload())
      setShowDupConfirm(true)
      return
    }
    doSingleDownload()
  }

  const doBatchDownload = async (urls: string[]) => {
    // 检查游客下载次数限制
    if (!isVip && remainingDownloads === 0) {
      setShowSubscription(true)
      return
    }
    setBatchQueue(urls.map(u => ({ url: u, status: 'pending', progress: 0 })))
    setBatchIndex(0)
    setLoading(true); setError('')
    autoDownloaded.current = false  // 重置自动下载标记
    try {
      const detectedFirst = detectPlatform(urls[0])
      const r = await axios.post(`${API}/download`, {
        url: urls[0], platform: detectedFirst || 'auto',
        needAsr: selected.has('asr'), options: [...selected], quality, asrLanguage,
      }, { timeout: 120000, headers: authToken ? { Authorization: `Bearer ${authToken}` } : {} })
      setTask(r.data.data)
    } catch (e: any) {
      setError(getErrorMessage(e.code === 'ECONNABORTED' ? 'timeout' : (e.response?.data?.message || e.message || 'Download failed')))
      setLoading(false)
    }
  }

  const doSingleDownload = async (skipQualityPicker = false) => {
    // 检查游客下载次数限制
    if (!isVip && remainingDownloads === 0) {
      setShowSubscription(true)
      setLoading(false)
      return
    }
    // First get video info to show quality selection
    setLoading(true); setError('')
    
    // 批量模式：跳过画质选择，直接下载
    if (!skipQualityPicker) {
      try {
        const infoRes = await axios.post(`${API}/video-info`, { url: url.trim() }, { timeout: 30000 })
        const qualities = (infoRes.data.data?.qualities || []).filter((q: any) => q.height >= 720);
        
        if (qualities.length > 1) {
          // Multiple qualities - show picker
          setAvailableQualities(qualities)
          setPendingUrl(url.trim())
          setShowQualityPicker(true)
          setLoading(false)
          return
        } else if (qualities.length === 1) {
          // Single quality - VIP直接使用，非VIP限制720p
          setQuality(isVip ? 'height<=99999' : (qualities[0].height >= 720 ? 'height<=720' : ''))
        }
      } catch (e) {
        console.log('[quality] Failed to fetch qualities, proceeding with default')
      }
    }
    
    // Proceed with download
    try {
      // VIP用户使用用户选择的画质，非VIP用户限制画质
      const downloadQuality = isVip ? quality : (quality || 'height<=720')
      const r = await axios.post(`${API}/download`, {
        url: url.trim(), platform: detected || 'auto',
        needAsr: selected.has('asr'), options: [...selected], quality: downloadQuality, asrLanguage,
      }, { timeout: 120000, headers: authToken ? { Authorization: `Bearer ${authToken}` } : {} })
      setTask(r.data.data); setDetected('')
    } catch (e: any) {
      setError(getErrorMessage(e.code === 'ECONNABORTED' ? 'timeout' : (e.response?.data?.message || e.message || 'Download failed')))
    } finally { setLoading(false) }
  }

  const toggle = (o: string) => setSelected(prev => {
    const n = new Set(prev)
    n.has(o) && n.size > 1 ? n.delete(o) : n.add(o)
    return n
  })
  const del = async (id: string) => {
    try { await axios.delete(`${API}/tasks/${id}`); fetchHistory(); if (task?.taskId === id) setTask(null) } catch {}
  }
  const deleteSelected = async () => {
    if (selectedTasks.size === 0) return
    if (!confirm(`Delete ${selectedTasks.size} item(s)?`)) return
    try {
      await Promise.all([...selectedTasks].map(id => axios.delete(`${API}/tasks/${id}`)))
      setSelectedTasks(new Set())
      fetchHistory()
    } catch {}
  }
  const toggleSelectAll = () => {
    selectedTasks.size === filteredHistory.length
      ? setSelectedTasks(new Set())
      : setSelectedTasks(new Set(filteredHistory.map(item => item.taskId)))
  }
  const retryTask = async (item: HistoryItem) => {
    if (!item.url) return
    setLoading(true); setError('')
    try {
      let r;
      // 尝试使用断点续传 API
      if (item.taskId) {
        try {
          r = await axios.post(`${API}/download/${item.taskId}/retry`, {}, { timeout: 120000, headers: authToken ? { Authorization: `Bearer ${authToken}` } : {} });
          if (r?.data?.code === 0) {
            // 续传成功，获取新任务状态
            const newTaskId = r.data.data.taskId;
            // 轮询新任务状态
            const pollTask = async () => {
              const status = await axios.get(`${API}/status/${newTaskId}`);
              if (status.data.data?.status === 'completed') {
                setTask(status.data.data);
                fetchHistory();
                return;
              }
              if (status.data.data?.status === 'error') {
                setError(status.data.data.error || 'Download failed');
                return;
              }
              if (status.data.data?.status === 'downloading') {
                setTask(status.data.data);
              }
              setTimeout(pollTask, 2000);
            };
            pollTask();
            setLoading(false);
            return;
          }
        } catch (e) {
          // 续传 API 不可用，使用普通下载
          console.log('[retry] Retry API not available, using regular download');
        }
      }
      // 普通下载
      r = await axios.post(`${API}/download`, { url: item.url, platform: item.platform || 'auto', needAsr: false, options: ['video'] }, { timeout: 120000 })
      setTask(r.data.data)
    } catch (e: any) { setError(getErrorMessage(e.response?.data?.message || e.message)) }
    finally { setLoading(false) }
  }
  const clearAllHistory = async () => {
    try { await axios.delete(`${API}/history`); fetchHistory(); setTask(null) } catch {}
  }
  const openSavedFile = (item: HistoryItem) => {
    // 在新窗口打开视频文件
    const videoUrl = `${BASE_URL}/download/${item.taskId}.mp4`
    window.open(videoUrl, '_blank')
  }
  const clip = async (text: string, id: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(id); setTimeout(() => setCopied(null), 3000) } catch {}
  }
  const clearUrl = () => { setUrl(''); setDetected('') }

  const isWorking = (s: string) => ['pending', 'parsing', 'processing', 'downloading', 'asr'].includes(s)
  const statusLabel = (s: string) => ({ pending: t('pending') || 'Queuing', parsing: t('parsing') || 'Parsing', downloading: t('downloading') || 'Downloading', asr: t('asr') || 'Speech recognition', completed: t('completed') || 'Completed', error: t('error') || 'Failed' }[s] || s)
  
  const getErrorMessage = (err: string) => {
    if (err.includes('TikHub API error')) return '❌ API service error, please try again later'
    if (err.includes('Sign in to confirm')) return '❌ YouTube requires verification, try another video'
    if (err.includes('No download URL')) return '❌ Video not available for download'
    if (err.includes('timeout')) return '⏱️ Download timeout, please try again'
    if (err.includes('network')) return '🌐 Network error, check your connection'
    if (err.includes('403') || err.includes('Forbidden')) return '🚫 Access denied, video may be private'
    if (err.includes('404') || err.includes('Not Found')) return '🔍 Video not found, check the link'
    return `❌ ${err || 'Download failed, please try again'}`
  }
  const platformLabel = (id: string) => PLATFORMS.find(p => p.id === id)?.label || ''

  if (showSubscription && authToken) {
    return <SubscriptionPage token={authToken} onBack={() => setShowSubscription(false)} onLogout={handleLogout} />
  }

  return (
    <div className={`min-h-screen ${isDark ? 'bg-dark-bg text-white' : 'bg-light-bg text-gray-900'}`}>
      {/* 背景光晕 - 橙色主题 */}
      <div className={`fixed inset-0 pointer-events-none ${isDark ? '' : 'opacity-30'}`}>
        <div className={`absolute top-0 right-0 w-96 h-96 rounded-full blur-3xl ${isDark ? 'bg-orange-500/8' : 'bg-orange-200'}`} />
        <div className={`absolute bottom-0 left-0 w-72 h-72 rounded-full blur-3xl ${isDark ? 'bg-amber-500/8' : 'bg-amber-200'}`} />
      </div>

      <div className="relative">
        {/* Header */}
        <header className="max-w-2xl mx-auto px-6 pt-16 pb-8 text-center">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-orange to-orange-light flex items-center justify-center shadow-lg shadow-orange-500/25 flex-shrink-0 overflow-hidden">
              <span className="text-3xl leading-none">🍊</span>
            </div>
            <div className="text-left">
              <h1 className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{t('appName')}</h1>
              <p className={`text-xs ${isDark ? 'text-slate-300' : 'text-gray-500'}`}>{t('appDesc')}</p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {/* 主题切换 */}
              <button
                onClick={toggleTheme}
                className={`p-2 rounded-lg transition ${isDark ? 'text-slate-300 hover:text-yellow-400' : 'text-gray-500 hover:text-orange-500'}`}
                title={isDark ? '切换到浅色模式' : '切换到深色模式'}
              >
                {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>
              {/* 语言切换 */}
              <div className="relative">
                <button
                  onClick={() => setShowLangMenu(!showLangMenu)}
                  className={`p-2 rounded-lg transition ${isDark ? 'text-slate-300 hover:text-orange-400' : 'text-gray-500 hover:text-orange-500'}`}
                  title={t('language')}
                >
                  <Languages className="w-4 h-4" />
                </button>
                {showLangMenu && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowLangMenu(false)} />
                    <div className="absolute right-0 top-10 bg-slate-800 rounded-xl py-2 w-40 border border-slate-700 shadow-xl z-50">
                      {[{ code: 'en', label: 'English' }, { code: 'ko', label: '한국어' }, { code: 'ja', label: '日本語' }, { code: 'hi', label: 'हिन्दी' }, { code: 'zh-TW', label: '繁體中文' }, { code: 'zh-CN', label: '简体中文' }].map(lang => (
                        <button
                          key={lang.code}
                          onClick={() => changeLanguage(lang.code)}
                          className={`w-full px-3 py-2 text-left text-sm hover:bg-slate-700/50 transition flex items-center gap-2 ${i18n.language === lang.code ? 'text-orange-400' : 'text-slate-300'}`}
                        >
                          {lang.label}
                          {i18n.language === lang.code && <Check className="w-3 h-3 ml-auto" />}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {/* 快捷键提示 */}
              <span className={`text-xs hidden sm:inline ${isDark ? 'text-slate-500' : 'text-gray-400'}`} title="Ctrl+V 粘贴, Ctrl+Enter 下载">⌨️</span>
              {authToken ? (
                <>
                  {/* 头像按钮 */}
                  <button 
                    onClick={() => setShowUserMenu(!showUserMenu)}
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold cursor-pointer ${authUser?.tier === 'pro' ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/50' : isDark ? 'bg-slate-700/50 text-slate-300 border border-slate-600/50' : 'bg-gray-200 text-gray-700 border-gray-300'}`}
                  >
                    {(authUser?.email || 'U').charAt(0).toUpperCase()}
                  </button>
                  {/* 用户菜单 */}
                  {showUserMenu && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setShowUserMenu(false)} />
                      <div className="absolute right-0 top-10 bg-slate-800 rounded-xl py-2 w-56 border border-slate-700 shadow-xl z-50">
                        <div className="px-3 py-2 border-b border-slate-700/50">
                          <p className="text-xs text-slate-300">账号</p>
                          <p className="text-sm text-white truncate">{authUser?.email || '未知的邮箱'}</p>
                          <p className="text-xs text-orange-400 mt-0.5">{authUser?.tier === 'pro' ? '⭐ Pro 会员' : 'Free 用户'}</p>
                        </div>
                        <div className="py-1">
                          <button onClick={() => { setShowUserMenu(false); setShowSubscription(true) }} className="w-full px-3 py-2 text-left text-sm text-slate-300 hover:bg-slate-700/50 transition flex items-center gap-2">
                            <span>📊</span> 订阅管理
                          </button>
                          <button onClick={() => { setShowUserMenu(false); setShowResetPwd(true) }} className="w-full px-3 py-2 text-left text-sm text-slate-300 hover:bg-slate-700/50 transition flex items-center gap-2">
                            <span>🔑</span> 修改密码
                          </button>
                        </div>
                        <div className="pt-1 border-t border-slate-700/50">
                          <button onClick={() => { setShowUserMenu(false); handleLogout() }} className="w-full px-3 py-2 text-left text-sm text-red-400 hover:bg-slate-700/50 transition flex items-center gap-2">
                            <span>🚪</span> 退出登录
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </>
              ) : (
                <button onClick={() => setShowAuthModal(true)} className="px-4 py-2 text-sm bg-gradient-to-r from-orange to-orange-light text-white border-0 rounded-lg font-medium shadow-md hover:shadow-lg transition-all">
                  登录/注册
                </button>
              )}
            </div>
          </div>
          <p className="text-slate-300 text-sm">
            <p className={`text-xs ${isDark ? 'text-slate-300' : 'text-gray-500'}`}>{t('tagline')}</p>
          </p>
        </header>

        {/* Main Card */}
        <main className="max-w-2xl mx-auto px-6 pb-10">
          <div className={`rounded-2xl p-5 shadow-lg ${isDark ? 'bg-dark-surface' : 'bg-white'}`}>

            {/* 单G/批量 Tab */}
            <div className="flex gap-2 mb-5">
              <button
                onClick={() => setBatchMode(false)}
                className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${!batchMode ? 'bg-orange-500/15 text-orange-300 border border-orange-500/30' : isDark ? 'bg-slate-700/30 text-slate-300 border border-transparent' : 'bg-gray-100 text-gray-500 border border-transparent'}`}
              >
                {t('singleDownload')}
              </button>
              <button
                onClick={() => setBatchMode(true)}
                className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${batchMode ? 'bg-orange-500/15 text-orange-300 border border-orange-500/30' : isDark ? 'bg-slate-700/30 text-slate-300 border border-transparent' : 'bg-gray-100 text-gray-500 border border-transparent'}`}
              >
                {t('batchDownload')}
              </button>
            </div>

            {/* Single Download模式 */}
            {!batchMode && (
              <div className="mb-5">
                <div className="relative">
                  {/* 粘贴按钮 */}
                  <button
                    onClick={handlePasteClick}
                    className="absolute left-3 top-1/2 -translate-y-1/2 p-2 text-slate-300 hover:text-orange-400 transition-colors"
                    title="Paste from clipboard"
                  >
                    <Clipboard className="w-5 h-5" />
                  </button>
                  <div className="absolute left-12 top-1/2 -translate-y-1/2 text-slate-300">
                    <Link2 className="w-5 h-5" />
                  </div>
                  <input
                    type="url"
                    value={url}
                    onChange={(e) => handleUrlChange(e.target.value)}
                    onPaste={handleSinglePaste}
                    placeholder="Paste video link..."
                    className={`w-full pl-24 pr-10 py-4 border-2 rounded-2xl focus:ring-4 focus:ring-orange-500/15 focus:border-orange-500/70 outline-none text-base transition-all placeholder:text-slate-300 ${isDark ? 'bg-slate-900/60 border-slate-600/50 text-white' : 'bg-white border-gray-300 text-gray-900'}`}
                  />
                  {/* 清理按钮 - 最右边 */}
                  {url && !loading && (
                    <button
                      onClick={clearUrl}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-slate-300 hover:text-slate-300 transition"
                      title="Clear link"
                    >
                      <Eraser className="w-4 h-4" />
                    </button>
                  )}
                  {/* 解析状态指示 */}
                  {loading && (
                    <div className="absolute right-2 top-1/2 -translate-y-1/2">
                      <Loader2 className="w-5 h-5 text-orange-400 animate-spin" />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Batch Download模式 */}
            {batchMode && (
              <div className="mb-5">
                {/* 粘贴区域 */}
                <textarea
                  value={batchUrls}
                  onChange={(e) => handleBatchChange(e.target.value)}
                  placeholder="Paste links (auto-extract) or type one per line：&#10;https://v.douyin.com/xxx&#10;https://x.com/yyy"
                  className={`w-full h-28 px-4 py-3 border-2 rounded-2xl focus:ring-4 focus:ring-orange-500/15 focus:border-orange-500/70 text-sm transition-all resize-none ${isDark ? 'bg-slate-900/60 border-slate-600/50 text-white placeholder:text-slate-300' : 'bg-white border-gray-300 text-gray-900 placeholder:text-gray-400'}`}
                />
                {/* 链接预览列表 - 带数字排序 */}
                {batchUrls.split('\n').filter(u => u.trim()).length > 0 && (
                  <div className="mt-2 max-h-48 overflow-y-auto space-y-1.5">
                    {batchUrls.split('\n').filter(u => u.trim()).map((url, idx) => {
                      // 去除数字前缀获取纯链接
                      const cleanUrl = url.replace(/^\d+\.\s*/, '').trim()
                      // 截取显示
                      const displayUrl = cleanUrl.replace(/^https?:\/\//, '')
                      const shortUrl = displayUrl.length > 35 
                        ? displayUrl.substring(0, 20) + '...' + displayUrl.substring(displayUrl.length - 10)
                        : displayUrl
                      return (
                        <div key={idx} className="flex items-center gap-0.5 px-3 py-2 bg-slate-700/30 rounded-xl border border-slate-700/60">
                          <span className="text-xs text-slate-300 w-6">{idx + 1}.</span>
                          <span className="flex-1 text-xs text-slate-300 truncate text-left" title={cleanUrl}>{shortUrl}</span>
                          <button
                            onClick={() => {
                              const lines = batchUrls.split('\n')
                              lines.splice(idx, 1)
                              setBatchUrls(lines.filter(l => l.trim()).join('\n'))
                            }}
                            className="text-slate-500 hover:text-red-400 transition"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
                <p className="text-xs text-slate-300 mt-2">
                  💡 One link per line, max 10 items. {batchUrls.split('\n').filter(u => u.trim()).length}/10
                </p>
              </div>
            )}

            {/* Supported Platforms */}
            <div className="mb-5">
              <p className="text-xs text-slate-300 mb-2">{t('supportedPlatforms')}</p>
              <div className="flex flex-wrap gap-1.5">
                {PLATFORMS.map((p) => (
                  <span key={p.id} className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-700/30 text-slate-300 text-xs rounded-lg">
                    <span>{p.icon}</span>
                    <span>{p.label}</span>
                  </span>
                ))}
              </div>
            </div>

            {/* 下载选项 */}
            <div className="mb-5">
              <p className="text-xs text-slate-300 mb-2">Download Content</p>
              <div className="flex flex-wrap gap-1.5">
                {OPTIONS.map(o => {
                  const Icon = o.icon; const on = selected.has(o.id)
                  return (
                    <button key={o.id} onClick={() => toggle(o.id)}
                      className={`flex items-center gap-1 px-3 py-2 text-xs rounded-lg transition-all
                        ${on ? 'bg-orange-500/15 text-orange-300 border border-orange-500/30' : 'bg-slate-700/30 text-slate-300 border border-transparent hover:text-slate-300'}`}>
                      <Icon className="w-3.5 h-3.5" />{o.label}
                    </button>
                  )
                })}
              </div>
              {/* ASR Language Selection */}
              {selected.has('asr') && (
                <div className="mt-3">
                  <label className="text-xs text-slate-300 mb-1 block">ASR Language 語言</label>
                  <select
                    value={asrLanguage}
                    onChange={(e) => setAsrLanguage(e.target.value)}
                    className={`w-full px-3 py-2 border-2 rounded-xl text-sm outline-none focus:border-orange-500/70 cursor-pointer appearance-none ${isDark ? 'bg-slate-900/60 border-slate-600/50 text-white' : 'bg-white border-gray-300 text-gray-900'}`}
                  >
                    {ASR_LANGUAGE_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {/* Save Location 保存位置 - 下拉式 */}
            <div className="mb-5">
              <label className="text-xs text-slate-300 mb-2 flex items-center gap-1.5">
                <FolderOpen className="w-3.5 h-3.5" />
                Save Location 保存位置
              </label>
              <div className="relative mt-1.5">
                <select
                  value={saveLocation}
                  onChange={(e) => handleLocationChange(e.target.value)}
                  className={`w-full px-4 py-3 border-2 rounded-xl text-sm outline-none focus:border-orange-500/70 cursor-pointer appearance-none ${isDark ? 'bg-slate-900/60 border-slate-600/50 text-white' : 'bg-white border-gray-300 text-gray-900'}`}
                >
                  <option value="album">📱 Phone Gallery 手機相冊</option>
                  <option value="download">💻 Download Folder 下載文件夾</option>
                  <option value="desktop">🖥️ Desktop 桌面</option>
                </select>
                <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-300 pointer-events-none" />
              </div>
              {saveLocation === 'download' && (
                <div className="mt-2 p-2.5 bg-slate-700/30 rounded-xl border border-slate-700/60">
                  <p className="text-xs text-slate-300 leading-relaxed">
                    💡 <span className="text-orange-400">Tip:</span>To change download path, set default download location in browser settings. Chrome: Settings → Advanced → Downloads.
                  </p>
                </div>
              )}
            </div>

            {/* 错误提示 */}
            {error && (
              <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                <p className="text-red-300 text-sm">{error}</p>
              </div>
            )}

            {/* 批量进度提示 */}
            {/* Batch progress indicator */}
            {/* Batch Progress 批量进度 */}
            {batchMode && batchQueue.length > 0 && (
              <div className={`mb-3 rounded-xl border overflow-hidden ${isDark ? 'bg-slate-900/60 border-slate-700/60' : 'bg-white border-gray-200'}`}>
                <div className={`px-4 py-2 border-b flex justify-between items-center ${isDark ? 'border-slate-700/60' : 'border-gray-200'}`}>
                  <p className={`text-xs ${isDark ? 'text-slate-300' : 'text-gray-600'}`}>
                    Batch Queue: {batchQueue.length} items
                  </p>
                  {loading && <span className="text-xs text-orange-400">Processing {batchIndex + 1}/{batchQueue.length}</span>}
                </div>
                <div className="max-h-40 overflow-y-auto">
                  {batchQueue.map((item, idx) => {
                    let statusIcon = <span className="text-xs text-slate-500">⏳</span>
                    let statusClass = ''
                    
                    if (item.status === 'completed') {
                      statusIcon = <span className="text-xs text-emerald-400">✓</span>
                      statusClass = 'opacity-50'
                    } else if (item.status === 'error') {
                      statusIcon = <span className="text-xs text-red-400">✗</span>
                      statusClass = 'opacity-50'
                    } else if (idx === batchIndex && loading) {
                      statusIcon = <Loader2 className="w-3 h-3 text-orange-400 animate-spin" />
                      statusClass = 'bg-orange-500/10'
                    }
                    
                    const platform = detectPlatform(item.url)
                    const icon = PLATFORMS.find(p => p.id === platform)?.icon || '🔗'
                    
                    return (
                      <div key={idx} className={`flex items-center gap-2 px-4 py-2 border-b border-slate-700/20 last:border-0 ${statusClass}`}>
                        <span className="text-xs text-slate-300 w-5">{idx + 1}.</span>
                        <span className="text-sm">{icon}</span>
                        <span className="text-xs text-slate-300 truncate flex-1" title={item.url}>
                          {item.url.replace(/^https?:\/\//, '').substring(0, 35)}...
                        </span>
                        {statusIcon}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Download button */}
            {/* 剩余下载次数提示 */}
            {!isVip && remainingDownloads >= 0 && (
              <div className={`mb-3 text-center text-xs py-2 rounded-xl ${isDark ? 'bg-slate-800/60 text-slate-300' : 'bg-gray-100 text-gray-500'}`}>
                {remainingDownloads === -1 ? t('unlimited') : `${t('downloadsRemaining', { count: remainingDownloads })}`}
                {remainingDownloads === 0 && <span className="ml-2 text-orange-400">· <button onClick={() => setShowSubscription(true)} className="underline hover:text-orange-300">{t('upgradeToPro')}</button></span>}
              </div>
            )}
            {isVip && (
              <div className="mb-3 text-center text-xs py-2 rounded-xl bg-yellow-500/10 text-yellow-400">
                ⭐ {t('unlimited')}
              </div>
            )}
            <button
              onClick={handleSubmit}
              disabled={loading}
              className="w-full py-4 rounded-2xl font-bold text-white text-base bg-orange-500 hover:bg-orange-600 active:bg-orange-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-orange-500/25 active:scale-[0.98]"
            >
              {loading ? (
                <><Loader2 className="w-5 h-5 animate-spin" />{batchMode ? `${t('processing')} ${batchIndex + 1}/${batchQueue.length}...` : t('processing')}</>
              ) : (
                <><Zap className="w-5 h-5" />{t('startDownload')}</>
              )}
            </button>
          </div>

          {/* 任务状态 */}
          {task && (
            <div className={`mt-5 backdrop-blur-sm rounded-2xl p-5 border shadow-xl space-y-3 ${isDark ? 'bg-slate-800/60 border-slate-700/60' : 'bg-white border-gray-200'}`}>
              <div className="flex items-center justify-between">
                <h3 className={`text-sm font-semibold flex items-center gap-2 ${isDark ? 'text-slate-500' : 'text-gray-700'}`}>
                  <Download className="w-4 h-4 text-orange-400" /> Download Progress
                </h3>
                <button onClick={() => setTask(null)}><X className={`w-4 h-4 ${isDark ? 'text-slate-300 hover:text-slate-300' : 'text-gray-400 hover:text-gray-600'}`} /></button>
              </div>

              <div className="flex items-center gap-2">
                {task.status === 'completed' && <CheckCircle2 className="w-5 h-5 text-emerald-400" />}
                {task.status === 'error' && <XCircle className="w-5 h-5 text-red-400" />}
                {isWorking(task.status) && <Loader2 className="w-5 h-5 text-orange-400 animate-spin" />}
                <span className={`text-sm ${isDark ? 'text-slate-500' : 'text-gray-600'}`}>{statusLabel(task.status)}</span>
              </div>

              {/* 精细进度条 */}
              {isWorking(task.status) && (
                <div className="space-y-2">
                  <div className={`w-full h-2.5 rounded-full overflow-hidden ${isDark ? 'bg-slate-700/50' : 'bg-gray-200'}`}>
                    <div 
                      className="h-full bg-orange-500 rounded-full transition-all duration-500"
                      style={{ width: `${task.progress}%` }}
                    />
                  </div>
                  <div className={`flex items-center justify-between text-xs ${isDark ? 'text-slate-300' : 'text-gray-500'}`}>
                    <span className={isDark ? 'text-slate-300' : 'text-gray-600'}>{task.title || 'Parsing...'}</span>
                    <div className="flex items-center gap-2">
                      {task.downloadedBytes && task.totalBytes ? (
                        <span className={isDark ? 'text-slate-300' : 'text-gray-500'}>
                          {formatBytes(task.downloadedBytes)}/{formatBytes(task.totalBytes)}
                        </span>
                      ) : null}
                      <span className="text-orange-400 font-medium">{task.progress}%</span>
                      {task.speed && <span className="text-emerald-400">{task.speed}/s</span>}
                      {task.eta && <span className={isDark ? 'text-slate-300' : 'text-gray-400'}>剩余 {task.eta}</span>}
                    </div>
                  </div>
                </div>
              )}

              {task.title && !isWorking(task.status) && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    {task.quality && (
                      <span className={`text-xs px-2 py-0.5 rounded-full ${task.height >= 720 ? 'bg-gradient-to-r from-yellow-500/20 to-orange-500/20 text-yellow-400 border border-yellow-500/30' : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'}`}>
                        🎬 {task.quality} {task.height >= 720 ? '⭐' : '✓'}
                      </span>
                    )}
                    <p className="text-sm text-slate-300">{task.title}</p>
                  </div>
                  {/* 画质调整提示 - 需求2 */}
                  {task.qualityAdjusted === 'downgrade' && (
                    <div className="text-xs text-orange-400 bg-orange-500/10 px-3 py-2 rounded-xl">
                      💡 您选择的画质不可用，已自动降级到 {task.height}p
                    </div>
                  )}
                  {task.qualityAdjusted === 'upgrade' && (
                    <div className="text-xs text-emerald-400 bg-emerald-500/10 px-3 py-2 rounded-xl">
                      💡 已自动升级到最佳可用画质 {task.height}p
                    </div>
                  )}
                  {/* Free用户下载限制提示 - 需求3 */}
                  {!isVip && task.height && task.height < 1080 && (
                    <div className="text-xs text-slate-300 bg-slate-700/30 px-3 py-2 rounded-xl flex items-center justify-between">
                      <span>🔒 Pro 专享更高画质</span>
                      <button onClick={() => setShowSubscription(true)} className="text-orange-400 hover:text-orange-300 underline">升级 Pro</button>
                    </div>
                  )}
                </div>
              )}

              {/* 图文 */}
              {task.isNote && task.imageFiles?.length > 0 && (
                <div>
                  <p className="text-xs text-slate-300 mb-2">Total {task.imageFiles.length}  images</p>
                  <div className="grid grid-cols-3 gap-2">
                    {task.imageFiles.map(img => (
                      <a key={img.filename} href={`${API.replace('/api', '')}${img.url}`} download><img src={`${API.replace('/api', '')}${img.url}`} alt="" className="w-full aspect-square object-cover rounded-xl bg-slate-700/30" loading="lazy" /></a>
                    ))}
                  </div>
                </div>
              )}

              {/* Video下载 */}
              {task.status === 'completed' && task.downloadUrl && (
                <button 
                  onClick={async () => {
                    clearAutoDownload()  // 取消自动下载
                    autoDownloaded.current = true  // 标记为已处理
                    setDownloading(true)
                    // 检查是否为直接链接（YouTube等）
                    if (task.directLink) {
                      // 直接在新窗口打开链接
                      window.open(task.downloadUrl, '_blank')
                      setDownloading(false)
                    } else {
                      await shareFile(task.downloadUrl, task.title || 'video', 'video')
                      setDownloading(false)
                    }
                  }}
                  disabled={downloading}
                  className="w-full py-3.5 rounded-2xl text-sm font-semibold bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} 
                  {downloading ? t('downloading') : (task.directLink ? t('openVideo') : (isIOS() ? t('downloadToPhone') : 'Save to Device'))}
                </button>
              )}

              {/* Cover */}
              {task.status === 'completed' && task.coverUrl && (
                <button 
                  onClick={async () => {
                    clearAutoDownload()
                    autoDownloaded.current = true
                    setDownloading(true)
                    await shareFile(task.coverUrl, 'cover', 'image')
                    setDownloading(false)
                  }}
                  disabled={downloading}
                  className="w-full py-3 rounded-xl text-xs bg-slate-700/30 border border-slate-700/60 text-slate-300 hover:text-white transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImageIcon className="w-3.5 h-3.5" />}
                  {downloading ? 'Downloading...' : 'Save Cover'}
                </button>
              )}

              {/* MP3 Audio */}
              {task.status === 'completed' && task.audioUrl && (
                <button 
                  onClick={async () => {
                    clearAutoDownload()
                    autoDownloaded.current = true
                    setDownloading(true)
                    await shareFile(task.audioUrl!, 'audio.mp3', 'audio')
                    setDownloading(false)
                  }}
                  disabled={downloading}
                  className="w-full py-3 rounded-xl text-xs bg-slate-700/30 border border-slate-700/60 text-slate-300 hover:text-white transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mic className="w-3.5 h-3.5" />}
                  {downloading ? 'Downloading...' : 'Save MP3'}
                </button>
              )}

              {/* Copywriting */}
              {task.status === 'completed' && task.copyText && (
                <div className="p-3 bg-slate-900/60 rounded-xl">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-slate-300">Copywriting</span>
                    <button onClick={() => clip(task.copyText!, 'copy')} className="text-xs text-slate-300 hover:text-orange-400 transition">
                      {copied === 'copy' ? <><Check className="w-3 h-3 inline" /> Copied</> : <><Copy className="w-3 h-3 inline" /> Copy</>}
                    </button>
                  </div>
                  <p className="text-sm text-slate-300 whitespace-pre-wrap max-h-28 overflow-y-auto">{task.copyText}</p>
                </div>
              )}

              {/* Subtitle */}
              {task.status === 'completed' && task.subtitleFiles?.length > 0 && (
                <div className="flex gap-2 flex-wrap">
                  {task.subtitleFiles.map(s => (
                    <a key={s.filename} href={`${API.replace('/api', '')}${s.url}`} download={s.filename} className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs bg-slate-700/30 border border-slate-700/60 text-slate-300 hover:text-white transition-all">
                      <Languages className="w-3 h-3" />{s.filename}
                    </a>
                  ))}
                </div>
              )}

              {/* ASR */}
              {task.asrText && (
                <div className="p-3 bg-slate-900/60 rounded-xl">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-slate-300">Speech to Text</span>
                    <div className="flex gap-2">
                      <button onClick={() => clip(task.asrText!, 'asr')} className="text-xs text-slate-300 hover:text-orange-400 transition">
                        {copied === 'asr' ? <><Check className="w-3 h-3 inline" /> Copied</> : <><Copy className="w-3 h-3 inline" /> Copy</>}
                      </button>
                      <button onClick={() => {
                        const blob = new Blob([task.asrText!], { type: 'text/plain' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `${task.title || 'asr'}.txt`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }} className="text-xs text-slate-300 hover:text-orange-400 transition">
                        <Download className="w-3 h-3 inline" /> TXT
                      </button>
                    </div>
                  </div>
                  <p className="text-sm text-slate-300 whitespace-pre-wrap max-h-32 overflow-y-auto">{task.asrText}</p>
                </div>
              )}

              {task.status === 'error' && task.error && <p className="text-sm text-red-400">{getErrorMessage(task.error)}</p>}
            </div>
          )}

          {/* How to Use - 精简版 */}
          <div className={`mt-5 rounded-2xl px-5 py-3 border ${isDark ? 'bg-slate-900/60 border-slate-700/60' : 'bg-gray-100 border-gray-200'}`}>
            <div className={`flex items-center gap-4 text-xs ${isDark ? 'text-slate-300' : 'text-gray-500'}`}>
              <span className="flex items-center gap-1"><span className="text-orange-400 font-bold">1</span> Copy link</span>
              <span>→</span>
              <span className="flex items-center gap-1"><span className="text-orange-400 font-bold">2</span> Paste</span>
              <span>→</span>
              <span className="flex items-center gap-1"><span className="text-orange-400 font-bold">3</span> Download</span>
            </div>
          </div>

          {/* // Download History - Enhanced */}
          <div className="mt-5">
            <button onClick={() => setShowHistory(!showHistory)}
              className={`w-full flex items-center justify-between px-5 py-3 rounded-2xl border text-sm transition ${isDark ? 'bg-slate-900/60 border-slate-700/60 text-slate-300 hover:text-slate-300' : 'bg-white border-gray-200 text-gray-600 hover:text-gray-900'}`}>
              <span className="flex items-center gap-2">
                <Clock className="w-4 h-4" /> Download History
                {history.length > 0 && <span className="bg-orange-500/20 text-orange-400 px-2 py-0.5 rounded text-xs">{history.length}</span>}
              </span>
              <span className="flex items-center gap-2">
                {history.length > 0 && showHistory && (
                  <button onClick={(e) => { e.stopPropagation(); clearAllHistory() }} className="text-xs text-red-400 hover:text-red-300 transition">Clear All</button>
                )}
                {showHistory ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
              </span>
            </button>
            {showHistory && (
              <div className={`mt-2 rounded-2xl border overflow-hidden ${isDark ? 'bg-slate-900/60 border-slate-700/60' : 'bg-white border-gray-200'}`}>
                <div className={`flex gap-2 p-3 border-b items-center ${isDark ? 'border-slate-700/30' : 'border-gray-100'}`}>
                  {filteredHistory.length > 0 && <input type="checkbox" checked={selectedTasks.size === filteredHistory.length} onChange={toggleSelectAll} className={`w-4 h-4 rounded ${isDark ? 'border-slate-600' : 'border-gray-400'}`} />}
                  {selectedTasks.size > 0 && <button onClick={deleteSelected} className="px-3 py-1.5 bg-red-500/20 text-red-400 border border-red-500/50 rounded-lg text-xs">Delete ({selectedTasks.size})</button>}
                  <div className="flex-1 relative">
                    <input type="text" value={historySearch} onChange={(e) => setHistorySearch(e.target.value)} placeholder="Search..." className={`w-full pl-8 pr-3 py-2 border rounded-lg text-sm placeholder:text-slate-300 ${isDark ? 'bg-slate-800/50 border-slate-700/50 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'}`} />
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-300" />
                  </div>
                  <select value={historyFilter} onChange={(e) => setHistoryFilter(e.target.value as any)} className={`px-3 py-2 border rounded-lg text-sm ${isDark ? 'bg-slate-800/50 border-slate-700/50 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'}`}>
                    <option value="all">All</option>
                    <option value="completed">Done</option>
                    <option value="error">Failed</option>
                    <option value="favorites">Fav</option>
                  </select>
                </div>
                <div className="max-h-60 overflow-y-auto">
                  {filteredHistory.length === 0 ? <p className="py-8 text-center text-sm text-slate-500">{historySearch || historyFilter !== 'all' ? 'No results' : 'No history'}</p> : filteredHistory.map(item => (
                    <div key={item.taskId} className={`flex items-center gap-3 px-4 py-3 border-b border-slate-700/20 last:border-0 hover:bg-slate-900/60 transition ${selectedTasks.has(item.taskId) ? 'bg-orange-500/10' : ''}`}>
                      <input type="checkbox" checked={selectedTasks.has(item.taskId)} onChange={() => { const s = new Set(selectedTasks); selectedTasks.has(item.taskId) ? s.delete(item.taskId) : s.add(item.taskId); setSelectedTasks(s) }} className="w-4 h-4 rounded border-slate-600 shrink-0" />
                      {item.thumbnailUrl ? <button onClick={() => openSavedFile(item)} className="relative shrink-0 group"><img src={`${BASE_URL}${item.thumbnailUrl}`} alt="" className="w-14 h-10 object-cover rounded-lg" /><div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-lg opacity-0 group-hover:opacity-100 transition"><Play className="w-4 h-4 text-white" /></div></button> : <div className="w-14 h-10 rounded-lg bg-slate-700/50 flex items-center justify-center shrink-0"><Video className="w-4 h-4 text-slate-500" /></div>}
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm text-slate-500 font-medium whitespace-nowrap ${(item.title || '').length > 20 ? 'animate-marquee' : 'truncate'}`}>{item.title || 'Untitled'}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          {item.platform && <span className="text-xs text-orange-400 bg-orange-500/10 px-1.5 py-0.5 rounded">{platformLabel(item.platform)}</span>}
                          {item.height && <span className={`text-xs px-1.5 py-0.5 rounded ${item.height >= 720 ? 'text-yellow-400 bg-yellow-500/10' : 'text-emerald-400 bg-emerald-500/10'}`}>🎬 {item.height}p {item.height >= 720 ? '⭐' : '✓'}</span>}
                          <span className="text-xs text-slate-500">{new Date(item.createdAt).toLocaleString('en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                      </div>
                      {item.status === 'error' && <button onClick={() => retryTask(item)} className="p-1.5 text-orange-500 hover:text-orange-400"><Loader2 className="w-4 h-4" /></button>}
                      <button onClick={() => toggleFavorite(item.taskId)} className={`p-1.5 ${favorites.has(item.taskId) ? 'text-yellow-400' : 'text-slate-500 hover:text-yellow-400'}`}><svg className="w-4 h-4" fill={favorites.has(item.taskId) ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg></button>
                      <button onClick={() => del(item.taskId)} className="p-1.5 text-slate-500 hover:text-red-400"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </main>

        {/* 重复下载确认弹窗 */}
        {/* 画质选择弹窗 */}
        {showQualityPicker && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
            <div className="bg-slate-800 rounded-2xl p-6 max-w-sm w-full border border-slate-700">
              <h3 className="text-lg font-bold text-white mb-1">{t('selectQuality')}</h3>
              <p className="text-xs text-slate-300 mb-4">
                {!isVip && <span className="text-orange-400">{t('vipOnly')} · </span>}{t('highQuality')}
              </p>
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {availableQualities.map((q, idx) => {
                  const isHighQuality = q.height > 720
                  const canSelect = isVip || !isHighQuality
                  const qualityLabel = q.quality || `${q.height}p`
                  return (
                    <button
                      key={idx}
                      onClick={() => {
                        if (!canSelect) {
                          setShowQualityPicker(false)
                          setShowSubscription(true)
                          return
                        }
                        setShowQualityPicker(false)
                        // Set quality filter for download - VIP用户直接传高度限制，不限制最高画质
                        // 4K=2160, 2K=1440, 1080p=1080, 720p=720
                        let qParam = ''
                        if (q.height >= 1440) qParam = `height<=${q.height}` // 4K/2K
                        else if (q.height >= 1080) qParam = 'height<=1080'
                        else if (q.height >= 720) qParam = 'height<=720'
                        setQuality(qParam)
                        // Proceed with download
                        setLoading(true)
                        axios.post(`${API}/download`, {
                          url: pendingUrl, platform: detected || 'auto',
                          needAsr: selected.has('asr'), options: [...selected], quality: qParam, asrLanguage,
                        }, { timeout: 120000, headers: authToken ? { Authorization: `Bearer ${authToken}` } : {} }).then(r => {
                          setTask(r.data.data)
                          setDetected('')
                        }).catch((e: any) => {
                          setError(getErrorMessage(e.response?.data?.message || e.message || 'Download failed'))
                        }).finally(() => setLoading(false))
                      }}
                      className={`w-full flex items-center justify-between p-3 rounded-xl transition text-left ${
                        canSelect ? 'bg-slate-700/50 hover:bg-slate-700' : 'bg-slate-800/50 opacity-50 cursor-not-allowed'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`font-medium ${canSelect ? 'text-white' : 'text-slate-300'}`}>{qualityLabel}</span>
                        {q.width > 0 && <span className={`text-xs ${canSelect ? 'text-slate-300' : 'text-slate-500'}`}>{q.width}x{q.height}</span>}
                        {isHighQuality && !isVip && <span className="text-xs text-orange-400 ml-1">🚫 {t('vipOnly')}</span>}
                        {isHighQuality && isVip && <span className="text-xs text-yellow-400 ml-1">⭐</span>}
                      </div>
                      <span className="text-xs text-slate-300">{q.hasAudio ? '🎬' : '🎵'}</span>
                    </button>
                  )
                })}
              </div>
              {!isVip && (
                <button
                  onClick={() => { setShowQualityPicker(false); setShowSubscription(true) }}
                  className="w-full mt-3 py-3 px-4 rounded-xl bg-gradient-to-r from-yellow-500/20 to-orange-500/20 text-orange-400 hover:from-yellow-500/30 hover:to-orange-500/30 transition border border-orange-500/30 flex items-center justify-center gap-2"
                >
                  <Crown className="w-4 h-4" />
                  升级会员解锁高清画质
                </button>
              )}
              <button
                onClick={() => { setShowQualityPicker(false); setPendingUrl('') }}
                className="w-full mt-2 py-2 px-4 rounded-xl bg-slate-700 text-slate-300 hover:bg-slate-600 transition"
              >
                取消
              </button>
            </div>
          </div>
        )}

        {showDupConfirm && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
            <div className="bg-slate-800 rounded-2xl p-6 max-w-sm w-full border border-slate-700">
              <h3 className="text-lg font-bold text-white mb-2">已下载过</h3>
              <p className="text-sm text-slate-300 mb-4">该视频已在下载历史中。是否还要下载？</p>
              <p className="text-xs text-slate-300 mb-4 truncate">{dupUrl}</p>
              <div className="flex gap-3">
                <button onClick={() => { setShowDupConfirm(false); setPendingDownload(null) }} className="flex-1 py-2 px-4 rounded-xl bg-slate-700 text-slate-300 hover:bg-slate-600 transition">取消</button>
                <button onClick={() => { setShowDupConfirm(false); if (pendingDownload) pendingDownload() }} className="flex-1 py-2 px-4 rounded-xl bg-orange-500 text-white hover:bg-orange-600 transition">继续下载</button>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <footer className={`text-center py-8 text-xs ${isDark ? 'text-slate-500' : 'text-gray-400'}`}>
          <p>Orange Downloader v1.0 · For personal use only</p>
        </footer>
        <AuthModal isOpen={showAuthModal} onClose={() => setShowAuthModal(false)} onSuccess={handleAuthSuccess} onForgotPassword={() => { setShowAuthModal(false); setShowResetPwd(true); }} />

        {/* 忘记密码弹窗 */}
        {showResetPwd && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
            <div className="bg-slate-800 rounded-2xl w-full max-w-xs border border-slate-700 shadow-2xl">
              {/* Header */}
              <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-700">
                <button onClick={() => setShowResetPwd(false)} className="text-slate-300 hover:text-white transition">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                </button>
                <h3 className="text-base font-bold text-white">🔑 修改密码</h3>
              </div>
              {/* Content */}
              <div className="p-4">
                {!resetPwdStep ? (
                  <>
                    <p className="text-xs text-slate-300 mb-3">输入注册邮箱，我们会发送重置链接</p>
                    <input
                      type="email"
                      value={resetEmail}
                      onChange={(e) => setResetEmail(e.target.value)}
                      placeholder="your@email.com"
                      className="w-full px-3 py-2.5 bg-slate-900/60 border border-slate-600/50 rounded-lg text-white text-sm outline-none focus:border-orange-500/70 mb-3"
                    />
                    {resetPwdMsg && <p className={`text-xs mb-3 ${resetPwdMsg.includes('失败') ? 'text-red-400' : 'text-green-400'}`}>{resetPwdMsg}</p>}
                    <button onClick={handleForgotPassword} disabled={resetPwdLoading} className="w-full py-2.5 rounded-lg bg-orange-500 text-white text-sm font-medium hover:bg-orange-600 transition disabled:opacity-50">
                      {resetPwdLoading ? '发送中...' : '发送重置链接'}
                    </button>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-slate-300 mb-3">设置新密码</p>
                    <input
                      type="password"
                      value={resetPwd}
                      onChange={(e) => setResetPwd(e.target.value)}
                      placeholder="新密码"
                      className="w-full px-3 py-2.5 bg-slate-900/60 border border-slate-600/50 rounded-lg text-white text-sm outline-none focus:border-orange-500/70 mb-3"
                    />
                    {resetPwdMsg && <p className={`text-xs mb-3 ${resetPwdMsg.includes('失败') || resetPwdMsg.includes('无效') ? 'text-red-400' : 'text-green-400'}`}>{resetPwdMsg}</p>}
                    <button onClick={handleResetPassword} disabled={resetPwdLoading} className="w-full py-2.5 rounded-lg bg-orange-500 text-white text-sm font-medium hover:bg-orange-600 transition disabled:opacity-50">
                      {resetPwdLoading ? '重置中...' : '确认重置'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

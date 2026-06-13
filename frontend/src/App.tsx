import { useState, useEffect, useCallback, useRef } from 'react'
import axios from 'axios'
import { useTranslation } from 'react-i18next'
import AuthModal from './components/AuthModal'
import SubscriptionPage from './components/SubscriptionPage'
import ReferralModal from './components/ReferralModal'
import PWAInstallPrompt from './components/PWAInstallPrompt'
import { initNotifications, showDownloadComplete } from './utils/notify'
import api, { API_BASE, setOnTokenExpired, isTokenExpired } from './api/auth'
import {
  Download, Link2, CheckCircle2, XCircle, Loader2,
  Video, FileText, Image as ImageIcon, Mic, Languages,
  Trash2, ChevronDown, ChevronUp, Clock, Copy, Check,
  X, Zap, AlertCircle, Eraser, FolderOpen, HardDrive, Smartphone,
  Play, Search, Clipboard, Sun, Moon, Keyboard, User,
} from 'lucide-react'

const BASE_URL = API_BASE
const API = `${BASE_URL}/api`

function readStoredJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    localStorage.removeItem(key)
    return fallback
  }
}

// Detect iOS Safari (用于提示 iOS 用户长按保存)
const isIOS = () => {
  try {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream
  } catch { return false }
}

/**
 * 触发文件下载（PWA + 浏览器通用）
 *
 * 策略:
 *   1. 优先：<a download> 同源直链触发浏览器原生「另存为」
 *   2. 兜底：隐藏 iframe（适用于跨源/旧浏览器）
 *
 * 注：原生 App 走 Capacitor 的逻辑已下线，PWA 已经能覆盖 99% 场景。
 *     iOS Safari 不支持自动 download，会原地播放/打开，需要用户长按选择「下载」。
 */
const shareFile = async (
  url: string,
  title: string,
  _fileType: 'video' | 'audio' | 'image' = 'video',
) => {
  // 下载用相对路径（保持同源，<a download> 才能生效命名）
  const fullUrl = url.startsWith('http') ? url : url
  const filename = (title || 'orange-download').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120)

  try {
    const a = document.createElement('a')
    a.href = fullUrl
    a.download = filename
    a.rel = 'noopener'
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    return { success: true }
  } catch (_) {
    // Fallback：iframe（兼容某些不识别 download 属性的环境）
    const iframe = document.createElement('iframe')
    iframe.style.display = 'none'
    iframe.src = fullUrl
    document.body.appendChild(iframe)
    setTimeout(() => { if (document.body.contains(iframe)) document.body.removeChild(iframe) }, 5000)
    return { success: true }
  }
}

interface Task {
  taskId: string; status: string; progress: number
  title?: string; platform?: string; thumbnailUrl?: string
  downloadUrl?: string; audioUrl?: string; asrText?: string; summaryText?: any; copyText?: string
  translatedText?: string; translatedTxtUrl?: string; subbedVideoUrl?: string
  coverUrl?: string; isNote?: boolean
  copywriteAnalysis?: any; copywriteTranscript?: string; commerceCardStatus?: string; commerceCardError?: string
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
  url?: string; downloadUrl?: string; height?: number
  isFavorite?: boolean; tags?: string[] | string; notes?: string; groupName?: string
  aiAnalysis?: any; copywriteAnalysis?: any
}
interface AiUsageStatus {
  copywrite: {
    used: number
    limit: number
    remaining: number
  }
  retention: {
    hours: number
    tier: string
  }
}

const PLATFORMS = [
  { id: 'douyin', labelKey: 'platform_douyin', labelFallback: '抖音', icon: '📱' },
  { id: 'tiktok', labelKey: 'platform_tiktok', labelFallback: 'TikTok', icon: '🎵' },
  { id: 'youtube', labelKey: 'platform_youtube', labelFallback: 'YouTube', icon: '▶️' },
  { id: 'x', labelKey: 'platform_x', labelFallback: 'X/Twitter', icon: '🐦' },
  { id: 'instagram', labelKey: 'platform_instagram', labelFallback: 'Instagram', icon: '📸' },
  { id: 'xiaohongshu', labelKey: 'platform_xiaohongshu', labelFallback: '小紅書', icon: '📕' },
  { id: 'bilibili', labelKey: 'platform_bilibili', labelFallback: 'Bilibili', icon: '📺' },
  { id: 'more', labelKey: 'morePlatforms', labelFallback: '更多', icon: '🌐' },
]

const OPTIONS: { id: string; labelKey: string; icon: typeof Video }[] = [
  { id: 'video', labelKey: 'downloadOptionVideo', icon: Video },
  { id: 'audio_only', labelKey: 'downloadOptionAudio', icon: Mic },
  { id: 'cover', labelKey: 'downloadOptionCover', icon: ImageIcon },
]

const AI_TOOLS: { id: string; labelKey: string; descKey: string; icon: typeof FileText }[] = [
  { id: 'asr', labelKey: 'aiToolAsr', descKey: 'aiToolAsrDesc', icon: FileText },
  { id: 'ai_summary', labelKey: 'aiToolSummary', descKey: 'aiToolSummaryDesc', icon: Zap },
  { id: 'copywriting', labelKey: 'aiToolCommerceCard', descKey: 'aiToolCommerceCardDesc', icon: FileText },
  { id: 'translate_subtitle', labelKey: 'aiToolTranslateSubtitle', descKey: 'aiToolTranslateSubtitleDesc', icon: Languages },
]

const normalizeHistoryTags = (tags?: string[] | string) => {
  if (Array.isArray(tags)) return tags.filter(Boolean)
  if (typeof tags === 'string') {
    return tags
      .split(/[,，#\s]+/)
      .map(tag => tag.trim())
      .filter(Boolean)
  }
  return []
}

const getAiOutputLanguage = (language: string) => {
  if (language.startsWith('en')) return 'en'
  if (language.startsWith('ja')) return 'ja'
  if (language.startsWith('ko')) return 'ko'
  return 'zh'
}

const getHistoryAnalysis = (item: HistoryItem) => item.copywriteAnalysis || item.aiAnalysis || null

const getHistoryRewritePackCount = (item: HistoryItem) => {
  const analysis = getHistoryAnalysis(item)
  return analysis?.rewritePacks && typeof analysis.rewritePacks === 'object'
    ? Object.keys(analysis.rewritePacks).length
    : 0
}

const getRequiredRewritePackCount = () => REWRITE_PLATFORMS.length * REWRITE_STYLES.length

const isHistoryRewritePackComplete = (item: HistoryItem) => getHistoryRewritePackCount(item) >= getRequiredRewritePackCount()

const flattenAnalysisText = (value: any): string => {
  if (!value) return ''
  if (Array.isArray(value)) return value.map(flattenAnalysisText).join(' ')
  if (typeof value === 'object') return Object.values(value).map(flattenAnalysisText).join(' ')
  return String(value)
}

const ASR_LANGUAGE_OPTIONS = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'auto', label: 'Auto' },
]

const BATCH_QUALITY_OPTIONS = [
  { value: '', labelKey: 'qualityAutoBest', icon: '🔄', height: 0 },
  { value: 'height<=1080', label: '1080p', icon: '📺', height: 1080 },
  { value: 'height<=99999', labelKey: 'originalQuality', icon: '🎞️', height: 1080, vipOnly: true },
  { value: 'height<=1440', label: '2K', icon: '🎬', height: 1440 },
  { value: 'height<=2160', label: '4K', icon: '🎥', height: 2160 },
]

const REWRITE_PLATFORMS = [
  { id: 'tiktok', label: 'TikTok' },
  { id: 'douyin', label: '抖音' },
  { id: 'xiaohongshu', label: '小红书' },
  { id: 'youtube_shorts', label: 'Shorts' },
]

const REWRITE_STYLES = [
  { id: 'seed', labelKey: 'rewriteStyleSeed' },
  { id: 'review', labelKey: 'rewriteStyleReview' },
  { id: 'promo', labelKey: 'rewriteStylePromo' },
  { id: 'problem', labelKey: 'rewriteStyleProblem' },
  { id: 'live', labelKey: 'rewriteStyleLive' },
]

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function detectPlatform(url: string): string {
  if (!url) return ''
  if (/douyin\.com|iesdouyin\.com/i.test(url)) return 'douyin'
  if (/tiktok\.com/i.test(url)) return 'tiktok'
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube'
  if (/twitter\.com|x\.com/i.test(url)) return 'x'
  if (/bilibili\.com|b23\.tv/i.test(url)) return 'bilibili'
  if (/instagram\.com/i.test(url)) return 'instagram'
  if (/bilibili\.com|b23\.tv/i.test(url)) return 'bilibili'
  if (/xiaohongshu\.com|xhslink\.com/i.test(url)) return 'xiaohongshu'
  if (/(?:channels|finder|weixin)\.weixin\.qq\.com|weixin\.qq\.com\/sph\/|wxsnsdy\.|wechat/i.test(url)) return 'wechat'
  if (/kuaishou\.com|v\.kuaishou\.com/i.test(url)) return 'kuaishou'
  return ''
}

export default function App() {
  const [url, setUrl] = useState('')
  useEffect(() => { initNotifications().catch(console.error); }, []);

  // 启动时检查 token 是否过期，提前清理避免 API 调用失败
  useEffect(() => {
    if (isTokenExpired()) {
      localStorage.removeItem('orange_token');
      localStorage.removeItem('orange_user');
      setAuthToken(null);
      setAuthUser(null);
    }
  }, []);

  // 锁定竖屏（PWA 安装后生效）- 多次重试确保锁定
  useEffect(() => {
    const lock = () => {
      try {
        if (screen.orientation && 'lock' in screen.orientation) {
          ;(screen.orientation.lock as (orientation: string) => Promise<void>)('portrait-primary').catch(() => {})
        }
      } catch {}
    }
    lock()  // 立即尝试
    // 用户首次交互时再锁一次（某些Android需要用户手势）
    const onInteraction = () => { lock(); document.removeEventListener('click', onInteraction) }
    document.addEventListener('click', onInteraction, { once: true })
  }, []);
  const [detected, setDetected] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set(['video']))
  const [selectedAiTools, setSelectedAiTools] = useState<Set<string>>(new Set())
  const [task, setTask] = useState<Task | null>(null)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [historyTotal, setHistoryTotal] = useState(0)
  const [historyPage, setHistoryPage] = useState(1)
  const [historyPageSize] = useState(50)
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [historyMeta, setHistoryMeta] = useState<any>(null)
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false)
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
  const [targetLang, setTargetLang] = useState('')
  const [availableQualities, setAvailableQualities] = useState<Array<{qualityLabel?: string, quality: string, format: string, width: number, height: number, hasVideo: boolean, hasAudio: boolean, size?: number}>>([])
  const [qualitiesLoading, setQualitiesLoading] = useState(false)
  const [autoQuality, setAutoQuality] = useState<{label: string, height: number} | null>(null) // 自动选择的画质
  const [sharedEntrySource, setSharedEntrySource] = useState<'extension' | 'share' | ''>('')
  const [sharedAutoStart, setSharedAutoStart] = useState(false)
    const [pendingUrl, setPendingUrl] = useState('')
  const [pendingQuality, setPendingQuality] = useState('')
  const [batchUrls, setBatchUrls] = useState('')
  const [batchQuality, setBatchQuality] = useState('') // 批量画质偏好
  const [batchId, setBatchId] = useState<string | null>(null) // 当前批量任务 ID
  const qualityManuallySet = useRef(false) // 防止 useEffect 自动选择覆盖用户手动选择
  const [copywritingLoading, setCopywritingLoading] = useState(false)
  const [copywritingResult, setCopywritingResult] = useState<any>(null)
  const [rewriteStyle, setRewriteStyle] = useState('seed')
  const [rewriteLoadingKey, setRewriteLoadingKey] = useState('')
  const [batchCardGenerating, setBatchCardGenerating] = useState(false)
  const [batchRewriteLoadingKey, setBatchRewriteLoadingKey] = useState('')
  const [batchCardProgress, setBatchCardProgress] = useState({ done: 0, total: 0 })
  const [batchCardMessage, setBatchCardMessage] = useState('')
  const [aiUsage, setAiUsage] = useState<AiUsageStatus | null>(null)

  // Auth state
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [authToken, setAuthToken] = useState<string | null>(localStorage.getItem('orange_token'))
  const [authUser, setAuthUser] = useState<any>(() => readStoredJson('orange_user', null))
  const [showSubscription, setShowSubscription] = useState(false)
  const [showReferral, setShowReferral] = useState(false)
  const [showUpgradePopup, setShowUpgradePopup] = useState(false)
  const [showAdminDashboard, setShowAdminDashboard] = useState(false)
  const [adminMetrics, setAdminMetrics] = useState<any>(null)
  const [adminMetricsLoading, setAdminMetricsLoading] = useState(false)
  const [adminMetricsError, setAdminMetricsError] = useState('')
  const [adminTab, setAdminTab] = useState<'overview' | 'users' | 'ai'>('overview')
  const [adminUsers, setAdminUsers] = useState<any[]>([])
  const [adminUsersTotal, setAdminUsersTotal] = useState(0)
  const [adminUsersLoading, setAdminUsersLoading] = useState(false)
  const [adminUserSearch, setAdminUserSearch] = useState('')
  const [adminUserTier, setAdminUserTier] = useState('')
  const [adminUserPage, setAdminUserPage] = useState(1)
  const [adminAiUsage, setAdminAiUsage] = useState<any[]>([])
  const [adminAiUsageTotal, setAdminAiUsageTotal] = useState(0)
  const [adminAiUsageLoading, setAdminAiUsageLoading] = useState(false)

  // 全局 401 拦截：token 过期自动弹出登录框
  useEffect(() => {
    setOnTokenExpired(() => {
      localStorage.removeItem('orange_token')
      localStorage.removeItem('orange_user')
      setAuthToken(null)
      setAuthUser(null)
      setShowAuthModal(true)
    })
  }, [])
  const [showIosGuide, setShowIosGuide] = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)
  // 在 useState 前同步读取 URL 参数，避免首次渲染闪现/闪退
  const _urlResetToken = typeof window !== 'undefined'
    ? (new URLSearchParams(window.location.search).get('token') || new URLSearchParams(window.location.search).get('reset') || '')
    : ''
  const [showResetPwd, setShowResetPwd] = useState(!!_urlResetToken)
  const resetPwdLocked = useRef(!!_urlResetToken) // 初始化即锁定，防止弹窗被意外关闭
  const [resetEmail, setResetEmail] = useState('')
  const [resetPwdStep, setResetPwdStep] = useState(!!_urlResetToken) // false=Send邮件, true=Settings新Password
  const [resetPwdToken, setResetPwdToken] = useState(_urlResetToken)
  const [resetPwd, setResetPwd] = useState('')
  const [resetPwdConfirm, setResetPwdConfirm] = useState('')
  const [subbedDownloading, setSubbedDownloading] = useState(false)
  const [resetPwdMsg, setResetPwdMsg] = useState('')
  const [resetPwdLoading, setResetPwdLoading] = useState(false)
  const [isVip, setIsVip] = useState(false)
  const [remainingDownloads, setRemainingDownloads] = useState(-1) // -1 = unlimited/no display, 0 = 0次, n = Remainingn次
  const GUEST_DAILY_LIMIT = 3
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem('orange_theme')
    return saved ? saved === 'dark' : true
  })
  const { t, i18n } = useTranslation()
  const [showLangMenu, setShowLangMenu] = useState(false)
  const getAuthHeaders = () => authToken ? { Authorization: `Bearer ${authToken}` } : {}
  const fetchAiUsage = useCallback(async () => {
    if (!authToken) {
      setAiUsage(null)
      return
    }
    try {
      setAiUsage(await api.getAiUsage(authToken))
    } catch (err) {
      console.error('[AI] getAiUsage failed:', err)
    }
  }, [authToken])

  const openAdminDashboard = async () => {
    if (!authToken) return
    setShowUserMenu(false)
    setShowAdminDashboard(true)
    setAdminMetricsLoading(true)
    setAdminMetricsError('')
    try {
      setAdminMetrics(await api.getAdminMetrics(authToken))
    } catch (e: any) {
      setAdminMetricsError(e.message || t('adminMetricsFailed'))
    } finally {
      setAdminMetricsLoading(false)
    }
  }
  const fetchAdminUsers = async () => {
    setAdminUsersLoading(true);
    try {
      const r = await axios.get(`${API_BASE}/api/auth/admin/users`, { headers: getAuthHeaders(), params: { search: adminUserSearch, tier: adminUserTier, page: adminUserPage } });
      if (r.data?.data) { setAdminUsers(r.data.data.items || []); setAdminUsersTotal(r.data.data.total || 0); }
    } catch {} finally { setAdminUsersLoading(false); }
  };
  const fetchAdminAiUsage = async () => {
    setAdminAiUsageLoading(true);
    try {
      const r = await axios.get(`${API_BASE}/api/auth/admin/ai-usage`, { headers: getAuthHeaders() });
      if (r.data?.data) { setAdminAiUsage(r.data.data.items || []); setAdminAiUsageTotal(r.data.data.total || 0); }
    } catch {} finally { setAdminAiUsageLoading(false); }
  };
  useEffect(() => { if (adminTab === 'users') fetchAdminUsers(); }, [adminTab, adminUserSearch, adminUserTier, adminUserPage]);
  useEffect(() => { if (adminTab === 'ai') fetchAdminAiUsage(); }, [adminTab]);
  const changeLanguage = (lng: string) => {
    i18n.changeLanguage(lng)
    localStorage.setItem('orange_language', lng)
    setShowLangMenu(false)
  }

  // 浏览器语言自动检测（仅首次访问时）
  useEffect(() => {
    if (localStorage.getItem('orange_language')) return // 用户已手动选择过
    const browserLang = navigator.language || ''
    if (browserLang.toLowerCase().startsWith('zh')) {
      i18n.changeLanguage('zh-CN')
    } else if (browserLang.toLowerCase().startsWith('ja')) {
      i18n.changeLanguage('ja')
    } else if (browserLang.toLowerCase().startsWith('ko')) {
      i18n.changeLanguage('ko')
    } else {
      i18n.changeLanguage('en')
    }
  }, [])

  // 清除 URL 中的重置 token（初始状态已正确，这里只清理 URL 参数）
  // 重置成功后解锁关闭弹窗
  const handleResetPwdSuccess = () => {
    localStorage.removeItem('orange_token')
    setResetPwdMsg(t('passwordResetSuccess'))
    setTimeout(() => {
      setShowResetPwd(false)
      setResetPwdStep(false)
      setResetEmail('')
      setResetPwd('')
      setResetPwdToken('')
    }, 2000)
  }

  // 只有通过成功重置才能关闭弹窗（禁止通过X按钮关闭）
  const safeSetShowResetPwdForClose = () => {
    // 不允许直接关闭，只有 handleResetPwdSuccess 才能关闭
  }

  // 切换Theme
  const toggleTheme = () => {
    setIsDark(!isDark)
    localStorage.setItem('orange_theme', !isDark ? 'dark' : 'light')
  }

  // 键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl/Cmd + V: Auto聚焦到输入框
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        if (document.activeElement?.tagName !== 'INPUT') {
          e.preventDefault()
          document.querySelector<HTMLInputElement>('input[type="url"]')?.focus()
        }
      }
      // Ctrl/Cmd + Enter: 触發Download
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        if (url.trim() && !loading) {
          doSingleDownload()
        }
      }
      // Escape: 关闭弹窗（重置密码弹窗在 URL token 打开时不允许 Escape 关闭）
      if (e.key === 'Escape') {
        setShowUserMenu(false)
        setShowDupConfirm(false)
        if (!resetPwdLocked.current) {
          setShowResetPwd(false)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [url, loading])

  // Check VIP status and remaining downloads
  useEffect(() => {
    if (authToken) {
      api.getMe(authToken).then(user => {
        setAuthUser(user)
        localStorage.setItem('orange_user', JSON.stringify(user))
      }).catch(() => {})
      api.getSubscriptionStatus(authToken).then(status => {
        // 同时检查 tier 和 subscriptionStatus，防止过期账号仍显示 VIP
        const isPro = status?.tier === 'pro' && status?.subscriptionStatus === 'active';
        setIsVip(isPro)
        // VIP用户Show无限制（-1），非VIPShowRemainingTimes
        if (isPro) {
          setRemainingDownloads(-1) // VIP无限制
        } else {
          setRemainingDownloads(status?.usage?.remaining ?? GUEST_DAILY_LIMIT)
        }
        fetchAiUsage()
      }).catch((err) => { 
        // API Failed时不要把Member当GuestProcess，HideTimesPrompt即可
        console.error('[VIP] getSubscriptionStatus failed:', err);
        setRemainingDownloads(GUEST_DAILY_LIMIT);
      })
    } else {
      setIsVip(false)
      setAiUsage(null)
      // Check localStorage for guest remaining downloads
      const today = new Date().toISOString().split('T')[0]
      const parsed = readStoredJson<{ date?: string; count?: number } | null>('orange_guest_downloads', null)
      if (parsed?.date === today) {
        setRemainingDownloads(Math.max(0, GUEST_DAILY_LIMIT - (parsed.count || 0)))
      } else {
        setRemainingDownloads(GUEST_DAILY_LIMIT)
      }
    }
  }, [authToken, fetchAiUsage])
  const [historySearch, setHistorySearch] = useState('')
  const [historyFilter, setHistoryFilter] = useState<'all' | 'completed' | 'error' | 'favorites'>('all')
  const [historyPlatformFilter, setHistoryPlatformFilter] = useState('all')
  const [historyGroupFilter, setHistoryGroupFilter] = useState('all')
  const [historyTagFilter, setHistoryTagFilter] = useState('all')
  const [historyAiOnly, setHistoryAiOnly] = useState(false)
  const [historyPackOnly, setHistoryPackOnly] = useState(false)
  const [historyPackTodoOnly, setHistoryPackTodoOnly] = useState(false)
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set(readStoredJson<string[]>('orange_favorites', [])))
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set())
  const [editingMaterial, setEditingMaterial] = useState<HistoryItem | null>(null)
  const [materialTagsText, setMaterialTagsText] = useState('')
  const [materialNotes, setMaterialNotes] = useState('')
  const [materialGroupName, setMaterialGroupName] = useState('')
  const [showWorkbenchManager, setShowWorkbenchManager] = useState(false)
  const [showBatchTagEditor, setShowBatchTagEditor] = useState(false)
  const [batchTagMode, setBatchTagMode] = useState<'add' | 'remove'>('add')
  const [batchTagsText, setBatchTagsText] = useState('')
  const [batchTagsLoading, setBatchTagsLoading] = useState(false)
  const [showBatchGroupEditor, setShowBatchGroupEditor] = useState(false)
  const [batchGroupName, setBatchGroupName] = useState('')
  const [batchGroupLoading, setBatchGroupLoading] = useState(false)
  const [renamingGroupName, setRenamingGroupName] = useState('')
  const [renameGroupText, setRenameGroupText] = useState('')
  const [groupRenameLoading, setGroupRenameLoading] = useState(false)
  const [showLexiconEditor, setShowLexiconEditor] = useState(false)
  const [lexiconText, setLexiconText] = useState('')
  const [lexiconLoading, setLexiconLoading] = useState(false)
  const [lexiconMessage, setLexiconMessage] = useState('')

  const historyPlatformOptions = Array.from(new Set(history.map(item => item.platform).filter(Boolean) as string[]))
  const historyGroupStats = (() => {
    // 优先服务端 meta
    if (historyMeta?.groups?.length > 0) {
      return {
        groups: historyMeta.groups.slice(0, 80).map((g: any) => ({ group: g.group, count: g.count })),
        ungrouped: historyMeta.ungroupedCount || 0
      };
    }
    const counts = new Map<string, number>()
    let ungrouped = 0
    history.forEach(item => {
      const group = item.groupName?.trim()
      if (group) counts.set(group, (counts.get(group) || 0) + 1)
      else ungrouped += 1
    })
    return {
      groups: Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 80).map(([group, count]) => ({ group, count })),
      ungrouped
    }
  })()
  const historyGroupOptions = historyGroupStats.groups.map(item => item.group)
  const historyTagStats = (() => {
    // 优先服务端 meta
    if (historyMeta?.tags?.length > 0) {
      return historyMeta.tags.slice(0, 80).map((t: any) => ({ tag: t.tag, count: t.count }));
    }
    const counts = new Map<string, number>()
    history.forEach(item => {
      normalizeHistoryTags(item.tags).forEach(tag => counts.set(tag, (counts.get(tag) || 0) + 1))
    })
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 80)
      .map(([tag, count]) => ({ tag, count }))
  })()
  const historyTagOptions = historyTagStats.slice(0, 60).map(item => item.tag)
  const popularHistoryTags = (() => {
    return historyTagStats.slice(0, 12)
  })()

  const filteredHistory = history.filter(item => {
    const isFav = item.isFavorite || favorites.has(item.taskId)
    if (historyFilter === 'favorites' && !isFav) return false
    if (historyFilter !== 'all' && historyFilter !== 'favorites' && item.status !== historyFilter) return false
    if (historyPlatformFilter !== 'all' && item.platform !== historyPlatformFilter) return false
    if (historyGroupFilter === '__ungrouped' && item.groupName?.trim()) return false
    if (historyGroupFilter !== 'all' && historyGroupFilter !== '__ungrouped' && (item.groupName || '') !== historyGroupFilter) return false
    if (historyTagFilter !== 'all' && !normalizeHistoryTags(item.tags).includes(historyTagFilter)) return false
    if (historyAiOnly && !getHistoryAnalysis(item)) return false
    if (historyPackOnly && getHistoryRewritePackCount(item) === 0) return false
    if (historyPackTodoOnly && (!getHistoryAnalysis(item) || isHistoryRewritePackComplete(item))) return false
    if (historySearch) {
      const q = historySearch.toLowerCase()
      const haystack = [
        item.title || '',
        item.url || '',
        item.platform || '',
        getPlatformLabel(item.platform || ''),
        item.groupName || '',
        item.notes || '',
        normalizeHistoryTags(item.tags).join(' '),
        flattenAnalysisText(getHistoryAnalysis(item))
      ].join(' ').toLowerCase()
      if (!haystack.includes(q)) return false
    }
    return true
  })

  const materialStats = (() => {
    // 优先使用服务端 meta，回退到客户端计算
    if (historyMeta) {
      const topPlatform = (historyMeta.platforms || [])[0];
      const topPlatformMeta = topPlatform ? PLATFORMS.find(p => p.id === topPlatform.platform) : null;
      return {
        total: historyMeta.total || historyTotal || history.length,
        aiCards: historyMeta.aiCardsCount || 0,
        publishPacks: historyMeta.publishPacksCount || 0,
        groups: (historyMeta.groups || []).length,
        favorites: historyMeta.favoritesCount || 0,
        topPlatform: topPlatformMeta ? t(topPlatformMeta.labelKey as any) || topPlatformMeta.labelFallback : topPlatform?.platform || t('none'),
        topPlatformCount: topPlatform?.count || 0,
      };
    }
    // 客户端计算（兜底）
    const platformCounts = new Map<string, number>()
    let aiCards = 0
    let publishPacks = 0
    let favoritesCount = 0
    history.forEach(item => {
      if (item.platform) platformCounts.set(item.platform, (platformCounts.get(item.platform) || 0) + 1)
      if (getHistoryAnalysis(item)) aiCards += 1
      publishPacks += getHistoryRewritePackCount(item)
      if (item.isFavorite || favorites.has(item.taskId)) favoritesCount += 1
    })
    const topPlatform = Array.from(platformCounts.entries()).sort((a, b) => b[1] - a[1])[0]
    const topPlatformMeta = topPlatform ? PLATFORMS.find(platform => platform.id === topPlatform[0]) : null
    return {
      total: historyTotal || history.length,
      aiCards,
      publishPacks,
      groups: historyGroupOptions.length,
      favorites: favoritesCount,
      topPlatform: topPlatformMeta ? t(topPlatformMeta.labelKey as any) || topPlatformMeta.labelFallback : topPlatform?.[0] || t('none'),
      topPlatformCount: topPlatform?.[1] || 0
    }
  })()

  const toggleFavorite = async (taskId: string) => {
    const nf = new Set(favorites)
    const nextFavorite = !nf.has(taskId)
    nextFavorite ? nf.add(taskId) : nf.delete(taskId)
    setFavorites(nf)
    localStorage.setItem('orange_favorites', JSON.stringify([...nf]))
    setHistory(prev => prev.map(item => item.taskId === taskId ? { ...item, isFavorite: nextFavorite } : item))
    if (authToken) {
      try {
        await axios.patch(`${API}/history/${taskId}`, { isFavorite: nextFavorite }, { headers: getAuthHeaders() })
      } catch {
        fetchHistory()
      }
    }
  }

  const openMaterialEditor = (item: HistoryItem) => {
    setEditingMaterial(item)
    setMaterialTagsText(normalizeHistoryTags(item.tags).join(', '))
    setMaterialNotes(item.notes || '')
    setMaterialGroupName(item.groupName || '')
  }

  const parseTagInput = (value: string) => value
    .split(/[,，#\n]/)
    .map(t => t.trim())
    .filter(Boolean)

  const appendTagsToInput = (value: string, tagsToAdd: string[]) => {
    return Array.from(new Set([...parseTagInput(value), ...tagsToAdd])).slice(0, 20).join(', ')
  }
  const toggleHistoryTagFilter = (tag: string) => {
    setHistoryTagFilter(current => current === tag ? 'all' : tag)
  }

  const saveMaterialMeta = async () => {
    if (!editingMaterial) return
    const tags = parseTagInput(materialTagsText).slice(0, 20)
    const notes = materialNotes.slice(0, 2000)
    const groupName = materialGroupName.trim().slice(0, 80)
    const taskId = editingMaterial.taskId

    setHistory(prev => prev.map(item => item.taskId === taskId ? { ...item, tags, notes, groupName } : item))
    setEditingMaterial(null)
    try {
      await axios.patch(`${API}/history/${taskId}`, { tags, notes, groupName }, { headers: getAuthHeaders() })
    } catch (e: any) {
      setError(e.response?.data?.message || '素材保存失败')
      fetchHistory()
    }
  }

  const openBatchTagEditor = (mode: 'add' | 'remove' = 'add') => {
    if (selectedTasks.size === 0) return
    setBatchTagMode(mode)
    setBatchTagsText('')
    setShowBatchTagEditor(true)
  }

  const openBatchGroupEditor = () => {
    if (selectedTasks.size === 0) return
    setBatchGroupName('')
    setShowBatchGroupEditor(true)
  }

  const saveBatchTags = async () => {
    const inputTags = parseTagInput(batchTagsText)
    if (inputTags.length === 0) {
      setError(batchTagMode === 'remove' ? t('enterTagsToRemove') : t('enterTagsToApply'))
      return
    }
    const selectedItems = history.filter(item => selectedTasks.has(item.taskId))
    if (selectedItems.length === 0) return

    setBatchTagsLoading(true)
    try {
      const updates = selectedItems.map(item => {
        const currentTags = normalizeHistoryTags(item.tags)
        const tags = batchTagMode === 'remove'
          ? currentTags.filter(tag => !inputTags.includes(tag))
          : Array.from(new Set([...currentTags, ...inputTags])).slice(0, 20)
        return { taskId: item.taskId, tags }
      })
      setHistory(prev => prev.map(item => {
        const update = updates.find(u => u.taskId === item.taskId)
        return update ? { ...item, tags: update.tags } : item
      }))
      await Promise.all(updates.map(update =>
        axios.patch(`${API}/history/${update.taskId}`, { tags: update.tags }, { headers: getAuthHeaders() })
      ))
      setShowBatchTagEditor(false)
      setBatchTagsText('')
      setError('')
    } catch (e: any) {
      setError(e.response?.data?.message || (batchTagMode === 'remove' ? t('batchRemoveTagsFailed') : t('batchTagsFailed')))
      fetchHistory()
    } finally {
      setBatchTagsLoading(false)
    }
  }

  const startRenameGroup = (group: string) => {
    setRenamingGroupName(group)
    setRenameGroupText(group)
  }

  const renameGroup = async () => {
    const oldName = renamingGroupName.trim()
    const newName = renameGroupText.trim().slice(0, 80)
    if (!oldName) return
    if (!newName) {
      setError(t('enterMaterialGroup'))
      return
    }
    if (oldName === newName) {
      setRenamingGroupName('')
      return
    }
    const groupItems = history.filter(item => (item.groupName || '').trim() === oldName)
    if (groupItems.length === 0) return

    setGroupRenameLoading(true)
    try {
      setHistory(prev => prev.map(item => (item.groupName || '').trim() === oldName ? { ...item, groupName: newName } : item))
      await Promise.all(groupItems.map(item =>
        axios.patch(`${API}/history/${item.taskId}`, { groupName: newName }, { headers: getAuthHeaders() })
      ))
      if (historyGroupFilter === oldName) setHistoryGroupFilter(newName)
      setRenamingGroupName('')
      setRenameGroupText('')
      setError('')
    } catch (e: any) {
      setError(e.response?.data?.message || t('renameGroupFailed'))
      fetchHistory()
    } finally {
      setGroupRenameLoading(false)
    }
  }

  const saveBatchGroup = async () => {
    const groupName = batchGroupName.trim().slice(0, 80)
    if (!groupName) {
      setError(t('enterMaterialGroup'))
      return
    }
    const selectedItems = history.filter(item => selectedTasks.has(item.taskId))
    if (selectedItems.length === 0) return

    setBatchGroupLoading(true)
    try {
      setHistory(prev => prev.map(item => selectedTasks.has(item.taskId) ? { ...item, groupName } : item))
      await Promise.all(selectedItems.map(item =>
        axios.patch(`${API}/history/${item.taskId}`, { groupName }, { headers: getAuthHeaders() })
      ))
      setShowBatchGroupEditor(false)
      setBatchGroupName('')
      setError('')
    } catch (e: any) {
      setError(e.response?.data?.message || t('batchGroupFailed'))
      fetchHistory()
    } finally {
      setBatchGroupLoading(false)
    }
  }

  const openLexiconEditor = async () => {
    if (!authToken) {
      setShowAuthModal(true)
      return
    }
    setShowLexiconEditor(true)
    setLexiconMessage('')
    setLexiconLoading(true)
    try {
      const data = await api.getAsrLexicon(authToken)
      setLexiconText((data.terms || []).join('\n'))
    } catch (e: any) {
      setLexiconMessage(e.message || '词库读取失败')
    } finally {
      setLexiconLoading(false)
    }
  }

  const saveLexicon = async () => {
    if (!authToken) return
    const terms = Array.from(new Set(
      lexiconText
        .split(/[,，#\n]/)
        .map(item => item.trim())
        .filter(item => item.length >= 2)
    )).slice(0, 200)
    setLexiconLoading(true)
    setLexiconMessage('')
    try {
      const data = await api.updateAsrLexicon(authToken, terms)
      setLexiconText((data.terms || terms).join('\n'))
      setLexiconMessage(`已保存 ${data.terms?.length ?? terms.length} 个专有词`)
    } catch (e: any) {
      setLexiconMessage(e.message || '词库保存失败')
    } finally {
      setLexiconLoading(false)
    }
  }

  const runCommerceCard = async () => {
    if (!task?.taskId) return
    if (!authToken) {
      setShowAuthModal(true)
      return
    }
    if (!isVip) {
      setShowUpgradePopup(true)
      return
    }
    setCopywritingLoading(true)
    try {
      const r = await axios.post(`${API}/copywrite`, { taskId: task.taskId, outputLanguage: getAiOutputLanguage(i18n.language) }, {
        headers: getAuthHeaders(),
        timeout: 120000,
      })
      if (r.data.code === 0) {
        const nextTask = {
          ...task,
          copywriteAnalysis: r.data.data.analysis,
          copywriteTranscript: r.data.data.transcript,
          commerceCardStatus: 'completed'
        }
        setTask(nextTask)
        setCopywritingResult({ taskId: task.taskId, ...r.data.data })
        fetchHistory()
        fetchAiUsage()
      } else {
        setError(r.data.message)
      }
    } catch (e: any) {
      setError(e.response?.data?.message || e.message)
    } finally {
      setCopywritingLoading(false)
    }
  }

  const listify = (value: any): string[] => {
    if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean)
    if (typeof value === 'string' && value.trim()) return [value.trim()]
    return []
  }

  const getRewritePacks = (commerce: any, style?: string): any[] => {
    const packs = commerce?.rewritePacks && typeof commerce.rewritePacks === 'object'
      ? Object.values(commerce.rewritePacks) as any[]
      : []
    return style ? packs.filter(pack => (pack?.style || 'seed') === style) : packs
  }

  const getRewriteStyleLabel = (style = 'seed') => {
    const match = REWRITE_STYLES.find(item => item.id === style)
    return match ? t(match.labelKey) : style
  }

  const getRewritePlatformLabel = (platform = '') => {
    const match = REWRITE_PLATFORMS.find(item => item.id === platform)
    return match?.label || platform || t('platformPublishPack')
  }

  const getMissingRewritePackLabels = (item: HistoryItem) => {
    const analysis = getHistoryAnalysis(item)
    const packs = analysis?.rewritePacks && typeof analysis.rewritePacks === 'object' ? analysis.rewritePacks : {}
    return REWRITE_STYLES.flatMap(style =>
      REWRITE_PLATFORMS
        .filter(platform => !packs[`${platform.id}:${style.id}`])
        .map(platform => `${platform.label} · ${t(style.labelKey)}`)
    )
  }

  const formatRewritePack = (pack: any) => [
    `${getRewritePlatformLabel(pack.platform)} · ${getRewriteStyleLabel(pack.style || 'seed')}`,
    pack.title,
    pack.hook,
    pack.caption,
    pack.shortScript,
    pack.cta,
    listify(pack.hashtags).map(tag => `#${tag}`).join(' ')
  ].filter(Boolean).join(' | ')

  const buildCommerceCardExport = (commerce: any, format: 'md' | 'txt' = 'md', fallbackTitle?: string) => {
    const title = commerce.productName || fallbackTitle || task?.title || t('aiCommerceCardTitle')
    const section = (heading: string, items: string[]): [string, string[]] => [heading, items]
    const sections: Array<[string, string[]]> = [
      section(t('openingHook'), listify(commerce.openingHook)),
      section(t('aiSellingPoints'), listify(commerce.sellingPoints)),
      section(t('painPoints'), listify(commerce.painPoints)),
      section(t('conversionTriggers'), listify(commerce.conversionTriggers)),
      section(t('targetAudience'), listify(commerce.targetAudience)),
      section(t('pricePromotion'), listify(commerce.priceInfo)),
      section(t('contentStructure'), listify(commerce.contentStructure)),
      section(t('viralReason'), listify(commerce.viralReason)),
      section(t('platformFit'), listify(commerce.platformFit)),
      section(t('rewriteAngles'), listify(commerce.rewriteAngles)),
      section(t('aiScript'), listify(commerce.copyScript)),
      section(t('tags'), listify(commerce.tags).map(tag => `#${tag}`)),
      section(t('platformPublishPack'), getRewritePacks(commerce).map(formatRewritePack))
    ].filter(([, items]) => items.length > 0)

    if (format === 'txt') {
      return [
        `${t('aiCommerceCardTitle')}: ${title}`,
        '',
        ...sections.flatMap(([heading, items]) => [
          heading,
          ...items.map(item => `- ${item}`),
          ''
        ])
      ].join('\n')
    }

    return [
      `# ${title}`,
      '',
      ...sections.flatMap(([heading, items]) => [
        `## ${heading}`,
        ...items.map(item => `- ${item}`),
        ''
      ])
    ].join('\n')
  }

  const buildPublishPackExport = (commerce: any, format: 'md' | 'txt' = 'md', fallbackTitle?: string, style = rewriteStyle) => {
    const packs = getRewritePacks(commerce, style)
    const title = commerce.productName || fallbackTitle || task?.title || t('platformPublishPack')
    if (format === 'txt') {
      return [
        `${t('platformPublishPack')}: ${title}`,
        getRewriteStyleLabel(style),
        '',
        ...packs.map(formatRewritePack)
      ].join('\n')
    }
    return [
      `# ${title}`,
      '',
      `## ${t('platformPublishPack')} · ${getRewriteStyleLabel(style)}`,
      '',
      ...packs.map(pack => `- ${formatRewritePack(pack)}`)
    ].join('\n')
  }

  const toCsvCell = (value: any) => `"${String(value ?? '').replace(/\r?\n/g, ' / ').replace(/"/g, '""')}"`

  const buildPublishPackCsv = (items: Array<{ item?: HistoryItem, commerce: any }>, style = rewriteStyle) => {
    const headers = [
      t('title'),
      t('platform'),
      t('materialGroup'),
      t('platformPublishPack'),
      'Style',
      'Pack Title',
      t('openingHook'),
      'Caption',
      t('aiScript'),
      'CTA',
      t('tags'),
      'URL'
    ]
    const rows = items.flatMap(({ item, commerce }) => {
      const materialTitle = item?.title || commerce.productName || ''
      return getRewritePacks(commerce, style).map(pack => [
        materialTitle,
        item?.platform ? getPlatformLabel(item.platform) : '',
        item?.groupName || '',
        getRewritePlatformLabel(pack.platform),
        getRewriteStyleLabel(pack.style || style),
        pack.title || '',
        pack.hook || '',
        pack.caption || '',
        pack.shortScript || '',
        pack.cta || '',
        listify(pack.hashtags).map(tag => `#${tag}`).join(' '),
        item?.url || ''
      ])
    })
    return [headers, ...rows].map(row => row.map(toCsvCell).join(',')).join('\n')
  }

  const buildCommerceCardCsv = (items: Array<{ item?: HistoryItem, commerce: any }>) => {
    const headers = [
      t('title'),
      t('platform'),
      t('materialGroup'),
      t('aiCommerceCardTitle'),
      t('openingHook'),
      t('aiSellingPoints'),
      t('painPoints'),
      t('conversionTriggers'),
      t('targetAudience'),
      t('pricePromotion'),
      t('contentStructure'),
      t('viralReason'),
      t('platformFit'),
      t('rewriteAngles'),
      t('aiScript'),
      t('tags'),
      t('platformPublishPack'),
      'URL'
    ]
    const rows = items.map(({ item, commerce }) => [
      item?.title || commerce.productName || '',
      item?.platform ? getPlatformLabel(item.platform) : '',
      item?.groupName || '',
      commerce.productName || '',
      listify(commerce.openingHook).join(' | '),
      listify(commerce.sellingPoints).join(' | '),
      listify(commerce.painPoints).join(' | '),
      listify(commerce.conversionTriggers).join(' | '),
      listify(commerce.targetAudience).join(' | '),
      listify(commerce.priceInfo).join(' | '),
      listify(commerce.contentStructure).join(' | '),
      listify(commerce.viralReason).join(' | '),
      listify(commerce.platformFit).join(' | '),
      listify(commerce.rewriteAngles).join(' | '),
      listify(commerce.copyScript).join(' | '),
      listify(commerce.tags).map(tag => `#${tag}`).join(' '),
      getRewritePacks(commerce).map(formatRewritePack).join(' || '),
      item?.url || ''
    ])
    return [headers, ...rows].map(row => row.map(toCsvCell).join(',')).join('\n')
  }

  const downloadUtf8TextFile = (text: string, filename: string) => {
    // Add BOM so Windows Notepad/Excel-like viewers do not misread CJK text as ANSI.
    const content = `\uFEFF${text.replace(/\n/g, '\r\n')}`
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = filename
    a.click()
    URL.revokeObjectURL(objectUrl)
  }

  const exportCommerceCard = (commerce: any, format: 'md' | 'txt' | 'csv' | 'pack' | 'packCsv') => {
    if (format === 'pack') {
      if (getRewritePacks(commerce, rewriteStyle).length === 0) {
        setError(t('noItemsNeedRewritePacks'))
        return
      }
      const text = buildPublishPackExport(commerce, 'md')
      const filename = `${(commerce.productName || task?.title || 'publish-packs').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)}-packs.md`
      downloadUtf8TextFile(text, filename)
      return
    }
    if (format === 'packCsv') {
      if (getRewritePacks(commerce, rewriteStyle).length === 0) {
        setError(t('noItemsNeedRewritePacks'))
        return
      }
      const text = buildPublishPackCsv([{ commerce }], rewriteStyle)
      const filename = `${(commerce.productName || task?.title || 'publish-packs').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)}-packs-${rewriteStyle}.csv`
      downloadUtf8TextFile(text, filename)
      return
    }
    const text = format === 'csv'
      ? buildCommerceCardCsv([{ commerce }])
      : buildCommerceCardExport(commerce, format)
    const filename = `${(commerce.productName || task?.title || 'commerce-card').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)}.${format}`
    downloadUtf8TextFile(text, filename)
  }

  const copyCommerceCard = (commerce: any, kind: 'card' | 'script' | 'tags') => {
    if (kind === 'card') {
      clip(buildCommerceCardExport(commerce, 'md'), 'commerce-card')
      return
    }
    if (kind === 'script') {
      clip(commerce.copyScript || '', 'commerce-script')
      return
    }
    const tags = listify(commerce.tags).map(tag => `#${tag}`).join(' ')
    clip(tags, 'commerce-tags')
  }

  const rewriteCommerceCard = async (commerce: any, platform: string, style = rewriteStyle) => {
    if (!task?.taskId) return
    if (!authToken) {
      setShowAuthModal(true)
      return
    }
    if (!isVip) {
      setShowUpgradePopup(true)
      return
    }
    const key = `${platform}:${style}`
    setRewriteLoadingKey(key)
    try {
      const r = await axios.post(`${API}/copywrite/rewrite`, {
        taskId: task.taskId,
        platform,
        style,
        outputLanguage: getAiOutputLanguage(i18n.language)
      }, {
        headers: getAuthHeaders(),
        timeout: 120000,
      })
      if (r.data.code === 0) {
        const nextAnalysis = r.data.data.analysis || {
          ...commerce,
          rewritePacks: {
            ...(commerce.rewritePacks || {}),
            [key]: r.data.data.pack
          }
        }
        setTask(prev => prev ? { ...prev, copywriteAnalysis: nextAnalysis } : prev)
        setCopywritingResult((prev: any) => prev?.taskId === task.taskId ? { ...prev, analysis: nextAnalysis } : prev)
        fetchHistory()
        fetchAiUsage()
      } else {
        setError(r.data.message)
      }
    } catch (e: any) {
      setError(e.response?.data?.message || e.message)
    } finally {
      setRewriteLoadingKey('')
    }
  }

  const generateSelectedRewritePacks = async (platform: string, style = rewriteStyle) => {
    if (!authToken) {
      setShowAuthModal(true)
      return
    }
    if (!isVip) {
      setShowUpgradePopup(true)
      return
    }
    const platforms = platform === 'all' ? REWRITE_PLATFORMS.map(item => item.id) : [platform]
    const styles = style === 'all' ? REWRITE_STYLES.map(item => item.id) : [style]
    const jobs = history.flatMap(item => {
      const commerce = getHistoryAnalysis(item)
      if (!selectedTasks.has(item.taskId) || !commerce) return []
      return styles.flatMap(styleId =>
        platforms
          .filter(platformId => !commerce.rewritePacks?.[`${platformId}:${styleId}`])
          .map(platformId => ({ item, platform: platformId, style: styleId }))
      )
    })
    if (jobs.length === 0) {
      setError(t('noItemsNeedRewritePacks'))
      return
    }

    setBatchRewriteLoadingKey(`${platform}:${style}`)
    setBatchCardMessage('')
    setBatchCardProgress({ done: 0, total: jobs.length })
    let success = 0
    try {
      for (let i = 0; i < jobs.length; i++) {
        const { item, platform: platformId, style: styleId } = jobs[i]
        const r = await axios.post(`${API}/copywrite/rewrite`, {
          taskId: item.taskId,
          platform: platformId,
          style: styleId,
          outputLanguage: getAiOutputLanguage(i18n.language)
        }, {
          headers: getAuthHeaders(),
          timeout: 120000,
        })
        if (r.data.code === 0) {
          success += 1
          setHistory(prev => prev.map(h => h.taskId === item.taskId ? {
            ...h,
            aiAnalysis: r.data.data.analysis,
            copywriteAnalysis: r.data.data.analysis,
          } : h))
        }
        setBatchCardProgress({ done: i + 1, total: jobs.length })
      }
      await fetchHistory()
      fetchAiUsage()
      setBatchCardMessage(success > 0 ? t('batchRewritePacksDone', { count: success }) : '')
    } catch (e: any) {
      await fetchHistory()
      setError(e.response?.data?.message || e.message)
    } finally {
      setBatchRewriteLoadingKey('')
    }
  }

  const exportSelectedCommerceCards = (format: 'md' | 'txt' | 'csv' | 'pack' | 'packCsv') => {
    const selectedItems = history.filter(item => selectedTasks.has(item.taskId) && getHistoryAnalysis(item))
    if (selectedItems.length === 0) {
      setError(t('noAiCardsToExport'))
      return
    }
    if (format === 'pack') {
      const itemsWithPacks = selectedItems.filter(item => getRewritePacks(getHistoryAnalysis(item), rewriteStyle).length > 0)
      if (itemsWithPacks.length === 0) {
        setError(t('noItemsNeedRewritePacks'))
        return
      }
      const text = itemsWithPacks
        .map(item => buildPublishPackExport(getHistoryAnalysis(item), 'md', item.title || item.url || item.taskId, rewriteStyle))
        .join('\n\n---\n\n')
      downloadUtf8TextFile(text, `orange-publish-packs-${itemsWithPacks.length}-${rewriteStyle}.md`)
      return
    }
    if (format === 'packCsv') {
      const itemsWithPacks = selectedItems.filter(item => getRewritePacks(getHistoryAnalysis(item), rewriteStyle).length > 0)
      if (itemsWithPacks.length === 0) {
        setError(t('noItemsNeedRewritePacks'))
        return
      }
      const text = buildPublishPackCsv(itemsWithPacks.map(item => ({ item, commerce: getHistoryAnalysis(item) })), rewriteStyle)
      downloadUtf8TextFile(text, `orange-publish-packs-${itemsWithPacks.length}-${rewriteStyle}.csv`)
      return
    }
    if (format === 'csv') {
      const text = buildCommerceCardCsv(selectedItems.map(item => ({ item, commerce: getHistoryAnalysis(item) })))
      downloadUtf8TextFile(text, `orange-commerce-cards-${selectedItems.length}.csv`)
      return
    }
    const separator = format === 'md' ? '\n\n---\n\n' : '\n\n==============================\n\n'
    const text = selectedItems
      .map(item => buildCommerceCardExport(getHistoryAnalysis(item), format, item.title || item.url || item.taskId))
      .join(separator)
    downloadUtf8TextFile(text, `orange-commerce-cards-${selectedItems.length}.${format}`)
  }

  const generateSelectedCommerceCards = async () => {
    if (!authToken) {
      setShowAuthModal(true)
      return
    }
    if (!isVip) {
      setShowUpgradePopup(true)
      return
    }
    const selectedItems = history.filter(item =>
      selectedTasks.has(item.taskId) &&
      item.status === 'completed' &&
      !getHistoryAnalysis(item)
    )
    if (selectedItems.length === 0) {
      setError(t('noItemsNeedAiCards'))
      return
    }

    setBatchCardGenerating(true)
    setBatchCardMessage('')
    setBatchCardProgress({ done: 0, total: selectedItems.length })
    let success = 0
    try {
      for (let i = 0; i < selectedItems.length; i++) {
        const item = selectedItems[i]
        const r = await axios.post(`${API}/copywrite`, {
          taskId: item.taskId,
          outputLanguage: getAiOutputLanguage(i18n.language)
        }, {
          headers: getAuthHeaders(),
          timeout: 120000,
        })
        if (r.data.code === 0) {
          success += 1
          setHistory(prev => prev.map(h => h.taskId === item.taskId ? {
            ...h,
            aiAnalysis: r.data.data.analysis,
            copywriteAnalysis: r.data.data.analysis,
            tags: r.data.data.analysis?.tags || h.tags
          } : h))
        }
        setBatchCardProgress({ done: i + 1, total: selectedItems.length })
      }
      await fetchHistory()
      fetchAiUsage()
      setBatchCardMessage(success > 0 ? t('batchAiCardsDone', { count: success }) : '')
    } catch (e: any) {
      await fetchHistory()
      setError(e.response?.data?.message || e.message)
    } finally {
      setBatchCardGenerating(false)
    }
  }

  const handleAuthSuccess = (token: string, user: any) => {
    setAuthToken(token)
    setAuthUser(user)
    localStorage.setItem('orange_token', token)
    localStorage.setItem('orange_user', JSON.stringify(user))
  }

  // 忘记Password - Send重置邮件
  const handleForgotPassword = async () => {
    if (!resetEmail) return
    setResetPwdLoading(true)
    setResetPwdMsg('')
    try {
      const result = await api.forgotPassword(resetEmail)
      if (import.meta.env.DEV && result.resetToken) {
        // Demo mode：直接Showtoken让用户重置
        setResetPwdToken(result.resetToken)
        setResetPwdStep(true)
        setResetPwdMsg(t('passwordResetSuccess'))
      } else {
        setResetPwdMsg(t('checkEmail'))
      }
    } catch (err: any) {
      setResetPwdMsg(err.message || t('operationFailed'))
    } finally {
      setResetPwdLoading(false)
    }
  }

  // 重置Password
  const handleResetPassword = async () => {
    if (!resetPwd || !resetPwdToken) return
    if (resetPwd.length < 6) {
      setResetPwdMsg(t('passwordMinLength'))
      return
    }
    if (resetPwd !== resetPwdConfirm) {
      setResetPwdMsg(t('passwordMismatch'))
      return
    }
    setResetPwdLoading(true)
    setResetPwdMsg('')
    try {
      await api.resetPassword(resetPwdToken, resetPwd)
      // 重置成功后清除本地token，强制重新登录
      localStorage.removeItem('orange_token')
      localStorage.removeItem('orange_user')
      setAuthToken(null)
      setAuthUser(null)
      setResetPwdMsg(t('passwordResetSuccess'))
      setTimeout(() => {
        setShowResetPwd(false)
        setResetPwdStep(false)
        setResetEmail('')
        setResetPwd('')
        setResetPwdConfirm('')
        setResetPwdToken('')
        setResetPwdMsg('')
        // 自动弹出登录框
        setShowAuthModal(true)
      }, 2000)
    } catch (err: any) {
      setResetPwdMsg(err.message || t('operationFailed'))
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

  // 从Text中Extract所有Link
  const extractUrls = (text: string): string[] => {
    // 更宽松的 URL 正则
    const urlRegex = /https?:\/\/[^\s\n,，、；;）)】"']+/g
    
    let matches = text.match(urlRegex) || []
    
    // Clear和补全
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

  // ProcessPaste事件 - AutoExtractLink
  const [batchQueue, setBatchQueue] = useState<Array<{url: string, status: string, progress: number, title?: string}>>([])
  const savedBatchTasks = useRef<Set<string>>(new Set())
  const [batchIndex, setBatchIndex] = useState(0)
  const [saveLocation, setSaveLocation] = useState<string>('album')

  // ReadSave的LocationPreference
  useEffect(() => {
    const saved = localStorage.getItem('xiaodianlv_saveLocation')
    if (saved) setSaveLocation(saved)
  }, [])

  // Save Location SaveLocationPreference
  const handleLocationChange = (loc: string) => {
    setSaveLocation(loc)
    localStorage.setItem('xiaodianlv_saveLocation', loc)
  }

  const locationLabels: Record<string, { label: string; icon: typeof Smartphone; desc: string }> = {
    album: { label: '手机相册', icon: Smartphone, desc: '默认Save到相册' },
    downloads: { label: t('saveToDownloads'), icon: HardDrive, desc: '' },
    desktop: { label: t('saveToDesktop'), icon: HardDrive, desc: '' },
    documents: { label: 'Documents', icon: FolderOpen, desc: 'Save到DocumentsFile夹' },
  }

  // Poll task status
  useEffect(() => {
    if (!task || ['completed', 'error'].includes(task.status)) return
    
    // 保存 taskId 到 localStorage（用于后台恢复）
    localStorage.setItem('orange_active_task', task.taskId)
    
    const t = setInterval(async () => {
      try {
        const r = await axios.get(`${API}/status/${task.taskId}`, { headers: getAuthHeaders() })
        if (r.data.data) {
          setTask(r.data.data)
          if (['completed', 'error'].includes(r.data.data.status)) { 
            clearInterval(t)
            localStorage.removeItem('orange_active_task')
            fetchHistory()
          }
        }
      } catch {}
    }, 1500)
    return () => clearInterval(t)
  }, [task?.taskId, authToken])

  // 画质短边(竖屏视频高宽颠倒,1080x1920是1080p不是2K)
  const qualityShortEdge = (q: {width: number, height: number}) => Math.min(q.width || 0, q.height || 0)

  // 画质自动选择：获取到可用画质后，自动选最佳（VIP→4K/2K，免费→720p）
  useEffect(() => {
    if (availableQualities.length === 0) {
      setAutoQuality(null)
      return
    }
    // 如果用户已手动选择画质，不覆盖
    if (qualityManuallySet.current) return
    const maxShortEdge = isVip ? 99999 : 720
    const best = availableQualities
      .filter(q => qualityShortEdge(q) <= maxShortEdge)
      .sort((a, b) => qualityShortEdge(b) - qualityShortEdge(a))[0]
    if (best) {
      const label = best.qualityLabel || `${qualityShortEdge(best)}p`
      setAutoQuality({ label, height: qualityShortEdge(best) })
      // 使用统一格式 height<=N，与手动选择保持一致
      const shortEdge = qualityShortEdge(best)
      setPendingQuality(`height<=${shortEdge}`)
    }
  }, [availableQualities, isVip])

  // 页面重新可见时恢复任务状态
  useEffect(() => {
    const savedTaskId = localStorage.getItem('orange_active_task')
    if (savedTaskId && (!task || task.taskId !== savedTaskId)) {
      // 恢复之前未完成的任务
      axios.get(`${API}/status/${savedTaskId}`, { headers: getAuthHeaders() }).then(r => {
        if (r.data.data && !['completed', 'error'].includes(r.data.data.status)) {
          setTask(r.data.data)
        } else {
          localStorage.removeItem('orange_active_task')
        }
      }).catch(() => localStorage.removeItem('orange_active_task'))
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        const tid = localStorage.getItem('orange_active_task')
        if (tid) {
          axios.get(`${API}/status/${tid}`, { headers: getAuthHeaders() }).then(r => {
            if (r.data.data) setTask(r.data.data)
          }).catch(() => {})
        }
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [authToken])

  // 下载完成提示音 — 清脆明亮的叮
  const playNotificationSound = () => {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
      const now = ctx.currentTime
      
      // 主音 2100Hz + 微偏 2130Hz — 清脆明亮钟鸣感
      for (const freq of [2100, 2130]) {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = freq
        gain.gain.setValueAtTime(0, now)
        gain.gain.linearRampToValueAtTime(freq === 2100 ? 0.35 : 0.2, now + 0.005)
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.65)
        osc.connect(gain).connect(ctx.destination)
        osc.start(now)
        osc.stop(now + 0.65)
      }
      
      // 高频泛音 3100Hz — 光泽层
      const oscH = ctx.createOscillator()
      const gainH = ctx.createGain()
      oscH.type = 'sine'
      oscH.frequency.value = 3100
      gainH.gain.setValueAtTime(0, now)
      gainH.gain.linearRampToValueAtTime(0.12, now + 0.005)
      gainH.gain.exponentialRampToValueAtTime(0.001, now + 0.35)
      oscH.connect(gainH).connect(ctx.destination)
      oscH.start(now)
      oscH.stop(now + 0.35)
      
      // 低频余韵 1050Hz — 悠长感
      const oscL = ctx.createOscillator()
      const gainL = ctx.createGain()
      oscL.type = 'sine'
      oscL.frequency.value = 1050
      gainL.gain.setValueAtTime(0, now + 0.08)
      gainL.gain.linearRampToValueAtTime(0.08, now + 0.12)
      gainL.gain.exponentialRampToValueAtTime(0.001, now + 0.65)
      oscL.connect(gainL).connect(ctx.destination)
      oscL.start(now + 0.08)
      oscL.stop(now + 0.65)
    } catch {}
  }

  // AutoDownload：当DownloadCompleted时AutoTriggerSave + PlayPrompt音
  // Use ref Track是否已AutoDownload过，AvoidDuplicateTrigger
  const autoDownloaded = useRef(false)
  const autoDownloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewingHistory = useRef(false)
  
  // ClearAutoDownload定时器
  const clearAutoDownload = () => {
    if (autoDownloadTimer.current) {
      clearTimeout(autoDownloadTimer.current)
      autoDownloadTimer.current = null
    }
  }
  
  useEffect(() => {
    // 每次 task 变化时，重置AutoDownloadMark
    autoDownloaded.current = false
    clearAutoDownload()
    if (previewingHistory.current) {
      previewingHistory.current = false
      autoDownloaded.current = true
      return
    }
    
    if (task?.status === 'completed' && task.downloadUrl && !downloading && !autoDownloaded.current) {
      autoDownloaded.current = true
      // PlayPrompt音
      playNotificationSound()
      // ShowCompleted通知
      showDownloadComplete(task.taskId, task.title || 'Download', false).catch(console.error)
      // 更新游客剩余次数
      if (!authToken && remainingDownloads > 0) {
        setRemainingDownloads(Math.max(0, remainingDownloads - 1))
      }
      // 延迟 500ms 后AutoDownload
      const downloadUrl = task.downloadUrl
      autoDownloadTimer.current = setTimeout(() => {
        setDownloading(true)
        // iOS Safari: 不触发自动下载，让用户通过 inline video 长按保存
        if (isIOS() && !task.directLink) {
          setShowIosGuide(true)
          setDownloading(false)
          return
        }
        shareFile(downloadUrl, task.title || 'video').finally(() => {
          setDownloading(false)
          // DownloadCompleted后重新获取Use量
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

  const fetchHistory = useCallback(async (append = false) => {
    try {
      const params: any = { pageSize: historyPageSize };
      const hasFilters = historySearch || historyPlatformFilter !== 'all' || historyGroupFilter !== 'all' || historyTagFilter !== 'all' || historyAiOnly || historyPackOnly || historyPackTodoOnly;
      
      if (hasFilters) {
        params.page = append ? historyPage : 1;
        if (historySearch) params.search = historySearch;
        if (historyPlatformFilter !== 'all') params.platform = historyPlatformFilter;
        if (historyGroupFilter !== 'all') params.group = historyGroupFilter;
        if (historyTagFilter !== 'all') params.tag = historyTagFilter;
        if (historyAiOnly) params.aiOnly = '1';
        if (historyPackOnly || historyPackTodoOnly) params.publishPackOnly = '1';
      }
      
      const r = await axios.get(`${API}/history`, { headers: getAuthHeaders(), params }); 
      const data = r.data.data || {};
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      
      if (append) {
        setHistory(prev => [...prev, ...tasks]);
      } else {
        setHistory(tasks);
        setHistoryPage(1);
      }
      
      const serverFavorites = tasks.filter((item: HistoryItem) => item.isFavorite).map((item: HistoryItem) => item.taskId);
      if (serverFavorites.length > 0) {
        setFavorites(prev => { const merged = new Set([...prev, ...serverFavorites]); localStorage.setItem('orange_favorites', JSON.stringify([...merged])); return merged; });
      }
      setHistoryTotal(data.total ?? tasks.length);
      setHistoryHasMore(data.hasMore ?? false);
      if (!append) setHistoryPage(1);
    } catch {}
  }, [authToken, historySearch, historyPlatformFilter, historyGroupFilter, historyTagFilter, historyAiOnly, historyPackOnly, historyPackTodoOnly, historyPage, historyPageSize])
  useEffect(() => { fetchHistory() }, [fetchHistory])

  // 独立加载 meta（不受筛选影响，始终显示全量统计）
  const fetchHistoryMeta = useCallback(async () => {
    try {
      const r = await axios.get(`${API}/history/meta`, { headers: getAuthHeaders() });
      if (r.data?.data) setHistoryMeta(r.data.data);
    } catch {}
  }, [authToken])
  useEffect(() => { fetchHistoryMeta() }, [fetchHistoryMeta])

  const loadMoreHistory = async () => {
    if (historyLoadingMore) return;
    setHistoryLoadingMore(true);
    setHistoryPage(p => p + 1);
    await fetchHistory(true);
    setHistoryLoadingMore(false);
  }

  const handleUrlChange = (value: string) => {
    // 检测是否有嵌入文字的Link
    const urls = extractUrls(value)
    const finalUrl = urls.length === 1 ? urls[0] : value.trim()
    const platform = detectPlatform(finalUrl)
    
    setSharedEntrySource('')
    setUrl(finalUrl)
    setDetected(platform)
    setPendingQuality('')
    qualityManuallySet.current = false
    
    // Fetch video qualities in background for inline quality selector
    if (finalUrl && !batchMode) {
      fetchVideoQualities(finalUrl).catch(() => {})
    }
  }

  // ClickPaste按钮 - 从剪贴板Paste
  const handlePasteClick = async () => {
    try {
      const text = await navigator.clipboard.readText()
      const urls = text.match(/https?:\/\/[^\s\n,，、；;）)】"']+/g) || []
      setSharedEntrySource('')
      if (urls.length > 1) {
        if (!isVip) { setShowUpgradePopup(true); return }
        setBatchMode(true)
        setBatchUrls(urls.map((url, idx) => `${idx + 1}. ${url}`).join('\n'))
      } else if (urls.length === 1) {
        setUrl(urls[0])
        setDetected(detectPlatform(urls[0]))
        setPendingQuality('')
        qualityManuallySet.current = false
        fetchVideoQualities(urls[0]).catch(() => {})
      } else if (text) {
        setUrl(text)
        setDetected(detectPlatform(text))
        setPendingQuality('')
        qualityManuallySet.current = false
        fetchVideoQualities(text).catch(() => {})
      }
    } catch (e) {
      console.error('[paste] failed:', e)
    }
  }

  // 单个输入框PasteProcess - AutoExtractLink
  const handleSinglePaste = (e: React.ClipboardEvent) => {
    const pastedText = e.clipboardData.getData('text')
    const urls = pastedText.match(/https?:\/\/[^\s\n,，、；;）)】"']+/g) || []
    if (urls.length > 1) {
      // 多个Link → 切换批量模式（仅VIP）
      e.preventDefault()
      if (!isVip) {
        setShowUpgradePopup(true)
        return
      }
      setBatchMode(true)
      setBatchUrls(urls.map((url, idx) => `${idx + 1}. ${url}`).join('\n'))
    } else if (urls.length === 1) {
      // 单个Link → ExtractLink，去除文字
      e.preventDefault()
      setUrl(urls[0])
      setDetected(detectPlatform(urls[0]))
      setPendingQuality('')
      qualityManuallySet.current = false
      fetchVideoQualities(urls[0]).catch(() => {})
    }
    // 没有Link则Use默认Paste行为
  }

  // 批量输入变化Process - AutoExtractLink
  const handleBatchChange = (value: string) => {
    // 先在每个 https:// 前插入换行（除了第一个）
    let processed = value.replace(/(?<!^)https:\/\//g, '\nhttps://')
    
    // Extract所有Link
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
    setQualitiesLoading(true)
    try {
      const r = await axios.post(`${API}/video-info`, { url: videoUrl }, { timeout: 30000 })
      if (r.data.code === 0 && r.data.data.qualities && r.data.data.qualities.length > 0) {
        // 后端返回实际可用画质，前端只过滤掉过低画质（<480p）
        const minDisplayHeight = 480
        const qualities = r.data.data.qualities
          .filter((q: any) => q.height >= minDisplayHeight && q.hasVideo)
          .map((q: any) => {
            let label = `${q.height}p`
            if (q.height >= 2160) label = '4K'
            else if (q.height >= 1440) label = '2K'
            else if (q.height >= 1080) label = '1080p'
            else if (q.height >= 720) label = '720p'
            return { ...q, qualityLabel: label }
          })
          .sort((a: any, b: any) => b.height - a.height);
        setAvailableQualities(qualities)
        setPendingUrl(videoUrl)
        setQualitiesLoading(false)
        return true
      }
    } catch (e) {
      console.log('[quality] Failed to fetch qualities')
    }
    setAvailableQualities([])
    setQualitiesLoading(false)
    return false
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const extensionAction = params.get('action')
    const sharedUrl = params.get('url')
    if (!sharedUrl && !extensionAction) return

    if (extensionAction === 'login' && !authToken) {
      setShowAuthModal(true)
    } else if (extensionAction === 'upgrade') {
      if (authToken) setShowSubscription(true)
      else setShowAuthModal(true)
    } else if (extensionAction === 'workbench') {
      setShowHistory(true)
    }

    if (sharedUrl) {
      const sharedPlatform = params.get('platform')
      const shouldAutoStart = params.get('autostart') === '1'
      setUrl(sharedUrl)
      setDetected(sharedPlatform || detectPlatform(sharedUrl))
      setSharedEntrySource(params.get('source') === 'extension' ? 'extension' : 'share')
      setSharedAutoStart(shouldAutoStart)
      fetchVideoQualities(sharedUrl).catch(() => {})
    }

    const clean = new URL(window.location.href)
    clean.searchParams.delete('url')
    clean.searchParams.delete('source')
    clean.searchParams.delete('platform')
    clean.searchParams.delete('autostart')
    clean.searchParams.delete('action')
    window.setTimeout(() => {
      window.history.replaceState({}, '', clean.toString())
    }, 0)
  }, [])

  const handleSubmit = async () => {
    if (loading) return  // 防重复提交
    autoDownloaded.current = false

    // 交由后端 IP 限制判断，不做本地预判（防止清缓存绕过）
    
    // 批量模式
    if (batchMode) {
      const urls = batchUrls.split('\n')
        .map(u => u.trim())
        .filter(u => u)
        .map(u => u.replace(/^\d+\.\s*/, ''))
        .map(u => extractUrls(u)[0] || u)
        .filter(u => u)
      if (urls.length === 0) { setError(t('enterVideoLink')); return }
      
      // 批量下载仅限VIP
      if (!isVip) {
        setShowUpgradePopup(true);
        return;
      }
      
      // 检查第一个Link是否已Download
      const firstUrl = urls[0]
      const dupItem = history.find(h => h.url === firstUrl)
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
    if (!url.trim()) { setError(t('enterVideoLink')); return }
    
    // 正在获取画质信息 → 提示等待
    if (qualitiesLoading) {
      setError(t('fetchingQualities'))
      return
    }
    
    // 如果还没有自动选择画质（API在加载中），继续用默认quality参数
    doSingleDownload()
    
    // 检查是否已Download
    const dupItem = history.find(h => h.url === url.trim())
    if (dupItem && dupItem.status === 'completed') {
      setDupUrl(url.trim())
      setPendingDownload(() => () => doSingleDownload())
      setShowDupConfirm(true)
      return
    }
    doSingleDownload()
  }

  const doBatchDownload = async (urls: string[]) => {
    if (!isVip) { setShowUpgradePopup(true); return }
    const requestOptions = [...selected, ...selectedAiTools]
    const requestNeedAsr = selectedAiTools.size > 0
    const requestTargetLang = selectedAiTools.has('translate_subtitle') ? (targetLang || 'en') : null

    const cleanUrls = urls.map(u => u.replace(/^\d+\.\s*/, '').trim()).filter(u => u)
    setBatchQueue(cleanUrls.map(u => ({ url: u, status: 'pending', progress: 0 })))
    setLoading(true); setError('')

    try {
      const r = await axios.post(`${API}/download/batch`, {
        urls: cleanUrls,
        quality: batchQuality || pendingQuality || quality,
        options: requestOptions,
        needAsr: requestNeedAsr,
        asrLanguage,
        targetLang: requestTargetLang,
        outputLanguage: getAiOutputLanguage(i18n.language),
      }, { timeout: 30000, headers: authToken ? { Authorization: `Bearer ${authToken}` } : {} })

      const { batchId: bid, tasks } = r.data.data
      setBatchId(bid)
      savedBatchTasks.current.clear()
      setBatchQueue(tasks.map((t: any) => ({ url: t.url, status: t.status, progress: 0 })))

      // 后台轮询批量状态
      pollBatchStatus(bid)
    } catch (e: any) {
      setError(getErrorMessage(e.response?.data?.message || e.message || t('errorDefault')))
      setLoading(false)
    }
  }

  const pollBatchStatus = (bid: string) => {
    const timer = setInterval(async () => {
      try {
        const r = await axios.get(`${API}/download/batch/${bid}`, {
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
        })
        const { status, tasks: batchTasks } = r.data.data
        setBatchQueue(batchTasks.map((t: any) => ({
          url: t.url,
          status: t.status,
          progress: 0,
          title: t.title || '',
          downloadUrl: t.downloadUrl || '',
        })))
        // 批量任务完成时自动保存（每个任务只保存一次）
        batchTasks.forEach((t: any) => {
          if (t.status === 'completed' && t.downloadUrl && !savedBatchTasks.current.has(t.taskId)) {
            savedBatchTasks.current.add(t.taskId)
            shareFile(t.downloadUrl, t.title || 'video')
          }
        })
        if (status === 'completed') {
          clearInterval(timer)
          setBatchId(null)
          setLoading(false)
          fetchHistory()
          // PWA notification
          const doneCount = batchTasks.filter((t: any) => t.status === 'completed').length
          const totalCount = batchTasks.length
          showDownloadComplete(bid, `批量下载完成 ${doneCount}/${totalCount}`, false)
        }
      } catch { /* ignore */ }
    }, 2000)
  }

  const doSingleDownload = async () => {
    // 交由后端 IP 限制判断
    setLoading(true); setError('')
    
    // 使用用户选择的画质
    const downloadQuality = pendingQuality
    const requestOptions = [...selected, ...selectedAiTools]
    const requestNeedAsr = selectedAiTools.size > 0
    const requestTargetLang = selectedAiTools.has('translate_subtitle') ? (targetLang || 'en') : null
    
    try {
      const r = await axios.post(`${API}/download`, {
        url: url.trim(), platform: detected || 'auto',
        needAsr: requestNeedAsr, options: requestOptions, quality: downloadQuality, asrLanguage, targetLang: requestTargetLang, outputLanguage: getAiOutputLanguage(i18n.language)
      }, { timeout: 120000, headers: authToken ? { Authorization: `Bearer ${authToken}` } : {} })
      setTask(r.data.data);
      // 服务器返回 403 且提到次数用尽 → 弹升级提示
      if (r.data.code === 403 && (r.data.message || '').includes('下载次数')) {
        setShowUpgradePopup(true)
      }
      setPendingQuality('')  // 清空选择的画质
      qualityManuallySet.current = false
    } catch (e: any) {
      setError(getErrorMessage(e.code === 'ECONNABORTED' ? 'timeout' : (e.response?.data?.message || e.message || t('errorDefault'))))
    } finally { setLoading(false) }
  }

  const toggle = (o: string) => setSelected(prev => {
    const n = new Set(prev)
    n.has(o) && n.size > 1 ? n.delete(o) : n.add(o)
    return n
  })
  const toggleAiTool = (toolId: string) => {
    if (!authToken) {
      setShowAuthModal(true)
      return
    }
    if (!isVip) {
      setShowUpgradePopup(true)
      return
    }
    setSelectedAiTools(prev => {
      const next = new Set(prev)
      next.has(toolId) ? next.delete(toolId) : next.add(toolId)
      if (toolId === 'translate_subtitle' && !targetLang) setTargetLang('en')
      return next
    })
  }
  const del = async (id: string) => {
    try { await axios.delete(`${API}/tasks/${id}`, { headers: getAuthHeaders() }); fetchHistory(); if (task?.taskId === id) setTask(null) } catch (e) { setError('删除失败，请重试') }
  }
  const deleteSelected = async () => {
    if (selectedTasks.size === 0) return
    if (!confirm(t('deleteConfirm', { count: selectedTasks.size }))) return
    try {
      await Promise.all([...selectedTasks].map(id => axios.delete(`${API}/tasks/${id}`, { headers: getAuthHeaders() })))
      setSelectedTasks(new Set())
      fetchHistory()
    } catch {}
  }
  const toggleSelectAll = () => {
    selectedTasks.size === filteredHistory.length
      ? setSelectedTasks(new Set())
      : setSelectedTasks(new Set(filteredHistory.map(item => item.taskId)))
  }
  const selectPackTodoItems = () => {
    const packTodoIds = filteredHistory
      .filter(item => getHistoryAnalysis(item) && !isHistoryRewritePackComplete(item))
      .map(item => item.taskId)
    setSelectedTasks(new Set(packTodoIds))
  }
  const retryTask = async (item: HistoryItem) => {
    if (!item.url) return
    setLoading(true); setError('')
    try {
      let r;
      // 尝试Use断点续传 API
      if (item.taskId) {
        try {
          r = await axios.post(`${API}/download/${item.taskId}/retry`, {}, { timeout: 120000, headers: getAuthHeaders() });
          if (r?.data?.code === 0) {
            // 续传Success，获取新任务状态
            const newTaskId = r.data.data.taskId;
            // 轮询新任务状态
            const pollTask = async () => {
              const status = await axios.get(`${API}/status/${newTaskId}`, { headers: getAuthHeaders() });
              if (status.data.data?.status === 'completed') {
                setTask(status.data.data);
                fetchHistory();
                return;
              }
              if (status.data.data?.status === 'error') {
                setError(status.data.data.error || t('errorDefault'));
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
          // 续传 API 不可用，Use普通Download
          console.log('[retry] Retry API not available, using regular download');
        }
      }
      // 普通Download
      r = await axios.post(`${API}/download`, { url: item.url, platform: item.platform || 'auto', needAsr: false, options: ['video'] }, { timeout: 120000, headers: getAuthHeaders() })
      setTask(r.data.data)
    } catch (e: any) { setError(getErrorMessage(e.response?.data?.message || e.message)) }
    finally { setLoading(false) }
  }
  const clearAllHistory = async () => {
    try { await axios.delete(`${API}/history`, { headers: getAuthHeaders() }); fetchHistory(); setTask(null) } catch {}
  }
  const openSavedFile = (item: HistoryItem) => {
    if (!item.downloadUrl) {
      setError('历史文件已过期，请重新下载后预览')
      return
    }
    clearAutoDownload()
    previewingHistory.current = true
    setTask({
      ...(item as unknown as Task),
      status: item.status || 'completed',
      progress: 100,
      directLink: false
    })
  }
  const clip = async (text: string, id: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(id); setTimeout(() => setCopied(null), 3000) } catch {}
  }
  const formatFileSize = (bytes: number) => {
    if (!bytes || bytes <= 0) return ''
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`
    return `${(bytes / 1073741824).toFixed(2)} GB`
  }

  useEffect(() => {
    if (!sharedAutoStart || !url || loading) return
    setSharedAutoStart(false)
    handleSubmit()
  }, [sharedAutoStart, url, loading])

  const clearUrl = () => { setUrl(''); setDetected(''); setSharedEntrySource(''); setSharedAutoStart(false) }

  const isWorking = (s: string) => ['pending', 'parsing', 'processing', 'downloading', 'asr'].includes(s)
  const statusLabel = (s: string) => ({ pending: t('pending'), parsing: t('parsing'), downloading: t('downloading'), asr: t('speechRecognition'), completed: t('completed'), error: t('failed') }[s] || s)
  
  const getErrorMessage = (err: string) => {
    if (err.includes('视频号链接已过期')) return '⚠️ 视频号链接已过期，请重新获取分享链接'
    if (err.includes('无法解析视频号')) return '⚠️ 无法识别视频号链接，请确认格式'
    if (err.includes('TikHub API error')) return t('errorApiService')
    if (err.includes('Sign in to confirm')) return t('errorYoutubeVerify')
    if (err.includes('No download URL')) return t('errorNotAvailable')
    if (err.includes('timeout')) return t('errorTimeoutMsg')
    if (err.includes('network')) return t('errorNetwork')
    if (err.includes('403') || err.includes('Forbidden')) return t('errorAccessDenied')
    if (err.includes('404') || err.includes('Not Found')) return t('errorNotFound')
    return `❌ ${err || t('errorDefault')}`
  }
  const getOptionLabel = (labelKey: string) => t(labelKey)
  const getPlatformLabel = (id: string) => {
    const p = PLATFORMS.find(p => p.id === id)
    return p ? t(p.labelKey as any) || p.labelFallback : ''
  }
  const formatAdminDate = (date: string) => {
    if (!date) return ''
    const [, month, day] = date.split('-')
    return month && day ? `${month}/${day}` : date
  }
  const formatAdminGeneratedAt = (value?: number) => {
    if (!value) return ''
    return new Date(value).toLocaleString(
      i18n.language === 'zh-CN' ? 'zh-CN' : i18n.language === 'ja' ? 'ja-JP' : i18n.language === 'ko' ? 'ko-KR' : 'en-US',
      { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    )
  }
  const sumAdminSeries = (items: Array<{ count?: number }> = []) => items.reduce((sum, item) => sum + (Number(item.count) || 0), 0)
  const maxAdminCount = (items: Array<{ count?: number }> = []) => Math.max(1, ...items.map(item => Number(item.count) || 0))
  const adminBarWidth = (count: number, max: number) => `${Math.max(6, Math.round(((Number(count) || 0) / Math.max(max, 1)) * 100))}%`

  if (showSubscription && authToken) {
    return <SubscriptionPage token={authToken} onBack={() => setShowSubscription(false)} onLogout={handleLogout} />
  }

  return (
    <div className={`min-h-screen ${isDark ? 'bg-dark-bg text-white' : 'bg-light-bg text-light-text'}`}>
      {/* 横屏保护遮罩 - PWA兜底 */}
      <div id="rotation-guard" className="fixed inset-0 z-[9999] bg-slate-900 hidden flex-col items-center justify-center gap-4">
        <div className="text-5xl">📱</div>
        <p className="text-white text-lg font-medium">{t('rotateToPortrait')}</p>
        <p className="text-slate-400 text-sm">{t('landscapeWarning')}</p>
        <div className="mt-4 animate-bounce">
          <svg className="w-8 h-8 text-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </div>
      </div>
      {/* 背景光晕 - 橙色Theme */}
      <div className={`fixed inset-0 pointer-events-none ${isDark ? '' : 'opacity-30'}`}>
        <div className={`absolute top-0 left-1/2 -translate-x-1/2 w-96 h-96 rounded-full blur-3xl ${isDark ? 'bg-blue-500/10' : 'bg-orange-200'}`} />
        <div className={`absolute bottom-0 left-0 w-72 h-72 rounded-full blur-3xl ${isDark ? 'bg-blue-500/10' : 'bg-cyan-100'}`} />
      </div>

      <div className="relative">
        {/* Header */}
        <header data-testid="app-header" className="max-w-2xl mx-auto px-6 pt-12 sm:pt-20 pb-6 sm:pb-10 text-center">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-full overflow-hidden shadow-lg shadow-orange/25 flex-shrink-0">
              <img src="/logo.png" alt="Orange" className="w-full h-full object-cover" />
            </div>
            <div className="text-left">
              <h1 className={`text-xl font-bold ${isDark ? 'text-white' : 'text-light-text'}`}>{t('appName')}</h1>
              <p className={`text-xs font-medium tracking-wide ${isDark ? 'text-orange/80' : 'text-orange-600'}`}>{t('appTagline')}</p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {/* Theme切换 */}
              <button
                onClick={toggleTheme}
                className={`p-2 rounded-lg transition ${isDark ? 'text-slate-300 hover:text-yellow-400' : 'text-light-textSecondary hover:text-orange-500'}`}
                title={isDark ? t('switchToLight') : t('switchToDark')}
              >
                {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
              </button>
              {/* Language切换 */}
              <div className="relative">
                <button
                  onClick={() => setShowLangMenu(!showLangMenu)}
                  data-testid="language-menu-button"
                  className={`px-2 py-1 rounded-lg text-xs font-bold transition ${isDark ? 'text-slate-300 hover:text-orange' : 'text-light-textSecondary hover:text-orange-500'}`}
                  title={t('language')}
                >
                  {i18n.language === 'zh-CN' ? '中' : i18n.language === 'ja' ? '日' : i18n.language === 'ko' ? '한' : 'EN'}
                </button>
                {showLangMenu && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowLangMenu(false)} />
                    <div className="absolute right-0 top-10 bg-slate-800 rounded-xl py-2 w-40 border border-slate-700 shadow-xl z-50">
                      {[{ code: 'zh-CN', label: '简体中文' }, { code: 'en', label: 'English' }, { code: 'ja', label: '日本語' }, { code: 'ko', label: '한국어' }].map(lang => (
                        <button
                          key={lang.code}
                          onClick={() => changeLanguage(lang.code)}
                          className={`w-full px-3 py-2 text-left text-sm hover:bg-slate-700/50 transition flex items-center gap-2 ${i18n.language === lang.code ? 'text-orange' : 'text-slate-300'}`}
                        >
                          {lang.label}
                          {i18n.language === lang.code && <Check className="w-3 h-3 ml-auto" />}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {/* 快捷键Prompt */}
              <span className={`text-xs hidden sm:inline ${isDark ? 'text-slate-500' : 'text-light-textMuted'}`} title="Ctrl+V Paste, Ctrl+Enter Download">⌨️</span>
              {authToken ? (
                <>
                  {/* 头像按钮 */}
                  <button 
                    onClick={() => setShowUserMenu(!showUserMenu)}
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold cursor-pointer ${authUser?.tier === 'pro' ? (isDark ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/50' : 'bg-amber-100 text-amber-700 border border-amber-300') : isDark ? 'bg-slate-700/50 text-slate-300 border border-slate-600/50' : 'bg-slate-200 text-slate-700 border border-slate-300'}`}
                  >
                    {(authUser?.email || 'U').charAt(0).toUpperCase()}
                  </button>
                  {/* 用户菜单 */}
                  {showUserMenu && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setShowUserMenu(false)} />
                      <div className="absolute right-0 top-10 bg-slate-800 rounded-xl py-2 w-56 border border-slate-700 shadow-xl z-50">
                        <div className="px-3 py-2 border-b border-slate-700/50">
                          <p className="text-xs text-slate-300">{t('account')}</p>
                          <p className="text-sm text-white truncate">{authUser?.email || t('unknownEmail')}</p>
                          <p className="text-xs text-orange mt-0.5">{authUser?.tier === 'pro' ? t('proMemberTag') : t('freeUserTag')}</p>
                        </div>
                        <div className="py-1">
                          <button onClick={() => { setShowUserMenu(false); setShowSubscription(true) }} className="w-full px-3 py-2 text-left text-sm text-slate-300 hover:bg-slate-700/50 transition flex items-center gap-2">
                            <span>📊</span> {t('settings')}
                          </button>
                          <button onClick={() => { setShowUserMenu(false); setShowReferral(true) }} className="w-full px-3 py-2 text-left text-sm text-slate-300 hover:bg-slate-700/50 transition flex items-center gap-2">
                            <span>🎁</span> {t('referral')}
                          </button>
                          {authUser?.isAdmin && (
                            <button onClick={openAdminDashboard} className="w-full px-3 py-2 text-left text-sm text-slate-300 hover:bg-slate-700/50 transition flex items-center gap-2">
                              <span>📈</span> {t('adminDashboard')}
                            </button>
                          )}
                          <button onClick={() => { setShowUserMenu(false); openLexiconEditor() }} className="w-full px-3 py-2 text-left text-sm text-slate-300 hover:bg-slate-700/50 transition flex items-center gap-2">
                            <span>📝</span> ASR 专有词库
                          </button>
                          <button onClick={() => { setShowUserMenu(false); setShowResetPwd(true) }} className="w-full px-3 py-2 text-left text-sm text-slate-300 hover:bg-slate-700/50 transition flex items-center gap-2">
                            <span>🔑</span> {t('changePassword')}
                          </button>
                        </div>
                        <div className="pt-1 border-t border-slate-700/50">
                          <button onClick={() => { setShowUserMenu(false); handleLogout() }} className="w-full px-3 py-2 text-left text-sm text-red-400 hover:bg-slate-700/50 transition flex items-center gap-2">
                            <span>🚪</span> {t('exitLoginLogout')}
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </>
              ) : (
                <button onClick={() => setShowAuthModal(true)} data-testid="login-button" className={`p-2 rounded-lg transition ${isDark ? 'text-slate-300 hover:text-orange' : 'text-slate-600 hover:text-orange-500'}`} title="Login">
                  <User className="w-5 h-5" />
                </button>
              )}
            </div>
          </div>
          <div className={`flex flex-wrap items-center justify-center gap-3 sm:gap-6 text-[11px] sm:text-xs mt-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            <span>🌍 {t('statsCountries')}</span>
            <span>🎬 {t('statsVideos')}</span>
            <span>⭐ {t('statsRating')}</span>
          </div>
        </header>

        {/* Main Card */}
        <main className="max-w-xl mx-auto px-4 sm:px-6 pb-10">
          <div className={`rounded-2xl sm:rounded-3xl p-4 sm:p-6 shadow-xl ${isDark ? 'bg-dark-surface' : 'bg-light-surface'}`}>

            {/* 单G/批量 Tab */}
            <div className="flex gap-2 mb-5">
              <button
                onClick={() => { setBatchMode(false); setBatchQuality('') }}
                className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${!batchMode ? 'bg-orange/15 text-orange border border-orange/30' : isDark ? 'bg-slate-700/30 text-slate-300 border border-transparent' : 'bg-light-input text-light-textSecondary border border-transparent'}`}
              >
                {t('singleDownload')}
              </button>
              <button
                onClick={() => !isVip ? setShowUpgradePopup(true) : setBatchMode(true)}
                className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${batchMode ? 'bg-orange/15 text-orange border border-orange/30' : isDark ? 'bg-slate-700/30 text-slate-300 border border-transparent' : 'bg-light-input text-light-textSecondary border border-transparent'}`}
              >
                {t('batchDownload')}{!isVip && <span className="ml-1 text-orange">🔒</span>}
              </button>
            </div>

            {/* Single Download模式 */}
            {!batchMode && (
              <div className="mb-5">
                <div className="relative">
                  {/* Paste按钮 */}
                  <button
                    onClick={handlePasteClick}
                    className={`absolute left-3 top-1/2 -translate-y-1/2 p-2 hover:text-orange transition-colors ${isDark ? 'text-slate-300' : 'text-slate-500'}`}
                    title={t('pasteFromClipboard')}
                  >
                    <Clipboard className="w-5 h-5" />
                  </button>
                  <input
                    type="url"
                    data-testid="url-input"
                    value={url}
                    onChange={(e) => handleUrlChange(e.target.value)}
                    onPaste={handleSinglePaste}
                    placeholder={t('pasteUrlPlaceholder')}
                    className={`w-full pl-10 sm:pl-12 pr-10 sm:pr-12 py-4 sm:py-5 border-2 rounded-2xl sm:rounded-3xl focus:ring-4 focus:ring-orange/10 focus:border-orange/70 outline-none text-base transition-all ${isDark ? 'bg-slate-900/60 border-slate-600/50 text-white placeholder:text-slate-400' : 'bg-light-surface border-light-border text-light-text placeholder:text-slate-400'}`}
                  />
                  {/* Clear按钮 - 最右边 */}
                  {url && !loading && (
                    <button
                      onClick={clearUrl}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-slate-300 hover:text-slate-300 transition"
                      title={t('clearLink')}
                    >
                      <Eraser className="w-5 h-5" />
                    </button>
                  )}
                  {/* Parsing状态指示 */}
                  {loading && (
                    <div className="absolute right-2 top-1/2 -translate-y-1/2">
                      <Loader2 className="w-5 h-5 text-orange animate-spin" />
                    </div>
                  )}
                </div>
                {sharedEntrySource && url && (
                  <div className="mt-3 p-3 rounded-xl bg-orange/10 border border-orange/30 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs text-orange font-medium">
                        {sharedEntrySource === 'extension' ? t('extensionLinkReceived') : t('sharedLinkReceived')}
                      </p>
                      <p className="text-[11px] text-slate-400 truncate mt-0.5">{t('sharedLinkHint')}</p>
                    </div>
                    <button
                      onClick={handleSubmit}
                      disabled={loading}
                      className="shrink-0 px-3 py-1.5 rounded-lg bg-orange text-white text-xs font-medium hover:bg-orange-dark transition disabled:opacity-60"
                    >
                      {loading ? t('processing') : t('startDownload')}
                    </button>
                  </div>
                )}
                {!url && !sharedEntrySource && (
                  <div className="mt-3 rounded-xl border border-orange/20 bg-orange/5 p-3">
                    <p className="text-xs font-semibold text-orange mb-1">{t('emptyUrlGuideTitle')}</p>
                    <p className="text-[11px] text-slate-400 leading-relaxed">{t('emptyUrlGuideDesc')}</p>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {PLATFORMS.slice(0, 6).map(platform => (
                        <span key={platform.id} className="px-2 py-1 rounded-full bg-slate-900/50 border border-slate-700/50 text-[10px] text-slate-300">
                          {platform.icon} {t(platform.labelKey as any) || platform.labelFallback}
                        </span>
                      ))}
                    </div>
                    <button
                      onClick={() => window.open('https://chromewebstore.google.com/', '_blank', 'noopener,noreferrer')}
                      className="mt-3 w-full px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700/60 text-xs text-slate-300 hover:text-orange hover:border-orange/30 transition"
                    >
                      {t('browserExtensionCta')}
                    </button>
                  </div>
                )}

              </div>
            )}

            {/* Batch Download模式 */}
            {batchMode && !isVip && (
              <div className="mb-5 p-4 bg-orange/10 border border-orange/30 rounded-2xl text-center">
                <p className="text-sm text-orange mb-2">🔒 {t('batchDownload')} {t('vipOnly')}</p>
                <p className="text-xs text-slate-300 mb-3">{t('batchVipHint')}</p>
                <button
                  onClick={() => setShowUpgradePopup(true)}
                  className="px-4 py-2 bg-orange text-white text-sm font-medium rounded-xl hover:bg-orange-dark transition"
                >
                  {t('upgradeToPro')}
                </button>
              </div>
            )}
            {batchMode && isVip && (
              <div className="mb-5">
                <div className="relative">
                  {/* 一键粘贴按钮 */}
                  <button
                    onClick={() => {
                      navigator.clipboard.readText().then(text => {
                        const urls = text.match(/https?:\/\/[^\s\n,，、；;）)】"'<>]+/g) || []
                        if (urls.length > 0) {
                          const existing = batchUrls.split('\n').filter(u => u.trim()).map(u => u.replace(/^\d+\.\s*/, '').trim())
                          const merged = [...new Set([...existing, ...urls])].slice(0, 10)
                          setBatchUrls(merged.map((url, idx) => `${idx + 1}. ${url}`).join('\n'))
                        }
                      }).catch(() => {})
                    }}
                    className="absolute left-3 top-3 p-2 text-slate-300 hover:text-orange transition-colors"
                    title="一键粘贴"
                  >
                    <Clipboard className="w-5 h-5" />
                  </button>
                  {/* 一键清除按钮 */}
                  {batchUrls.trim() && (
                    <button
                      onClick={() => { setBatchUrls(''); setBatchQuality('') }}
                      className="absolute right-3 top-3 p-2 text-slate-300 hover:text-red-400 transition-colors"
                      title="一键清除"
                    >
                      <Eraser className="w-5 h-5" />
                    </button>
                  )}
                  <textarea
                    value={batchUrls}
                    onChange={(e) => handleBatchChange(e.target.value)}
                    onPaste={(e) => {
                      const text = e.clipboardData.getData('text')
                      const urls = text.match(/https?:\/\/[^\s\n,，、；;）)】"'<>]+/g) || []
                      if (urls.length > 0) {
                        e.preventDefault()
                        const existing = batchUrls.split('\n').filter(u => u.trim()).map(u => u.replace(/^\d+\.\s*/, '').trim())
                        const merged = [...new Set([...existing, ...urls])].slice(0, 10)
                        setBatchUrls(merged.map((url, idx) => `${idx + 1}. ${url}`).join('\n'))
                      }
                    }}
                    placeholder={t('pasteLinksHint') + '\nhttps://v.douyin.com/xxx\nhttps://x.com/yyy'}
                    className={`w-full h-28 pl-12 pr-10 py-3 border-2 rounded-2xl focus:ring-4 focus:ring-orange/10 focus:border-orange/70 text-sm transition-all resize-none ${isDark ? 'bg-slate-900/60 border-slate-600/50 text-white placeholder:text-slate-300' : 'bg-light-surface border-light-border text-light-text placeholder:text-light-textMuted'}`}
                  />
                </div>
                {/* Link预览列表 - 带数字排序 */}
                {batchUrls.split('\n').filter(u => u.trim()).length > 0 && (
                  <div className="mt-2 max-h-48 overflow-y-auto space-y-1.5">
                    {batchUrls.split('\n').filter(u => u.trim()).map((url, idx) => {
                      // 去除数字前缀获取纯Link
                      const cleanUrl = url.replace(/^\d+\.\s*/, '').trim()
                      // 截取Show
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
                  💡 {t('batchTip')} {batchUrls.split('\n').filter(u => u.trim()).length}/10
                </p>

                {/* 批量画质偏好 */}
                <div className="mt-3">
                  <p className="text-xs text-slate-400 mb-2 font-medium">🎬 {t('quality')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {BATCH_QUALITY_OPTIONS.map(opt => {
                      const isHigh = opt.height > 720
                      const canSelect = isVip || !isHigh
                      const isSelected = batchQuality === opt.value
                      return (
                        <button
                          key={opt.value}
                          onClick={() => {
                            if (!canSelect) { setShowUpgradePopup(true); return }
                            setBatchQuality(isSelected ? '' : opt.value)
                          }}
                          className={`flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg transition-all ${
                            isSelected
                              ? 'bg-orange text-white font-semibold shadow-md'
                              : canSelect
                                ? 'bg-slate-700/40 text-slate-300 border border-slate-600/40 hover:border-orange/40 hover:text-white'
                                : 'bg-slate-800/40 text-slate-500 border border-slate-700/40 opacity-50'
                          }`}
                        >
                          <span>{opt.icon}</span>
                          <span>{opt.labelKey ? t(opt.labelKey) : opt.label}</span>
                          {isHigh && !isVip && <span className="text-[10px]">⭐</span>}
                        </button>
                      )
                    })}
                  </div>
                  <p className="text-[10px] text-slate-500 mt-1">
                    {t('batchQualityTip')}
                  </p>
                </div>

                {/* ASR 耗时提示 */}
                {selectedAiTools.size > 0 && (
                  <div className="mt-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl flex items-start gap-2">
                    <span className="text-sm mt-0.5">⏳</span>
                    <div>
                      <p className="text-xs text-amber-300 font-medium">{t('asrTimeNotice')}</p>
                      <p className="text-[11px] text-amber-200/70 mt-0.5">
                        {t('asrTimeDetail')}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}

            

            {/* Supported Platforms */}
            <div className="mb-5">
              <p className={`text-xs mb-2 ${isDark ? 'text-slate-300' : 'text-light-textSecondary'}`}>{t('supportedPlatforms')}</p>
              <div className="flex flex-wrap gap-1.5">
                {PLATFORMS.map((p) => (
                  <span key={p.id} className={`flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg ${isDark ? 'bg-slate-700/30 text-slate-300' : 'bg-slate-100 text-slate-700 border border-slate-200'}`}>
                    <span>{p.icon}</span>
                    <span>{t(p.labelKey as any) || p.labelFallback}</span>
                  </span>
                ))}
              </div>
            </div>

            {/* 下载内容 */}
            <div className="mb-4">
              <p className="text-xs text-slate-400 mb-2 font-medium">📥 {t('downloadContent')}</p>
              <div className="flex flex-wrap gap-1.5">
                {OPTIONS.map(o => {
                  const Icon = o.icon; const on = selected.has(o.id)
                  return (
                    <button key={o.id} onClick={() => toggle(o.id)}
                      className={`flex items-center gap-1 px-3 py-2 text-xs rounded-lg transition-all
                        ${on ? 'bg-orange/15 text-orange border border-orange/30' : isDark ? 'bg-slate-700/30 text-slate-300 border border-transparent hover:text-slate-300' : 'bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200'}`}>
                      <Icon className="w-3.5 h-3.5" />
                      {getOptionLabel(o.labelKey)}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* AI 工具 */}
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-purple-300 font-medium">🤖 {t('aiToolsTitle')} <span className="text-orange">Pro</span></p>
                <button onClick={openLexiconEditor} className="text-[11px] text-slate-400 hover:text-orange transition">{t('asrLexicon')}</button>
              </div>
              <p className="text-[11px] text-slate-500 mb-2">{t('aiToolsHint')}</p>
              <div className="grid grid-cols-2 gap-2">
                {AI_TOOLS.map(tool => {
                  const Icon = tool.icon
                  const on = selectedAiTools.has(tool.id)
                  return (
                    <button
                      key={tool.id}
                      onClick={() => toggleAiTool(tool.id)}
                      className={`text-left rounded-xl px-3 py-2 border transition-all ${
                        on
                          ? 'bg-purple-500/15 border-purple-400/40 text-purple-200'
                          : isDark
                            ? 'bg-slate-700/25 border-slate-700/50 text-slate-300 hover:border-purple-400/30'
                            : 'bg-slate-100 border-slate-200 text-slate-700 hover:border-purple-300'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 text-xs font-medium">
                        <Icon className="w-3.5 h-3.5" />
                        <span>{t(tool.labelKey)}</span>
                        {!isVip && <span className="ml-auto text-orange">🔒</span>}
                      </div>
                      <p className="text-[10px] opacity-70 mt-0.5">{t(tool.descKey)}</p>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* 画质选择 */}
            {availableQualities.length > 0 && !batchMode && (
              <div className="mb-4">
                <p className="text-xs text-slate-400 mb-2 font-medium">🎬 {t('quality')}</p>
                <div className="flex flex-wrap gap-1.5">
                    {/* 原画 - VIP 专属，抖音(TikHub) / YouTube(Yout.com) 支持 */}
                    {isVip && (detected === 'douyin' || detected === 'youtube') && (
                      <button
                        onClick={() => {
                          qualityManuallySet.current = true
                          setPendingQuality('height<=99999')
                          setQuality('height<=99999')
                          setAutoQuality({ label: t('originalQuality'), height: 99999 })
                        }}
                        className={`flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg transition-all ${
                          pendingQuality === 'height<=99999'
                            ? 'bg-gradient-to-r from-orange to-orange-light text-white font-semibold shadow-md'
                            : 'bg-slate-700/40 text-amber-300 border border-amber-500/30 hover:border-amber-400 hover:text-amber-200'
                        }`}
                      >
                        <span>🎞️</span>
                        <span>{t('originalQuality')}</span>
                        <span className="text-[10px] opacity-60">VIP</span>
                      </button>
                    )}
                    {availableQualities.map((q, idx) => {
                      const shortEdge = qualityShortEdge(q)
                      const isHighQuality = shortEdge > 720
                      const canSelect = isVip || !isHighQuality
                      const qualityLabel = (q as any).qualityLabel || q.quality || `${shortEdge}p`
                      const isSelected = pendingQuality === `height<=${shortEdge}`
                      return (
                        <button
                          key={idx}
                          onClick={() => {
                            if (!canSelect) { setShowUpgradePopup(true); return }
                            const qualityStr = `height<=${shortEdge}`
                            qualityManuallySet.current = true
                            setPendingQuality(qualityStr)
                            setQuality(qualityStr)
                            setAutoQuality({ label: qualityLabel, height: shortEdge })
                          }}
                          className={`flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg transition-all ${
                            isSelected
                              ? 'bg-orange text-white font-semibold shadow-md'
                              : canSelect
                                ? 'bg-slate-700/40 text-slate-300 border border-slate-600/40 hover:border-orange/40 hover:text-white'
                                : 'bg-slate-800/40 text-slate-500 border border-slate-700/40 opacity-50'
                          }`}
                        >
                          <span>🎬</span>
                          <span>{qualityLabel}</span>
                          {q.size && q.size > 0 && <span className="text-[10px] opacity-60 ml-0.5">~{(q.size / 1048576).toFixed(1)}MB</span>}
                          {isHighQuality && !isVip && <span className="text-[10px]">⭐</span>}
                        </button>
                      )
                    })}
                  </div>
              </div>
            )}

            {/* AI/ASR Language Selection */}
            {selectedAiTools.size > 0 && (
              <div className="mb-4">
                <label className="text-xs text-slate-400 mb-2 block font-medium">🌐 {t('asrLanguageLabel')}</label>
                <select
                  value={asrLanguage}
                  onChange={(e) => setAsrLanguage(e.target.value)}
                  className={`w-full px-3 py-2 border-2 rounded-xl text-sm outline-none focus:border-orange/70 cursor-pointer appearance-none ${isDark ? 'bg-slate-900/60 border-slate-600/50 text-white' : 'bg-light-surface border-light-border text-light-text'}`}
                >
                  {ASR_LANGUAGE_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                {selectedAiTools.has('translate_subtitle') && (
                  <>
                    <label className="text-xs text-slate-400 mt-3 mb-2 block font-medium">🌐 {t('translateTo') || '翻译为'}</label>
                    <select
                      value={targetLang || 'en'}
                      onChange={(e) => setTargetLang(e.target.value)}
                      className={`w-full px-3 py-2 border-2 rounded-xl text-sm outline-none focus:border-orange/70 cursor-pointer appearance-none ${isDark ? 'bg-slate-900/60 border-slate-600/50 text-white' : 'bg-light-surface border-light-border text-light-text'}`}
                    >
                      <option value="en">English</option>
                      <option value="ja">日本語</option>
                      <option value="ko">한국어</option>
                      <option value="zh">中文</option>
                    </select>
                  </>
                )}
              </div>
            )}

            {/* Save Location SaveLocation - 下拉式 */}
            <div className="mb-5">
              <label className="text-xs text-slate-400 mb-2 font-medium flex items-center gap-1.5">
                <FolderOpen className="w-3.5 h-3.5" />
                {t('saveLocation')}
              </label>
              <div className="relative mt-1.5">
                <select
                  value={saveLocation}
                  onChange={(e) => handleLocationChange(e.target.value)}
                  className={`w-full px-4 py-3 border-2 rounded-xl text-sm outline-none focus:border-orange/70 cursor-pointer appearance-none ${isDark ? 'bg-slate-900/60 border-slate-600/50 text-white' : 'bg-light-surface border-light-border text-light-text'}`}
                >
                  <option value="album">📱 {t('saveToAlbum')}</option>
                  <option value="download">💻 {t('saveToDownloads')}</option>
                  <option value="desktop">🖥️ {t('saveToDesktop')}</option>
                </select>
                <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-300 pointer-events-none" />
              </div>
              {saveLocation === 'download' && (
                <div className="mt-2 p-2.5 bg-slate-700/30 rounded-xl border border-slate-700/60">
                  <p className="text-xs text-slate-300 leading-relaxed">
                    {t('tipChangeDownloadPath')}
                  </p>
                </div>
              )}
            </div>

            {/* ErrorPrompt */}
            {error && (
              <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-2">
                <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
                <p className="text-red-300 text-sm">{error}</p>
              </div>
            )}

            {/* 批量进度 */}
            {batchMode && batchQueue.length > 0 && (
              <div className={`mb-3 rounded-xl border overflow-hidden ${isDark ? 'bg-slate-900/60 border-slate-700/60' : 'bg-light-surface border-light-border'}`}>
                <div className={`px-4 py-2 border-b flex justify-between items-center ${isDark ? 'border-slate-700/60' : 'border-light-border'}`}>
                  <p className={`text-xs ${isDark ? 'text-slate-300' : 'text-light-textSecondary'}`}>
                    📋 批量下载 · {batchQueue.filter(i => i.status !== 'pending').length}/{batchQueue.length}
                  </p>
                  {batchId && <span className="text-[10px] text-emerald-400">✅ {t('canClosePage')}</span>}
                </div>
                <div className="max-h-52 overflow-y-auto">
                  {batchQueue.map((item, idx) => {
                    let statusIcon: any = <span className="text-xs text-slate-500">⏳</span>
                    let rowClass = ''
                    if (item.status === 'completed' || item.status === 'completed') {
                      statusIcon = <span className="text-xs text-emerald-400">✅</span>
                      rowClass = 'opacity-60'
                    } else if (item.status === 'error') {
                      statusIcon = <span className="text-xs text-red-400">❌</span>
                      rowClass = 'opacity-60'
                    } else if (item.status === 'processing') {
                      statusIcon = <Loader2 className="w-3 h-3 text-orange animate-spin" />
                      rowClass = 'bg-orange/10'
                    }
                    const platform = detectPlatform(item.url)
                    const icon = PLATFORMS.find(p => p.id === platform)?.icon || '🔗'
                    const label = item.title || item.url.replace(/^https?:\/\//, '').substring(0, 30)
                    return (
                      <div key={idx} className={`flex items-center gap-2 px-4 py-2 border-b border-slate-700/20 last:border-0 ${rowClass}`}>
                        <span className="text-xs text-slate-300 w-5">{idx + 1}.</span>
                        <span className="text-sm">{icon}</span>
                        <span className="text-xs text-slate-300 truncate flex-1" title={label}>{label}</span>
                        {statusIcon}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Download button */}
            {/* Upgrade Banner when out of downloads */}
            {!isVip && remainingDownloads === 0 && (
              <div className="mb-3 p-3 bg-gradient-to-r from-orange/20 to-orange-light/20 rounded-xl border border-orange-500/40 text-center">
                <p className="text-sm text-white mb-1">{t('dailyDownloadsExhausted')}</p>
                <p className="text-[11px] text-slate-300 mb-1">{t('upgradeLimitHint')}</p>
                <button onClick={() => setShowUpgradePopup(true)} className="text-orange hover:text-orange font-semibold text-sm">
                  ⭐ {t('upgradeToProUnlimited')} →
                </button>
              </div>
            )}
            {/* RemainingDownloadTimesPrompt */}
            {!isVip && remainingDownloads >= 0 && (
              <div className={`mb-3 text-center text-xs py-2 rounded-xl ${isDark ? 'bg-slate-800/60 text-slate-300' : 'bg-light-input text-light-textSecondary'}`}>
                {remainingDownloads === -1 ? t('unlimited') : `${t('downloadsRemaining', { count: remainingDownloads })}`}
                {remainingDownloads === 0 && <span className="ml-2 text-orange">· <button onClick={() => setShowUpgradePopup(true)} className="underline hover:text-orange">{t('upgradeToPro')}</button></span>}
              </div>
            )}
            {isVip && (
              <div className={`mb-3 text-center text-xs py-2 rounded-xl font-medium ${isDark ? 'bg-yellow-500/10 text-yellow-400' : 'bg-amber-100 text-amber-700 border border-amber-200'}`}>
                ⭐ {t('proUnlimitedOriginalQuality')}
              </div>
            )}
            {authToken && aiUsage && (
              <div className={`mb-3 grid grid-cols-2 gap-2 text-[11px] ${isDark ? 'text-slate-300' : 'text-light-textSecondary'}`}>
                <div className={`rounded-xl px-3 py-2 ${isDark ? 'bg-purple-500/10 border border-purple-500/20' : 'bg-purple-50 border border-purple-100'}`}>
                  <p className="text-purple-300 font-medium">{t('aiCopyQuota')}</p>
                  <p className="mt-0.5">
                    {aiUsage.copywrite.limit < 0
                      ? t('aiQuotaUsedUnlimited', { used: aiUsage.copywrite.used })
                      : t('aiQuotaUsedRemaining', { used: aiUsage.copywrite.used, limit: aiUsage.copywrite.limit, remaining: aiUsage.copywrite.remaining })}
                  </p>
                </div>
                <div className={`rounded-xl px-3 py-2 ${isDark ? 'bg-slate-800/60 border border-slate-700/60' : 'bg-light-input border border-light-border'}`}>
                  <p className="text-orange font-medium">{t('fileRetention')}</p>
                  <p className="mt-0.5">
                    {aiUsage.retention.hours >= 24
                      ? t('retentionDays', { count: Math.round(aiUsage.retention.hours / 24) })
                      : t('retentionHours', { count: aiUsage.retention.hours })}
                  </p>
                </div>
              </div>
            )}

            {/* Unified Action Area: 按钮 + 进度融合 */}
            <div className="mb-5">
              {/* Idle: Download Button */}
              {!task && (
                <div className="space-y-2">
                  <button
                    onClick={handleSubmit}
                    disabled={loading}
                    className="w-full py-3.5 sm:py-4 rounded-2xl font-bold text-white text-sm sm:text-base bg-gradient-to-r from-orange to-orange-light hover:from-orange-600 hover:to-amber-600 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-orange/25 active:scale-[0.98]"
                  >
                    {loading ? (
                      <><Loader2 className="w-5 h-5 animate-spin" />{batchMode ? `${t('processing')} ${batchIndex + 1}/${batchQueue.length}...` : t('processing')}</>
                    ) : (
                      <><Zap className="w-5 h-5" />{autoQuality ? `${t('startDownload')} (${autoQuality.height === 99999 ? t('originalQuality') : autoQuality.label})` : t('startDownload')}</>
                    )}
                  </button>
                  {!isVip && (
                    <p className="text-center text-[11px] text-slate-500">{t('freeDailyDownloads')}</p>
                  )}
                </div>
              )}

{/* Task Progress / Completion - replaces button area */}
              {task && (
                <div className={`rounded-2xl p-4 border shadow-xl space-y-3 ${isDark ? 'bg-slate-800/60 border-slate-700/60' : 'bg-light-surface border-light-border'}`}>
                  {/* Header: status + close */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {task.status === 'completed' && <CheckCircle2 className="w-5 h-5 text-emerald-400" />}
                      {task.status === 'error' && <XCircle className="w-5 h-5 text-red-400" />}
                      {isWorking(task.status) && <Loader2 className="w-5 h-5 text-orange animate-spin" />}
                      <span className={`text-xs font-medium ${isDark ? 'text-slate-300' : 'text-light-textSecondary'}`}>{statusLabel(task.status)}</span>
                    </div>
                    <button onClick={async () => {
                      if (task?.taskId && isWorking(task.status)) {
                        try { await axios.delete(`${API}/tasks/${task.taskId}`) } catch {}
                      }
                      setTask(null)
                    }}><X className={`w-3.5 h-3.5 ${isDark ? 'text-slate-300 hover:text-slate-300' : 'text-light-textMuted hover:text-light-textSecondary'}`} /></button>
                  </div>

              {/* 精细进度条 */}
              {isWorking(task.status) && (
                <div className="space-y-2">
                  <div className={`w-full h-2.5 rounded-full overflow-hidden ${isDark ? 'bg-slate-700/50' : 'bg-light-input'}`}>
                    <div 
                      className="h-full bg-orange rounded-full transition-all duration-500"
                      style={{ width: `${task.progress}%` }}
                    />
                  </div>
                  <div className={`flex items-center justify-between text-xs ${isDark ? 'text-slate-300' : 'text-light-textSecondary'}`}>
                    <span className={isDark ? 'text-slate-300' : 'text-light-textSecondary'}>{task.title || t('parsing')}</span>
                    <div className="flex items-center gap-2">
                      {task.downloadedBytes && task.totalBytes ? (
                        <span className={isDark ? 'text-slate-300' : 'text-light-textSecondary'}>
                          {formatBytes(task.downloadedBytes)}/{formatBytes(task.totalBytes)}
                        </span>
                      ) : null}
                      <span className="text-orange font-medium">{task.progress}%</span>
                      {task.speed && <span className="text-emerald-400">{task.speed}/s</span>}
                      {task.eta && <span className={isDark ? 'text-slate-300' : 'text-light-textMuted'}>{t('remaining')} {task.eta}</span>}
                    </div>
                  </div>
                  <p className="text-[10px] text-emerald-400/70">✅ {t('canClosePage')}</p>
                </div>
              )}

              {task.title && !isWorking(task.status) && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    {task.quality && (() => {
                      const height = task.height || 0
                      return (
                        <span className={`text-xs px-2 py-0.5 rounded-full ${height >= 720 ? 'bg-gradient-to-r from-yellow-500/20 to-orange/20 text-yellow-400 border border-yellow-500/30' : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'}`}>
                          🎬 {task.quality} {height >= 720 ? '⭐' : '✓'}
                        </span>
                      )
                    })()}
                    <p className="text-sm text-slate-300">{task.title}</p>
                  </div>
                  {/* Quality调整提示 */}
                  {task.qualityAdjusted === 'downgrade' && (
                    <div className="text-xs text-amber-400 bg-amber-500/10 px-3 py-2 rounded-xl">
                      {t('qualityDowngraded', { quality: task.quality })}
                    </div>
                  )}
                  {task.qualityAdjusted === 'upgrade' && (
                    <div className="text-xs text-emerald-400 bg-emerald-500/10 px-3 py-2 rounded-xl">
                      {t('qualityUpgraded', { quality: task.quality })}
                    </div>
                  )}
                  {/* Free User Download limit Prompt */}
                  {!isVip && task.height && task.height < 1080 && (
                    <div className="text-xs text-slate-300 bg-slate-700/30 px-3 py-2 rounded-xl flex items-center justify-between">
                      <span>🔒 {t('memberExclusiveQuality')}</span>
                      <button onClick={() => setShowUpgradePopup(true)} className="text-orange hover:text-orange underline">{t('upgradeToPro')}</button>
                    </div>
                  )}
                </div>
              )}

              {/* 图文笔记 - 图片网格 + 批量下载 */}
              {task.isNote && (task.imageFiles?.length || 0) > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-slate-300">
                      🖼️ {t('totalImages', { count: task.imageFiles!.length })}
                    </p>
                    <button
                      onClick={async () => {
                        for (const img of task.imageFiles!) {
                          const fullUrl = (img.url.startsWith('http') ? img.url : `${BASE_URL}${img.url}`);
                          const a = document.createElement('a');
                          a.href = fullUrl;
                          a.download = img.filename;
                          a.click();
                          await new Promise(r => setTimeout(r, 300));
                        }
                      }}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg bg-orange/15 text-orange border border-orange/30 hover:bg-orange/25 transition"
                    >
                      <Download className="w-3 h-3" />
                      {t('saveAllImages')}
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {task.imageFiles!.map(img => {
                      const fullUrl = img.url.startsWith('http') ? img.url : `${BASE_URL}${img.url}`;
                      const dimLabel = (img as any).width ? `${(img as any).width}×${(img as any).height}` : '';
                      return (
                        <div key={img.filename} className="group relative rounded-xl overflow-hidden bg-slate-700/30">
                          <img
                            src={fullUrl}
                            alt=""
                            className="w-full object-cover"
                            style={{ aspectRatio: (img as any).width && (img as any).height ? `${(img as any).width}/${(img as any).height}` : '3/4' }}
                            loading="lazy"
                          />
                          {/* 单张下载按钮 */}
                          <a
                            href={fullUrl}
                            download={img.filename}
                            className="absolute bottom-2 right-2 flex items-center gap-1 px-2 py-1 text-[10px] rounded-lg bg-black/60 text-white opacity-0 group-hover:opacity-100 hover:bg-orange transition-all"
                          >
                            <Download className="w-3 h-3" />
                          </a>
                          {dimLabel && (
                            <span className="absolute top-2 left-2 px-1.5 py-0.5 text-[10px] rounded bg-black/50 text-slate-300">
                              {dimLabel}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Video Save - Inline <video> tag for iOS long-press save */}
              {task.status === 'completed' && task.downloadUrl && !task.directLink && (
                <div className="mt-2">
                  <div className="relative rounded-xl overflow-hidden bg-black">
                    <video
                      src={task.downloadUrl.startsWith('http') ? task.downloadUrl : `${BASE_URL}${task.downloadUrl}`}
                      controls
                      playsInline
                      style={{ width: '100%', borderRadius: '12px', maxHeight: '400px' }}
                      preload="metadata"
                    />
                  </div>
                  <p style={{ color: 'gray', fontSize: '13px', marginTop: '6px', textAlign: 'center' }}>
                    {t('longPressToSave')}
                  </p>
                  <button
                    onClick={async () => {
                      clearAutoDownload()  // 取消AutoDownload
                      autoDownloaded.current = true  // Mark为已Process
                      setDownloading(true)
                      await shareFile(task.downloadUrl!, task.title || 'video', 'video')
                      setDownloading(false)
                    }}
                    disabled={downloading}
                    className="w-full mt-2 py-3 rounded-xl text-sm font-semibold bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {downloading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Download className="w-5 h-5" />}
                    {downloading ? t('downloading') : t('saveToPhotos')}
                  </button>
                </div>
              )}

              {/* Direct Link Download (YouTube etc.) */}
              {task.status === 'completed' && task.downloadUrl && task.directLink && (
                <button
                  onClick={() => {
                    clearAutoDownload()
                    autoDownloaded.current = true
                    const fullUrl = task.downloadUrl!.startsWith('http') ? task.downloadUrl : `${BASE_URL}${task.downloadUrl}`
                    window.open(fullUrl, '_blank')
                  }}
                  className="w-full py-3.5 rounded-2xl text-sm font-semibold bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 transition-all flex items-center justify-center gap-2"
                >
                  <Download className="w-5 h-5" />
                  {t('openVideo')}
                </button>
              )}

              {/* Cover */}
              {task.status === 'completed' && task.coverUrl && (
                <button 
                  onClick={async () => {
                    clearAutoDownload()
                    autoDownloaded.current = true
                    setDownloading(true)
                    await shareFile(task.coverUrl!, (task.title || 'video') + '_cover', 'image')
                    setDownloading(false)
                  }}
                  disabled={downloading}
                  className="w-full py-3 rounded-xl text-xs bg-slate-700/30 border border-slate-700/60 text-slate-300 hover:text-white transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImageIcon className="w-3.5 h-3.5" />}
                  {downloading ? t('downloading') : t('saveCover')}
                </button>
              )}

              {/* MP3 Audio */}
              {task.status === 'completed' && task.audioUrl && (
                <button 
                  onClick={async () => {
                    clearAutoDownload()
                    autoDownloaded.current = true
                    setDownloading(true)
                    await shareFile(task.audioUrl!, task.title || 'audio', 'audio')
                    setDownloading(false)
                  }}
                  disabled={downloading}
                  className="w-full py-3 rounded-xl text-xs bg-slate-700/30 border border-slate-700/60 text-slate-300 hover:text-white transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mic className="w-3.5 h-3.5" />}
                  {downloading ? t('downloading') : t('saveMp3')}
                </button>
              )}

              {/* VIP Upgrade Teaser - show after free user download completes */}
              {task.status === 'completed' && !isVip && !authToken && (
                <div className="mt-3 p-3 bg-gradient-to-r from-orange/10 to-orange-light/10 border border-orange/20 rounded-xl">
                  <p className="text-xs text-slate-300 text-center">
                    🎬 {t('memberSubscribe')} · {t('qualityUpTo4K')} · {t('unlimited')} {t('downloads')}
                  </p>
                  <button
                    onClick={() => setShowAuthModal(true)}
                    className="w-full mt-2 py-2 rounded-lg bg-orange hover:bg-orange-dark text-white text-xs font-medium transition"
                  >
                    {t('upgradeVip')}
                  </button>
                </div>
              )}

              {/* AI 带货素材卡 */}
              {task.status === 'completed' && task.taskId && !task.directLink && (
                <div className="p-3 bg-purple-500/10 border border-purple-500/20 rounded-xl">
                  {(() => {
                    const commerce = copywritingResult?.taskId === task.taskId ? copywritingResult.analysis : task.copywriteAnalysis
                    if (!commerce) {
                      const requested = selectedAiTools.has('copywriting') || task.commerceCardStatus === 'processing'
                      return (
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-xs text-purple-300 font-medium">🤖 {t('aiCommerceCardTitle')}</p>
                            <p className="text-[11px] text-slate-400 mt-0.5">
                              {task.commerceCardStatus === 'error'
                                ? (task.commerceCardError || t('aiCommerceCardFailed'))
                                : requested
                                  ? t('aiCommerceCardGeneratingHint')
                                  : t('aiCommerceCardReadyHint')}
                            </p>
                          </div>
                          <button
                            onClick={runCommerceCard}
                            disabled={copywritingLoading || task.commerceCardStatus === 'processing'}
                            className="shrink-0 px-3 py-1.5 rounded-lg text-xs bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 transition disabled:opacity-50"
                          >
                            {copywritingLoading || task.commerceCardStatus === 'processing' ? t('generating') : t('generate')}
                          </button>
                        </div>
                      )
                    }
                    return (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-purple-300 font-medium">🤖 {t('aiCommerceCardTitle')}</span>
                        <div className="flex items-center gap-2 flex-wrap justify-end">
                          <button onClick={() => copyCommerceCard(commerce, 'card')} className="text-[10px] text-purple-400 hover:text-purple-300">
                            {copied === 'commerce-card' ? `✓ ${t('copied')}` : t('copyCard')}
                          </button>
                          {commerce.copyScript && (
                            <button onClick={() => copyCommerceCard(commerce, 'script')} className="text-[10px] text-purple-400 hover:text-purple-300">
                              {copied === 'commerce-script' ? `✓ ${t('copied')}` : t('copyScript')}
                            </button>
                          )}
                          {commerce.tags?.length > 0 && (
                            <button onClick={() => copyCommerceCard(commerce, 'tags')} className="text-[10px] text-purple-400 hover:text-purple-300">
                              {copied === 'commerce-tags' ? `✓ ${t('copied')}` : t('copyTags')}
                            </button>
                          )}
                          <button onClick={() => exportCommerceCard(commerce, 'md')} className="text-[10px] text-purple-400 hover:text-purple-300">MD</button>
                          <button onClick={() => exportCommerceCard(commerce, 'txt')} className="text-[10px] text-purple-400 hover:text-purple-300">TXT</button>
                          <button onClick={() => exportCommerceCard(commerce, 'csv')} className="text-[10px] text-purple-400 hover:text-purple-300">CSV</button>
                          <button onClick={() => exportCommerceCard(commerce, 'pack')} className="text-[10px] text-orange hover:text-orange/80">PACK</button>
                          <button onClick={() => exportCommerceCard(commerce, 'packCsv')} className="text-[10px] text-orange hover:text-orange/80">PACK CSV</button>
                          <button onClick={runCommerceCard} disabled={copywritingLoading} className="text-[10px] text-purple-400 hover:text-purple-300 disabled:opacity-50">
                            {copywritingLoading ? t('regenerating') : t('regenerate')}
                          </button>
                        </div>
                      </div>
                      {commerce.productName && (
                        <p className="text-xs text-slate-300">📦 <span className="text-white">{commerce.productName}</span></p>
                      )}
                      <div className="p-2 rounded-lg bg-slate-900/50 border border-slate-700/50">
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <p className="text-[10px] text-slate-400">🚀 {t('platformPublishPack')}</p>
                          <div className="flex flex-wrap gap-1 justify-end">
                            <select
                              value={rewriteStyle}
                              onChange={(e) => setRewriteStyle(e.target.value)}
                              className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-950/70 border border-slate-700 text-slate-300"
                            >
                              {REWRITE_STYLES.map(style => (
                                <option key={style.id} value={style.id}>{t(style.labelKey)}</option>
                              ))}
                            </select>
                            {REWRITE_PLATFORMS.map(platform => {
                              const key = `${platform.id}:${rewriteStyle}`
                              return (
                                <button
                                  key={platform.id}
                                  onClick={() => rewriteCommerceCard(commerce, platform.id, rewriteStyle)}
                                  disabled={!!rewriteLoadingKey}
                                  className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/10 text-purple-300 hover:bg-purple-500/20 disabled:opacity-60"
                                >
                                  {rewriteLoadingKey === key ? t('generating') : platform.label}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                        {commerce.rewritePacks && Object.values(commerce.rewritePacks).length > 0 ? (
                          <div className="space-y-2">
                            {(Object.values(commerce.rewritePacks) as any[]).map((pack, i) => (
                              <div key={`${pack.platform || 'platform'}-${i}`} className="p-2 rounded-lg bg-slate-950/50 border border-slate-800">
                                <div className="flex items-center justify-between gap-2 mb-1">
                                  <span className="text-[10px] text-orange">{getRewritePlatformLabel(pack.platform)} · {getRewriteStyleLabel(pack.style || 'seed')}</span>
                                  <button
                                    onClick={() => clip([`${getRewritePlatformLabel(pack.platform)} · ${getRewriteStyleLabel(pack.style || 'seed')}`, pack.title, pack.caption, listify(pack.hashtags).map(tag => `#${tag}`).join(' '), pack.cta].filter(Boolean).join('\n'), `rewrite-${i}`)}
                                    className="text-[10px] text-purple-400 hover:text-purple-300"
                                  >
                                    {copied === `rewrite-${i}` ? `✓ ${t('copied')}` : t('copyPack')}
                                  </button>
                                </div>
                                {pack.title && <p className="text-xs text-white font-medium">{pack.title}</p>}
                                {pack.hook && <p className="text-[11px] text-slate-300 mt-1">🪝 {pack.hook}</p>}
                                {pack.caption && <p className="text-[11px] text-slate-300 mt-1 whitespace-pre-wrap">{pack.caption}</p>}
                                {pack.shortScript && <p className="text-[11px] text-slate-400 mt-1 whitespace-pre-wrap">🎙️ {pack.shortScript}</p>}
                                {pack.cta && <p className="text-[11px] text-emerald-300 mt-1">{pack.cta}</p>}
                                {pack.hashtags?.length > 0 && (
                                  <div className="flex flex-wrap gap-1 mt-1">
                                    {pack.hashtags.map((tag: string, idx: number) => (
                                      <span key={idx} className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-300">#{tag}</span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-[11px] text-slate-500">{t('platformPublishHint')}</p>
                        )}
                      </div>
                      {commerce.openingHook && (
                        <p className="text-xs text-slate-300">🪝 <span className="text-slate-400">{t('openingHook')}：</span>{commerce.openingHook}</p>
                      )}
                      {commerce.sellingPoints?.length > 0 && (
                        <div>
                          <p className="text-[10px] text-slate-400 mb-1">💡 {t('aiSellingPoints')}</p>
                          <ul className="text-xs text-slate-300 space-y-0.5">
                            {commerce.sellingPoints.map((sp: string, i: number) => (
                              <li key={i} className="flex gap-1"><span className="text-purple-400">•</span> {sp}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {commerce.painPoints?.length > 0 && (
                        <div>
                          <p className="text-[10px] text-slate-400 mb-1">⚠️ {t('painPoints')}</p>
                          <ul className="text-xs text-slate-300 space-y-0.5">
                            {commerce.painPoints.map((item: string, i: number) => (
                              <li key={i} className="flex gap-1"><span className="text-purple-400">•</span> {item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {commerce.conversionTriggers?.length > 0 && (
                        <div>
                          <p className="text-[10px] text-slate-400 mb-1">🎯 {t('conversionTriggers')}</p>
                          <ul className="text-xs text-slate-300 space-y-0.5">
                            {commerce.conversionTriggers.map((item: string, i: number) => (
                              <li key={i} className="flex gap-1"><span className="text-purple-400">•</span> {item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {commerce.targetAudience && (
                        <p className="text-xs text-slate-300">🎯 <span className="text-slate-400">{t('targetAudience')}：</span>{commerce.targetAudience}</p>
                      )}
                      {commerce.priceInfo && (
                        <p className="text-xs text-slate-300">💰 <span className="text-slate-400">{t('pricePromotion')}：</span>{commerce.priceInfo}</p>
                      )}
                      {commerce.contentStructure?.length > 0 && (
                        <div>
                          <p className="text-[10px] text-slate-400 mb-1">🧩 {t('contentStructure')}</p>
                          <div className="flex flex-wrap gap-1">
                            {commerce.contentStructure.map((item: string, i: number) => (
                              <span key={i} className="text-[10px] px-1.5 py-0.5 bg-slate-700/60 text-slate-300 rounded-full">{i + 1}. {item}</span>
                            ))}
                          </div>
                        </div>
                      )}
                      {commerce.viralReason?.length > 0 && (
                        <div>
                          <p className="text-[10px] text-slate-400 mb-1">📈 {t('viralReason')}</p>
                          <ul className="text-xs text-slate-300 space-y-0.5">
                            {commerce.viralReason.map((item: string, i: number) => (
                              <li key={i} className="flex gap-1"><span className="text-purple-400">•</span> {item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {commerce.platformFit?.length > 0 && (
                        <div>
                          <p className="text-[10px] text-slate-400 mb-1">📱 {t('platformFit')}</p>
                          <div className="flex flex-wrap gap-1">
                            {commerce.platformFit.map((item: string, i: number) => (
                              <span key={i} className="text-[10px] px-1.5 py-0.5 bg-blue-500/10 text-blue-300 rounded-full">{item}</span>
                            ))}
                          </div>
                        </div>
                      )}
                      {commerce.rewriteAngles?.length > 0 && (
                        <div>
                          <p className="text-[10px] text-slate-400 mb-1">✍️ {t('rewriteAngles')}</p>
                          <div className="flex flex-wrap gap-1">
                            {commerce.rewriteAngles.map((item: string, i: number) => (
                              <span key={i} className="text-[10px] px-1.5 py-0.5 bg-emerald-500/10 text-emerald-300 rounded-full">{item}</span>
                            ))}
                          </div>
                        </div>
                      )}
                      {commerce.copyScript && (
                        <div>
                          <p className="text-[10px] text-slate-400 mb-1">📝 {t('aiScript')}</p>
                          <p className="text-xs text-slate-300 bg-slate-900/80 p-2 rounded-lg whitespace-pre-wrap max-h-32 overflow-y-auto">
                            {commerce.copyScript}
                          </p>
                          <button
                            onClick={() => copyCommerceCard(commerce, 'script')}
                            className="mt-1 text-[10px] text-purple-400 hover:text-purple-300"
                          >
                            {copied === 'commerce-script' ? `✓ ${t('copied')}` : `📋 ${t('copyScript')}`}
                          </button>
                        </div>
                      )}
                      {commerce.tags?.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {commerce.tags.map((t: string, i: number) => (
                            <span key={i} className="text-[10px] px-1.5 py-0.5 bg-purple-500/20 text-purple-300 rounded-full">#{t}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    )
                  })()}
                </div>
              )}

              {/* Copywriting */}
              {task.status === 'completed' && task.copyText && (
                <div className="p-3 bg-slate-900/60 rounded-xl">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-slate-300">{t('copywritingLabel')}</span>
                    <div className="flex gap-2">
                      <button onClick={() => clip(task.copyText!, 'copy')} className="text-xs text-slate-300 hover:text-orange transition">
                        {copied === 'copy' ? <><Check className="w-3 h-3 inline" /> Copied</> : <><Copy className="w-3 h-3 inline" /> Copy</>}
                      </button>
                      <button onClick={() => {
                        const blob = new Blob([task.copyText!], { type: 'text/plain' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `${task.title || 'copywriting'}.txt`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }} className="text-xs text-slate-300 hover:text-orange transition">
                        <Download className="w-3 h-3 inline" /> TXT
                      </button>
                    </div>
                  </div>
                  <p className="text-sm text-slate-300 whitespace-pre-wrap max-h-28 overflow-y-auto">{task.copyText}</p>
                </div>
              )}

              {/* Subtitle */}
              {task.status === 'completed' && (task.subtitleFiles?.length || 0) > 0 && (
                <div className="flex gap-2 flex-wrap">
                  {task.subtitleFiles!.map(s => (
                    <a key={s.filename} href={`${BASE_URL}${s.url}`} download={s.filename} className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs bg-slate-700/30 border border-slate-700/60 text-slate-300 hover:text-white transition-all">
                      <Languages className="w-3 h-3" />{s.filename}
                    </a>
                  ))}
                </div>
              )}

              {/* AI 摘要（纯文本版本） */}
              {typeof task.summaryText === 'string' && task.summaryText && (
                <div className="p-3 bg-gradient-to-r from-orange/10 to-orange-light/10 rounded-xl border border-orange/20">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs text-orange">🤖</span>
                    <span className="text-xs text-orange font-medium">{t('aiSummary')}</span>
                  </div>
                  <p className="text-sm text-slate-300 leading-relaxed">{task.summaryText}</p>
                </div>
              )}

              {/* AI 视频总结 */}
              {task.summaryText?.summary && (
                <div className="p-3 bg-cyan-500/5 border border-cyan-500/15 rounded-xl">
                  <p className="text-xs text-cyan-400 mb-2 font-medium">🤖 AI 视频总结</p>
                  <p className="text-sm text-slate-300 mb-2">{task.summaryText.summary}</p>
                  {task.summaryText.tags && (
                    <div className="flex flex-wrap gap-1 mb-2">
                      {task.summaryText.tags.map((tag: string, i: number) => (
                        <span key={i} className="px-2 py-0.5 bg-cyan-500/10 text-cyan-300 text-[10px] rounded-full">#{tag}</span>
                      ))}
                    </div>
                  )}
                  {task.summaryText.titles && (
                    <div className="text-[11px] text-slate-400 space-y-0.5">
                      <p className="text-cyan-400/60">📝 推荐标题：</p>
                      {task.summaryText.titles.slice(0,3).map((t: string, i: number) => (
                        <p key={i} className="cursor-pointer hover:text-cyan-300" onClick={() => clip(t, 'title' + i)}>• {t}</p>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ASR */}
              {task.asrText && (
                <div className="p-3 bg-slate-900/60 rounded-xl">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-slate-300">{t('speechToTextLabel')}</span>
                    <div className="flex gap-2">
                      <button onClick={() => clip(task.asrText!, 'asr')} className="text-xs text-slate-300 hover:text-orange transition">
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
                      }} className="text-xs text-slate-300 hover:text-orange transition">
                        <Download className="w-3 h-3 inline" /> TXT
                      </button>
                    </div>
                  </div>
                  <p className="text-sm text-slate-300 whitespace-pre-wrap max-h-32 overflow-y-auto">{task.asrText}</p>
                </div>
              )}

              {task.subbedVideoUrl && (
                <button
                  onClick={async () => {
                    setSubbedDownloading(true)
                    try {
                      const subbedVideoUrl = task.subbedVideoUrl!
                      const fullUrl = subbedVideoUrl.startsWith('http') ? subbedVideoUrl : `${BASE_URL}${subbedVideoUrl}`
                      const a = document.createElement('a')
                      a.href = fullUrl
                      a.download = (task.title || 'subbed') + '_subbed.mp4'
                      document.body.appendChild(a)
                      a.click()
                      document.body.removeChild(a)
                      await new Promise(r => setTimeout(r, 1000))
                    } catch {}
                    setSubbedDownloading(false)
                  }}
                  disabled={subbedDownloading}
                  className="flex items-center justify-center gap-2 w-full py-3.5 rounded-2xl text-sm font-semibold bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 hover:bg-cyan-500/20 transition-all disabled:opacity-50"
                >
                  {subbedDownloading ? <><Loader2 className="w-4 h-4 animate-spin" /> 下载中...</> : <>🎬 下载翻译字幕视频</>}
                </button>
              )}

              {task.translatedText && (
                <div className="p-3 bg-slate-900/60 rounded-xl">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-slate-300">{t('translationLabel')}</span>
                    <div className="flex gap-2">
                      <button onClick={() => clip(task.translatedText!, 'translated')} className="text-xs text-slate-300 hover:text-orange transition">
                        {copied === 'translated' ? <><Check className="w-3 h-3 inline" /> Copied</> : <><Copy className="w-3 h-3 inline" /> Copy</>}
                      </button>
                      <button onClick={() => {
                        const blob = new Blob([task.translatedText!], { type: 'text/plain' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `${task.title || 'translation'}.txt`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }} className="text-xs text-slate-300 hover:text-orange transition">
                        <Download className="w-3 h-3 inline" /> TXT
                      </button>
                    </div>
                  </div>
                  <p className="text-sm text-slate-300 whitespace-pre-wrap max-h-32 overflow-y-auto">{task.translatedText}</p>
                </div>
              )}

              {task.status === 'error' && task.error && <p className="text-sm text-red-400">{getErrorMessage(task.error)}</p>}
            </div>
          )}
            </div>
          </div>

          {/* How to Use - 精简版 */}
          <div className={`mt-5 rounded-2xl px-5 py-3 border ${isDark ? 'bg-slate-900/60 border-slate-700/60' : 'bg-light-input border-light-border'}`}>
            <div className={`flex items-center gap-4 text-xs ${isDark ? 'text-slate-300' : 'text-light-textSecondary'}`}>
              <span className="flex items-center gap-1"><span className="text-orange font-bold">1</span> {t('step1CopyLink')}</span>
              <span>→</span>
              <span className="flex items-center gap-1"><span className="text-orange font-bold">2</span> {t('step2Paste')}</span>
              <span>→</span>
              <span className="flex items-center gap-1"><span className="text-orange font-bold">3</span> {t('step3Download')}</span>
            </div>
          </div>

          {/* Pricing Card - 免费用户可见 */}
          {!isVip && (
            <div className="mt-5 bg-slate-800/40 backdrop-blur-sm rounded-2xl p-4 border border-slate-700/50">
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div className="bg-slate-700/30 rounded-xl p-3 text-center">
                  <p className="text-sm font-bold text-slate-300 mb-2">🆓 {t('pricingFree')}</p>
                  <div className="space-y-1 text-[11px] text-slate-400">
                    <p>{t('pricingTimes')}</p>
                    <p>{t('pricing720p')}</p>
                    <p>{t('pricingSingleLink')}</p>
                    <p className="text-slate-500">❌ {t('aiCopyTitle')}</p>
                  </div>
                </div>
                <div className="bg-gradient-to-br from-amber-500/10 to-orange/10 rounded-xl p-3 text-center border border-amber-500/20">
                  <p className="text-sm font-bold text-amber-400 mb-2">⭐ {t('pricingPro')}</p>
                  <div className="space-y-1 text-[11px] text-amber-300/80">
                    <p>{t('pricingUnlimited')}</p>
                    <p>{t('pricing4K')}</p>
                    <p>{t('batchDownload')}</p>
                    <p>🤖 {t('aiCopyTitle')}</p>
                  </div>
                </div>
              </div>
              <div className="flex gap-3">
                <button className="flex-1 py-2 rounded-xl text-xs font-medium bg-slate-700/50 text-slate-400 border border-slate-600/30 cursor-default">
                  {t('pricingCurrentPlan')}
                </button>
                <button
                  onClick={() => setShowUpgradePopup(true)}
                  className="flex-1 py-2 rounded-xl text-xs font-bold bg-gradient-to-r from-amber-500 to-orange text-white hover:from-amber-600 hover:to-orange-600 transition-all"
                >
                  $6/月
                </button>
              </div>
            </div>
          )}

          {/* Pro 功能预览 — 游客可见，点击引导升级 */}
          {!isVip && (
            <div className="mt-4 bg-slate-800/30 rounded-2xl p-4 border border-slate-700/30">
              <p className="text-xs text-slate-500 mb-3">⭐ {t('proFeaturePreview')}</p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {[
                  { icon: '🎬', title: t('proFeatureOriginal4K'), desc: t('proFeatureOriginal4KDesc') },
                  { icon: '📦', title: t('proFeatureBatch'), desc: t('proFeatureBatchDesc') },
                  { icon: '🤖', title: t('proFeatureAiCopy'), desc: t('proFeatureAiCopyDesc') },
                  { icon: '📊', title: t('proFeatureAiSummary'), desc: t('proFeatureAiSummaryDesc') },
                  { icon: '🌐', title: t('proFeatureTranslatedSubtitle'), desc: t('proFeatureTranslatedSubtitleDesc') },
                  { icon: '🔓', title: t('proFeatureUnlimited'), desc: t('proFeatureUnlimitedDesc') },
                ].map(f => (
                  <div key={f.title} className="flex items-start gap-2 p-2 bg-slate-700/20 rounded-lg cursor-pointer hover:bg-slate-700/30 transition" onClick={() => setShowUpgradePopup(true)}>
                    <span className="text-base">{f.icon}</span>
                    <div>
                      <p className="text-slate-300 font-medium">{f.title}</p>
                      <p className="text-slate-500">{f.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* // Download History - Enhanced */}
          <div className="mt-5">
            <button onClick={() => setShowHistory(!showHistory)}
              data-testid="history-toggle"
              className={`w-full flex items-center justify-between px-5 py-3 rounded-2xl border text-sm transition ${isDark ? 'bg-slate-900/60 border-slate-700/60 text-slate-300 hover:text-slate-300' : 'bg-light-surface border-light-border text-light-textSecondary hover:text-light-text'}`}>
              <span className="flex items-center gap-2">
                <Clock className="w-5 h-5" /> {t('downloadHistory')}
                {historyTotal > 0 && <span className="bg-orange/20 text-orange px-2 py-0.5 rounded text-xs">{historyTotal}</span>}
              </span>
              <span className="flex items-center gap-2">
                {history.length > 0 && showHistory && (
                  <button onClick={(e) => { e.stopPropagation(); clearAllHistory() }} className="text-xs text-red-400 hover:text-red-300 transition">{t('clearAllHistory')}</button>
                )}
                {showHistory ? <ChevronDown className="w-5 h-5" /> : <ChevronUp className="w-5 h-5" />}
              </span>
            </button>
            {showHistory && (
              <div data-testid="history-panel" className={`mt-2 rounded-2xl border overflow-hidden ${isDark ? 'bg-slate-900/60 border-slate-700/60' : 'bg-light-surface border-light-border'}`}>
                {history.length > 0 && (
                  <div className={`p-3 border-b ${isDark ? 'border-slate-700/30 bg-slate-950/30' : 'border-light-border bg-light-bg'}`}>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <p className="text-xs font-semibold text-slate-300">📊 {t('materialDashboard')}</p>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-slate-500">{t('dashboardFromHistory')}</span>
                        <button
                          onClick={() => setShowWorkbenchManager(v => !v)}
                          data-testid="workbench-toggle"
                          className={`px-2 py-1 rounded-lg border text-[10px] transition ${showWorkbenchManager ? 'bg-orange/15 border-orange/30 text-orange' : 'bg-slate-800/60 border-slate-700/60 text-slate-300 hover:text-orange'}`}
                        >
                          {t('workbenchManager')}
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                      {[
                        { label: t('dashboardDownloads'), value: materialStats.total, color: 'text-orange' },
                        { label: t('dashboardAiCards'), value: materialStats.aiCards, color: 'text-purple-300' },
                        { label: t('dashboardPublishPacks'), value: materialStats.publishPacks, color: 'text-emerald-300' },
                        { label: t('dashboardGroups'), value: materialStats.groups, color: 'text-cyan-300' },
                        { label: t('dashboardFavorites'), value: materialStats.favorites, color: 'text-yellow-300' },
                        { label: t('dashboardTopPlatform'), value: `${materialStats.topPlatform}${materialStats.topPlatformCount ? ` · ${materialStats.topPlatformCount}` : ''}`, color: 'text-slate-200' },
                      ].map(stat => (
                        <div key={stat.label} className={`rounded-xl px-3 py-2 border ${isDark ? 'bg-slate-800/45 border-slate-700/40' : 'bg-light-surface border-light-border'}`}>
                          <p className="text-[10px] text-slate-500">{stat.label}</p>
                          <p className={`mt-0.5 font-bold ${stat.color}`}>{stat.value}</p>
                        </div>
                      ))}
                    </div>
                    {showWorkbenchManager && (
                      <div className="grid md:grid-cols-2 gap-3 mt-3">
                        <div className="rounded-xl bg-slate-900/60 border border-slate-700/60 p-3">
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-xs text-slate-300 font-semibold">{t('tagManager')}</p>
                            <span className="text-[10px] text-slate-500">{t('tagCount', { count: historyTagStats.length })}</span>
                          </div>
                          {historyTagStats.length === 0 ? (
                            <p className="text-xs text-slate-500">{t('none')}</p>
                          ) : (
                            <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                              {historyTagStats.map(({ tag, count }) => (
                                <button
                                  key={tag}
                                  onClick={() => toggleHistoryTagFilter(tag)}
                                  data-testid={`tag-chip-${tag}`}
                                  className={`px-2 py-1 rounded-full border text-[10px] transition ${historyTagFilter === tag ? 'bg-purple-500/20 border-purple-500/40 text-purple-300' : 'bg-slate-800/50 border-slate-700/50 text-slate-300 hover:text-purple-300'}`}
                                >
                                  #{tag} · {count}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="rounded-xl bg-slate-900/60 border border-slate-700/60 p-3">
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-xs text-slate-300 font-semibold">{t('groupSidebar')}</p>
                            <button
                              onClick={() => setHistoryGroupFilter('all')}
                              className="text-[10px] text-slate-500 hover:text-orange"
                            >
                              {t('filterAll')}
                            </button>
                          </div>
                          <div className="space-y-1.5 max-h-32 overflow-y-auto">
                            <button
                              onClick={() => setHistoryGroupFilter('__ungrouped')}
                              className={`w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-xs transition ${historyGroupFilter === '__ungrouped' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-800/45 text-slate-300 hover:text-emerald-300'}`}
                            >
                              <span>{t('ungrouped')}</span>
                              <span>{historyGroupStats.ungrouped}</span>
                            </button>
                            {historyGroupStats.groups.map(({ group, count }) => (
                              <div key={group} className={`rounded-lg px-2 py-1.5 ${historyGroupFilter === group ? 'bg-emerald-500/15' : 'bg-slate-800/45'}`}>
                                {renamingGroupName === group ? (
                                  <div className="flex items-center gap-1">
                                    <input
                                      value={renameGroupText}
                                      onChange={(e) => setRenameGroupText(e.target.value)}
                                      className="min-w-0 flex-1 px-2 py-1 rounded bg-slate-950 border border-slate-700 text-xs text-white"
                                      autoFocus
                                    />
                                    <button onClick={renameGroup} disabled={groupRenameLoading} className="text-[10px] text-orange disabled:opacity-50">{t('save')}</button>
                                    <button onClick={() => setRenamingGroupName('')} disabled={groupRenameLoading} className="text-[10px] text-slate-500 disabled:opacity-50">{t('cancel')}</button>
                                  </div>
                                ) : (
                                  <div className="flex items-center gap-2">
                                    <button onClick={() => setHistoryGroupFilter(group)} className="flex-1 min-w-0 text-left text-xs text-slate-300 hover:text-emerald-300 truncate">
                                      {group}
                                    </button>
                                    <span className="text-[10px] text-emerald-300">{count}</span>
                                    <button onClick={() => startRenameGroup(group)} className="text-[10px] text-slate-500 hover:text-orange">{t('rename')}</button>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <div className={`p-3 border-b space-y-2 ${isDark ? 'border-slate-700/30' : 'border-light-border'}`}>
                  <div className="flex gap-2 items-center">
                    {filteredHistory.length > 0 && <input type="checkbox" checked={selectedTasks.size === filteredHistory.length} onChange={toggleSelectAll} className={`w-3.5 h-3.5 rounded-full ${isDark ? 'border-slate-600' : 'border-light-border'}`} />}
                    {selectedTasks.size > 0 && (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[10px] text-slate-400">{t('selectedCount', { count: selectedTasks.size })}</span>
                        <button onClick={() => openBatchTagEditor('add')} data-testid="batch-tags-button" className="px-2 py-1 bg-blue-500/15 text-blue-300 border border-blue-500/30 rounded-lg text-[10px]">{t('batchTags')}</button>
                        <button onClick={() => openBatchTagEditor('remove')} data-testid="batch-remove-tags-button" className="px-2 py-1 bg-red-500/15 text-red-300 border border-red-500/30 rounded-lg text-[10px]">{t('batchRemoveTags')}</button>
                        <button onClick={openBatchGroupEditor} data-testid="batch-group-button" className="px-2 py-1 bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 rounded-lg text-[10px]">{t('batchGroup')}</button>
                        {history.some(item => selectedTasks.has(item.taskId) && item.status === 'completed' && !getHistoryAnalysis(item)) && (
                          <button
                            onClick={generateSelectedCommerceCards}
                            disabled={batchCardGenerating}
                            className="px-2 py-1 bg-orange/15 text-orange border border-orange/30 rounded-lg text-[10px] disabled:opacity-60"
                          >
                            {batchCardGenerating ? t('generatingAiCards', batchCardProgress) : t('batchGenerateAiCards')}
                          </button>
                        )}
                        {history.some(item => selectedTasks.has(item.taskId) && getHistoryAnalysis(item)) && (
                          <div className="flex items-center gap-1">
                            <span className="text-[10px] text-slate-500">{t('batchRewritePacks')}</span>
                            <select
                              value={rewriteStyle}
                              onChange={(e) => setRewriteStyle(e.target.value)}
                              disabled={!!batchRewriteLoadingKey}
                              className="px-2 py-1 bg-slate-900/50 text-slate-300 border border-slate-700/50 rounded-lg text-[10px] disabled:opacity-60"
                            >
                              {REWRITE_STYLES.map(style => (
                                <option key={style.id} value={style.id}>{t(style.labelKey)}</option>
                              ))}
                            </select>
                            <button
                              onClick={() => generateSelectedRewritePacks('all', rewriteStyle)}
                              disabled={!!batchRewriteLoadingKey}
                              className="px-2 py-1 bg-orange/15 text-orange border border-orange/30 rounded-lg text-[10px] disabled:opacity-60"
                            >
                              {batchRewriteLoadingKey === `all:${rewriteStyle}` ? t('generatingAiCards', batchCardProgress) : t('allPlatforms')}
                            </button>
                            <button
                              onClick={() => generateSelectedRewritePacks('all', 'all')}
                              disabled={!!batchRewriteLoadingKey}
                              className="px-2 py-1 bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 rounded-lg text-[10px] disabled:opacity-60"
                            >
                              {batchRewriteLoadingKey === 'all:all' ? t('generatingAiCards', batchCardProgress) : t('completePublishPacks')}
                            </button>
                            {REWRITE_PLATFORMS.map(platform => {
                              const key = `${platform.id}:${rewriteStyle}`
                              return (
                                <button
                                  key={platform.id}
                                  onClick={() => generateSelectedRewritePacks(platform.id, rewriteStyle)}
                                  disabled={!!batchRewriteLoadingKey}
                                  className="px-2 py-1 bg-purple-500/15 text-purple-300 border border-purple-500/30 rounded-lg text-[10px] disabled:opacity-60"
                                >
                                  {batchRewriteLoadingKey === key ? t('generatingAiCards', batchCardProgress) : platform.label}
                                </button>
                              )
                            })}
                          </div>
                        )}
                        <button onClick={() => exportSelectedCommerceCards('md')} className="px-2 py-1 bg-purple-500/15 text-purple-300 border border-purple-500/30 rounded-lg text-[10px]">MD</button>
                        <button onClick={() => exportSelectedCommerceCards('txt')} className="px-2 py-1 bg-purple-500/15 text-purple-300 border border-purple-500/30 rounded-lg text-[10px]">TXT</button>
                        <button onClick={() => exportSelectedCommerceCards('csv')} className="px-2 py-1 bg-purple-500/15 text-purple-300 border border-purple-500/30 rounded-lg text-[10px]">CSV</button>
                        <button onClick={() => exportSelectedCommerceCards('pack')} className="px-2 py-1 bg-orange/15 text-orange border border-orange/30 rounded-lg text-[10px]">PACK</button>
                        <button onClick={() => exportSelectedCommerceCards('packCsv')} className="px-2 py-1 bg-orange/15 text-orange border border-orange/30 rounded-lg text-[10px]">PACK CSV</button>
                        <button onClick={deleteSelected} className="px-2 py-1 bg-red-500/20 text-red-400 border border-red-500/50 rounded-lg text-[10px]">{t('clearAll')}</button>
                      </div>
                    )}
                    <div className="flex-1 relative">
                      <input type="text" value={historySearch} onChange={(e) => setHistorySearch(e.target.value)} placeholder={t('searchPlaceholder')} data-testid="history-search-input" className={`w-full pl-8 pr-3 py-2 border rounded-lg text-sm placeholder:text-slate-300 ${isDark ? 'bg-slate-800/50 border-slate-700/50 text-white' : 'bg-light-bg border-light-border text-light-text'}`} />
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-300" />
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 items-center">
                    <select value={historyFilter} onChange={(e) => setHistoryFilter(e.target.value as 'all' | 'completed' | 'error' | 'favorites')} className={`px-2 py-1.5 border rounded-lg text-xs ${isDark ? 'bg-slate-800/50 border-slate-700/50 text-white' : 'bg-light-bg border-light-border text-light-text'}`}>
                      <option value="all">{t('filterAll')}</option>
                      <option value="completed">{t('filterDone')}</option>
                      <option value="error">{t('filterFailed')}</option>
                      <option value="favorites">{t('filterFav')}</option>
                    </select>
                    <select value={historyPlatformFilter} onChange={(e) => setHistoryPlatformFilter(e.target.value)} className={`px-2 py-1.5 border rounded-lg text-xs ${isDark ? 'bg-slate-800/50 border-slate-700/50 text-white' : 'bg-light-bg border-light-border text-light-text'}`}>
                      <option value="all">{t('allPlatforms')}</option>
                      {historyPlatformOptions.map(platform => (
                        <option key={platform} value={platform}>{getPlatformLabel(platform)}</option>
                      ))}
                    </select>
                    <select value={historyGroupFilter} onChange={(e) => setHistoryGroupFilter(e.target.value)} className={`px-2 py-1.5 border rounded-lg text-xs ${isDark ? 'bg-slate-800/50 border-slate-700/50 text-white' : 'bg-light-bg border-light-border text-light-text'}`}>
                      <option value="all">{t('allGroups')}</option>
                      <option value="__ungrouped">{t('ungrouped')}</option>
                      {historyGroupOptions.map(group => (
                        <option key={group} value={group}>{group}</option>
                      ))}
                    </select>
                    <select value={historyTagFilter} onChange={(e) => setHistoryTagFilter(e.target.value)} className={`px-2 py-1.5 border rounded-lg text-xs ${isDark ? 'bg-slate-800/50 border-slate-700/50 text-white' : 'bg-light-bg border-light-border text-light-text'}`}>
                      <option value="all">{t('allTags')}</option>
                      {historyTagOptions.map(tag => (
                        <option key={tag} value={tag}>#{tag}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => setHistoryAiOnly(v => !v)}
                      className={`px-2 py-1.5 border rounded-lg text-xs transition ${historyAiOnly ? 'bg-purple-500/20 border-purple-500/40 text-purple-300' : isDark ? 'bg-slate-800/50 border-slate-700/50 text-slate-300' : 'bg-light-bg border-light-border text-light-text'}`}
                    >
                      {t('aiCardsOnly')}
                    </button>
                    <button
                      onClick={() => setHistoryPackOnly(v => !v)}
                      className={`px-2 py-1.5 border rounded-lg text-xs transition ${historyPackOnly ? 'bg-orange/20 border-orange/40 text-orange' : isDark ? 'bg-slate-800/50 border-slate-700/50 text-slate-300' : 'bg-light-bg border-light-border text-light-text'}`}
                    >
                      {t('publishPacksOnly')}
                    </button>
                    <button
                      onClick={() => setHistoryPackTodoOnly(v => !v)}
                      className={`px-2 py-1.5 border rounded-lg text-xs transition ${historyPackTodoOnly ? 'bg-yellow-500/20 border-yellow-500/40 text-yellow-300' : isDark ? 'bg-slate-800/50 border-slate-700/50 text-slate-300' : 'bg-light-bg border-light-border text-light-text'}`}
                    >
                      {t('publishPacksTodoOnly')}
                    </button>
                    {filteredHistory.some(item => getHistoryAnalysis(item) && !isHistoryRewritePackComplete(item)) && (
                      <button
                        onClick={selectPackTodoItems}
                        className="px-2 py-1.5 bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 rounded-lg text-xs transition"
                      >
                        {t('selectPublishPackTodos')}
                      </button>
                    )}
                    {(batchCardGenerating || batchRewriteLoadingKey || batchCardMessage) && (
                      <span className="text-[10px] text-orange">
                        {batchCardGenerating || batchRewriteLoadingKey ? t('generatingAiCards', batchCardProgress) : batchCardMessage}
                      </span>
                    )}
                  </div>
                  {popularHistoryTags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 items-center">
                      <span className="text-[10px] text-slate-500">{t('popularTags')}</span>
                      {popularHistoryTags.slice(0, 8).map(({ tag, count }) => (
                        <button
                          key={tag}
                          onClick={() => toggleHistoryTagFilter(tag)}
                          className={`px-2 py-1 rounded-full border text-[10px] transition ${historyTagFilter === tag ? 'bg-purple-500/20 border-purple-500/40 text-purple-300' : isDark ? 'bg-slate-800/40 border-slate-700/50 text-slate-300 hover:text-purple-300' : 'bg-light-bg border-light-border text-light-textSecondary'}`}
                        >
                          #{tag} · {count}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="max-h-60 overflow-y-auto">
                  {filteredHistory.length === 0 ? <p className="py-8 text-center text-sm text-slate-500">{historySearch || historyFilter !== 'all' || historyPlatformFilter !== 'all' || historyGroupFilter !== 'all' || historyTagFilter !== 'all' || historyAiOnly || historyPackOnly || historyPackTodoOnly ? t('noResults') : t('noHistory')}</p> : filteredHistory.map(item => (
                    <div key={item.taskId} className={`flex items-center gap-2 px-3 py-2 border-b border-slate-700/20 last:border-0 hover:bg-slate-900/60 transition ${selectedTasks.has(item.taskId) ? 'bg-orange/10' : ''}`}>
                      <input type="checkbox" checked={selectedTasks.has(item.taskId)} onChange={() => { const s = new Set(selectedTasks); selectedTasks.has(item.taskId) ? s.delete(item.taskId) : s.add(item.taskId); setSelectedTasks(s) }} className="w-3.5 h-3.5 rounded-full border-slate-600 shrink-0" />
                      {item.thumbnailUrl ? <button onClick={() => openSavedFile(item)} className="relative shrink-0 group"><img src={`${BASE_URL}${item.thumbnailUrl}`} alt="" className="w-12 h-9 object-cover rounded-lg" /><div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-lg opacity-0 group-hover:opacity-100 transition"><Play className="w-4 h-4 text-white" /></div></button> : <div className="w-12 h-9 rounded-lg bg-slate-700/50 flex items-center justify-center shrink-0"><Video className="w-4 h-4 text-slate-500" /></div>}
                      <div className="flex-1 min-w-0 overflow-hidden">
                        <div className="overflow-hidden leading-5" title={item.title || t('untitled')}>
                          <p className={`text-xs text-slate-300 font-medium whitespace-nowrap ${(item.title || '').length > 20 ? 'animate-marquee' : 'truncate'}`}>{item.title || t('untitled')}</p>
                        </div>
                        <div className="flex items-center justify-between gap-2 mt-0.5">
                          <div className="flex items-center gap-1.5 min-w-0 overflow-hidden whitespace-nowrap">
                            {item.platform && <span className="shrink-0 text-[10px] text-orange bg-orange/10 px-1.5 py-0.5 rounded">{getPlatformLabel(item.platform)}</span>}
                            {item.height && <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${item.height >= 720 ? 'text-yellow-400 bg-yellow-500/10' : 'text-emerald-400 bg-emerald-500/10'}`}>{item.height}p</span>}
                            {normalizeHistoryTags(item.tags).slice(0, 2).map(tag => (
                              <span key={tag} className="min-w-0 max-w-[56px] truncate text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/10 text-purple-300" title={`#${tag}`}>#{tag}</span>
                            ))}
                            {normalizeHistoryTags(item.tags).length > 2 && (
                              <span className="shrink-0 text-[10px] text-slate-500">+{normalizeHistoryTags(item.tags).length - 2}</span>
                            )}
                            {getHistoryAnalysis(item) && (
                              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/15 text-purple-300" title={t('aiCommerceCardTitle')}>AI</span>
                            )}
                            {item.groupName && (
                              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300" title={t('materialGroup')}>{item.groupName}</span>
                            )}
                            {getHistoryAnalysis(item) && (
                              <span
                                className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full ${isHistoryRewritePackComplete(item) ? 'bg-emerald-500/15 text-emerald-300' : 'bg-orange/15 text-orange'}`}
                                title={getMissingRewritePackLabels(item).length > 0 ? getMissingRewritePackLabels(item).slice(0, 12).join('\n') : t('platformPublishPack')}
                              >
                                PACK {getHistoryRewritePackCount(item)}/{getRequiredRewritePackCount()}
                              </span>
                            )}
                            {getHistoryAnalysis(item) && !isHistoryRewritePackComplete(item) && (
                              <span
                                className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-500/15 text-yellow-300"
                                title={getMissingRewritePackLabels(item).slice(0, 12).join('\n')}
                              >
                                {t('missingPublishPacks', { count: getRequiredRewritePackCount() - getHistoryRewritePackCount(item) })}
                              </span>
                            )}
                          </div>
                          <span className="shrink-0 text-[10px] text-slate-500">{new Date(item.createdAt).toLocaleString(i18n.language === 'zh-CN' ? 'zh-CN' : i18n.language === 'ja' ? 'ja-JP' : i18n.language === 'ko' ? 'ko-KR' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                      </div>
                      {item.status === 'error' && <button onClick={() => retryTask(item)} className="p-1.5 text-orange-500 hover:text-orange"><Loader2 className="w-5 h-5" /></button>}
                      {item.status === 'completed' && <button onClick={() => retryTask(item)} title="Re-download" className="p-1 text-slate-500 hover:text-green-400"><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg></button>}
                      <button onClick={() => openMaterialEditor(item)} className="p-1 text-slate-500 hover:text-purple-300" title="编辑素材"><FileText className="w-4 h-4" /></button>
                      <button onClick={() => toggleFavorite(item.taskId)} className={`p-1.5 ${item.isFavorite || favorites.has(item.taskId) ? 'text-yellow-400' : 'text-slate-500 hover:text-yellow-400'}`}><svg className="w-4 h-4" fill={item.isFavorite || favorites.has(item.taskId) ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg></button>
                      <button onClick={() => del(item.taskId)} className="p-1 text-slate-500 hover:text-red-400"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  ))}
                </div>
              </div>
              {historyHasMore ? (
                <div className="py-2 text-center">
                  <button onClick={loadMoreHistory} disabled={historyLoadingMore} data-testid="load-more-button" className="w-full py-2.5 rounded-xl text-sm font-medium bg-slate-700/30 text-slate-300 hover:bg-slate-700/50 disabled:opacity-50 transition">
                    {historyLoadingMore ? <><Loader2 className="w-4 h-4 inline animate-spin mr-2" />{t('loading')}</> : t('loadMore')}
                  </button>
                </div>
              ) : null}
            )}
          </div>
        </main>

        {showDupConfirm && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
            <div className="bg-slate-800 rounded-2xl p-6 max-w-sm w-full border border-slate-700">
              <h3 className="text-lg font-bold text-white mb-2">{t("alreadyInHistory")}</h3>
              <p className="text-sm text-slate-300 mb-4">{t("downloadAgain")}</p>
              <p className="text-xs text-slate-300 mb-4 truncate">{dupUrl}</p>
              <div className="flex gap-3">
                <button onClick={() => { setShowDupConfirm(false); setPendingDownload(null) }} className="flex-1 py-2 px-4 rounded-xl bg-slate-700 text-slate-300 hover:bg-slate-600 transition">{t("cancel")}</button>
                <button onClick={() => { setShowDupConfirm(false); if (pendingDownload) pendingDownload() }} className="flex-1 py-2 px-4 rounded-xl bg-orange text-white hover:bg-orange-dark transition">{t("downloadAgain")}</button>
              </div>
            </div>
          </div>
        )}

        {showBatchTagEditor && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
            <div className="bg-slate-800 rounded-2xl p-5 max-w-md w-full border border-slate-700">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-base font-bold text-white">{batchTagMode === 'remove' ? t('batchRemoveTags') : t('batchTags')}</h3>
                <button onClick={() => setShowBatchTagEditor(false)} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
              </div>
              <p className="text-xs text-slate-400 mb-3">{t(batchTagMode === 'remove' ? 'batchRemoveTagsHint' : 'batchTagsHint', { count: selectedTasks.size })}</p>
              <label className="block text-xs text-slate-300 mb-1">{t('tags')}</label>
              <input
                value={batchTagsText}
                onChange={(e) => setBatchTagsText(e.target.value)}
                placeholder={t('batchTagsPlaceholder')}
                className="w-full px-3 py-2 rounded-lg bg-slate-900/80 border border-slate-700 text-sm text-white placeholder:text-slate-500"
              />
              {popularHistoryTags.length > 0 && (
                <div className="mt-3">
                  <p className="text-[10px] text-slate-500 mb-1">{t('quickAddPopularTags')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {popularHistoryTags.map(({ tag, count }) => (
                      <button
                        key={tag}
                        onClick={() => setBatchTagsText(prev => appendTagsToInput(prev, [tag]))}
                        type="button"
                        className="px-2 py-1 rounded-full bg-purple-500/10 border border-purple-500/20 text-purple-300 text-[10px] hover:bg-purple-500/20 transition"
                      >
                        #{tag} · {count}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex gap-3 mt-4">
                <button onClick={() => setShowBatchTagEditor(false)} disabled={batchTagsLoading} className="flex-1 py-2 rounded-xl bg-slate-700 text-slate-300 hover:bg-slate-600 transition disabled:opacity-60">{t('cancel')}</button>
                <button onClick={saveBatchTags} disabled={batchTagsLoading} className={`flex-1 py-2 rounded-xl text-white transition disabled:opacity-60 ${batchTagMode === 'remove' ? 'bg-red-500 hover:bg-red-600' : 'bg-orange hover:bg-orange-dark'}`}>
                  {batchTagsLoading ? t('saving') : t(batchTagMode === 'remove' ? 'removeTags' : 'applyTags')}
                </button>
              </div>
            </div>
          </div>
        )}

        {showBatchGroupEditor && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
            <div className="bg-slate-800 rounded-2xl p-5 max-w-md w-full border border-slate-700">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-base font-bold text-white">{t('batchGroup')}</h3>
                <button onClick={() => setShowBatchGroupEditor(false)} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
              </div>
              <p className="text-xs text-slate-400 mb-3">{t('batchGroupHint', { count: selectedTasks.size })}</p>
              <label className="block text-xs text-slate-300 mb-1">{t('materialGroup')}</label>
              <input
                value={batchGroupName}
                onChange={(e) => setBatchGroupName(e.target.value)}
                placeholder={t('materialGroupPlaceholder')}
                className="w-full px-3 py-2 rounded-lg bg-slate-900/80 border border-slate-700 text-sm text-white placeholder:text-slate-500"
              />
              <div className="flex gap-3 mt-4">
                <button onClick={() => setShowBatchGroupEditor(false)} disabled={batchGroupLoading} className="flex-1 py-2 rounded-xl bg-slate-700 text-slate-300 hover:bg-slate-600 transition disabled:opacity-60">{t('cancel')}</button>
                <button onClick={saveBatchGroup} disabled={batchGroupLoading} className="flex-1 py-2 rounded-xl bg-orange text-white hover:bg-orange-dark transition disabled:opacity-60">
                  {batchGroupLoading ? t('saving') : t('applyGroup')}
                </button>
              </div>
            </div>
          </div>
        )}

        {editingMaterial && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
            <div className="bg-slate-800 rounded-2xl p-5 max-w-md w-full border border-slate-700">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-base font-bold text-white">{t('editMaterial')}</h3>
                <button onClick={() => setEditingMaterial(null)} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
              </div>
              <p className="text-xs text-slate-400 mb-3 truncate">{editingMaterial.title || editingMaterial.url || editingMaterial.taskId}</p>
              <label className="block text-xs text-slate-300 mb-1">{t('materialGroup')}</label>
              <input
                value={materialGroupName}
                onChange={(e) => setMaterialGroupName(e.target.value)}
                placeholder={t('materialGroupPlaceholder')}
                className="w-full px-3 py-2 rounded-lg bg-slate-900/80 border border-slate-700 text-sm text-white placeholder:text-slate-500 mb-3"
              />
              <label className="block text-xs text-slate-300 mb-1">{t('materialTagsLabel')}</label>
              <input
                value={materialTagsText}
                onChange={(e) => setMaterialTagsText(e.target.value)}
                placeholder={t('batchTagsPlaceholder')}
                className="w-full px-3 py-2 rounded-lg bg-slate-900/80 border border-slate-700 text-sm text-white placeholder:text-slate-500 mb-3"
              />
              {popularHistoryTags.length > 0 && (
                <div className="mb-3">
                  <p className="text-[10px] text-slate-500 mb-1">{t('quickAddPopularTags')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {popularHistoryTags.map(({ tag, count }) => (
                      <button
                        key={tag}
                        onClick={() => setMaterialTagsText(prev => appendTagsToInput(prev, [tag]))}
                        type="button"
                        className="px-2 py-1 rounded-full bg-purple-500/10 border border-purple-500/20 text-purple-300 text-[10px] hover:bg-purple-500/20 transition"
                      >
                        #{tag} · {count}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <label className="block text-xs text-slate-300 mb-1">{t('materialNotes')}</label>
              <textarea
                value={materialNotes}
                onChange={(e) => setMaterialNotes(e.target.value)}
                placeholder={t('materialNotesPlaceholder')}
                rows={4}
                className="w-full px-3 py-2 rounded-lg bg-slate-900/80 border border-slate-700 text-sm text-white placeholder:text-slate-500 resize-none"
              />
              <div className="flex gap-3 mt-4">
                <button onClick={() => setEditingMaterial(null)} className="flex-1 py-2 rounded-xl bg-slate-700 text-slate-300 hover:bg-slate-600 transition">{t('cancel')}</button>
                <button onClick={saveMaterialMeta} className="flex-1 py-2 rounded-xl bg-orange text-white hover:bg-orange-dark transition">{t('save')}</button>
              </div>
            </div>
          </div>
        )}

        {showLexiconEditor && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
            <div className="bg-slate-800 rounded-2xl p-5 max-w-md w-full border border-slate-700">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-base font-bold text-white">ASR 专有词库</h3>
                <button onClick={() => setShowLexiconEditor(false)} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
              </div>
              <p className="text-xs text-slate-400 mb-3">
                添加品牌名、产品名、行业词。语音转文字会优先参考这些词，减少同音错别字。
              </p>
              <textarea
                value={lexiconText}
                onChange={(e) => setLexiconText(e.target.value)}
                placeholder="磁吸&#10;仿真&#10;MagSafe&#10;品牌名&#10;产品型号"
                rows={8}
                className="w-full px-3 py-2 rounded-lg bg-slate-900/80 border border-slate-700 text-sm text-white placeholder:text-slate-500 resize-none"
              />
              <p className="mt-2 text-[11px] text-slate-500">支持逗号、# 或换行分隔，最多保存 200 个词。</p>
              {lexiconMessage && <p className="mt-2 text-xs text-orange">{lexiconMessage}</p>}
              <div className="flex gap-3 mt-4">
                <button onClick={() => setShowLexiconEditor(false)} className="flex-1 py-2 rounded-xl bg-slate-700 text-slate-300 hover:bg-slate-600 transition">关闭</button>
                <button onClick={saveLexicon} disabled={lexiconLoading} className="flex-1 py-2 rounded-xl bg-orange text-white hover:bg-orange-dark transition disabled:opacity-50">
                  {lexiconLoading ? '保存中...' : '保存词库'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <footer className={`text-center py-8 text-xs ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
          <div className="flex justify-center gap-4 mb-2">
            <a href={`/${i18n.language === 'zh-CN' ? '' : i18n.language + '/'}terms.html`} className="hover:text-orange transition">{t('termsOfService')}</a>
            <a href={`/${i18n.language === 'zh-CN' ? '' : i18n.language + '/'}privacy.html`} className="hover:text-orange transition">{t('privacyPolicy')}</a>
            <a href={`/${i18n.language === 'zh-CN' ? '' : i18n.language + '/'}disclaimer.html`} className="hover:text-orange transition">{t('disclaimer')}</a>
          </div>
          <p>{t('personalUseOnly')}</p>
          <p className="mt-1 opacity-60">Orange Downloader v1.0</p>
        </footer>
        <AuthModal isOpen={showAuthModal} onClose={() => setShowAuthModal(false)} onSuccess={handleAuthSuccess} onForgotPassword={() => { setShowAuthModal(false); setShowResetPwd(true); }} />
        {authToken && <ReferralModal token={authToken} isOpen={showReferral} onClose={() => setShowReferral(false)} />}

        {showAdminDashboard && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-slate-800 rounded-2xl w-full max-w-4xl border border-slate-700 shadow-2xl overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
                <div>
                  <h3 className="text-lg font-bold text-white">📈 {t('adminDashboard')}</h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {t('adminDashboardHint')}
                    {adminMetrics?.generatedAt ? ` · ${t('adminGeneratedAt', { time: formatAdminGeneratedAt(adminMetrics.generatedAt) })}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={openAdminDashboard}
                    disabled={adminMetricsLoading}
                    className="px-3 py-1.5 rounded-lg bg-orange/15 text-orange border border-orange/30 text-xs hover:bg-orange/25 transition disabled:opacity-60"
                  >
                    {adminMetricsLoading ? t('loading') : t('refresh')}
                  </button>
                  <button onClick={() => setShowAdminDashboard(false)} className="text-slate-400 hover:text-white">
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>
              {/* Admin tabs */}
              <div className="flex gap-2 border-b border-slate-700/50 pb-2">
                {(['overview', 'users', 'ai'] as const).map(tab => (
                  <button key={tab} onClick={() => setAdminTab(tab)} className={`px-3 py-1.5 rounded-lg text-xs transition ${adminTab === tab ? 'bg-orange/20 text-orange' : 'text-slate-400 hover:text-white'}`}>
                    {tab === 'overview' ? t('adminOverview') : tab === 'users' ? t('adminUsersTab') : t('adminAiUsageTab')}
                  </button>
                ))}
                <div className="ml-auto flex gap-2">
                  {adminTab === 'users' && <a href={`${API_BASE}/api/auth/admin/export/users.csv`} download className="px-2 py-1.5 rounded-lg bg-slate-700/50 text-slate-300 text-[10px] hover:bg-slate-600 transition">📥 CSV</a>}
                  {adminTab === 'ai' && <a href={`${API_BASE}/api/auth/admin/export/ai-usage.csv`} download className="px-2 py-1.5 rounded-lg bg-slate-700/50 text-slate-300 text-[10px] hover:bg-slate-600 transition">📥 CSV</a>}
                </div>
              </div>
              <div className="p-5 max-h-[78vh] overflow-y-auto">
                {adminMetricsLoading ? (
                  <div className="py-10 flex items-center justify-center text-slate-400 text-sm">
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" /> {t('loading')}
                  </div>
                ) : adminMetricsError ? (
                  <div className="rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-sm p-3">{adminMetricsError}</div>
                ) : adminMetrics ? (
                  (() => {
                    const downloadsTrend = adminMetrics.trends?.downloads30d || []
                    const usersTrend = adminMetrics.trends?.newUsers30d || []
                    const platform7d = adminMetrics.platform7d || []
                    const aiBreakdown = adminMetrics.aiBreakdown || []
                    const maxDownloads = maxAdminCount(downloadsTrend)
                    const maxUsers = maxAdminCount(usersTrend)
                    const maxPlatforms = maxAdminCount(platform7d)
                    const maxAi = maxAdminCount(aiBreakdown.map((item: any) => ({ count: item.requests })))
                    return (
                      <div className="space-y-4">
                        <section>
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-xs text-slate-300 font-semibold">{t('adminOverview')}</p>
                            <span className="text-[10px] text-slate-500">{t('adminReadOnly')}</span>
                          </div>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            {[
                              { label: t('adminUsers'), value: adminMetrics.users?.total || 0, sub: t('adminNewUsers7d', { count: adminMetrics.users?.new7d || 0 }) },
                              { label: t('adminProUsers'), value: adminMetrics.users?.pro || 0, sub: t('adminVerifiedUsers', { count: adminMetrics.users?.verified || 0 }) },
                              { label: t('adminDownloads'), value: adminMetrics.downloads?.total || 0, sub: t('adminDownloadsToday', { count: adminMetrics.downloads?.today || 0 }) },
                              { label: t('adminAiRequests'), value: adminMetrics.ai?.requests || 0, sub: t('adminAiRequests7d', { count: adminMetrics.ai?.requests7d || 0 }) },
                              { label: t('adminAiCards'), value: adminMetrics.materials?.aiCards || 0, sub: t('adminFavorites', { count: adminMetrics.materials?.favorites || 0 }) },
                              { label: t('adminGroups'), value: adminMetrics.materials?.groups || 0, sub: t('adminOutputItems', { count: adminMetrics.ai?.outputItems || 0 }) },
                              { label: t('adminDownloads7d'), value: adminMetrics.downloads?.last7d || 0, sub: t('adminFreeUsers', { count: adminMetrics.users?.free || 0 }) },
                              { label: t('adminVerifiedUsers', { count: adminMetrics.users?.verified || 0 }), value: `${Math.round(((adminMetrics.users?.verified || 0) / Math.max(adminMetrics.users?.total || 1, 1)) * 100)}%`, sub: t('adminVerifiedRate') },
                            ].map(card => (
                              <div key={card.label} className="rounded-xl bg-slate-900/60 border border-slate-700/60 p-3">
                                <p className="text-[11px] text-slate-400">{card.label}</p>
                                <p className="text-xl font-bold text-orange mt-1">{card.value}</p>
                                <p className="text-[10px] text-slate-500 mt-1">{card.sub}</p>
                              </div>
                            ))}
                          </div>
                        </section>

                        <section className="grid lg:grid-cols-2 gap-3">
                          <div className="rounded-xl bg-slate-900/60 border border-slate-700/60 p-3">
                            <div className="flex items-center justify-between mb-3">
                              <p className="text-xs text-slate-300 font-semibold">{t('adminDownloadTrend30d')}</p>
                              <span className="text-[10px] text-slate-500">{t('adminTrendTotal', { count: sumAdminSeries(downloadsTrend) })}</span>
                            </div>
                            <div className="flex items-end gap-1 h-28">
                              {downloadsTrend.map((item: any, index: number) => (
                                <div key={item.date} className="flex-1 flex flex-col items-center gap-1">
                                  <div className="w-full flex items-end h-20">
                                    <div
                                      title={`${item.date}: ${item.count}`}
                                      className="w-full min-h-[4px] rounded-t bg-orange/70"
                                      style={{ height: adminBarWidth(item.count, maxDownloads) }}
                                    />
                                  </div>
                                  {index % 5 === 0 && <span className="text-[9px] text-slate-600">{formatAdminDate(item.date)}</span>}
                                </div>
                              ))}
                            </div>
                          </div>
                          <div className="rounded-xl bg-slate-900/60 border border-slate-700/60 p-3">
                            <div className="flex items-center justify-between mb-3">
                              <p className="text-xs text-slate-300 font-semibold">{t('adminUserTrend30d')}</p>
                              <span className="text-[10px] text-slate-500">{t('adminTrendTotal', { count: sumAdminSeries(usersTrend) })}</span>
                            </div>
                            <div className="flex items-end gap-1 h-28">
                              {usersTrend.map((item: any, index: number) => (
                                <div key={item.date} className="flex-1 flex flex-col items-center gap-1">
                                  <div className="w-full flex items-end h-20">
                                    <div
                                      title={`${item.date}: ${item.count}`}
                                      className="w-full min-h-[4px] rounded-t bg-cyan-400/70"
                                      style={{ height: adminBarWidth(item.count, maxUsers) }}
                                    />
                                  </div>
                                  {index % 5 === 0 && <span className="text-[9px] text-slate-600">{formatAdminDate(item.date)}</span>}
                                </div>
                              ))}
                            </div>
                          </div>
                        </section>

                        <section className="grid lg:grid-cols-2 gap-3">
                          <div className="rounded-xl bg-slate-900/60 border border-slate-700/60 p-3">
                            <p className="text-xs text-slate-300 font-semibold mb-3">{t('adminPlatformTrend7d')}</p>
                            {platform7d.length === 0 ? (
                              <span className="text-xs text-slate-500">{t('none')}</span>
                            ) : (
                              <div className="space-y-2">
                                {platform7d.map((item: any) => (
                                  <div key={item.platform}>
                                    <div className="flex items-center justify-between text-[11px] mb-1">
                                      <span className="text-slate-300">{getPlatformLabel(item.platform) || item.platform}</span>
                                      <span className="text-orange">{item.count}</span>
                                    </div>
                                    <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                                      <div className="h-full rounded-full bg-orange/70" style={{ width: adminBarWidth(item.count, maxPlatforms) }} />
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="rounded-xl bg-slate-900/60 border border-slate-700/60 p-3">
                            <p className="text-xs text-slate-300 font-semibold mb-3">{t('adminAiBreakdown7d')}</p>
                            {aiBreakdown.length === 0 ? (
                              <span className="text-xs text-slate-500">{t('none')}</span>
                            ) : (
                              <div className="space-y-2">
                                {aiBreakdown.map((item: any) => (
                                  <div key={item.feature}>
                                    <div className="flex items-center justify-between text-[11px] mb-1">
                                      <span className="text-slate-300">{item.feature}</span>
                                      <span className="text-purple-300">{t('adminAiBreakdownMeta', { requests: item.requests, outputs: item.outputItems })}</span>
                                    </div>
                                    <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                                      <div className="h-full rounded-full bg-purple-400/70" style={{ width: adminBarWidth(item.requests, maxAi) }} />
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </section>

                        <section className="rounded-xl bg-slate-900/60 border border-slate-700/60 p-3">
                          <p className="text-xs text-slate-300 font-semibold mb-2">{t('adminTopPlatforms')}</p>
                          <div className="flex flex-wrap gap-2">
                            {(adminMetrics.topPlatforms || []).length === 0 ? (
                              <span className="text-xs text-slate-500">{t('none')}</span>
                            ) : adminMetrics.topPlatforms.map((item: any) => (
                              <span key={item.platform} className="px-2 py-1 rounded-full bg-orange/10 text-orange border border-orange/20 text-xs">
                                {getPlatformLabel(item.platform) || item.platform} · {item.count}
                              </span>
                            ))}
                          </div>
                        </section>
                      </div>
                    )
                  })()
                ) : null}
              </div>
            </div>
            {/* Users tab */}
            {adminTab === 'users' && (
              <div className="rounded-xl bg-slate-900/60 border border-slate-700/60 p-3">
                <div className="flex gap-2 mb-3">
                  <input type="text" value={adminUserSearch} onChange={e => { setAdminUserSearch(e.target.value); setAdminUserPage(1); }} placeholder="搜索邮箱..." className="flex-1 px-2 py-1.5 rounded-lg bg-slate-800/50 border border-slate-700/50 text-white text-xs" />
                  <select value={adminUserTier} onChange={e => { setAdminUserTier(e.target.value); setAdminUserPage(1); }} className="px-2 py-1.5 rounded-lg bg-slate-800/50 border border-slate-700/50 text-white text-xs">
                    <option value="">全部</option><option value="pro">Pro</option><option value="free">Free</option>
                  </select>
                </div>
                {adminUsersLoading ? <p className="text-slate-400 text-xs py-4 text-center">{t('loading')}</p> : (
                  <div className="space-y-1 max-h-60 overflow-y-auto">
                    {adminUsers.map((u: any) => (
                      <div key={u.id} className="flex items-center justify-between p-2 rounded-lg bg-slate-800/30 text-xs">
                        <span className="text-slate-300 truncate flex-1">{u.email}</span>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] ml-2 ${u.tier === 'pro' ? 'bg-yellow-500/15 text-yellow-400' : 'bg-slate-700/50 text-slate-400'}`}>{u.tier}</span>
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-[10px] text-slate-500 mt-2">共 {adminUsersTotal} 用户</p>
              </div>
            )}
            {/* AI Usage tab */}
            {adminTab === 'ai' && (
              <div className="rounded-xl bg-slate-900/60 border border-slate-700/60 p-3">
                {adminAiUsageLoading ? <p className="text-slate-400 text-xs py-4 text-center">{t('loading')}</p> : (
                  <div className="space-y-1 max-h-60 overflow-y-auto">
                    {adminAiUsage.map((item: any, i: number) => (
                      <div key={i} className="flex items-center justify-between p-2 rounded-lg bg-slate-800/30 text-xs">
                        <span className="text-slate-300 truncate flex-1">{(item.title || item.task_id)}</span>
                        <span className="text-slate-500 ml-2">{item.output_chars ? (item.output_chars > 1000 ? (item.output_chars/1000).toFixed(0)+'k' : item.output_chars) + ' chars' : ''}</span>
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-[10px] text-slate-500 mt-2">共 {adminAiUsageTotal} 条</p>
              </div>
            )}
          </div>
        )}

        {/* Upgrade Popup */}
        {showUpgradePopup && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-slate-800 rounded-2xl w-full max-w-md p-6 border border-orange/30 shadow-2xl relative overflow-hidden">
              <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-orange to-orange-light" />
              <button onClick={() => setShowUpgradePopup(false)} className="absolute top-3 right-3 text-slate-400 hover:text-white">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
              <div className="text-center mb-5">
                <p className="text-4xl mb-2">🚀</p>
                <h3 className="text-xl font-bold text-white">{t('upgradeWorkbenchTitle')}</h3>
                <p className="text-slate-400 text-sm mt-2">{t('upgradeWorkbenchDesc')}</p>
              </div>
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="p-3 bg-slate-700/30 rounded-xl text-center">
                  <p className="text-slate-400 text-xs">{t('free')}</p>
                  <p className="text-lg font-bold text-white">3/{t('dailyShort')}</p>
                </div>
                <div className="p-3 bg-orange/10 border border-orange/30 rounded-xl text-center">
                  <p className="text-orange text-xs">⭐ Pro</p>
                  <p className="text-lg font-bold text-orange">{t('unlimited')}</p>
                </div>
              </div>
              <div className="space-y-2 mb-5">
                {[
                  { icon: '🤖', text: t('upgradeBenefitAiCards') },
                  { icon: '📣', text: t('upgradeBenefitPublishPacks') },
                  { icon: '📁', text: t('upgradeBenefitWorkbench') },
                  { icon: '⚡', text: t('upgradeBenefitBatch') },
                ].map(item => (
                  <div key={item.text} className="flex items-center gap-2 p-2 rounded-xl bg-slate-700/25 text-xs text-slate-300">
                    <span>{item.icon}</span>
                    <span>{item.text}</span>
                  </div>
                ))}
              </div>
              <button
                onClick={() => { setShowUpgradePopup(false); setShowSubscription(true) }}
                className="w-full py-3 bg-gradient-to-r from-orange to-orange-600 hover:from-orange-600 hover:to-orange-700 text-white font-bold rounded-xl transition-all shadow-lg shadow-orange/25"
              >
                {t('upgradeToPro')} →
              </button>
              <p className="text-center text-xs text-slate-500 mt-3">{t('startFrom')} $2.99/{t('monthly')}</p>
            </div>
          </div>
        )}

        {/* iOS Save to Photos Guide */}
        {showIosGuide && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-slate-800 rounded-2xl w-full max-w-xs p-6 border border-slate-700 shadow-2xl">
              <button onClick={() => setShowIosGuide(false)} className="absolute top-3 right-3 text-slate-400 hover:text-white">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
              <div className="text-center mb-4">
                <p className="text-4xl mb-3">📱</p>
                <h3 className="text-lg font-bold text-white mb-2">{t('iosGuideTitle')}</h3>
              </div>
              <div className="space-y-3 text-sm text-slate-300">
                <div className="flex items-start gap-3">
                  <span className="text-orange font-bold">1</span>
                  <p>{t('iosGuideStep1')}</p>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-orange font-bold">2</span>
                  <p>{t('iosGuideStep2')}</p>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-orange font-bold">3</span>
                  <p>{t('iosGuideStep3')}</p>
                </div>
              </div>
              <button
                onClick={() => setShowIosGuide(false)}
                className="w-full mt-5 py-2.5 bg-orange hover:bg-orange-dark text-white font-medium rounded-xl transition"
              >
                {t('gotIt')}
              </button>
            </div>
          </div>
        )}

        {/* 忘记Password弹窗 */}
        {showResetPwd && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
            <div className="bg-slate-800 rounded-2xl w-full max-w-xs border border-slate-700 shadow-2xl">
              {/* Header */}
              <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-700">
                <button onClick={() => !resetPwdLocked.current && setShowResetPwd(false)} className={`text-slate-300 hover:text-white transition ${resetPwdLocked.current ? 'opacity-30 cursor-not-allowed' : ''}`}>
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                </button>
                <h3 className="text-base font-bold text-white">🔑 {t('changePassword')}</h3>
              </div>
              {/* Content */}
              <div className="p-4">
                {!resetPwdStep ? (
                  <>
                    <p className="text-xs text-slate-300 mb-3">{t('enterEmailForReset')}</p>
                    <input
                      type="email"
                      value={resetEmail}
                      onChange={(e) => setResetEmail(e.target.value)}
                      placeholder="your@email.com"
                      className="w-full px-3 py-2.5 bg-slate-900/60 border border-slate-600/50 rounded-lg text-white text-sm outline-none focus:border-orange/70 mb-3"
                    />
                    {resetPwdMsg && <p className={`text-xs mb-3 ${resetPwdMsg.includes('Failed') ? 'text-red-400' : 'text-green-400'}`}>{resetPwdMsg}</p>}
                    <button onClick={handleForgotPassword} disabled={resetPwdLoading} className="w-full py-2.5 rounded-lg bg-orange text-white text-sm font-medium hover:bg-orange-dark transition disabled:opacity-50">
                      {resetPwdLoading ? t('sending') : t('sendResetLinkBtn')}
                    </button>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-slate-300 mb-3">{t('setNewPassword')}</p>
                    <input
                      type="password"
                      value={resetPwd}
                      onChange={(e) => setResetPwd(e.target.value)}
                      placeholder={t('newPassword')}
                      className="w-full px-3 py-2.5 bg-slate-900/60 border border-slate-600/50 rounded-lg text-white text-sm outline-none focus:border-orange/70 mb-2"
                    />
                    <input
                      type="password"
                      value={resetPwdConfirm}
                      onChange={(e) => setResetPwdConfirm(e.target.value)}
                      placeholder={t('confirmPassword')}
                      className="w-full px-3 py-2.5 bg-slate-900/60 border border-slate-600/50 rounded-lg text-white text-sm outline-none focus:border-orange/70 mb-3"
                    />
                    {resetPwdMsg && <p className={`text-xs mb-3 ${resetPwdMsg.includes('Failed') || resetPwdMsg.includes('无效') ? 'text-red-400' : 'text-green-400'}`}>{resetPwdMsg}</p>}
                    <button onClick={handleResetPassword} disabled={resetPwdLoading} className="w-full py-2.5 rounded-lg bg-orange text-white text-sm font-medium hover:bg-orange-dark transition disabled:opacity-50">
                      {resetPwdLoading ? t('resetting') : t('confirmReset')}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
        <PWAInstallPrompt />
      </div>
    </div>
  )
}

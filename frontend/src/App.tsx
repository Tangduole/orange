import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import { Share } from '@capacitor/share'
import {
  Download, Link2, CheckCircle2, XCircle, Loader2,
  Video, FileText, Image as ImageIcon, Mic, Languages,
  Trash2, ChevronDown, ChevronUp, Clock, Copy, Check,
  X, Zap, AlertCircle, Eraser, FolderOpen, HardDrive, Smartphone,
  Play,
} from 'lucide-react'

const API = 'https://orange-production-95b9.up.railway.app/api'
const BASE_URL = API.replace('/api', '')

// Share file using native share sheet (Android: shows save to Photos/Files option)
const isNativeApp = () => {
  try {
    return (window as any).Capacitor?.isNativePlatform?.() ?? false
  } catch { return false }
}

const shareFile = async (url: string, title: string) => {
  const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`
  
  if (isNativeApp()) {
    try {
      // Native app: 下载并直接保存到相册
      const resp = await fetch(fullUrl)
      const blob = await resp.blob()
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onloadend = () => resolve(reader.result as string)
        reader.readAsDataURL(blob)
      })
      
      // 直接保存到 Pictures 目录（相册）
      const { Filesystem, Directory } = await import('@capacitor/filesystem')
      const fileName = `Orange_${Date.now()}.mp4`
      await Filesystem.writeFile({
        path: `Pictures/${fileName}`,
        data: base64.split(',')[1],
        directory: Directory.ExternalStorage,
      })
      
      return { success: true }
    } catch (e) {
      console.error('Save failed:', e)
      return { success: false, error: String(e) }
    }
  } else {
    // Web: fetch as blob → force download
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
  directLink?: boolean; quality?: string
  downloadedBytes?: number; totalBytes?: number
  speed?: string; eta?: string
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
  { id: 'copywriting', label: 'Copywriting 文案', icon: FileText },
  { id: 'cover', label: 'Cover 封面', icon: ImageIcon },
  { id: 'asr', label: 'Audio 音轉文字', icon: Mic },
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
  { value: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', label: 'Best 最高画质' },
  { value: 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]', label: '1080p' },
  { value: 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]', label: '720p' },
  { value: 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480]', label: '480p' },
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
  const [quality, setQuality] = useState('bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best')
  const [asrLanguage, setAsrLanguage] = useState('zh')
  const [availableQualities, setAvailableQualities] = useState<Array<{quality: string, format: string, width: number, height: number, hasVideo: boolean, hasAudio: boolean}>>([])
  const [showQualityPicker, setShowQualityPicker] = useState(false)
  const [pendingUrl, setPendingUrl] = useState('')
  const [batchUrls, setBatchUrls] = useState('')

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
          axios.post(`${API}/download`, {
            url: nextUrl, platform: detectPlatform(nextUrl) || 'auto',
            needAsr: selected.has('asr'), options: [...selected], quality, asrLanguage,
          }, { timeout: 180000 }).then(r => {
            setTask(r.data.data)
          }).catch((e) => {
            console.error('[batch] 下载失败:', e.message)
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
  useEffect(() => {
    if (task?.status === 'completed' && task.downloadUrl && !downloading) {
      // 播放提示音
      playNotificationSound()
      // 延迟 500ms 后自动下载
      const timer = setTimeout(() => {
        setDownloading(true)
        shareFile(task.downloadUrl, task.title || 'video').finally(() => setDownloading(false))
      }, 500)
      return () => clearTimeout(timer)
    }
  }, [task?.status, task?.downloadUrl])

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
      if (r.data.code === 0 && r.data.data.qualities.length > 1) {
        setAvailableQualities(r.data.data.qualities)
        setPendingUrl(videoUrl)
        setShowQualityPicker(true)
        return true
      }
    } catch (e) {
      console.log('[quality] Failed to fetch qualities, using default')
    }
    return false
  }

  const handleSubmit = async () => {
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
    setBatchQueue(urls.map(u => ({ url: u, status: 'pending', progress: 0 })))
    setBatchIndex(0)
    setLoading(true); setError('')
    try {
      const detectedFirst = detectPlatform(urls[0])
      const r = await axios.post(`${API}/download`, {
        url: urls[0], platform: detectedFirst || 'auto',
        needAsr: selected.has('asr'), options: [...selected], quality, asrLanguage,
      }, { timeout: 120000 })
      setTask(r.data.data)
    } catch (e: any) {
      setError(getErrorMessage(e.code === 'ECONNABORTED' ? 'timeout' : (e.response?.data?.message || e.message || 'Download failed')))
      setLoading(false)
    }
  }

  const doSingleDownload = async () => {
    setLoading(true); setError('')
    try {
      const r = await axios.post(`${API}/download`, {
        url: url.trim(), platform: detected || 'auto',
        needAsr: selected.has('asr'), options: [...selected], quality, asrLanguage,
      }, { timeout: 120000 })
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
  const statusLabel = (s: string) => ({ pending: 'Queuing', parsing: 'Parsing', downloading: 'Downloading', asr: 'Speech recognition', completed: 'Completed', error: 'Failed' }[s] || s)
  
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      {/* 背景光晕 - 橙色主题 */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-0 right-0 w-96 h-96 bg-orange-500/8 rounded-full blur-3xl" />
        <div className="absolute bottom-0 left-0 w-72 h-72 bg-amber-500/8 rounded-full blur-3xl" />
      </div>

      <div className="relative">
        {/* Header */}
        <header className="max-w-2xl mx-auto px-6 pt-16 pb-8 text-center">
          <div className="inline-flex items-center justify-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-orange-500 to-amber-500 flex items-center justify-center shadow-lg shadow-orange-500/25">
              <span className="text-2xl filter drop-shadow-lg">🍊</span>
            </div>
            <div className="text-left">
              <h1 className="text-xl font-bold text-white">Orange Downloader</h1>
              <p className="text-xs text-slate-400">Multi-platform Video Downloader</p>
            </div>
          </div>
          <p className="text-slate-500 text-sm">
            Paste link → One-click download. Support multiple platforms
          </p>
        </header>

        {/* Main Card */}
        <main className="max-w-2xl mx-auto px-6 pb-10">
          <div className="bg-slate-800/60 backdrop-blur-sm rounded-3xl p-6 border border-slate-700/60 shadow-xl">

            {/* 单G/批量 Tab */}
            <div className="flex gap-2 mb-5">
              <button
                onClick={() => setBatchMode(false)}
                className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${!batchMode ? 'bg-orange-500/15 text-orange-300 border border-orange-500/30' : 'bg-slate-700/30 text-slate-500 border border-transparent'}`}
              >
                Single Download
              </button>
              <button
                onClick={() => setBatchMode(true)}
                className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${batchMode ? 'bg-orange-500/15 text-orange-300 border border-orange-500/30' : 'bg-slate-700/30 text-slate-500 border border-transparent'}`}
              >
                Batch Download
              </button>
            </div>

            {/* Single Download模式 */}
            {!batchMode && (
              <div className="mb-5">
                <div className="relative">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500">
                    <Link2 className="w-5 h-5" />
                  </div>
                  <input
                    type="url"
                    value={url}
                    onChange={(e) => handleUrlChange(e.target.value)}
                    onPaste={handleSinglePaste}
                    placeholder="Paste video link..."
                    className="w-full pl-10 pr-10 py-4 bg-slate-900/60 border-2 border-slate-600/50 rounded-2xl focus:ring-4 focus:ring-orange-500/15 focus:border-orange-500/70 outline-none text-white text-base transition-all placeholder:text-slate-500"
                  />
                  {/* 清理按钮 - 最右边 */}
                  {url && !loading && (
                    <button
                      onClick={clearUrl}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-slate-500 hover:text-slate-300 transition"
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
                  className="w-full h-28 px-4 py-3 bg-slate-900/60 border-2 border-slate-600/50 rounded-2xl focus:ring-4 focus:ring-orange-500/15 focus:border-orange-500/70 outline-none text-white text-sm transition-all placeholder:text-slate-500 resize-none"
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
                          <span className="text-xs text-slate-500 w-6">{idx + 1}.</span>
                          <span className="flex-1 text-xs text-slate-400 truncate text-left" title={cleanUrl}>{shortUrl}</span>
                          <button
                            onClick={() => {
                              const lines = batchUrls.split('\n')
                              lines.splice(idx, 1)
                              setBatchUrls(lines.filter(l => l.trim()).join('\n'))
                            }}
                            className="text-slate-600 hover:text-red-400 transition"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
                <p className="text-xs text-slate-500 mt-2">
                  💡 One link per line, max 10 items. {batchUrls.split('\n').filter(u => u.trim()).length}/10
                </p>
              </div>
            )}

            {/* Supported Platforms */}
            <div className="mb-5">
              <p className="text-xs text-slate-500 mb-2">Supported Platforms</p>
              <div className="flex flex-wrap gap-1.5">
                {PLATFORMS.map((p) => (
                  <span key={p.id} className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-700/30 text-slate-500 text-xs rounded-lg">
                    <span>{p.icon}</span>
                    <span>{p.label}</span>
                  </span>
                ))}
              </div>
            </div>

            {/* 下载选项 */}
            <div className="mb-5">
              <p className="text-xs text-slate-500 mb-2">Download Content</p>
              <div className="flex flex-wrap gap-1.5">
                {OPTIONS.map(o => {
                  const Icon = o.icon; const on = selected.has(o.id)
                  return (
                    <button key={o.id} onClick={() => toggle(o.id)}
                      className={`flex items-center gap-1 px-3 py-2 text-xs rounded-lg transition-all
                        ${on ? 'bg-orange-500/15 text-orange-300 border border-orange-500/30' : 'bg-slate-700/30 text-slate-500 border border-transparent hover:text-slate-300'}`}>
                      <Icon className="w-3.5 h-3.5" />{o.label}
                    </button>
                  )
                })}
              </div>
              {/* ASR Language Selection */}
              {selected.has('asr') && (
                <div className="mt-3">
                  <label className="text-xs text-slate-500 mb-1 block">ASR Language 語言</label>
                  <select
                    value={asrLanguage}
                    onChange={(e) => setAsrLanguage(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-900/60 border-2 border-slate-600/50 rounded-xl text-sm text-white outline-none focus:border-orange-500/70 cursor-pointer appearance-none"
                  >
                    {ASR_LANGUAGE_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {/* Quality Selection 画质选择 - 下拉菜单 */}
            <div className="mb-5">
              <label className="text-xs text-slate-500 mb-2 flex items-center gap-1.5">
                <Video className="w-3.5 h-3.5" />
                Video Quality 画质
              </label>
              <div className="flex gap-2 mt-1.5">
                <div className="relative flex-1">
                  <select
                    value={quality}
                    onChange={(e) => setQuality(e.target.value)}
                    className="w-full px-4 py-3 bg-slate-900/60 border-2 border-slate-600/50 rounded-xl text-sm text-white outline-none focus:border-orange-500/70 cursor-pointer appearance-none"
                  >
                    {availableQualities.length > 0 ? (
                      <>
                        <option value="best[ext=mp4]/best">Best 最高画质</option>
                        {availableQualities.map((q, idx) => {
                          const format = q.height >= 1440 
                            ? `bestvideo[height<=${q.height}]+bestaudio/best[height<=${q.height}]`
                            : `bestvideo[height<=${q.height}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${q.height}]`
                          return (
                            <option key={idx} value={format}>
                              {q.quality} ({q.width}x{q.height})
                            </option>
                          )
                        })}
                      </>
                    ) : (
                      QUALITY_OPTIONS.map(q => (
                        <option key={q.value} value={q.value}>{q.label}</option>
                      ))
                    )}
                  </select>
                  <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
                </div>
                {detected === 'youtube' && url.trim() && (
                  <button
                    onClick={() => fetchVideoQualities(url.trim())}
                    className="px-3 py-3 bg-slate-700/50 hover:bg-slate-700 rounded-xl text-slate-400 text-sm transition"
                    title="获取可用画质"
                  >
                    🔍
                  </button>
                )}
              </div>
            </div>

            {/* Save Location 保存位置 - 下拉式 */}
            <div className="mb-5">
              <label className="text-xs text-slate-500 mb-2 flex items-center gap-1.5">
                <FolderOpen className="w-3.5 h-3.5" />
                Save Location 保存位置
              </label>
              <div className="relative mt-1.5">
                <select
                  value={saveLocation}
                  onChange={(e) => handleLocationChange(e.target.value)}
                  className="w-full px-4 py-3 bg-slate-900/60 border-2 border-slate-600/50 rounded-xl text-sm text-white outline-none focus:border-orange-500/70 cursor-pointer appearance-none"
                >
                  <option value="album">📱 Phone Gallery 手機相冊</option>
                  <option value="download">💻 Download Folder 下載文件夾</option>
                  <option value="desktop">🖥️ Desktop 桌面</option>
                </select>
                <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
              </div>
              {saveLocation === 'download' && (
                <div className="mt-2 p-2.5 bg-slate-700/30 rounded-xl border border-slate-700/60">
                  <p className="text-xs text-slate-500 leading-relaxed">
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
              <div className="mb-3 bg-slate-900/60 rounded-xl border border-slate-700/60 overflow-hidden">
                <div className="px-4 py-2 border-b border-slate-700/60 flex justify-between items-center">
                  <p className="text-xs text-slate-400">
                    Batch Queue: {batchQueue.length} items
                  </p>
                  {loading && <span className="text-xs text-orange-400">Processing {batchIndex + 1}/{batchQueue.length}</span>}
                </div>
                <div className="max-h-40 overflow-y-auto">
                  {batchQueue.map((item, idx) => {
                    let statusIcon = <span className="text-xs text-slate-600">⏳</span>
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
                        <span className="text-xs text-slate-500 w-5">{idx + 1}.</span>
                        <span className="text-sm">{icon}</span>
                        <span className="text-xs text-slate-400 truncate flex-1" title={item.url}>
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
            <button
              onClick={handleSubmit}
              disabled={loading}
              className="w-full py-4 rounded-2xl font-bold text-white text-base bg-orange-500 hover:bg-orange-600 active:bg-orange-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-orange-500/25 active:scale-[0.98]"
            >
              {loading ? (
                <><Loader2 className="w-5 h-5 animate-spin" />{batchMode ? `Processing ${batchIndex + 1}/${batchQueue.length}...` : 'Processing...'}</>
              ) : (
                <><Zap className="w-5 h-5" />Start Download</>
              )}
            </button>
          </div>

          {/* 任务状态 */}
          {task && (
            <div className="mt-5 bg-slate-800/60 backdrop-blur-sm rounded-2xl p-5 border border-slate-700/60 shadow-xl space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-600 flex items-center gap-2">
                  <Download className="w-4 h-4 text-orange-400" /> Download Progress
                </h3>
                <button onClick={() => setTask(null)}><X className="w-4 h-4 text-slate-500 hover:text-slate-300" /></button>
              </div>

              <div className="flex items-center gap-2">
                {task.status === 'completed' && <CheckCircle2 className="w-5 h-5 text-emerald-400" />}
                {task.status === 'error' && <XCircle className="w-5 h-5 text-red-400" />}
                {isWorking(task.status) && <Loader2 className="w-5 h-5 text-orange-400 animate-spin" />}
                <span className="text-sm text-slate-600">{statusLabel(task.status)}</span>
              </div>

              {/* 精细进度条 */}
              {isWorking(task.status) && (
                <div className="space-y-2">
                  <div className="w-full h-2.5 bg-slate-700/50 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-orange-500 rounded-full transition-all duration-500"
                      style={{ width: `${task.progress}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>{task.title || 'Parsing...'}</span>
                    <div className="flex items-center gap-2">
                      {task.downloadedBytes && task.totalBytes ? (
                        <span className="text-slate-400">
                          {formatBytes(task.downloadedBytes)}/{formatBytes(task.totalBytes)}
                        </span>
                      ) : null}
                      <span className="text-orange-400 font-medium">{task.progress}%</span>
                    </div>
                  </div>
                </div>
              )}

              {task.title && !isWorking(task.status) && <p className="text-sm text-slate-500">{task.title}</p>}

              {/* 图文 */}
              {task.isNote && task.imageFiles?.length > 0 && (
                <div>
                  <p className="text-xs text-slate-500 mb-2">Total {task.imageFiles.length}  images</p>
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
                    setDownloading(true)
                    // 检查是否为直接链接（YouTube等）
                    if (task.directLink) {
                      // 直接在新窗口打开链接
                      window.open(task.downloadUrl, '_blank')
                      setDownloading(false)
                    } else {
                      await shareFile(task.downloadUrl, task.title || 'video')
                      setDownloading(false)
                    }
                  }}
                  disabled={downloading}
                  className="w-full py-3.5 rounded-2xl text-sm font-semibold bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} 
                  {downloading ? 'Downloading...' : (task.directLink ? '打开下载链接' : 'Save to Device')}
                </button>
              )}

              {/* Cover */}
              {task.status === 'completed' && task.coverUrl && (
                <button 
                  onClick={async () => {
                    setDownloading(true)
                    await shareFile(task.coverUrl, 'cover')
                    setDownloading(false)
                  }}
                  disabled={downloading}
                  className="w-full py-3 rounded-xl text-xs bg-slate-700/30 border border-slate-700/60 text-slate-500 hover:text-white transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImageIcon className="w-3.5 h-3.5" />}
                  {downloading ? 'Downloading...' : 'Save Cover'}
                </button>
              )}

              {/* MP3 Audio */}
              {task.status === 'completed' && task.audioUrl && (
                <button 
                  onClick={async () => {
                    setDownloading(true)
                    await shareFile(task.audioUrl!, 'audio.mp3')
                    setDownloading(false)
                  }}
                  disabled={downloading}
                  className="w-full py-3 rounded-xl text-xs bg-slate-700/30 border border-slate-700/60 text-slate-500 hover:text-white transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mic className="w-3.5 h-3.5" />}
                  {downloading ? 'Downloading...' : 'Save MP3'}
                </button>
              )}

              {/* Copywriting */}
              {task.status === 'completed' && task.copyText && (
                <div className="p-3 bg-slate-900/60 rounded-xl">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-slate-500">Copywriting</span>
                    <button onClick={() => clip(task.copyText!, 'copy')} className="text-xs text-slate-500 hover:text-orange-400 transition">
                      {copied === 'copy' ? <><Check className="w-3 h-3 inline" /> Copied</> : <><Copy className="w-3 h-3 inline" /> Copy</>}
                    </button>
                  </div>
                  <p className="text-sm text-slate-500 whitespace-pre-wrap max-h-28 overflow-y-auto">{task.copyText}</p>
                </div>
              )}

              {/* Subtitle */}
              {task.status === 'completed' && task.subtitleFiles?.length > 0 && (
                <div className="flex gap-2 flex-wrap">
                  {task.subtitleFiles.map(s => (
                    <a key={s.filename} href={`${API.replace('/api', '')}${s.url}`} download={s.filename} className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs bg-slate-700/30 border border-slate-700/60 text-slate-500 hover:text-white transition-all">
                      <Languages className="w-3 h-3" />{s.filename}
                    </a>
                  ))}
                </div>
              )}

              {/* ASR */}
              {task.asrText && (
                <div className="p-3 bg-slate-900/60 rounded-xl">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-slate-500">Speech to Text</span>
                    <button onClick={() => clip(task.asrText!, 'asr')} className="text-xs text-slate-500 hover:text-orange-400 transition">
                      {copied === 'asr' ? <><Check className="w-3 h-3 inline" /> Copied</> : <><Copy className="w-3 h-3 inline" /> Copy</>}
                    </button>
                  </div>
                  <p className="text-sm text-slate-500 whitespace-pre-wrap max-h-32 overflow-y-auto">{task.asrText}</p>
                </div>
              )}

              {task.status === 'error' && task.error && <p className="text-sm text-red-400">{getErrorMessage(task.error)}</p>}
            </div>
          )}

          {/* How to Use - 精简版 */}
          <div className="mt-5 bg-slate-900/60 rounded-2xl px-5 py-3 border border-slate-700/60">
            <div className="flex items-center gap-4 text-xs text-slate-500">
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
              className="w-full flex items-center justify-between px-5 py-3 bg-slate-900/60 rounded-2xl border border-slate-700/60 text-sm text-slate-500 hover:text-slate-300 transition">
              <span className="flex items-center gap-2">
                <Clock className="w-4 h-4" /> Download History
                {history.length > 0 && <span className="bg-orange-500/20 text-orange-300 px-2 py-0.5 rounded text-xs">{history.length}</span>}
              </span>
              <span className="flex items-center gap-2">
                {history.length > 0 && showHistory && (
                  <button onClick={(e) => { e.stopPropagation(); clearAllHistory() }} className="text-xs text-red-400 hover:text-red-300 transition">Clear All</button>
                )}
                {showHistory ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
              </span>
            </button>
            {showHistory && (
              <div className="mt-2 max-h-72 overflow-y-auto bg-slate-900/60 rounded-2xl border border-slate-700/60">
                {history.length === 0
                  ? <p className="py-10 text-center text-sm text-slate-600">No download history</p>
                  : history.map(item => (
                    <div key={item.taskId} className="flex items-center gap-3 px-4 py-3 border-b border-slate-700/20 last:border-0 hover:bg-slate-900/60 transition">
                      {/* 缩略图 - 点击打开已保存的文件 */}
                      {item.thumbnailUrl
                        ? <button 
                            onClick={() => openSavedFile(item)}
                            className="relative shrink-0 group"
                          >
                            <img src={`${BASE_URL}${item.thumbnailUrl}`} alt="" className="w-14 h-10 object-cover rounded-lg" />
                            <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-lg opacity-0 group-hover:opacity-100 transition">
                              <Play className="w-4 h-4 text-white" />
                            </div>
                          </button>
                        : <div className="w-14 h-10 rounded-lg bg-slate-700/50 flex items-center justify-center shrink-0"><Video className="w-4 h-4 text-slate-600" /></div>
                      }
                      <div className="flex-1 min-w-0">
                        {/* 标题 - 长标题才跑马灯 */}
                        <div className="overflow-hidden">
                          <div className="overflow-hidden">
                            <p className={`text-sm text-slate-600 font-medium whitespace-nowrap ${(item.title || '').length > 20 ? 'animate-marquee' : 'truncate'}`}>
                              {(item.title || '').length > 20 ? <>{item.title}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{item.title}</> : (item.title || 'Untitled')}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          {item.platform && <span className="text-xs text-orange-400 bg-orange-500/10 px-1.5 py-0.5 rounded">{platformLabel(item.platform)}</span>}
                          <span className="text-xs text-slate-600">{new Date(item.createdAt).toLocaleString('en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                      </div>
                      <button onClick={() => del(item.taskId)} className="p-1.5 text-slate-600 hover:text-red-400 transition"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </main>

        {/* 画质选择弹窗 */}
        {showQualityPicker && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
            <div className="bg-slate-800 rounded-2xl p-6 max-w-sm w-full border border-slate-700">
              <h3 className="text-lg font-bold text-white mb-4">选择画质</h3>
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {availableQualities.map((q, idx) => (
                  <button
                    key={idx}
                    onClick={() => {
                      setShowQualityPicker(false)
                      // Set quality based on selection
                      if (q.hasVideo) {
                        const format = q.height >= 1440 
                          ? `bestvideo[height<=${q.height}]+bestaudio/best[height<=${q.height}]`
                          : `bestvideo[height<=${q.height}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${q.height}]`
                        setQuality(format)
                      } else {
                        setQuality('bestaudio[ext=m4a]/bestaudio')
                      }
                      doSingleDownload()
                    }}
                    className="w-full flex items-center justify-between p-3 rounded-xl bg-slate-700/50 hover:bg-slate-700 transition text-left"
                  >
                    <div>
                      <span className="text-white font-medium">{q.quality}</span>
                      {q.width > 0 && <span className="text-slate-400 text-xs ml-2">{q.width}x{q.height}</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      {q.hasVideo && q.hasAudio && <span className="text-xs text-green-400">🎬</span>}
                      {!q.hasVideo && q.hasAudio && <span className="text-xs text-blue-400">🎵</span>}
                      <span className="text-xs text-slate-500">{q.format.split('/')[1]}</span>
                    </div>
                  </button>
                ))}
              </div>
              <button
                onClick={() => { setShowQualityPicker(false); setPendingUrl('') }}
                className="w-full mt-4 py-2 px-4 rounded-xl bg-slate-700 text-slate-300 hover:bg-slate-600 transition"
              >
                取消
              </button>
            </div>
          </div>
        )}

        {/* 重复下载确认弹窗 */}
        {showDupConfirm && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
            <div className="bg-slate-800 rounded-2xl p-6 max-w-sm w-full border border-slate-700">
              <h3 className="text-lg font-bold text-white mb-2">已下载过</h3>
              <p className="text-sm text-slate-400 mb-4">该视频已在下载历史中。是否还要下载？</p>
              <p className="text-xs text-slate-500 mb-4 truncate">{dupUrl}</p>
              <div className="flex gap-3">
                <button onClick={() => { setShowDupConfirm(false); setPendingDownload(null) }} className="flex-1 py-2 px-4 rounded-xl bg-slate-700 text-slate-300 hover:bg-slate-600 transition">取消</button>
                <button onClick={() => { setShowDupConfirm(false); if (pendingDownload) pendingDownload() }} className="flex-1 py-2 px-4 rounded-xl bg-orange-500 text-white hover:bg-orange-600 transition">继续下载</button>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <footer className="text-center py-8 text-slate-600 text-xs">
          <p>Orange Downloader v1.0 · For personal use only</p>
        </footer>
      </div>
    </div>
  )
}

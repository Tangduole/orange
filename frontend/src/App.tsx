import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import { Share } from '@capacitor/share'
import {
  Download, Link2, CheckCircle2, XCircle, Loader2,
  Video, FileText, Image as ImageIcon, Mic, Languages,
  Trash2, ChevronDown, ChevronUp, Clock, Copy, Check,
  X, Zap, AlertCircle, Eraser, FolderOpen, HardDrive, Smartphone,
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
      await Share.share({
        title: title || 'Orange Downloader',
        url: fullUrl,
      })
      return { success: true }
    } catch (e) {
      console.error('Share failed:', e)
      return { success: false, error: String(e) }
    }
  } else {
    // Web: fetch as blob → force download (no new tab)
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
      // Fallback: direct link
      window.open(fullUrl, '_blank')
      return { success: false, error: String(e) }
    }
  }
}

interface Task {
  taskId: string; status: string; progress: number
  title?: string; platform?: string; thumbnailUrl?: string
  downloadUrl?: string; asrText?: string; copyText?: string
  coverUrl?: string; isNote?: boolean
  imageFiles?: Array<{ filename: string; url: string }>
  subtitleFiles?: Array<{ filename: string; url: string }>
  error?: string; createdAt: string | number
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
  { id: 'bilibili', label: 'Bilibili', icon: '📺' },
  { id: 'instagram', label: 'Instagram', icon: '📸' },
]

const OPTIONS: { id: string; label: string; icon: typeof Video }[] = [
  { id: 'video', label: 'Video 视频', icon: Video },
  { id: 'copywriting', label: 'Copywriting 文案', icon: FileText },
  { id: 'cover', label: 'Cover 封面', icon: ImageIcon },
  { id: 'asr', label: 'Audio 音轉文字', icon: Mic },
  { id: 'subtitle', label: 'Subtitle 字幕', icon: Languages },
]

function detectPlatform(url: string): string {
  if (/douyin\.com|iesdouyin\.com/i.test(url)) return 'douyin'
  if (/tiktok\.com/i.test(url)) return 'tiktok'
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube'
  if (/twitter\.com|x\.com/i.test(url)) return 'x'
  if (/bilibili\.com|b23\.tv/i.test(url)) return 'bilibili'
  if (/instagram\.com/i.test(url)) return 'instagram'
  return ''
}

export default function App() {
  const [url, setUrl] = useState('')
  const [detected, setDetected] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set(['video']))
  const [task, setTask] = useState<Task | null>(null)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [batchMode, setBatchMode] = useState(false)
  const [batchUrls, setBatchUrls] = useState('')
  const [batchQueue, setBatchQueue] = useState<string[]>([])
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

  // Poll task status + 批量处理
  useEffect(() => {
    if (!task || task.status === 'completed' || task.status === 'error') {
      // 如果是批量模式且有队列中的下一G
      if (task?.status === 'completed' && batchMode && batchQueue.length > 0 && batchIndex < batchQueue.length - 1) {
        const nextIndex = batchIndex + 1
        const nextUrl = batchQueue[nextIndex]
        setBatchIndex(nextIndex)
        setLoading(true)
        axios.post(`${API}/download`, {
          url: nextUrl, platform: detectPlatform(nextUrl) || 'auto',
          needAsr: selected.has('asr'), options: [...selected],
        }, { timeout: 120000 }).then(r => {
          setTask(r.data.data)
        }).catch(() => {
          setError('Batch DownloadFailed')
        }).finally(() => setLoading(false))
      }
      return
    }
    const t = setInterval(async () => {
      try {
        const r = await axios.get(`${API}/status/${task.taskId}`)
        if (r.data.data) {
          setTask(r.data.data)
          if (['completed', 'error'].includes(r.data.data.status)) { clearInterval(t); fetchHistory() }
        }
      } catch {}
    }, 1500)
    return () => clearInterval(t)
  }, [task, batchMode, batchQueue, batchIndex])

  const fetchHistory = useCallback(async () => {
    try { const r = await axios.get(`${API}/history`); setHistory(Array.isArray(r.data.data) ? r.data.data : []) } catch {}
  }, [])
  useEffect(() => { fetchHistory() }, [fetchHistory])

  const handleUrlChange = (value: string) => {
    setUrl(value)
    setDetected(value.trim() ? detectPlatform(value) : '')
  }

  const handleSubmit = async () => {
    // 批量模式
    if (batchMode) {
      const urls = batchUrls.split('\n').map(u => u.trim()).filter(u => u)
      if (urls.length === 0) { setError('Please enter a video link'); return }
      setBatchQueue(urls)
      setBatchIndex(0)
      // Start Download第一G
      const firstUrl = urls[0]
      setLoading(true); setError('')
      try {
        const detectedFirst = detectPlatform(firstUrl)
        const r = await axios.post(`${API}/download`, {
          url: firstUrl, platform: detectedFirst || 'auto',
          needAsr: selected.has('asr'), options: [...selected],
        }, { timeout: 120000 })
        setTask(r.data.data)
      } catch (e: any) {
        setError(e.code === 'ECONNABORTED' ? 'Request timeout, please retry' : (e.response?.data?.message || 'Download failed'))
        setLoading(false)
      }
      return
    }
    // 单G模式
    if (!url.trim()) { setError('Please enter a video link'); return }
    setLoading(true); setError('')
    try {
      const r = await axios.post(`${API}/download`, {
        url: url.trim(), platform: detected || 'auto',
        needAsr: selected.has('asr'), options: [...selected],
      }, { timeout: 120000 })
      setTask(r.data.data); setUrl(''); setDetected('')
    } catch (e: any) {
      setError(e.code === 'ECONNABORTED' ? 'Request timeout, please retry' : (e.response?.data?.message || 'Download failed'))
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
  const clip = async (text: string, id: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(id); setTimeout(() => setCopied(null), 3000) } catch {}
  }
  const clearUrl = () => { setUrl(''); setDetected('') }

  const isWorking = (s: string) => ['pending', 'parsing', 'processing', 'downloading', 'asr'].includes(s)
  const statusLabel = (s: string) => ({ pending: 'Queuing', parsing: 'Parsing', downloading: 'Downloading', asr: 'Speech recognition', completed: 'Completed', error: 'Failed' }[s] || s)
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
          <p className="text-slate-400 text-sm">
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
                className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${!batchMode ? 'bg-orange-500/15 text-orange-300 border border-orange-500/30' : 'bg-slate-700/40 text-slate-500 border border-transparent'}`}
              >
                Single Download
              </button>
              <button
                onClick={() => setBatchMode(true)}
                className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${batchMode ? 'bg-orange-500/15 text-orange-300 border border-orange-500/30' : 'bg-slate-700/40 text-slate-500 border border-transparent'}`}
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
                    placeholder="Paste video link..."
                    className="w-full pl-12 pr-24 py-4 bg-slate-900/60 border-2 border-slate-600/50 rounded-2xl focus:ring-4 focus:ring-orange-500/15 focus:border-orange-500/70 outline-none text-white text-base transition-all placeholder:text-slate-500"
                  />
                  {/* 一键清理按钮 */}
                  {url && (
                    <button
                      onClick={clearUrl}
                      className="absolute right-16 top-1/2 -translate-y-1/2 p-2 text-slate-500 hover:text-slate-300 transition"
                      title="Clear link"
                    >
                      <Eraser className="w-4 h-4" />
                    </button>
                  )}
                  {/* 解析状态指示 */}
                  {loading && (
                    <div className="absolute right-4 top-1/2 -translate-y-1/2">
                      <Loader2 className="w-5 h-5 text-orange-400 animate-spin" />
                    </div>
                  )}
                  {detected && !loading && (
                    <div className="absolute right-4 top-1/2 -translate-y-1/2 px-2 py-1 bg-orange-500/15 text-orange-300 text-xs rounded-lg border border-orange-500/20">
                      {platformLabel(detected) || detected}
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
                  onChange={(e) => setBatchUrls(e.target.value)}
                  placeholder="Paste multiple video links, one per line：&#10;https://v.douyin.com/xxx&#10;https://v.douyin.com/yyy&#10;https://x.com/zzz"
                  className="w-full h-28 px-4 py-3 bg-slate-900/60 border-2 border-slate-600/50 rounded-2xl focus:ring-4 focus:ring-orange-500/15 focus:border-orange-500/70 outline-none text-white text-sm transition-all placeholder:text-slate-500 resize-none"
                />
                {/* 链接预览列表 */}
                {batchUrls.split('\n').filter(u => u.trim()).length > 0 && (
                  <div className="mt-2 max-h-48 overflow-y-auto space-y-1.5">
                    {batchUrls.split('\n').filter(u => u.trim()).map((url, idx) => {
                      const platform = detectPlatform(url)
                      const platformIcon = PLATFORMS.find(p => p.id === platform)?.icon || '🔗'
                      return (
                        <div key={idx} className="flex items-center gap-2 px-3 py-2 bg-slate-700/40 rounded-xl border border-slate-600/30">
                          <span className="text-sm">{platformIcon}</span>
                          <span className="flex-1 text-xs text-slate-400 truncate" title={url}>{url}</span>
                          <button
                            onClick={() => {
                              const lines = batchUrls.split('\n')
                              lines.splice(idx, 1)
                              setBatchUrls(lines.join('\n'))
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
                  <span key={p.id} className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-700/40 text-slate-400 text-xs rounded-lg">
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
                        ${on ? 'bg-orange-500/15 text-orange-300 border border-orange-500/30' : 'bg-slate-700/40 text-slate-500 border border-transparent hover:text-slate-300'}`}>
                      <Icon className="w-3.5 h-3.5" />{o.label}
                    </button>
                  )
                })}
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
                <div className="mt-2 p-2.5 bg-slate-700/30 rounded-xl border border-slate-600/30">
                  <p className="text-xs text-slate-400 leading-relaxed">
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
            {batchMode && batchQueue.length > 0 && (
              <div className="mb-3 p-2.5 bg-orange-500/10 border border-orange-500/20 rounded-xl">
                <p className="text-xs text-orange-300 text-center">
                  Batch downloading: {batchIndex + 1} / {batchQueue.length}
                </p>
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
                <h3 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
                  <Download className="w-4 h-4 text-orange-400" /> Download Progress
                </h3>
                <button onClick={() => setTask(null)}><X className="w-4 h-4 text-slate-500 hover:text-slate-300" /></button>
              </div>

              <div className="flex items-center gap-2">
                {task.status === 'completed' && <CheckCircle2 className="w-5 h-5 text-emerald-400" />}
                {task.status === 'error' && <XCircle className="w-5 h-5 text-red-400" />}
                {isWorking(task.status) && <Loader2 className="w-5 h-5 text-orange-400 animate-spin" />}
                <span className="text-sm text-slate-300">{statusLabel(task.status)}</span>
              </div>

              {/* 精细进度条 */}
              {isWorking(task.status) && (
                <div className="space-y-2">
                  <div className="w-full h-2.5 bg-slate-700/50 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-gradient-to-r from-orange-500 to-amber-400 rounded-full transition-all duration-500"
                      style={{ width: `${task.progress}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>{task.title || 'Parsing...'}</span>
                    <span className="text-orange-400 font-medium">{task.progress}%</span>
                  </div>
                </div>
              )}

              {task.title && !isWorking(task.status) && <p className="text-sm text-slate-400">{task.title}</p>}

              {/* 图文 */}
              {task.isNote && task.imageFiles?.length > 0 && (
                <div>
                  <p className="text-xs text-slate-500 mb-2">Total {task.imageFiles.length}  images</p>
                  <div className="grid grid-cols-3 gap-2">
                    {task.imageFiles.map(img => (
                      <a key={img.filename} href={`${API.replace('/api', '')}${img.url}`} download><img src={`${API.replace('/api', '')}${img.url}`} alt="" className="w-full aspect-square object-cover rounded-xl bg-slate-800" loading="lazy" /></a>
                    ))}
                  </div>
                </div>
              )}

              {/* Video下载 */}
              {task.status === 'completed' && task.downloadUrl && (
                <button 
                  onClick={async () => {
                    setDownloading(true)
                    await shareFile(task.downloadUrl, task.title || 'video')
                    setDownloading(false)
                  }}
                  disabled={downloading}
                  className="w-full py-3.5 rounded-2xl text-sm font-semibold bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} 
                  {downloading ? 'Downloading...' : 'Save to Device'}
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
                  className="w-full py-3 rounded-xl text-xs bg-slate-700/30 border border-slate-600/30 text-slate-400 hover:text-white transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImageIcon className="w-3.5 h-3.5" />}
                  {downloading ? 'Downloading...' : 'Save Cover'}
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
                  <p className="text-sm text-slate-400 whitespace-pre-wrap max-h-28 overflow-y-auto">{task.copyText}</p>
                </div>
              )}

              {/* Subtitle */}
              {task.status === 'completed' && task.subtitleFiles?.length > 0 && (
                <div className="flex gap-2 flex-wrap">
                  {task.subtitleFiles.map(s => (
                    <a key={s.filename} href={`${API.replace('/api', '')}${s.url}`} download={s.filename} className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs bg-slate-700/30 border border-slate-600/30 text-slate-400 hover:text-white transition-all">
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
                  <p className="text-sm text-slate-400 whitespace-pre-wrap max-h-32 overflow-y-auto">{task.asrText}</p>
                </div>
              )}

              {task.status === 'error' && task.error && <p className="text-sm text-red-400">{task.error}</p>}
            </div>
          )}

          {/* How to Use */}
          <div className="mt-5 bg-slate-800/30 rounded-2xl p-5 border border-slate-700/30">
            <h3 className="text-sm font-semibold text-slate-300 mb-3 flex items-center gap-2">
              <Download className="w-4 h-4 text-orange-400" />
              How to Use
            </h3>
            <div className="space-y-2.5 text-sm text-slate-400">
              <div className="flex items-start gap-2">
                <span className="text-orange-400 font-bold text-xs mt-0.5">1</span>
                <p>Copy any video link from supported platforms</p>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-orange-400 font-bold text-xs mt-0.5">2</span>
                <p>Paste in the input box above, auto-detects platform</p>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-orange-400 font-bold text-xs mt-0.5">3</span>
                <p>Select content to download (video/copy/cover/etc)</p>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-orange-400 font-bold text-xs mt-0.5">4</span>
                <p>Click Start Download</p>
              </div>
            </div>
          </div>

          {/* // Download History - Enhanced */}
          <div className="mt-5">
            <button onClick={() => setShowHistory(!showHistory)}
              className="w-full flex items-center justify-between px-5 py-3 bg-slate-800/30 rounded-2xl border border-slate-700/30 text-sm text-slate-400 hover:text-slate-300 transition">
              <span className="flex items-center gap-2">
                <Clock className="w-4 h-4" /> Download History
                {history.length > 0 && <span className="bg-orange-500/20 text-orange-300 px-2 py-0.5 rounded text-xs">{history.length}</span>}
              </span>
              {showHistory ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
            </button>
            {showHistory && (
              <div className="mt-2 max-h-72 overflow-y-auto bg-slate-800/30 rounded-2xl border border-slate-700/30">
                {history.length === 0
                  ? <p className="py-10 text-center text-sm text-slate-600">No download history</p>
                  : history.map(item => (
                    <div key={item.taskId} className="flex items-center gap-3 px-4 py-3 border-b border-slate-700/20 last:border-0 hover:bg-slate-700/20 transition">
                      {item.thumbnailUrl
                        ? <img src={item.thumbnailUrl} alt="" className="w-14 h-10 object-cover rounded-lg shrink-0" />
                        : <div className="w-14 h-10 rounded-lg bg-slate-700/50 flex items-center justify-center shrink-0"><Video className="w-4 h-4 text-slate-600" /></div>
                      }
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-slate-300 truncate font-medium">{item.title || 'Untitled'}</p>
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

        {/* Footer */}
        <footer className="text-center py-8 text-slate-600 text-xs">
          <p>Orange Downloader v1.0 · For personal use only</p>
        </footer>
      </div>
    </div>
  )
}

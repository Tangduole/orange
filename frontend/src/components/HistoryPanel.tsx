import React from 'react';
import { Clock, ChevronDown, ChevronUp, Trash2, Video, RotateCcw } from 'lucide-react';

interface HistoryItem {
  taskId: string; status: string; title?: string;
  platform?: string; thumbnailUrl?: string; createdAt: string | number;
}

interface Props {
  showHistory: boolean;
  onToggle: () => void;
  history: HistoryItem[];
  onClearAll: () => void;
  onDelete: (taskId: string) => void;
  onRetry: (item: HistoryItem) => void;
  onDownloadTask: (item: HistoryItem) => void;
  isDark: boolean;
  t: (key: string) => string;
  getApiBase: () => string;
}

const PLATFORMS: Array<{ id: string; label: string }> = [
  { id: 'douyin', label: '抖音' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'x', label: 'X' },
  { id: 'bilibili', label: 'B站' },
  { id: 'instagram', label: 'Ins' },
];

export default function HistoryPanel({
  showHistory, onToggle, history, onClearAll, onDelete, onRetry, onDownloadTask,
  isDark, t, getApiBase
}: Props) {
  const platformLabel = (id: string) => PLATFORMS.find(p => p.id === id)?.label || '';

  return (
    <div className="mt-5">
      <button onClick={onToggle}
        className={`w-full flex items-center justify-between px-5 py-3 rounded-2xl border text-sm transition ${isDark ? 'bg-slate-900/60 border-slate-700/60 text-slate-300' : 'bg-light-surface border-light-border text-light-textSecondary'}`}>
        <span className="flex items-center gap-2">
          <Clock className="w-4 h-4" /> {t('downloadHistory')}
          {history.length > 0 && <span className="bg-orange-500/20 text-orange-400 px-2 py-0.5 rounded text-xs">{history.length}</span>}
        </span>
        <span className="flex items-center gap-2">
          {history.length > 0 && showHistory && (
            <button onClick={(e) => { e.stopPropagation(); onClearAll(); }} className="text-xs text-red-400 hover:text-red-300">{t('clearAllHistory')}</button>
          )}
          {showHistory ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
        </span>
      </button>
      {showHistory && (
        <div className={`mt-2 rounded-2xl border overflow-hidden ${isDark ? 'bg-slate-900/60 border-slate-700/60' : 'bg-light-surface border-light-border'}`}>
          <div className="max-h-60 overflow-y-auto">
            {history.length === 0 ? (
              <p className={`py-8 text-center text-sm ${isDark ? 'text-slate-500' : ''}`}>暂无下载记录</p>
            ) : history.map(item => (
              <div key={item.taskId} className={`flex items-center gap-3 px-4 py-3 border-b last:border-0 transition ${isDark ? 'border-slate-700/20 hover:bg-slate-800/40' : 'border-light-border hover:bg-gray-50'}`}>
                {item.thumbnailUrl ? (
                  <img src={item.thumbnailUrl.startsWith('http') ? item.thumbnailUrl : `${getApiBase()}${item.thumbnailUrl}`} alt="" className="w-12 h-8 object-cover rounded-lg shrink-0 bg-slate-700/50" />
                ) : (
                  <div className="w-12 h-8 rounded-lg bg-slate-700/50 flex items-center justify-center shrink-0"><Video className="w-3.5 h-3.5 text-slate-600" /></div>
                )}
                <div className="flex-1 min-w-0">
                  <p className={`text-xs font-medium truncate ${isDark ? 'text-slate-300' : 'text-light-text'}`}>{item.title || '未命名'}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    {item.platform && <span className="text-[10px] text-orange-400 bg-orange-500/10 px-1.5 py-0.5 rounded">{platformLabel(item.platform)}</span>}
                    <span className={`text-[10px] ${isDark ? 'text-slate-500' : 'text-light-textMuted'}`}>{new Date(item.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                </div>
                {item.status === 'error' && (
                  <button onClick={() => onRetry(item)} className="p-1.5 text-orange-500 hover:text-orange-400" title="重试">
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                )}
                <button onClick={() => onDelete(item.taskId)} className="p-1.5 text-slate-500 hover:text-red-400" title="删除">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

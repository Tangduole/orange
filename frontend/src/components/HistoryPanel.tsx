import React, { useState } from 'react';
import { Clock, ChevronDown, ChevronUp, Trash2, Video, Search, RotateCcw } from 'lucide-react';

interface HistoryItem {
  taskId: string; status: string; title?: string;
  platform?: string; thumbnailUrl?: string; createdAt: string | number;
  url?: string;
}

const PLATFORMS: Array<{ id: string; label: string; icon: string }> = [
  { id: 'douyin', label: '抖音', icon: '📱' },
  { id: 'tiktok', label: 'TikTok', icon: '🎵' },
  { id: 'youtube', label: 'YouTube', icon: '▶️' },
  { id: 'x', label: 'X / Twitter', icon: '🐦' },
  { id: 'bilibili', label: 'Bilibili', icon: '📺' },
  { id: 'instagram', label: 'Instagram', icon: '📸' },
];

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

export default function HistoryPanel({
  showHistory, onToggle, history, onClearAll, onDelete, onRetry, onDownloadTask,
  isDark, t, getApiBase
}: Props) {
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set());
  const [favorites, setFavorites] = useState<Set<string>>(new Set());

  const filteredHistory = history.filter(item => {
    if (filter === 'completed' && item.status !== 'completed') return false;
    if (filter === 'error' && item.status !== 'error') return false;
    if (filter === 'favorites' && !favorites.has(item.taskId)) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (item.title || '').toLowerCase().includes(q) || (item.platform || '').toLowerCase().includes(q);
    }
    return true;
  });

  const toggleSelect = (taskId: string) => {
    const next = new Set(selectedTasks);
    next.has(taskId) ? next.delete(taskId) : next.add(taskId);
    setSelectedTasks(next);
  };

  const toggleSelectAll = () => {
    if (selectedTasks.size === filteredHistory.length) setSelectedTasks(new Set());
    else setSelectedTasks(new Set(filteredHistory.map(h => h.taskId)));
  };

  const toggleFavorite = (taskId: string) => {
    const next = new Set(favorites);
    next.has(taskId) ? next.delete(taskId) : next.add(taskId);
    setFavorites(next);
    localStorage.setItem('orange_favorites', JSON.stringify([...next]));
  };

  const platformLabel = (id: string) => PLATFORMS.find(p => p.id === id)?.label || '';
  const apiBase = getApiBase();

  return (
    <div className="mt-5">
      <button onClick={onToggle}
        className={`w-full flex items-center justify-between px-5 py-3 rounded-2xl border text-sm transition ${isDark ? 'bg-slate-900/60 border-slate-700/60 text-slate-300 hover:text-slate-300' : 'bg-light-surface border-light-border text-light-textSecondary hover:text-light-text'}`}>
        <span className="flex items-center gap-2">
          <Clock className="w-4 h-4" /> {t('downloadHistory')}
          {history.length > 0 && <span className="bg-orange-500/20 text-orange-400 px-2 py-0.5 rounded text-xs">{history.length}</span>}
        </span>
        <span className="flex items-center gap-2">
          {history.length > 0 && showHistory && (
            <button onClick={(e) => { e.stopPropagation(); onClearAll(); }} className="text-xs text-red-400 hover:text-red-300 transition">{t('clearAllHistory')}</button>
          )}
          {showHistory ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
        </span>
      </button>
      {showHistory && (
        <div className={`mt-2 rounded-2xl border overflow-hidden ${isDark ? 'bg-slate-900/60 border-slate-700/60' : 'bg-light-surface border-light-border'}`}>
          <div className={`flex gap-2 p-3 border-b items-center ${isDark ? 'border-slate-700/30' : 'border-light-border'}`}>
            {filteredHistory.length > 0 && <input type="checkbox" checked={selectedTasks.size === filteredHistory.length} onChange={toggleSelectAll} className={`w-4 h-4 rounded ${isDark ? 'border-slate-600' : 'border-light-border'}`} />}
            {selectedTasks.size > 0 && (
              <button onClick={async () => { await Promise.all([...selectedTasks].map(id => onDelete(id))); setSelectedTasks(new Set()); }} className="px-3 py-1.5 bg-red-500/20 text-red-400 border border-red-500/50 rounded-lg text-xs">
                Delete ({selectedTasks.size})
              </button>
            )}
            <div className="flex-1 relative">
              <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search..."
                className={`w-full pl-8 pr-3 py-2 rounded-lg text-sm text-white placeholder:text-slate-500 ${isDark ? 'bg-slate-800/50 border border-slate-700/50' : ''}`} />
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            </div>
            <select value={filter} onChange={e => setFilter(e.target.value)}
              className={`px-3 py-2 rounded-lg text-sm text-white ${isDark ? 'bg-slate-800/50 border border-slate-700/50' : ''}`}>
              <option value="all">All</option>
              <option value="completed">Done</option>
              <option value="error">Failed</option>
            </select>
          </div>
          <div className="max-h-60 overflow-y-auto">
            {filteredHistory.length === 0 ? (
              <p className={`py-8 text-center text-sm ${isDark ? 'text-slate-600' : ''}`}>{searchQuery || filter !== 'all' ? 'No results' : 'No history'}</p>
            ) : filteredHistory.map(item => (
              <div key={item.taskId} className={`flex items-center gap-3 px-4 py-3 border-b last:border-0 hover:bg-slate-900/60 transition ${isDark ? 'border-slate-700/20' : 'border-light-border'} ${selectedTasks.has(item.taskId) ? 'bg-orange-500/10' : ''}`}>
                <input type="checkbox" checked={selectedTasks.has(item.taskId)} onChange={() => toggleSelect(item.taskId)} className={`w-4 h-4 rounded shrink-0 ${isDark ? 'border-slate-600' : ''}`} />
                {item.thumbnailUrl ? (
                  <button onClick={() => onDownloadTask(item)} className="relative shrink-0 group">
                    <img src={`${apiBase}${item.thumbnailUrl}`} alt="" className="w-14 h-10 object-cover rounded-lg" />
                    <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-lg opacity-0 group-hover:opacity-100 transition">
                      <Video className="w-4 h-4 text-white" />
                    </div>
                  </button>
                ) : <div className="w-14 h-10 rounded-lg bg-slate-700/50 flex items-center justify-center shrink-0"><Video className="w-4 h-4 text-slate-600" /></div>}
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium whitespace-nowrap ${(item.title || '').length > 20 ? 'animate-marquee' : 'truncate'} ${isDark ? 'text-slate-300' : ''}`}>{item.title || 'Untitled'}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    {item.platform && <span className="text-xs text-orange-400 bg-orange-500/10 px-1.5 py-0.5 rounded">{platformLabel(item.platform)}</span>}
                    <span className={`text-xs ${isDark ? 'text-slate-500' : ''}`}>{new Date(item.createdAt).toLocaleString('en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                </div>
                {item.status === 'error' && <button onClick={() => onRetry(item)} className="p-1.5 text-orange-500 hover:text-orange-400"><RotateCcw className="w-4 h-4" /></button>}
                <button onClick={() => toggleFavorite(item.taskId)} className={`p-1.5 ${favorites.has(item.taskId) ? 'text-yellow-400' : 'text-slate-600 hover:text-yellow-400'}`}>
                  <svg className="w-4 h-4" fill={favorites.has(item.taskId) ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                  </svg>
                </button>
                <button onClick={() => onDelete(item.taskId)} className="p-1.5 text-slate-600 hover:text-red-400"><Trash2 className="w-4 h-4" /></button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

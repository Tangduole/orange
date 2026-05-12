import React from 'react';

interface QualityOption {
  qualityLabel?: string; quality: string; format: string;
  width: number; height: number; hasVideo: boolean; hasAudio: boolean;
}

interface Props {
  qualities: QualityOption[];
  pendingQuality: string;
  onSelect: (q: string) => void;
  isVip: boolean;
  onUpgrade: () => void;
  isDark: boolean;
  batchMode: boolean;
}

const qualityShortEdge = (q: QualityOption) => q.height || Math.round(q.width * 9 / 16) || 720;

export default function QualitySelector({ qualities, pendingQuality, onSelect, isVip, onUpgrade, isDark, batchMode }: Props) {
  if (qualities.length === 0 || batchMode) return null;

  return (
    <div className="mb-4">
      <p className={`text-xs mb-2 font-medium ${isDark ? 'text-slate-400' : 'text-light-textSecondary'}`}>🎬 画质</p>
      <div className="flex flex-wrap gap-1.5">
        {qualities.map((q, idx) => {
          const shortEdge = qualityShortEdge(q);
          const isHighQuality = shortEdge > 720;
          const canSelect = isVip || !isHighQuality;
          const qualityLabel = (q as any).qualityLabel || q.quality || `${shortEdge}p`;
          const isSelected = pendingQuality === `height<=${shortEdge}`;
          return (
            <button
              key={idx}
              onClick={() => {
                if (!canSelect) { onUpgrade(); return; }
                onSelect(`height<=${shortEdge}`);
              }}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg transition-all ${
                isSelected
                  ? 'bg-orange-500 text-white font-semibold shadow-md'
                  : canSelect
                    ? 'bg-slate-700/40 text-slate-300 border border-slate-600/40 hover:border-orange-500/50 hover:text-white'
                    : 'bg-slate-800/40 text-slate-500 border border-slate-700/40 opacity-50'
              }`}
            >
              <span>🎬</span>
              <span>{qualityLabel}</span>
              {isHighQuality && !isVip && <span className="text-[10px]">⭐</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

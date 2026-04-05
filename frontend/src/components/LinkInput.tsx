import { X } from 'lucide-react';

interface LinkInputProps {
  value: string;
  onChange: (v: string) => void;
  platform?: string;
  onClear?: () => void;
}

export default function LinkInput({ value, onChange, platform, onClear }: LinkInputProps) {
  const platformNames: Record<string, string> = {
    douyin: '抖音',
    tiktok: 'TikTok',
    youtube: 'YouTube',
    x: 'X',
    instagram: 'Instagram',
    twitter: 'Twitter',
  };

  const platformIcons: Record<string, string> = {
    douyin: '🎵',
    tiktok: '🎵',
    youtube: '📺',
    x: '🐦',
    instagram: '📷',
    twitter: '🐦',
  };

  return (
    <div className="bg-dark-surface rounded-xl p-4 mb-4">
      <div className="relative">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="粘贴视频链接..."
          className="w-full h-12 bg-dark-input rounded-lg px-4 pr-10 text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-orange/50"
        />
        {value && (
          <button
            onClick={() => { onChange(''); onClear?.(); }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>
      
      {platform && platform !== 'unknown' && (
        <div className="mt-3 flex items-center gap-2">
          <span className="text-lg">{platformIcons[platform] || '🔗'}</span>
          <span className="text-sm text-text-secondary">
            已识别：{platformNames[platform] || platform}
          </span>
        </div>
      )}
    </div>
  );
}

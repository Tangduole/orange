import { Video, Music, FileText } from 'lucide-react';

type DownloadType = 'video' | 'audio' | 'subtitle';

interface DownloadOptionsProps {
  selected: DownloadType;
  onChange: (t: DownloadType) => void;
}

export default function DownloadOptions({ selected, onChange }: DownloadOptionsProps) {
  const options = [
    { type: 'video' as const, icon: Video, label: '视频' },
    { type: 'audio' as const, icon: Music, label: '音频' },
    { type: 'subtitle' as const, icon: FileText, label: '字幕' },
  ];
  
  return (
    <div className="grid grid-cols-3 gap-2 mb-4">
      {options.map((opt) => {
        const isSelected = selected === opt.type;
        return (
          <button
            key={opt.type}
            onClick={() => onChange(opt.type)}
            className={`
              py-3 px-2 rounded-xl flex flex-col items-center gap-1.5 transition-all border
              ${isSelected 
                ? 'bg-orange/15 border-orange text-orange' 
                : 'bg-dark-surface border-dark-border text-text-secondary'
              }
            `}
          >
            <opt.icon className="w-5 h-5" />
            <span className="text-sm font-medium">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

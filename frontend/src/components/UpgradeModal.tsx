import React from 'react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onUpgrade: () => void;
  isDark: boolean;
  t: (key: string) => string;
}

export default function UpgradeModal({ isOpen, onClose, onUpgrade, isDark, t }: Props) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-2xl w-full max-w-sm p-6 border border-orange-500/30 shadow-2xl relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-orange-500 to-amber-500" />
        <button onClick={onClose} className="absolute top-3 right-3 text-slate-400 hover:text-white">
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
        <div className="text-center mb-5">
          <p className="text-4xl mb-2">⚡</p>
          <h3 className="text-xl font-bold text-white">{t('dailyLimitReached')}</h3>
          <p className="text-slate-400 text-sm mt-2">{t('upgradeForUnlimited')}</p>
        </div>
        <div className="grid grid-cols-2 gap-3 mb-5">
          <div className="p-3 bg-slate-700/30 rounded-xl text-center">
            <p className="text-slate-400 text-xs">{t('free')}</p>
            <p className="text-lg font-bold text-white">3/{t('dailyShort')}</p>
          </div>
          <div className="p-3 bg-orange-500/10 border border-orange-500/30 rounded-xl text-center">
            <p className="text-orange-400 text-xs">⭐ Pro</p>
            <p className="text-lg font-bold text-orange-400">{t('unlimited')}</p>
          </div>
        </div>
        <button onClick={onUpgrade} className="w-full py-3 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 text-white font-bold rounded-xl transition-all shadow-lg shadow-orange-500/25">
          {t('upgradeToPro')} →
        </button>
      </div>
    </div>
  );
}

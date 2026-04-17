import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/auth';

interface ReferralModalProps {
  token: string;
  isOpen: boolean;
  onClose: () => void;
}

export default function ReferralModal({ token, isOpen, onClose }: ReferralModalProps) {
  const { t } = useTranslation();
  const [stats, setStats] = useState<any>(null);
  const [referralCode, setReferralCode] = useState('');
  const [applyCode, setApplyCode] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (isOpen) loadStats();
  }, [isOpen]);

  const loadStats = async () => {
    try {
      const data = await api.getReferralInfo(token);
      setStats(data);
      setReferralCode(data.referralCode || '');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleApply = async () => {
    if (!applyCode.trim()) return;
    setApplying(true);
    setError('');
    setMessage('');
    try {
      const res = await api.applyReferralCode(token, applyCode.trim());
      setMessage(res.message);
      setApplyCode('');
      loadStats();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setApplying(false);
    }
  };

  const copyCode = () => {
    const link = `https://orangedl.com?ref=${referralCode}`;
    navigator.clipboard.writeText(link);
    setMessage(t('copied'));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-2xl w-full max-w-md p-6 border border-slate-700 shadow-2xl">
        {/* Header */}
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold text-white">🎁 {t('referral')}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Messages */}
        {error && <div className="mb-4 p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-400 text-sm">{error}</div>}
        {message && <div className="mb-4 p-3 bg-green-500/20 border border-green-500/50 rounded-lg text-green-400 text-sm">{message}</div>}

        {/* My Referral Code */}
        <div className="mb-6 p-4 bg-gradient-to-r from-orange-500/10 to-amber-500/10 rounded-xl border border-orange-500/20">
          <p className="text-sm text-slate-400 mb-2">{t('yourReferralCode')}</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-2xl font-mono font-bold text-orange-400 tracking-wider">
              {referralCode || '...'}
            </code>
            <button
              onClick={copyCode}
              className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium rounded-lg transition"
            >
              {t('copyLink')}
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-2">{t('referralHint')}</p>
        </div>

        {/* Stats */}
        {stats && (
          <div className="mb-6 grid grid-cols-2 gap-3">
            <div className="p-3 bg-slate-700/30 rounded-xl text-center">
              <p className="text-2xl font-bold text-white">{stats.referredCount}</p>
              <p className="text-xs text-slate-400">{t('referredUsers')}</p>
            </div>
            <div className="p-3 bg-slate-700/30 rounded-xl text-center">
              <p className="text-2xl font-bold text-green-400">
                {stats.hasBonus ? `+${stats.bonusDownloads}` : '0'}
              </p>
              <p className="text-xs text-slate-400">{t('bonusPerDay')}</p>
            </div>
          </div>
        )}

        {/* Apply Referral Code */}
        {stats && !stats.referredCount && (
          <div className="mb-4">
            <p className="text-sm text-slate-300 mb-2">{t('haveReferralCode')}</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={applyCode}
                onChange={(e) => setApplyCode(e.target.value.toUpperCase())}
                placeholder={t('enterReferralCode')}
                className="flex-1 px-3 py-2 bg-slate-900/50 border border-slate-700 rounded-lg text-white placeholder:text-slate-500 text-sm font-mono uppercase"
              />
              <button
                onClick={handleApply}
                disabled={applying || !applyCode.trim()}
                className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium rounded-lg transition disabled:opacity-50"
              >
                {applying ? '...' : t('apply')}
              </button>
            </div>
          </div>
        )}

        {/* Rules */}
        <div className="p-3 bg-slate-700/20 rounded-xl">
          <p className="text-xs text-slate-400 font-medium mb-2">{t('referralRules')}</p>
          <ul className="text-xs text-slate-500 space-y-1">
            <li>• {t('referralRule1')}</li>
            <li>• {t('referralRule2')}</li>
            <li>• {t('referralRule3')}</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

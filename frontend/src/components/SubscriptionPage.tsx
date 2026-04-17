import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/auth';

interface SubscriptionPageProps {
  token: string;
  onBack: () => void;
  onLogout: () => void;
}

export default function SubscriptionPage({ token, onBack, onLogout }: SubscriptionPageProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<any>(null);
  const [userEmail, setUserEmail] = useState('');
  const [error, setError] = useState('');
  const [upgrading, setUpgrading] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');

  useEffect(() => {
    loadStatus();
  }, []);

  const loadStatus = async () => {
    try {
      const [userData, data] = await Promise.all([
        api.getMe(token),
        api.getSubscriptionStatus(token)
      ]);
      setUserEmail(userData.email || '');
      setStatus(data);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleUpgrade = async () => {
    setUpgrading(true);
    setError('');
    try {
      const data = await api.createCheckout(token);
      window.location.href = data.checkoutUrl;
    } catch (err: any) {
      setError(err.message || t('subscribeFailed'));
      setUpgrading(false);
    }
  };

  const formatDate = (ts: number | null) => {
    if (!ts) return t('na');
    const ms = ts > 10000000000 ? ts : ts * 1000;
    return new Date(ms).toLocaleDateString();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white">
      {/* Header */}
      <header className="p-4 flex items-center justify-between">
        <button 
          onClick={onBack}
          className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <button 
          onClick={onBack}
          className="p-2 text-slate-400 hover:text-white transition-colors"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        <h1 className="text-3xl font-bold text-center mb-2">{t('memberSubscribe')}</h1>
        <p className="text-slate-400 text-center mb-8">{t('unlockUnlimitedDownload')}</p>

        {error && (
          <div className="mb-6 p-4 bg-red-500/20 border border-red-500/50 rounded-xl text-red-400 text-center">
            {error}
          </div>
        )}

        {/* Current Status */}
        {status && (
          <div className="mb-8 p-4 bg-slate-800/50 rounded-xl border border-slate-700/50">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-400">{t('currentPlan')}</p>
                <p className="text-2xl font-bold">
                  {status.tier === 'pro' ? (
                    <span className="text-yellow-400">🎉 {t('pro')}</span>
                  ) : (
                    <span>{t('free')}</span>
                  )}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm text-slate-400">{t('subscription')}</p>
                <p className="font-medium capitalize">{status.subscriptionStatus || 'none'}</p>
              </div>
            </div>
            
            {status.tier === 'free' && (
              <div className="mt-4 pt-4 border-t border-slate-700">
                <p className="text-sm text-slate-400 mb-2">
                  {t('todayDownload')}: {status.usage?.dailyDownloads || 0} / {status.usage?.dailyLimit || 5}
                </p>
                <div className="w-full bg-slate-700 rounded-full h-2">
                  <div 
                    className="bg-orange-500 h-2 rounded-full transition-all"
                    style={{ 
                      width: `${Math.min(100, ((status.usage?.dailyDownloads || 0) / (status.usage?.dailyLimit || 5)) * 100)}%` 
                    }}
                  />
                </div>
              </div>
            )}

            {status.subscriptionEndsAt && (
              <p className="mt-3 text-sm text-slate-500">
                {t('subscriptionEndsAt')}: {formatDate(status.subscriptionEndsAt)}
              </p>
            )}
          </div>
        )}

        {/* Pricing Cards */}
        <div className="grid md:grid-cols-2 gap-6">
          {/* Free Plan */}
          <div className="bg-slate-800/50 rounded-2xl p-6 border border-slate-700/50">
            <h3 className="text-xl font-bold mb-2">{t('free')}</h3>
            <p className="text-3xl font-bold mb-4">$0<span className="text-base text-slate-400 font-normal">/{t('monthly')}</span></p>
            <p className="text-slate-400 text-sm mb-6">{t('forOccasionalUse')}</p>
            
            <ul className="space-y-3 mb-6">
              <li className="flex items-center gap-2 text-sm">
                <span className="text-green-400">✓</span> {t('dailyDownloadLimit', { count: 3 })}
              </li>
              <li className="flex items-center gap-2 text-sm">
                <span className="text-green-400">✓</span> {t('supportMainPlatforms')}
              </li>
              <li className="flex items-center gap-2 text-sm text-slate-500">
                <span>✗</span> {t('qualityLimit720p')}
              </li>
              <li className="flex items-center gap-2 text-sm text-slate-500">
                <span>✗</span> {t('batchDownload')}
              </li>
            </ul>

            <button
              disabled
              className="w-full py-3 bg-slate-700 text-slate-400 font-semibold rounded-xl cursor-not-allowed"
            >
              {t('currentPlan')}
            </button>
          </div>

          {/* Pro Plan */}
          <div className="bg-gradient-to-br from-orange-500/20 to-orange-600/10 rounded-2xl p-6 border-2 border-orange-500/50 relative">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-orange-500 text-xs font-bold rounded-full">
              ⭐ {t('popular')}
            </div>
            
            <h3 className="text-xl font-bold mb-2 text-orange-400">{t('pro')}</h3>
            <p className="text-3xl font-bold mb-4">$4.99<span className="text-base text-slate-400 font-normal">/{t('monthly')}</span></p>
            <p className="text-slate-400 text-sm mb-6">{t('bestValueForPowerUsers')}</p>
            
            <ul className="space-y-3 mb-6">
              <li className="flex items-center gap-2 text-sm">
                <span className="text-green-400">✓</span> <strong>{t('unlimited')}</strong> {t('downloads')}
              </li>
              <li className="flex items-center gap-2 text-sm">
                <span className="text-green-400">✓</span> {t('allPlatformsIncluding')}
              </li>
              <li className="flex items-center gap-2 text-sm">
                <span className="text-green-400">✓</span> {t('qualityUpTo4K')}
              </li>
              <li className="flex items-center gap-2 text-sm">
                <span className="text-green-400">✓</span> {t('batchDownload')}
              </li>
              <li className="flex items-center gap-2 text-sm">
                <span className="text-green-400">✓</span> {t('prioritySupport')}
              </li>
            </ul>

            {status?.tier === 'pro' ? (
              <button
                disabled
                className="w-full py-3 bg-green-500/20 text-green-400 font-semibold rounded-xl border border-green-500/50"
              >
                ✓ {t('alreadySubscribed')}
              </button>
            ) : (
              <button
                onClick={handleUpgrade}
                disabled={upgrading}
                className="w-full py-3 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 text-white font-semibold rounded-xl transition-all disabled:opacity-50"
              >
                {upgrading ? t('upgrading') + '...' : t('upgradeNow')}
              </button>
            )}
          </div>
        </div>

        {/* Delete Account */}
        <div className="mt-12 pt-8 border-t border-slate-700">
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="w-full py-3 text-red-500 hover:text-red-400 font-medium text-center transition-colors"
          >
            {t('deleteAccount')}
          </button>
        </div>

        {/* Delete Confirmation Modal */}
        {showDeleteConfirm && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
            <div className="bg-slate-800 rounded-2xl p-6 max-w-sm w-full border border-red-500/50">
              <h3 className="text-lg font-bold text-red-400 mb-4">⚠️ {t('confirmDeleteAccount')}</h3>
              <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                <p className="text-red-400 text-sm font-medium mb-2">{t('warningCannotBeRecovered')}</p>
                <ul className="text-slate-400 text-xs space-y-1">
                  <li>• {t('yourDownloadsWillBeDeleted')}</li>
                  <li>• {t('yourSubscriptionWillBeCancelled')}</li>
                  <li>• {t('thisActionCannotBeUndone')}</li>
                </ul>
              </div>
              <p className="text-white text-sm mb-4">{t('enterPasswordToConfirm')}</p>
              <input
                type="password"
                value={deletePassword}
                onChange={(e) => setDeletePassword(e.target.value)}
                placeholder={t('enterYourPassword')}
                className="w-full px-3 py-2 mb-4 bg-slate-900/50 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-500"
              />
              <div className="flex gap-3">
                <button
                  onClick={() => { setShowDeleteConfirm(false); setDeletePassword(''); setError(''); }}
                  className="flex-1 py-2.5 px-4 rounded-xl bg-slate-700 text-slate-300 hover:bg-slate-600 transition"
                >
                  {t('cancel')}
                </button>
                <button
                  onClick={async () => {
                    setDeleting(true)
                    if (!deletePassword) {
                      setError(t('pleaseEnterPassword'))
                      return
                    }
                    setError('')
                    setDeleting(true)
                    try {
                      await api.login(userEmail, deletePassword)
                      await api.deleteAccount(token)
                      onLogout()
                    } catch (err: any) {
                      setError(err.message || t('deletionFailed'))
                      setDeleting(false)
                    }
                  }}
                  disabled={deleting}
                  className="flex-1 py-2.5 px-4 rounded-xl bg-red-500 text-white hover:bg-red-600 transition disabled:opacity-50"
                >
                  {deleting ? t('deleting') + '...' : t('confirm')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* FAQ */}
        <div className="mt-12">
          <h3 className="text-lg font-bold mb-4">{t('faq')}</h3>
          <div className="space-y-3">
            <details className="bg-slate-800/30 rounded-lg">
              <summary className="p-4 cursor-pointer font-medium">{t('canICancelAnytime')}</summary>
              <p className="px-4 pb-4 text-sm text-slate-400">
                {t('yesYouCanCancelAnytime')}
              </p>
            </details>
            <details className="bg-slate-800/30 rounded-lg">
              <summary className="p-4 cursor-pointer font-medium">{t('whatPaymentMethods')}</summary>
              <p className="px-4 pb-4 text-sm text-slate-400">
                {t('weAcceptVariousPaymentMethods')}
              </p>
            </details>
            <details className="bg-slate-800/30 rounded-lg">
              <summary className="p-4 cursor-pointer font-medium">{t('howLongCanIDownload')}</summary>
              <p className="px-4 pb-4 text-sm text-slate-400">
                {t('downloadVideosAreStored')}
              </p>
            </details>
          </div>
        </div>
      </main>
    </div>
  );
}

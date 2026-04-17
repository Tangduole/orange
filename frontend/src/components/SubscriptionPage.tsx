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
  const [upgrading, setUpgrading] = useState('');
  const [billing, setBilling] = useState<'monthly' | 'yearly'>('monthly');
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

  const handleUpgrade = async (plan: string) => {
    setUpgrading(plan);
    setError('');
    try {
      const data = await api.createCheckout(token, plan);
      window.location.href = data.checkoutUrl;
    } catch (err: any) {
      setError(err.message || t('subscribeFailed'));
      setUpgrading('');
    }
  };

  const formatDate = (ts: number | null) => {
    if (!ts) return t('na');
    const ms = ts > 10000000000 ? ts : ts * 1000;
    return new Date(ms).toLocaleDateString();
  };

  const plans = [
    {
      key: 'free',
      name: t('free'),
      price: billing === 'monthly' ? '$0' : '$0',
      period: billing === 'monthly' ? t('monthly') : t('yearly'),
      desc: t('forOccasionalUse'),
      features: [
        { text: t('dailyDownloadLimit', { count: 3 }), included: true },
        { text: t('supportMainPlatforms'), included: true },
        { text: t('qualityLimit720p'), included: false },
        { text: t('batchDownload'), included: false },
      ],
      current: status?.tier === 'free',
      planId: null,
      highlight: false,
    },
    {
      key: 'basic',
      name: t('basic'),
      price: billing === 'monthly' ? '$2.99' : '$19.99',
      period: billing === 'monthly' ? t('monthly') : t('yearly'),
      savings: billing === 'yearly' ? '44%' : null,
      desc: t('forRegularUse'),
      features: [
        { text: t('dailyDownloadLimit', { count: 30 }), included: true },
        { text: t('allPlatforms'), included: true },
        { text: t('qualityUpTo1080p'), included: true },
        { text: t('batchDownload'), included: false },
      ],
      current: status?.tier === 'basic',
      planId: billing === 'monthly' ? 'basic_monthly' : 'basic_yearly',
      highlight: false,
    },
    {
      key: 'pro',
      name: t('pro'),
      price: billing === 'monthly' ? '$4.99' : '$29.99',
      period: billing === 'monthly' ? t('monthly') : t('yearly'),
      savings: billing === 'yearly' ? '50%' : null,
      desc: t('bestValueForPowerUsers'),
      features: [
        { text: t('unlimited') + ' ' + t('downloads'), included: true },
        { text: t('allPlatformsIncluding'), included: true },
        { text: t('qualityUpTo4K'), included: true },
        { text: t('batchDownload'), included: true },
        { text: t('prioritySupport'), included: true },
      ],
      current: status?.tier === 'pro',
      planId: billing === 'monthly' ? 'pro_monthly' : 'pro_yearly',
      highlight: true,
    },
  ];

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

      <main className="max-w-5xl mx-auto px-4 py-8">
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
                  ) : status.tier === 'basic' ? (
                    <span className="text-blue-400">✨ {t('basic')}</span>
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
                  {t('todayDownload')}: {status.usage?.dailyDownloads || 0} / {status.usage?.dailyLimit || 3}
                </p>
                <div className="w-full bg-slate-700 rounded-full h-2">
                  <div 
                    className="bg-orange-500 h-2 rounded-full transition-all"
                    style={{ 
                      width: `${Math.min(100, ((status.usage?.dailyDownloads || 0) / (status.usage?.dailyLimit || 3)) * 100)}%` 
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

        {/* Monthly/Yearly Toggle */}
        <div className="flex justify-center mb-8">
          <div className="inline-flex bg-slate-800/50 rounded-xl p-1 border border-slate-700/50">
            <button
              onClick={() => setBilling('monthly')}
              className={`px-6 py-2 rounded-lg text-sm font-medium transition-all ${
                billing === 'monthly' 
                  ? 'bg-orange-500 text-white shadow-lg' 
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {t('monthly')}
            </button>
            <button
              onClick={() => setBilling('yearly')}
              className={`px-6 py-2 rounded-lg text-sm font-medium transition-all relative ${
                billing === 'yearly' 
                  ? 'bg-orange-500 text-white shadow-lg' 
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {t('yearly')}
              <span className="absolute -top-2 -right-2 px-1.5 py-0.5 bg-green-500 text-white text-[10px] font-bold rounded-full">
                -50%
              </span>
            </button>
          </div>
        </div>

        {/* Pricing Cards */}
        <div className="grid md:grid-cols-3 gap-6">
          {plans.map((plan) => (
            <div 
              key={plan.key}
              className={`bg-slate-800/50 rounded-2xl p-6 border-2 relative ${
                plan.highlight 
                  ? 'border-orange-500/50 bg-gradient-to-br from-orange-500/20 to-orange-600/10' 
                  : 'border-slate-700/50'
              }`}
            >
              {plan.highlight && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-orange-500 text-xs font-bold rounded-full">
                  ⭐ {t('popular')}
                </div>
              )}
              {plan.savings && (
                <div className="absolute -top-3 right-4 px-2 py-0.5 bg-green-500 text-white text-xs font-bold rounded-full">
                  {t('save')} {plan.savings}
                </div>
              )}
              
              <h3 className={`text-xl font-bold mb-2 ${plan.highlight ? 'text-orange-400' : ''}`}>{plan.name}</h3>
              <p className="text-3xl font-bold mb-1">
                {plan.price}
                <span className="text-base text-slate-400 font-normal">/{plan.period}</span>
              </p>
              <p className="text-slate-400 text-sm mb-6">{plan.desc}</p>
              
              <ul className="space-y-3 mb-6">
                {plan.features.map((f, i) => (
                  <li key={i} className={`flex items-center gap-2 text-sm ${f.included ? '' : 'text-slate-500'}`}>
                    <span className={f.included ? 'text-green-400' : 'text-slate-600'}>{f.included ? '✓' : '✗'}</span>
                    {f.text}
                  </li>
                ))}
              </ul>

              {plan.current ? (
                <button
                  disabled
                  className={`w-full py-3 font-semibold rounded-xl cursor-not-allowed ${
                    plan.highlight 
                      ? 'bg-green-500/20 text-green-400 border border-green-500/50' 
                      : 'bg-slate-700 text-slate-400'
                  }`}
                >
                  {plan.key === 'free' ? t('currentPlan') : `✓ ${t('alreadySubscribed')}`}
                </button>
              ) : plan.planId ? (
                <button
                  onClick={() => handleUpgrade(plan.planId!)}
                  disabled={!!upgrading}
                  className={`w-full py-3 font-semibold rounded-xl transition-all disabled:opacity-50 ${
                    plan.highlight 
                      ? 'bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 text-white' 
                      : 'bg-slate-700 hover:bg-slate-600 text-white'
                  }`}
                >
                  {upgrading === plan.planId ? t('upgrading') + '...' : t('upgradeNow')}
                </button>
              ) : (
                <button
                  disabled
                  className="w-full py-3 bg-slate-700 text-slate-400 font-semibold rounded-xl cursor-not-allowed"
                >
                  {t('currentPlan')}
                </button>
              )}
            </div>
          ))}
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
                    if (!deletePassword) {
                      setError(t('pleaseEnterPassword'))
                      return
                    }
                    setError('')
                    setDeleting(true)
                    try {
                      await api.deleteAccount(token, deletePassword)
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

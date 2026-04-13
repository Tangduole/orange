import { useState, useEffect } from 'react';
import api from '../api/auth';

interface SubscriptionPageProps {
  token: string;
  onBack: () => void;
  onLogout: () => void;
}

export default function SubscriptionPage({ token, onBack, onLogout }: SubscriptionPageProps) {
  const [loading, setLoading] = useState(false);
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
      // 跳转到 Lemon Squeezy checkout
      window.location.href = data.checkoutUrl;
    } catch (err: any) {
      setError(err.message || '创建订阅失败');
      setUpgrading(false);
    }
  };

  const formatDate = (ts: number | null) => {
    if (!ts) return 'N/A';
    // ts 可能是秒或毫秒，检测：如果大于10亿则是秒，转毫秒
    const ms = ts > 10000000000 ? ts : ts * 1000;
    return new Date(ms).toLocaleDateString('zh-CN');
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
          返回
        </button>
        <button 
          onClick={onBack}
          className="p-2 text-slate-400 hover:text-white transition-colors"
          title="关闭"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        <h1 className="text-3xl font-bold text-center mb-2">会员订阅</h1>
        <p className="text-slate-400 text-center mb-8">解锁无限下载，高清画质</p>

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
                <p className="text-sm text-slate-400">当前等级</p>
                <p className="text-2xl font-bold">
                  {status.tier === 'pro' ? (
                    <span className="text-yellow-400">🎉 Pro</span>
                  ) : (
                    <span>Free</span>
                  )}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm text-slate-400">订阅状态</p>
                <p className="font-medium capitalize">{status.subscriptionStatus || 'none'}</p>
              </div>
            </div>
            
            {status.tier === 'free' && (
              <div className="mt-4 pt-4 border-t border-slate-700">
                <p className="text-sm text-slate-400 mb-2">
                  今日下载: {status.usage?.dailyDownloads || 0} / {status.usage?.dailyLimit || 5}
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
                订阅到期: {formatDate(status.subscriptionEndsAt)}
              </p>
            )}
          </div>
        )}

        {/* Pricing Cards */}
        <div className="grid md:grid-cols-2 gap-6">
          {/* Free Plan */}
          <div className="bg-slate-800/50 rounded-2xl p-6 border border-slate-700/50">
            <h3 className="text-xl font-bold mb-2">Free</h3>
            <p className="text-3xl font-bold mb-4">¥0<span className="text-base text-slate-400 font-normal">/永久</span></p>
            <p className="text-slate-400 text-sm mb-6">适合轻度使用</p>
            
            <ul className="space-y-3 mb-6">
              <li className="flex items-center gap-2 text-sm">
                <span className="text-green-400">✓</span> 每天 3 次下载
              </li>
              <li className="flex items-center gap-2 text-sm">
                <span className="text-green-400">✓</span> 抖音 / TikTok / X / YouTube
              </li>
              <li className="flex items-center gap-2 text-sm text-slate-500">
                <span>✗</span> 最高画质（720p）
              </li>
              <li className="flex items-center gap-2 text-sm text-slate-500">
                <span>✗</span> 无广告
              </li>
            </ul>

            <button
              disabled
              className="w-full py-3 bg-slate-700 text-slate-400 font-semibold rounded-xl cursor-not-allowed"
            >
              当前方案
            </button>
          </div>

          {/* Pro Plan */}
          <div className="bg-gradient-to-br from-orange-500/20 to-orange-600/10 rounded-2xl p-6 border-2 border-orange-500/50 relative">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-orange-500 text-xs font-bold rounded-full">
              推荐
            </div>
            
            <h3 className="text-xl font-bold mb-2 text-orange-400">Pro</h3>
            <p className="text-3xl font-bold mb-4">$4.99<span className="text-base text-slate-400 font-normal">/月</span></p>
            <p className="text-slate-400 text-sm mb-6">适合创作者和重度用户</p>
            
            <ul className="space-y-3 mb-6">
              <li className="flex items-center gap-2 text-sm">
                <span className="text-green-400">✓</span> <strong>无限</strong> 下载
              </li>
              <li className="flex items-center gap-2 text-sm">
                <span className="text-green-400">✓</span> 支持所有平台
              </li>
              <li className="flex items-center gap-2 text-sm">
                <span className="text-green-400">✓</span> 最高 1080p 原画
              </li>
              <li className="flex items-center gap-2 text-sm">
                <span className="text-green-400">✓</span> 无广告
              </li>
              <li className="flex items-center gap-2 text-sm">
                <span className="text-green-400">✓</span> 优先客服支持
              </li>
            </ul>

            {status?.tier === 'pro' ? (
              <button
                disabled
                className="w-full py-3 bg-green-500/20 text-green-400 font-semibold rounded-xl border border-green-500/50"
              >
                ✓ 已升级
              </button>
            ) : (
              <button
                onClick={handleUpgrade}
                disabled={upgrading}
                className="w-full py-3 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 text-white font-semibold rounded-xl transition-all disabled:opacity-50"
              >
                {upgrading ? '跳转中...' : '立即升级'}
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
            注销账号
          </button>
        </div>

        {/* Delete Confirmation Modal */}
        {showDeleteConfirm && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
            <div className="bg-slate-800 rounded-2xl p-6 max-w-sm w-full border border-red-500/50">
              <h3 className="text-lg font-bold text-red-400 mb-4">⚠️ 确认注销账号</h3>
              <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                <p className="text-red-400 text-sm font-medium mb-2">注销后将无法恢复！</p>
                <ul className="text-slate-400 text-xs space-y-1">
                  <li>• 您的所有下载记录将被删除</li>
                  <li>• 您的订阅将被取消</li>
                  <li>• 此操作不可撤销</li>
                </ul>
              </div>
              <p className="text-white text-sm mb-4">确定要注销账号吗？</p>
              <input
                type="password"
                value={deletePassword}
                onChange={(e) => setDeletePassword(e.target.value)}
                placeholder="请输入登录密码确认"
                className="w-full px-3 py-2 mb-4 bg-slate-900/50 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-500"
              />
              <div className="flex gap-3">
                <button
                  onClick={() => { setShowDeleteConfirm(false); setDeletePassword(''); setError(''); }}
                  className="flex-1 py-2.5 px-4 rounded-xl bg-slate-700 text-slate-300 hover:bg-slate-600 transition"
                >
                  取消
                </button>
                <button
                  onClick={async () => {
                    setDeleting(true)
                    if (!deletePassword) {
                      setError('请输入密码')
                      return
                    }
                    setError('')
                    setDeleting(true)
                    try {
                      // 先验证密码
                      await api.login(userEmail, deletePassword)
                      // 密码正确，注销账号
                      await api.deleteAccount(token)
                      onLogout()
                    } catch (err: any) {
                      setError(err.message || '注销失败，密码可能不正确')
                      setDeleting(false)
                    }
                  }}
                  disabled={deleting}
                  className="flex-1 py-2.5 px-4 rounded-xl bg-red-500 text-white hover:bg-red-600 transition disabled:opacity-50"
                >
                  {deleting ? '注销中...' : '确认注销'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* FAQ */}
        <div className="mt-12">
          <h3 className="text-lg font-bold mb-4">常见问题</h3>
          <div className="space-y-3">
            <details className="bg-slate-800/30 rounded-lg">
              <summary className="p-4 cursor-pointer font-medium">订阅可以取消吗？</summary>
              <p className="px-4 pb-4 text-sm text-slate-400">
                可以随时取消。取消后，在当前计费周期结束前你仍可享受 Pro 功能。
              </p>
            </details>
            <details className="bg-slate-800/30 rounded-lg">
              <summary className="p-4 cursor-pointer font-medium">支持哪些支付方式？</summary>
              <p className="px-4 pb-4 text-sm text-slate-400">
                支持 Visa、Mastercard、American Express 等国际信用卡，以及 PayPal。
              </p>
            </details>
            <details className="bg-slate-800/30 rounded-lg">
              <summary className="p-4 cursor-pointer font-medium">下载的视频有水印吗？</summary>
              <p className="px-4 pb-4 text-sm text-slate-400">
                无水印。Pro 用户下载的视频均为原始高清版本。
              </p>
            </details>
          </div>
        </div>
      </main>
    </div>
  );
}

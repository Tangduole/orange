import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/auth';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (token: string, user: any) => void;
  onForgotPassword: () => void;
}

export default function AuthModal({ isOpen, onClose, onSuccess, onForgotPassword }: AuthModalProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    if (mode === 'register' && password !== confirmPassword) {
      setError(t('passwordMismatch'));
      setLoading(false);
      return;
    }

    try {
      const data = mode === 'login' 
        ? await api.login(email, password)
        : await api.register(email, password);
      
      if (data.needsEmailVerification) {
        setLoading(false);
        setSuccessMessage(t('registerSuccess'));
        setError('');
        setMode('login');
        setPassword('');
        setConfirmPassword('');
        return;
      }
      
      api.saveToken(data.token);
      localStorage.setItem('orange_user', JSON.stringify(data.user));
      onSuccess(data.token, data.user);
      onClose();
    } catch (err: any) {
      setError(err.message || t('operationFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-2xl w-full max-w-md p-6 shadow-2xl border border-slate-700">
        {/* Header with Tab Switcher */}
        <div className="flex justify-between items-center mb-6">
          <div className="flex gap-2 w-full">
            <button
              onClick={() => setMode('login')}
              className={`flex-1 py-2 rounded-xl text-sm font-medium transition-all ${
                mode === 'login' 
                  ? 'bg-orange-500/15 text-orange-300 border border-orange-500/30' 
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {t('login')}
            </button>
            <button
              onClick={() => setMode('register')}
              className={`flex-1 py-2 rounded-xl text-sm font-medium transition-all ${
                mode === 'register' 
                  ? 'bg-orange-500/15 text-orange-300 border border-orange-500/30' 
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {t('register')}
            </button>
          </div>
          <button 
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors ml-3"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Success */}
        {successMessage && (
          <div className="mb-4 p-3 bg-green-500/20 border border-green-500/50 rounded-lg text-green-400 text-sm">
            {successMessage}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">
              {t('email')}
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
              className="w-full px-4 py-3 bg-slate-900/50 border border-slate-600/50 rounded-xl text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-orange-500/50 focus:border-orange-500/70 transition-all"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">
              {t('password')}
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={6}
              className="w-full px-4 py-3 bg-slate-900/50 border border-slate-600/50 rounded-xl text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-orange-500/50 focus:border-orange-500/70 transition-all"
            />
          </div>

          {mode === 'register' && (
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">
                {t('confirmPassword')}
              </label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                required
                minLength={6}
                className="w-full px-4 py-3 bg-slate-900/50 border border-slate-600/50 rounded-xl text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-orange-500/50 focus:border-orange-500/70 transition-all"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 text-white font-semibold rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? t('loading') + '...' : (mode === 'login' ? t('login') : t('register'))}
          </button>
        </form>

        {/* Forgot Password - Only in login mode */}
        {mode === 'login' && (
          <div className="mt-3 text-center">
            <button
              onClick={onForgotPassword}
              className="text-xs text-slate-500 hover:text-orange-400 transition"
            >
              {t('forgotPassword')}
            </button>
          </div>
        )}

        {/* Switch Mode - Hidden since we use tabs now */}
        <div className="mt-4 text-center text-sm text-slate-500">
          {mode === 'login' ? t('noAccount') : t('hasAccount')}
          <button
            onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); setSuccessMessage(''); setPassword(''); setConfirmPassword(''); }}
            className="text-orange-400 hover:text-orange-300 ml-1 font-medium"
          >
            {mode === 'login' ? t('register') : t('login')}
          </button>
        </div>

        {/* Info */}
        <div className="mt-4 p-3 bg-slate-700/30 rounded-lg text-xs text-slate-400">
          💡 {t('registerInfo')}
        </div>
      </div>
    </div>
  );
}

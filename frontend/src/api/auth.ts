/**
 * API 服务 - 认证相关
 */

// 本地开发优先走 Vite 代理，生产环境默认走线上 API。
export const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? '' : 'https://api.orangedl.com');

// 全局 token 过期回调（App.tsx 注册）
let onTokenExpired: (() => void) | null = null;
export function setOnTokenExpired(fn: () => void) {
  onTokenExpired = fn;
}

// 提前检查 token 是否过期，避免用户看到错误
export function isTokenExpired(): boolean {
  try {
    const token = localStorage.getItem('orange_token');
    if (!token) return true;
    const payload = JSON.parse(atob(token.split('.')[1]));
    const now = Math.floor(Date.now() / 1000);
    return payload.exp ? payload.exp < now : false;
  } catch {
    return true;
  }
}

// 统一请求封装，自动处理 401 和 JSON 解析失败
async function apiFetch(url: string, options?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, options);
  } catch (e: any) {
    throw new Error('网络连接失败，请检查网络后重试');
  }
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    throw new Error('服务器繁忙，请稍后重试');
  }
  let data: any;
  try {
    const text = await res.text();
    if (!text) throw new Error('服务器返回空响应');
    data = JSON.parse(text);
  } catch (e: any) {
    if (e.message === '服务器返回空响应') throw e;
    throw new Error('服务器响应异常，请稍后重试');
  }
  if (data.code === 401 && onTokenExpired) {
    onTokenExpired();
  }
  return data;
}

interface AuthResponse {
  token: string;
  user: {
    id: string;
    email: string;
    tier: string;
    subscriptionStatus?: string;
  };
}

interface UsageResponse {
  tier: string;
  isPro: boolean;
  dailyDownloads: number;
  dailyLimit: number;
  remaining: number;
  subscriptionStatus: string;
  subscriptionEndsAt: number | null;
}

interface SubscribeResponse {
  checkoutUrl: string;
  checkoutId: string;
}

export const api = {
  // 获取当前域名作为 Referer
  getReferer: () => window.location.origin,

  // 认证 API
  async register(email: string, password: string): Promise<AuthResponse> {
    const data = await apiFetch(`${API_BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (data.code !== 0) throw new Error(data.message);
    return data.data;
  },

  async login(email: string, password: string): Promise<AuthResponse> {
    const data = await apiFetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (data.code !== 0) throw new Error(data.message);
    return data.data;
  },

  async getMe(token: string) {
    const data = await apiFetch(`${API_BASE}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (data.code !== 0) throw new Error(data.message);
    return data.data;
  },

  // 获取用户使用量（下载次数等）
  async getUsage(token: string) {
    const data = await apiFetch(`${API_BASE}/api/subscribe/status`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (data.code !== 0) throw new Error(data.message);
    return data.data.usage;
  },

  // 订阅 API
  async getSubscriptionStatus(token: string) {
    const data = await apiFetch(`${API_BASE}/api/subscribe/status`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (data.code !== 0) throw new Error(data.message);
    return data.data;
  },

  async createCheckout(token: string, plan: string = 'pro_monthly'): Promise<SubscribeResponse> {
    const data = await apiFetch(`${API_BASE}/api/subscribe/checkout`, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ plan })
    });
    if (data.code !== 0) throw new Error(data.message);
    return data.data;
  },

  // Token 管理
  saveToken: (token: string) => localStorage.setItem('orange_token', token),
  getToken: () => localStorage.getItem('orange_token'),
  removeToken: () => localStorage.removeItem('orange_token'),
  
  // 清除认证
  logout: () => {
    localStorage.removeItem('orange_token');
    localStorage.removeItem('orange_user');
  },

  // 注销账号
  async deleteAccount(token: string, password: string) {
    const data = await apiFetch(`${API_BASE}/api/auth/delete-account`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ password })
    });
    if (data.code !== 0) throw new Error(data.message);
    return data.data;
  },

  // 推荐系统
  async getReferralInfo(token: string) {
    const data = await apiFetch(`${API_BASE}/api/auth/referral`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (data.code !== 0) throw new Error(data.message);
    return data.data;
  },

  async applyReferralCode(token: string, code: string) {
    const data = await apiFetch(`${API_BASE}/api/auth/referral/apply`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ code })
    });
    if (data.code !== 0) throw new Error(data.message);
    return data;
  },

  // 忘记密码
  async forgotPassword(email: string) {
    const data = await apiFetch(`${API_BASE}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    if (data.code !== 0) throw new Error(data.message);
    return data;
  },

  // 重置密码
  async resetPassword(token: string, password: string) {
    const data = await apiFetch(`${API_BASE}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password })
    });
    if (data.code !== 0) throw new Error(data.message);
    return data;
  },

  // 管理员：赋予会员
  async adminGrantVip(token: string, email: string, days: number = 365) {
    const data = await apiFetch(`${API_BASE}/api/subscribe/admin/grant-vip`, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, days })
    });
    if (data.code !== 0) throw new Error(data.message);
    return data;
  },

  // 管理员：撤销会员
  async adminRevokeVip(token: string, email: string) {
    const data = await apiFetch(`${API_BASE}/api/subscribe/admin/revoke-vip`, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email })
    });
    if (data.code !== 0) throw new Error(data.message);
    return data;
  }
};

export default api;

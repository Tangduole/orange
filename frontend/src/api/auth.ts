/**
 * API 服务 - 认证相关
 */

// 如果没配置 VITE_API_URL，本地开发用相对路径，生产环境用 Railway
const API_BASE = import.meta.env.VITE_API_URL || 'https://orange-production-95b9.up.railway.app';

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
    const res = await fetch(`${API_BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(data.message);
    return data.data;
  },

  async login(email: string, password: string): Promise<AuthResponse> {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(data.message);
    return data.data;
  },

  async getMe(token: string) {
    const res = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(data.message);
    return data.data;
  },

  // 订阅 API
  async getSubscriptionStatus(token: string) {
    const res = await fetch(`${API_BASE}/api/subscribe/status`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(data.message);
    return data.data;
  },

  async createCheckout(token: string): Promise<SubscribeResponse> {
    const res = await fetch(`${API_BASE}/api/subscribe/checkout`, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    const data = await res.json();
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
  async deleteAccount(token: string) {
    const res = await fetch(`/api/auth/delete-account`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(data.message);
    return data.data;
  },

  // 忘记密码
  async forgotPassword(email: string) {
    const res = await fetch(`${API_BASE}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(data.message);
    return data;
  },

  // 重置密码
  async resetPassword(token: string, password: string) {
    const res = await fetch(`${API_BASE}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password })
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(data.message);
    return data;
  },

  // 管理员：赋予会员
  async adminGrantVip(token: string, email: string, days: number = 365) {
    const res = await fetch(`${API_BASE}/api/subscribe/admin/grant-vip`, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, days })
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(data.message);
    return data;
  },

  // 管理员：撤销会员
  async adminRevokeVip(token: string, email: string) {
    const res = await fetch(`${API_BASE}/api/subscribe/admin/revoke-vip`, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(data.message);
    return data;
  }
};

export default api;

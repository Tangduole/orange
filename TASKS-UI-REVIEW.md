# UI 优化任务清单（来自评审）

## 任务 1：SubscriptionPage 接入 i18n（Bug 级，优先级最高）
**文件：** `frontend/src/components/SubscriptionPage.tsx`

问题：组件完全没有接入 i18n，所有文案都是硬编码英文 key 名（MemberSubscribe/Subscribe/Free 等）。

**改动：**
- 加上 `import { useTranslation } from 'react-i18next'`，组件内调用 `const { t } = useTranslation()`
- 所有硬编码字符串改为 `t('key')` 形式
- 在 `frontend/src/i18n/locales/` 的 6 个语言文件补充缺失的翻译 key（中英双语）

**需替换的 key 示例：**
- `MemberSubscribe` → `t('memberSubscribe')`
- `Subscribe` → `t('subscribe')`
- `Free` → `t('free')`
- `Pro` → `t('pro')`
- `TodayDownload` → `t('todayDownload')`
- `Unlimited` → `t('unlimited')`
- `SubscribecanCancel？` → `t('subscribeCanCancel')`
- FAQ 区域所有 key 名文字

---

## 任务 2：次数用尽时加升级 Banner
**文件：** `frontend/src/App.tsx`

在下载按钮/表单区域，次数用尽时（`remainingDownloads === 0`）显示醒目 Banner：

```jsx
{!isVip && remainingDownloads === 0 && (
  <div className="mb-3 p-3 bg-gradient-to-r from-orange-500/20 to-amber-500/20 rounded-xl border border-orange-500/40 text-center">
    <p className="text-sm text-white mb-1">今日下载次数已用完</p>
    <button onClick={() => setShowSubscription(true)} className="text-orange-400 hover:text-orange-300 font-semibold text-sm">
      ⭐ 升级 Pro 解锁无限下载 →
    </button>
  </div>
)}
```

---

## 任务 3：AuthModal 品牌一致性和 Tab 样式
**文件：** `frontend/src/components/AuthModal.tsx`

**3a. 背景色修复（第 83 行附近）：**
`bg-[#1a1a2e]` 硬编码背景，改为跟随主题系统（需要从 App.tsx 传入 isDark 或类似状态）。

**3b. 登录/注册改为 Tab 切换样式：**
```jsx
<div className="flex gap-2 mb-6">
  <button onClick={() => setMode('login')} className={`flex-1 py-2 rounded-xl text-sm font-medium ${mode === 'login' ? 'bg-orange-500/15 text-orange-300' : 'text-slate-400'}`}>
    {t('login')}
  </button>
  <button onClick={() => setMode('register')} className={`flex-1 py-2 rounded-xl text-sm font-medium ${mode === 'register' ? 'bg-orange-500/15 text-orange-300' : 'text-slate-400'}`}>
    {t('register')}
  </button>
</div>
```

---

## 任务 4：空状态引导区
**文件：** `frontend/src/App.tsx`

URL 输入框下方，首次访问时（`!url`）显示引导区：

```jsx
{!url && (
  <div className="mb-4 p-4 bg-gradient-to-r from-orange-500/10 to-amber-500/10 rounded-2xl border border-orange-500/20">
    <p className="text-sm text-slate-300 mb-2">🍊 粘贴任意短视频链接即可下载</p>
    <p className="text-xs text-slate-500">支持 抖音 / TikTok / YouTube / X / Instagram / 小红书</p>
  </div>
)}
```

---

**优先级：** 任务 1 最优先（i18n bug），其余顺序不限。

# 橙子下载器 UI 设计方案

## 1. 整体设计风格说明

### 设计理念
采用 **现代极简工具风**，突出功能性，减少视觉干扰。作为一款生产力工具，让用户专注于下载任务本身。

- **轻量层次**：通过阴影、圆角、透明度创造柔和层次感，不使用过多装饰
- **信息分层**：核心操作（输入链接）放在最显眼位置，辅助功能下沉
- **手势友好**：按钮和可点击区域足够大（最小 48dp），适合移动端触摸操作
- **动效适度**：转场和状态变化使用微动画，不喧宾夺主

### 设计关键词
- 简洁 · 专业 · 高效
- 深色优先 · 橙色活力
- 移动端优先 · 手势友好

---

## 2. 配色方案

### 主色调（品牌色）
| 名称 | 色值 | 用途 |
|------|------|------|
| 橙子主色 | `#FF7D00` | 主按钮、高亮、进度条、Logo |
| 橙子浅 | `#FFA347` | 按钮 hover、渐变辅助 |
| 橙子深 | `#E56E00` | 按钮按压、边框强调 |

### 深色主题色板
| 名称 | 色值 | 用途 |
|------|------|------|
| 背景 0 | `#121212` | 主背景 |
| 背景 1 | `#1E1E1E` | 卡片、面板 |
| 背景 2 | `#2C2C2C` | 输入框、高亮卡片 |
| 背景 3 | `#333333` | 分隔、禁用组件 |
| 边框 | `#3A3A3A` | 分割线、边框 |

### 文字色
| 名称 | 色值 | 用途 |
|------|------|------|
| 主文字 | `#FFFFFF` | 标题、重要信息 |
| 次要文字 | `#B0B0B0` | 正文、辅助说明 |
| 提示文字 | `#757575` | 占位符、帮助文字 |
| 链接 | `#FF7D00` | 可点击文字 |

### 状态色
| 名称 | 色值 | 用途 |
|------|------|------|
| 成功 | `#4CAF50` | 下载完成、成功状态 |
| 警告 | `#FFC107` | 等待、提醒 |
| 错误 | `#F44336` | 下载失败、错误 |
| 进行中 | `#2196F3` | 下载中、处理中 |

---

## 3. 页面详细设计

### 3.1 首页（主下载界面）

#### 布局结构（自上而下）

```
┌─────────────────────────────────┐
│  [Logo] 橙子下载器          我的  │ ← 头部导航
├─────────────────────────────────┤
│                                 │
│  □ 粘贴链接                     │ ← 链接输入区（最大高度）
│  🔗 自动识别：抖音               │ ← 识别结果标签
│                                 │
│  ┌───┐ ┌─────┐ ┌─────┐          │
│  │🎬  │ │🔊  │ │📝  │          │ ← 下载选项（三选一）
│  │视频│ │音频│ │字幕│          │
│  └───┘ └─────┘ └─────┘          │
│                                 │
│         [ 立即下载 ]            │ ← 主按钮
│                                 │
├─────────────────────────────────┤
│  最近下载         查看全部 →     │
│  ┌────────────────────────────┐  │
│  │ 封面  标题         完成 ▶️  │  │
│  ├────────────────────────────┤  │
│  │ 封面  标题         下载中 ● │  │
│  └────────────────────────────┘  │
└─────────────────────────────────┘
```

#### 组件细节

**头部导航**
- 高度：56dp
- 左侧：橙子图标（16dp × 16dp）+ "橙子下载器" 标题（18sp，字重 600）
- 右侧："我的" 文字按钮 / 头像（如果已登录），点击弹出侧边栏 / 打开会员页
- 背景：`#121212`（同主背景）

**链接输入区**
- 容器：圆角 12dp，背景 `#1E1E1E`，内边距 16dp
- 输入框：
  - 高度：48dp
  - 背景：`#2C2C2C`
  - 圆角：8dp
  - 占位文字："粘贴视频链接..."（`#757575`）
  - 右侧有 "清空" 按钮（X 图标）
- 自动识别标签：
  - 显示在输入框下方，间距 8dp
  - 左侧平台图标 + "已识别：抖音" 文字（14sp，`#B0B0B0`）
  - 未识别时显示 "未识别链接"（灰色）

**下载选项**
- 三个选项卡片，平均分布宽度
- 间距：8dp
- 未选中状态：背景 `#1E1E1E`，边框 `#3A3A3A`，文字 `#B0B0B0`
- 选中状态：背景 `rgba(255, 125, 0, 0.15)`，边框 `#FF7D00`，文字 `#FF7D00`，图标颜色主色
- 每个选项包含图标 + 文字（两行），居中对齐

**立即下载按钮**
- 高度：52dp，圆角 12dp
- 背景：线性渐变 `#FF7D00` → `#FFA347`
- 文字："立即下载"（16sp，字重 600，白色）
- 阴影：柔和橙色阴影 `rgba(255, 125, 0, 0.3)`
- 禁用状态：背景 `#333333`，文字 `#757575`，无阴影

**下载进度区域**（点击下载后显示）
- 卡片：背景 `#1E1E1E`，圆角 12dp，内边距 16dp，margin 16dp 0
- 左侧：文件名 + 状态文字
- 右侧：速度 / 大小
- 进度条：
  - 背景：`#333333`，高度 8dp，圆角 4dp
  - 进度：`#FF7D00`，圆角跟随
- 操作按钮：暂停 / 取消，悬浮在右侧

**最近下载区域**
- 标题栏："最近下载"（16sp，字重 600）+ "查看全部 →" 链接文字右对齐
- 列表项：
  - 高度：72dp
  - 左侧：视频封面缩略图（圆角 8dp，56dp × 56dp）
  - 中间：标题（一行省略）+ 时间 + 状态标签
  - 右侧：播放按钮 / 重新下载按钮
  - 分割线：`#3A3A3A`，底部 1dp

#### 交互设计
- 打开 App 自动聚焦输入框（Web 端），弹出粘贴板读取提示（App 端）
- 粘贴链接后 500ms 自动识别平台
- 识别成功后轻微震动反馈（App）
- 选项切换有平滑动画过渡
- 下载列表支持左滑删除（移动端）

---

### 3.2 会员订阅页

#### 布局结构

```
┌─────────────────────────────────┐
│  ← 返回             橙子会员     │
├─────────────────────────────────┤
│                                 │
│          🎁 解锁高级功能         │
│      成为会员 · 享受极速下载     │
│                                 │
│  ┌────────────────────────────┐  │
│  │  🟠 当前：免费版            │  │ ← 当前方案卡片
│  └────────────────────────────┘  │
│                                 │
│  ┌──────────┐  ┌────────────┐   │
│  │ 免费版   │  │  专业版     │   │ ← 对比表格
│  │  ✓基础下载│  │  ✓全部功能  │   │
│  │  ✕高速通道│  │  ✓高速通道  │   │
│  │  ✕无广告  │  │  ✓无广告    │   │
│  │  ...     │  │  ...        │   │
│  └──────────┘  └────────────┘   │
│                                 │
│  ┌────────────────────────────┐  │
│  │  专业版                    │  │ ← 推荐订阅卡片
│  │  🔥 推荐 一年¥39 / 年       │  │
│  │  相当于 ¥3.2 / 月           │  │
│  │  [ 立即开通 ]              │  │
│  └────────────────────────────┘  │
│                                 │
│  月付 ¥6 / 月    [ 开通 ]        │ ← 其他选项
│                                 │
│  ❓ 常见问题                     │
│  • 购买后可以退款吗？            │
│  • 支持多设备吗？                │
│                                 │
└─────────────────────────────────┘
```

#### 组件细节

**头部**
- 返回按钮（左侧，箭头图标，48dp × 48dp 可点击区域）
- 标题 "橙子会员" 居中
- 背景：`#121212`

**头部介绍区**
- 居中对齐，padding 24dp 0
- 图标：橙子图标，用主色，大小 48dp
- 主标题："解锁高级功能"（24sp，字重 700，白色）
- 副标题："成为会员，享受极速下载与无广告体验"（14sp，`#B0B0B0`）

**对比表格**
- 两行三列布局（功能行 vs 版本列）
- 背景：`#1E1E1E`，圆角 12dp
- 表头：免费版 / 专业版，专业版表头背景 `rgba(255, 125, 0, 0.15)`，文字主色
- 对勾：绿色 ✓ 表示支持，灰色 ✕ 表示不支持
- 功能列表：
  1. 多平台视频下载 ✓ / ✓
  2. 最高画质支持 ✓ / ✓
  3. 音频提取 ✓ / ✓
  4. 高速下载通道 ✕ / ✓
  5. 无广告 ✕ / ✓
  6. 批量下载 ✕ / ✓
  7. 云同步下载历史 ✕ / ✓
  8. 优先更新支持 ✕ / ✓

**订阅选项卡片**
- 推荐卡片：
  - 边框：2dp `#FF7D00`
  - 背景：`rgba(255, 125, 0, 0.08)`
  - 左上角 "🔥 推荐" 标签（圆角 20dp，背景 `#FF7D00`，文字白色，小字号）
  - 价格区域：大字号显示价格，小字号显示周期
  - 开通按钮：主色背景，圆角 8dp，高度 44dp，文字 "立即开通"
- 其他选项：
  - 背景：`#1E1E1E`，边框 1dp `#3A3A3A`
  - 布局同推荐卡片，按钮样式为描边

**常见问题**
- 标题 "常见问题"（16sp，字重 600）
- 折叠面板，点击展开回答
- 问题文字：14sp，白色
- 回答文字：14sp，`#B0B0B0`，padding 12dp 0 16dp

#### 交互设计
- 默认选中年付选项（推荐）
- 切换月付/年付有选中态动画
- 开通按钮直接唤起支付
- 已订阅用户显示"当前订阅"状态，按钮变灰不可点击

---

### 3.3 登录/注册弹窗

#### 设计说明
- 底部弹窗样式（移动端），从下往上滑入
- 支持手机号+验证码登录，也可以选择微信一键登录
- 简洁，只保留必要字段

#### 布局结构

```
┌─────────────────────────────────┐
│  欢迎使用橙子下载器               │
│  登录后可同步下载记录到云端       │
│                                 │
│  [📱 手机号登录]  [💬 微信登录]    │ ← Tab 切换
│                                 │
│  +86  [ 请输入手机号 ]           │ ← 输入框
│                                 │
│  [ 请输入验证码 ]  [获取验证码]   │
│                                 │
│         [ 同意 《用户协议》      │
│          和 《隐私政策》] ☑️       │
│                                 │
│          [ 登录 ]                │
│                                 │
└─────────────────────────────────┘
```

#### 组件细节

**弹窗容器**
- 宽度：100%，最大高度：85% 屏幕
- 背景：`#1E1E1E`
- 顶部圆角：16dp
- 顶部有拖拽条（`#333333`，宽度 40dp，高度 4dp，圆角 2dp，居中）

**标题区**
- 标题："欢迎使用橙子下载器"（20sp，字重 600，白色）
- 说明："登录后可同步下载记录到云端"（14sp，`#B0B0B0`）
- 间距：16dp 上下

**Tab 切换**
- 两个选项，平分宽度
- 高度：44dp
- 未选中：背景透明，文字 `#B0B0B0`
- 选中：底部 2dp `#FF7D00` 下划线，文字 `#FF7D00`

**输入区域**
- 每个输入框：
  - 标签 / 前置：左侧显示 country code / 提示
  - 输入框本身：高度 48dp，背景 `#2C2C2C`，圆角 8dp，内边距 12dp
  - 文字颜色：白色，占位符 `#757575`
- 验证码输入框：
  - 左侧输入框占 2/3
  - 右侧 "获取验证码" 按钮占 1/3，margin-left 12dp
  - 按钮背景：`#FF7D00`，圆角 8dp，文字白色（14sp）
  - 倒计时状态：按钮背景 `#333333`，文字 `#757575`

**协议勾选**
- 布局：复选框 + 文字，居中
- 复选框：选中态填充 `#FF7D00`
- 文字："我已同意《用户协议》和《隐私政策》"，12sp，`#B0B0B0`，可点击链接跳转

**登录按钮**
- 高度：52dp，圆角 12dp
- 背景：`#FF7D00` 渐变
- 文字："登录"（16sp，字重 600，白色）
- 禁用状态：背景 `#333333`，文字 `#757575`

**微信登录**
- 微信登录 Tab 内容更简单：
  - 大微信图标
  - 说明："点击下方按钮一键登录"
  - 按钮：[ 微信一键登录 ]，绿色背景（微信品牌色 `#07C160`）

#### 交互设计
- 打开：从底部向上滑入动画（300ms）
- 点击遮罩 / 向下拖拽关闭
- 输入手机号后自动格式化（3-4-4 分组）
- 获取验证码按钮点击后开始 60s 倒计时
- 勾选协议才能点击登录按钮

---

## 4. 实现代码片段（React + Tailwind CSS）

### 深色主题配色定义 (tailwind.config.js)

```js
/** @type {import('tailwindcss').Config} */
module.exports = {
  theme: {
    extend: {
      colors: {
        orange: {
          500: '#FF7D00',
          400: '#FFA347',
          600: '#E56E00',
        },
        dark: {
          bg: '#121212',
          surface: '#1E1E1E',
          input: '#2C2C2C',
          border: '#3A3A3A',
        },
        text: {
          primary: '#FFFFFF',
          secondary: '#B0B0B0',
          tertiary: '#757575',
        }
      },
      borderRadius: {
        'xl': '12px',
        '2xl': '16px',
      }
    }
  }
}
```

### 首页输入区域组件

```tsx
import { useState } from 'react';

type Platform = 'douyin' | 'tiktok' | 'youtube' | 'unknown';

export function LinkInput() {
  const [url, setUrl] = useState('');
  const [detected, setDetected] = useState<Platform>('unknown');
  
  const platformNames: Record<Platform, string> = {
    douyin: '抖音',
    tiktok: 'TikTok',
    youtube: 'YouTube',
    unknown: '未识别',
  };
  
  const platformIcons: Record<Platform, string> = {
    // icon classes...
    douyin: '🎵',
    tiktok: '🎵',
    youtube: '📺',
    unknown: '🔗',
  };

  return (
    <div className="bg-dark-surface rounded-xl p-4 mb-4">
      <div className="relative">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="粘贴视频链接..."
          className="w-full h-12 bg-dark-input rounded-lg px-4 text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-orange-500/50"
        />
        {url && (
          <button
            onClick={() => setUrl('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary"
          >
            ✕
          </button>
        )}
      </div>
      
      {detected !== 'unknown' && (
        <div className="mt-3 flex items-center gap-2">
          <span className="text-xl">{platformIcons[detected]}</span>
          <span className="text-sm text-text-secondary">
            已识别：{platformNames[detected]}
          </span>
        </div>
      )}
    </div>
  );
}
```

### 下载选项组件

```tsx
type DownloadType = 'video' | 'audio' | 'subtitle';

interface DownloadOptionsProps {
  selected: DownloadType;
  onChange: (t: DownloadType) => void;
}

export function DownloadOptions({ selected, onChange }: DownloadOptionsProps) {
  const options = [
    { type: 'video' as const, icon: '🎬', label: '视频' },
    { type: 'audio' as const, icon: '🔊', label: '音频' },
    { type: 'subtitle' as const, icon: '📝', label: '字幕' },
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
              py-3 px-2 rounded-lg flex flex-col items-center gap-1 transition-all
              ${isSelected 
                ? 'bg-orange-500/15 border border-orange-500 text-orange-500' 
                : 'bg-dark-surface border border-dark-border text-text-secondary'
              }
            `}
          >
            <span className="text-xl">{opt.icon}</span>
            <span className="text-sm font-medium">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
```

### 主按钮组件

```tsx
interface PrimaryButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}

export function PrimaryButton({ children, onClick, disabled }: PrimaryButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`
        w-full h-13 rounded-xl font-semibold text-base transition-all
        ${disabled 
          ? 'bg-dark-border text-text-tertiary cursor-not-allowed'
          : 'bg-gradient-to-r from-orange-500 to-orange-400 text-white shadow-lg shadow-orange-500/30 hover:shadow-orange-500/40 active:scale-95'
        }
      `}
    >
      {children}
    </button>
  );
}
```

---

## 设计总结

本次设计遵循以下原则：

1. **功能优先**：核心的下载操作放在最突出位置，减少用户思考
2. **深色友好**：长时间使用不刺眼，适合工具类 App
3. **品牌一致**：橙色作为强调色，贯穿整个设计
4. **现代简洁**：圆角柔和，层次清晰，没有冗余装饰
5. **移动优先**：触摸区域足够大，适合单手操作

完整设计文件可导出为 Figma 文件，或基于上述代码片段直接在项目中实现。

---

*设计师：韩希孟（含兮）*  
*日期：2026-04-05*

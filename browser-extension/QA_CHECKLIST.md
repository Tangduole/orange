# Browser Extension QA Checklist

## Chrome / Edge Store Submission

### Basic Installation
- [ ] Load unpacked extension in Chrome (`chrome://extensions` → Developer Mode → Load unpacked)
- [ ] Load unpacked extension in Edge (`edge://extensions` → Developer Mode → Load unpacked)
- [ ] Extension icon appears in toolbar
- [ ] Clicking icon opens popup

### Popup States
- [ ] Guest state: shows placeholder, Open Downloader button disabled
- [ ] Free user: shows email, Open Downloader button enabled
- [ ] Pro user: shows Pro badge, all buttons enabled
- [ ] Daily limit reached: shows limit warning

### Core Actions
- [ ] "Open Downloader" opens `orangedl.com?url=...&source=extension` in new tab
- [ ] URL is correctly populated in downloader input
- [ ] Platform is auto-detected
- [ ] "Open & Start" opens downloader and auto-starts download
- [ ] "Open Material Workbench" opens workbench view

### Account Sync
- [ ] Login in popup syncs to main page
- [ ] Logout in popup clears state
- [ ] Account state persists across popup reopens

### Localization
- [ ] English (en): all text displays correctly
- [ ] 中文 (zh_CN): all text displays correctly
- [ ] 日本語 (ja): all text displays correctly
- [ ] 한국어 (ko): all text displays correctly
- [ ] Locale auto-detects from browser language

### Package Validation
- [ ] `node scripts/validate.js` passes
- [ ] `node scripts/package.js` creates release zip
- [ ] Release zip can be loaded as unpacked extension

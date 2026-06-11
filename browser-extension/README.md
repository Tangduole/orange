# Orange Downloader Browser Extension

Minimal Chrome/Edge extension for sending the current tab URL to Orange Downloader.
It detects the current platform, shows the synced Orange account status, and can either open the downloader or start the import flow immediately.

## Local Install

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select this `browser-extension` folder.
5. Sign in on `https://www.orangedl.com` once if you want the popup to show your Free/Pro status.
6. Open a supported video page and click the extension.
7. Choose "Open Downloader" to prefill the URL, or "Open & Start" to begin the download/import flow immediately.

The extension opens:

```text
https://www.orangedl.com?url=<current-page-url>&source=extension&platform=<platform>
https://www.orangedl.com?url=<current-page-url>&source=extension&platform=<platform>&autostart=1
https://www.orangedl.com?source=extension&action=<login|upgrade|workbench>
```

The web app reads the `url`, `platform`, `autostart`, and `action` query parameters. It pre-fills the download input, shows a confirmation banner, starts automatically when `autostart=1`, and opens login, upgrade, or the material workbench when an extension action is provided.

## Platform Detection

The popup detects TikTok, Douyin, Xiaohongshu, YouTube, Instagram, and X from the active tab hostname. Unsupported HTTP pages can still be sent without a platform hint.

## Account Status

The extension syncs the Orange web app login token only from `orangedl.com` pages into extension local storage. The popup uses that token to call `https://api.orangedl.com/api/auth/me` and displays:

- Guest when no login has been synced.
- Free with today's remaining free downloads.
- Pro when unlimited downloads are active.

The account card also shows a contextual shortcut: sign in for guests, upgrade for Free/Limit users, and open the material workbench for Pro users.

If the token expires, the popup clears the synced state and asks the user to sign in again.

## Localization

Chrome extension i18n files are included under `_locales/` for English, Simplified Chinese, Japanese, and Korean. Manifest text and popup UI copy use `chrome.i18n`.

## Production Notes

- Replace `ORANGE_URL` in `popup.js` if deploying to another domain.
- Extension icons are included under `icons/` and wired in `manifest.json`.
- Use `STORE_LISTING.md` for store copy, permissions justification, privacy summary, and manual QA.
- The content script only runs on Orange domains to sync account state; it does not inject scripts into video pages or collect browsing data.

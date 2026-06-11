# Orange Downloader Browser Extension

Minimal Chrome/Edge extension for sending the current tab URL to Orange Downloader.
It detects the current platform and can either open the downloader or start the import flow immediately.

## Local Install

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select this `browser-extension` folder.
5. Open a supported video page and click the extension.
6. Choose "Open Downloader" to prefill the URL, or "Open & Start" to begin the download/import flow immediately.

The extension opens:

```text
https://www.orangedl.com?url=<current-page-url>&source=extension&platform=<platform>
https://www.orangedl.com?url=<current-page-url>&source=extension&platform=<platform>&autostart=1
```

The web app reads the `url`, `platform`, and `autostart` query parameters. It pre-fills the download input, shows a confirmation banner, and starts automatically when `autostart=1`.

## Platform Detection

The popup detects TikTok, Douyin, Xiaohongshu, YouTube, Instagram, and X from the active tab hostname. Unsupported HTTP pages can still be sent without a platform hint.

## Production Notes

- Replace `ORANGE_URL` in `popup.js` if deploying to another domain.
- Add extension icons before publishing to the Chrome Web Store.
- Keep the extension lightweight: it does not inject scripts into pages or collect browsing data.

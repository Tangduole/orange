# Orange Downloader Browser Extension

Minimal Chrome/Edge extension for sending the current tab URL to Orange Downloader.

## Local Install

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select this `browser-extension` folder.
5. Open a supported video page and click "Send to Orange".

The extension opens:

```text
https://www.orangedl.com?url=<current-page-url>&source=extension
```

The web app reads the `url` query parameter, pre-fills the download input, and shows a confirmation banner with a Start Download action.

## Production Notes

- Replace `ORANGE_URL` in `popup.js` if deploying to another domain.
- Add extension icons before publishing to the Chrome Web Store.
- Keep the extension lightweight: it does not inject scripts into pages or collect browsing data.

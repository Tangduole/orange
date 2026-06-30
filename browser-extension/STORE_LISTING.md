# Orange Creator Assistant Extension Store Listing

## Short Description

Send short video pages to Orange for material collection, AI commerce breakdowns, and platform publish packs.

## Full Description

Orange Creator helps creators, editors, and e-commerce operators turn short videos into reusable selling materials: collect the source video, generate AI material cards, organize by campaign, and prepare publish-ready copy for multiple platforms.

With the browser extension, you can:

- Detect supported platforms from the current tab.
- Open Orange Creator with the video URL already filled in.
- Open and start the import flow immediately.
- See synced account status: Guest, Free, Pro, or daily limit reached.
- Jump directly to login, upgrade, or the material workbench.
- Use Orange Pro to generate AI material cards, viral breakdowns, and platform publish packs after import.

The extension only runs its account sync script on Orange domains. It does not inject scripts into TikTok, YouTube, Instagram, X, Douyin, Xiaohongshu, or other video pages.

## Permissions Justification

- `activeTab`: reads the current active tab URL after the user opens the extension popup.
- `tabs`: opens Orange Creator in a new tab with the selected action.
- `storage`: stores the synced Orange account token locally inside the extension.
- `https://www.orangedl.com/*` and `https://orangedl.com/*`: syncs login state from the Orange web app.
- `https://api.orangedl.com/*`: checks the signed-in user's plan and remaining free material processing credits.

## Privacy Summary

The extension does not collect browsing history. It reads the active tab URL only when the user opens the popup and clicks an action. The URL is sent to Orange Creator only when the user chooses "Open Material Platform" or "Open & Start".

Account status is synced only from Orange domains and stored locally in Chrome/Edge extension storage. The extension uses the token only to request the current Orange account status from `https://api.orangedl.com/api/auth/me`.

## Localization

The extension includes Chrome `_locales` resources for:

- English: `en`
- Simplified Chinese: `zh_CN`
- Japanese: `ja`
- Korean: `ko`

Before submitting to stores, add localized store listing text and screenshots for the target markets if the store requires per-locale assets.

## Manual QA Checklist

1. Load the unpacked extension from `browser-extension`.
2. Confirm the toolbar icon appears at 16/32/48/128 sizes.
3. Open a TikTok, YouTube, Instagram, X, Douyin, or Xiaohongshu page and open the popup.
4. Confirm platform detection is correct.
5. Click "Open Downloader" and verify the URL is filled in on Orange.
6. Click "Open & Start" and verify `autostart=1` begins the import flow.
7. Open the popup before signing in and confirm it shows `Guest` and "Sign in to Orange".
8. Sign in on Orange, reopen the popup, and confirm Free/Pro status is shown.
9. For Free users, confirm "Upgrade to Pro" opens the subscription flow.
10. For Pro users, confirm "Open Material Workbench" opens the history/workbench section.
11. Sign out on Orange and confirm the extension clears the synced state after the next popup refresh.
12. Change Chrome/Edge language to Chinese, Japanese, or Korean and confirm popup copy switches locale.


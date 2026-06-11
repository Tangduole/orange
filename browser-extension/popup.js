const ORANGE_URL = "https://www.orangedl.com";

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function detectPlatform(pageUrl) {
  try {
    const host = new URL(pageUrl).hostname.replace(/^www\./, "").toLowerCase();
    if (host.includes("tiktok.com")) return { id: "tiktok", label: "TikTok" };
    if (host.includes("douyin.com")) return { id: "douyin", label: "抖音" };
    if (host.includes("xiaohongshu.com") || host.includes("xhslink.com")) return { id: "xiaohongshu", label: "小红书" };
    if (host.includes("youtube.com") || host.includes("youtu.be")) return { id: "youtube", label: "YouTube" };
    if (host.includes("instagram.com")) return { id: "instagram", label: "Instagram" };
    if (host.includes("twitter.com") || host.includes("x.com")) return { id: "x", label: "X" };
  } catch {}
  return { id: "unknown", label: "Unknown platform" };
}

function buildTargetUrl(pageUrl, platform, autostart = false) {
  const target = new URL(ORANGE_URL);
  target.searchParams.set("url", pageUrl);
  target.searchParams.set("source", "extension");
  if (platform && platform.id !== "unknown") target.searchParams.set("platform", platform.id);
  if (autostart) target.searchParams.set("autostart", "1");
  return target.toString();
}

document.addEventListener("DOMContentLoaded", async () => {
  const urlEl = document.getElementById("url");
  const platformEl = document.getElementById("platform");
  const sendBtn = document.getElementById("send");
  const importBtn = document.getElementById("import");

  try {
    const tab = await getActiveTab();
    const pageUrl = tab && tab.url ? tab.url : "";
    if (!/^https?:\/\//i.test(pageUrl)) {
      urlEl.textContent = "This page cannot be sent.";
      platformEl.textContent = "Unsupported page";
      return;
    }

    const platform = detectPlatform(pageUrl);
    platformEl.textContent = platform.label;
    urlEl.textContent = pageUrl;
    sendBtn.disabled = false;
    importBtn.disabled = false;
    sendBtn.addEventListener("click", async () => {
      await chrome.tabs.create({ url: buildTargetUrl(pageUrl, platform) });
      window.close();
    });
    importBtn.addEventListener("click", async () => {
      await chrome.tabs.create({ url: buildTargetUrl(pageUrl, platform, true) });
      window.close();
    });
  } catch (e) {
    urlEl.textContent = "Unable to read current tab.";
    platformEl.textContent = "Unavailable";
  }
});

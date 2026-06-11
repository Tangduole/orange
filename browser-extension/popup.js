const ORANGE_URL = "https://www.orangedl.com";
const API_BASE = "https://api.orangedl.com";

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

function buildAppActionUrl(action) {
  const target = new URL(ORANGE_URL);
  target.searchParams.set("source", "extension");
  target.searchParams.set("action", action);
  return target.toString();
}

function isTokenExpired(token) {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.exp ? payload.exp < Math.floor(Date.now() / 1000) : false;
  } catch {
    return true;
  }
}

function setAccountStatus({ title, hint, badge, badgeClass = "" }) {
  document.getElementById("accountTitle").textContent = title;
  document.getElementById("accountHint").textContent = hint;
  const badgeEl = document.getElementById("accountBadge");
  badgeEl.textContent = badge;
  badgeEl.className = `badge ${badgeClass}`.trim();
}

async function getStoredAuth() {
  const result = await chrome.storage.local.get("orangeAuth");
  return result.orangeAuth || null;
}

async function refreshAccountStatus() {
  const auth = await getStoredAuth();
  if (!auth || !auth.token || isTokenExpired(auth.token)) {
    await chrome.storage.local.remove("orangeAuth");
    setAccountStatus({
      title: "Not signed in",
      hint: "Sign in on Orange to sync Pro status here.",
      badge: "Guest"
    });
    return { status: "guest" };
  }

  try {
    const res = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${auth.token}` }
    });
    const data = await res.json();
    if (res.status === 401 || data.code === 401) {
      await chrome.storage.local.remove("orangeAuth");
      setAccountStatus({
        title: "Not signed in",
        hint: "Your session expired. Sign in on Orange again.",
        badge: "Guest"
      });
      return { status: "guest" };
    }
    if (data.code !== 0) throw new Error(data.message || "Account check failed");

    const user = data.data;
    const usage = user.usage || {};
    const isPro = user.tier === "pro" || usage.isPro;
    const remaining = typeof usage.remaining === "number" ? usage.remaining : null;
    const dailyLimit = typeof usage.dailyLimit === "number" ? usage.dailyLimit : null;
    const quotaText = isPro
      ? "Unlimited downloads unlocked."
      : remaining !== null && dailyLimit !== null
        ? `${remaining}/${dailyLimit} free downloads left today.`
        : "Free account synced.";

    await chrome.storage.local.set({
      orangeAuth: {
        ...auth,
        user,
        syncedAt: Date.now()
      }
    });

    setAccountStatus({
      title: user.email || "Orange account",
      hint: quotaText,
      badge: isPro ? "Pro" : remaining === 0 ? "Limit" : "Free",
      badgeClass: isPro ? "pro" : remaining === 0 ? "out" : "free"
    });
    return { status: isPro ? "pro" : remaining === 0 ? "limit" : "free" };
  } catch {
    const cachedStatus = auth.user?.tier === "pro" ? "pro" : "free";
    setAccountStatus({
      title: auth.user?.email || "Account synced",
      hint: "Open Orange to refresh account status.",
      badge: cachedStatus === "pro" ? "Pro" : "Free",
      badgeClass: cachedStatus === "pro" ? "pro" : "free"
    });
    return { status: cachedStatus };
  }
}

function getAccountAction(status) {
  if (status === "pro") {
    return { label: "Open Material Workbench", action: "workbench" };
  }
  if (status === "free" || status === "limit") {
    return { label: "Upgrade to Pro", action: "upgrade" };
  }
  return { label: "Sign in to Orange", action: "login" };
}

document.addEventListener("DOMContentLoaded", async () => {
  const urlEl = document.getElementById("url");
  const platformEl = document.getElementById("platform");
  const sendBtn = document.getElementById("send");
  const importBtn = document.getElementById("import");
  const accountActionBtn = document.getElementById("accountAction");

  try {
    const account = await refreshAccountStatus();
    const accountAction = getAccountAction(account?.status);
    accountActionBtn.textContent = accountAction.label;
    accountActionBtn.addEventListener("click", async () => {
      await chrome.tabs.create({ url: buildAppActionUrl(accountAction.action) });
      window.close();
    });

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

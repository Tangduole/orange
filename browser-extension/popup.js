const ORANGE_URL = "https://orangedl.com";

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function buildTargetUrl(pageUrl) {
  const target = new URL(ORANGE_URL);
  target.searchParams.set("url", pageUrl);
  target.searchParams.set("source", "extension");
  return target.toString();
}

document.addEventListener("DOMContentLoaded", async () => {
  const urlEl = document.getElementById("url");
  const sendBtn = document.getElementById("send");

  try {
    const tab = await getActiveTab();
    const pageUrl = tab && tab.url ? tab.url : "";
    if (!/^https?:\/\//i.test(pageUrl)) {
      urlEl.textContent = "This page cannot be sent.";
      return;
    }

    urlEl.textContent = pageUrl;
    sendBtn.disabled = false;
    sendBtn.addEventListener("click", async () => {
      await chrome.tabs.create({ url: buildTargetUrl(pageUrl) });
      window.close();
    });
  } catch (e) {
    urlEl.textContent = "Unable to read current tab.";
  }
});

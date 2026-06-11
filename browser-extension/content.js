function readAuthState() {
  const token = localStorage.getItem("orange_token");
  const rawUser = localStorage.getItem("orange_user");

  if (!token) return null;

  let user = null;
  try {
    user = rawUser ? JSON.parse(rawUser) : null;
  } catch {
    user = null;
  }

  return {
    token,
    user,
    syncedAt: Date.now()
  };
}

async function syncAuthState() {
  const auth = readAuthState();
  if (!auth) {
    await chrome.storage.local.remove("orangeAuth");
    return;
  }
  await chrome.storage.local.set({ orangeAuth: auth });
}

let lastAuthSignature = null;

function syncAuthStateIfChanged() {
  const signature = [
    localStorage.getItem("orange_token") || "",
    localStorage.getItem("orange_user") || ""
  ].join("|");
  if (signature === lastAuthSignature) return;
  lastAuthSignature = signature;
  syncAuthState();
}

syncAuthStateIfChanged();
setInterval(syncAuthStateIfChanged, 2500);

window.addEventListener("storage", (event) => {
  if (event.key === "orange_token" || event.key === "orange_user") syncAuthStateIfChanged();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) syncAuthStateIfChanged();
});


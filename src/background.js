const STORAGE_KEY = "jobApplicationLinks";
const MAX_ENTRIES = 1000;

chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
});

chrome.runtime.onStartup?.addListener(() => {
  updateBadge();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.type === "job-link-saver:save") {
    saveApplication(message.payload, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "job-link-saver:list") {
    getEntries()
      .then((entries) => sendResponse({ ok: true, entries }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "job-link-saver:clear") {
    clearEntries()
      .then(() => sendResponse({ ok: true, entries: [] }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function saveApplication(payload = {}, sender = {}) {
  const cleanedUrl = cleanHttpUrl(payload.url);

  if (!cleanedUrl) {
    return { ok: false, reason: "invalid_url" };
  }

  const key = normalizeKey(payload.normalizedUrl || cleanedUrl);
  const now = new Date().toISOString();
  const entries = await getEntries();
  const existingIndex = entries.findIndex((entry) => entry.key === key);
  const senderUrl = sender.tab?.url ? cleanHttpUrl(sender.tab.url) : "";

  if (existingIndex >= 0) {
    const existing = entries[existingIndex];

    entries[existingIndex] = {
      ...existing,
      title: pickLatest(payload.title, existing.title),
      company: pickLatest(payload.company, existing.company),
      platform: pickLatest(payload.platform, existing.platform),
      url: cleanedUrl,
      pageUrl: cleanHttpUrl(payload.pageUrl) || senderUrl || existing.pageUrl || cleanedUrl,
      lastDetectedAt: payload.detectedAt || now,
      captureCount: (existing.captureCount || 1) + 1,
      evidence: limitText(payload.evidence) || existing.evidence || "",
      source: payload.source || existing.source || "content-script"
    };

    await setEntries(entries);
    return { ok: true, saved: false, updated: true, entry: entries[existingIndex] };
  }

  const entry = {
    key,
    url: cleanedUrl,
    pageUrl: cleanHttpUrl(payload.pageUrl) || senderUrl || cleanedUrl,
    title: limitText(payload.title) || "Untitled job",
    company: limitText(payload.company) || "",
    platform: limitText(payload.platform) || hostnameFromUrl(cleanedUrl),
    evidence: limitText(payload.evidence) || "",
    source: payload.source || "content-script",
    firstDetectedAt: payload.detectedAt || now,
    lastDetectedAt: payload.detectedAt || now,
    captureCount: 1
  };

  entries.unshift(entry);
  const trimmed = entries.slice(0, MAX_ENTRIES);
  await setEntries(trimmed);

  return { ok: true, saved: true, updated: false, entry };
}

function getEntries() {
  return storageGet({ [STORAGE_KEY]: [] }).then((result) => {
    return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
  });
}

function setEntries(entries) {
  return storageSet({ [STORAGE_KEY]: entries }).then(() => {
    updateBadge(entries);
  });
}

function clearEntries() {
  return storageSet({ [STORAGE_KEY]: [] }).then(() => {
    updateBadge([]);
  });
}

function storageGet(defaults) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(defaults, (result) => {
      const error = chrome.runtime.lastError;

      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(result);
    });
  });
}

function storageSet(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      const error = chrome.runtime.lastError;

      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve();
    });
  });
}

async function updateBadge(entries) {
  if (!chrome.action?.setBadgeText) {
    return;
  }

  const currentEntries = entries || await getEntries();
  const count = currentEntries.length;
  const text = count ? String(Math.min(count, 999)) : "";

  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
}

function cleanHttpUrl(value) {
  if (!value || typeof value !== "string") {
    return "";
  }

  try {
    const url = new URL(value, "https://example.invalid");

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }

    const removableParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "dclid",
      "gbraid",
      "wbraid",
      "msclkid",
      "mc_cid",
      "mc_eid",
      "ref",
      "refId",
      "trk",
      "trackingId",
      "source"
    ];

    for (const param of removableParams) {
      url.searchParams.delete(param);
    }

    for (const param of [...url.searchParams.keys()]) {
      if (param.toLowerCase().startsWith("utm_")) {
        url.searchParams.delete(param);
      }
    }

    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeKey(value) {
  const cleaned = cleanHttpUrl(value);

  if (!cleaned) {
    return "";
  }

  const url = new URL(cleaned);
  url.hostname = url.hostname.replace(/^www\./i, "").toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/g, "");

  const keepParams = new Set([
    "jk",
    "jobId",
    "jobid",
    "currentJobId",
    "gh_jid",
    "lever-origin",
    "position",
    "postingId"
  ]);

  for (const param of [...url.searchParams.keys()]) {
    if (!keepParams.has(param)) {
      url.searchParams.delete(param);
    }
  }

  return url.toString().toLowerCase();
}

function hostnameFromUrl(value) {
  try {
    return new URL(value).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function pickLatest(incoming, current) {
  const value = limitText(incoming);
  return value && value !== "Untitled job" ? value : current || "";
}

function limitText(value) {
  if (!value || typeof value !== "string") {
    return "";
  }

  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

const list = document.querySelector("#applications");
const summary = document.querySelector("#summary");
const emptyState = document.querySelector("#emptyState");
const copyLinksButton = document.querySelector("#copyLinks");
const exportCsvButton = document.querySelector("#exportCsv");
const exportJsonButton = document.querySelector("#exportJson");
const clearAllButton = document.querySelector("#clearAll");

let entries = [];

document.addEventListener("DOMContentLoaded", loadEntries);
copyLinksButton.addEventListener("click", copyLinks);
exportCsvButton.addEventListener("click", () => downloadFile("job-applications.csv", toCsv(entries), "text/csv"));
exportJsonButton.addEventListener("click", () => downloadFile("job-applications.json", JSON.stringify(entries, null, 2), "application/json"));
clearAllButton.addEventListener("click", clearAll);

function loadEntries() {
  chrome.runtime.sendMessage({ type: "job-link-saver:list" }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      summary.textContent = "Could not load saved links.";
      return;
    }

    entries = response.entries || [];
    render();
  });
}

function render() {
  list.innerHTML = "";
  summary.textContent = entries.length === 1
    ? "1 job application captured"
    : `${entries.length} job applications captured`;

  emptyState.hidden = entries.length > 0;
  copyLinksButton.disabled = entries.length === 0;
  exportCsvButton.disabled = entries.length === 0;
  exportJsonButton.disabled = entries.length === 0;
  clearAllButton.disabled = entries.length === 0;

  for (const entry of entries) {
    const item = document.createElement("li");
    const title = document.createElement("h2");
    const meta = document.createElement("div");
    const link = document.createElement("a");
    const evidence = document.createElement("div");

    item.className = "application";
    title.className = "title";
    title.textContent = entry.title || "Untitled job";
    meta.className = "meta";
    meta.textContent = formatMeta(entry);
    link.className = "url";
    link.href = entry.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = entry.url;
    evidence.className = "evidence";
    evidence.textContent = entry.evidence || "Detected after application completion.";

    item.append(title, meta, link, evidence);
    list.append(item);
  }
}

async function copyLinks() {
  const text = entries.map((entry) => entry.url).join("\n");

  try {
    await navigator.clipboard.writeText(text);
    copyLinksButton.textContent = "Copied";
    window.setTimeout(() => {
      copyLinksButton.textContent = "Copy Links";
    }, 1400);
  } catch {
    copyLinksButton.textContent = "Copy Failed";
    window.setTimeout(() => {
      copyLinksButton.textContent = "Copy Links";
    }, 1400);
  }
}

function clearAll() {
  const confirmed = window.confirm("Clear all saved job application links?");

  if (!confirmed) {
    return;
  }

  chrome.runtime.sendMessage({ type: "job-link-saver:clear" }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      summary.textContent = "Could not clear saved links.";
      return;
    }

    entries = [];
    render();
  });
}

function toCsv(rows) {
  const headers = [
    "title",
    "company",
    "platform",
    "url",
    "firstDetectedAt",
    "lastDetectedAt",
    "captureCount",
    "evidence"
  ];

  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))
  ].join("\n");
}

function csvCell(value) {
  const text = String(value || "");
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = filename;
  anchor.click();

  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

function formatMeta(entry) {
  const parts = [];

  if (entry.company) {
    parts.push(entry.company);
  }

  if (entry.platform) {
    parts.push(entry.platform);
  }

  if (entry.firstDetectedAt) {
    parts.push(new Date(entry.firstDetectedAt).toLocaleString());
  }

  return parts.join(" - ");
}

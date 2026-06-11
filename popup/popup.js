const list = document.querySelector("#applications");
const summary = document.querySelector("#summary");
const emptyState = document.querySelector("#emptyState");
const selectAllCheckbox = document.querySelector("#selectAll");
const selectionSummary = document.querySelector("#selectionSummary");
const copyLinksButton = document.querySelector("#copyLinks");
const exportCsvButton = document.querySelector("#exportCsv");
const exportJsonButton = document.querySelector("#exportJson");
const deleteSelectedButton = document.querySelector("#deleteSelected");
const clearAllButton = document.querySelector("#clearAll");

let entries = [];
let selectedKeys = new Set();

document.addEventListener("DOMContentLoaded", loadEntries);
selectAllCheckbox.addEventListener("change", toggleAll);
copyLinksButton.addEventListener("click", copyLinks);
exportCsvButton.addEventListener("click", () => downloadFile("selected-job-applications.csv", toCsv(getSelectedEntries()), "text/csv"));
exportJsonButton.addEventListener("click", () => downloadFile("selected-job-applications.json", JSON.stringify(getSelectedEntries(), null, 2), "application/json"));
deleteSelectedButton.addEventListener("click", deleteSelected);
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
  syncSelection();

  summary.textContent = entries.length === 1
    ? "1 job application captured"
    : `${entries.length} job applications captured`;

  emptyState.hidden = entries.length > 0;
  selectAllCheckbox.disabled = entries.length === 0;
  selectAllCheckbox.checked = entries.length > 0 && selectedKeys.size === entries.length;
  selectAllCheckbox.indeterminate = selectedKeys.size > 0 && selectedKeys.size < entries.length;
  selectionSummary.textContent = selectedKeys.size === 1
    ? "1 selected"
    : `${selectedKeys.size} selected`;
  copyLinksButton.disabled = selectedKeys.size === 0;
  exportCsvButton.disabled = selectedKeys.size === 0;
  exportJsonButton.disabled = selectedKeys.size === 0;
  deleteSelectedButton.disabled = selectedKeys.size === 0;
  clearAllButton.disabled = entries.length === 0;

  for (const entry of entries) {
    const item = document.createElement("li");
    const selectionCell = document.createElement("label");
    const checkbox = document.createElement("input");
    const content = document.createElement("div");
    const title = document.createElement("h2");
    const meta = document.createElement("div");
    const link = document.createElement("a");
    const evidence = document.createElement("div");
    const key = getEntryKey(entry);

    item.className = "application";
    item.classList.toggle("selected", selectedKeys.has(key));
    selectionCell.className = "selection-cell";
    checkbox.className = "selection-input";
    checkbox.type = "checkbox";
    checkbox.checked = selectedKeys.has(key);
    checkbox.setAttribute("aria-label", `Select ${entry.title || "saved job application"}`);
    checkbox.addEventListener("change", () => {
      setEntrySelected(key, checkbox.checked);
    });
    content.className = "application-content";
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

    selectionCell.append(checkbox);
    content.append(title, meta, link, evidence);
    item.append(selectionCell, content);
    list.append(item);
  }
}

function toggleAll() {
  selectedKeys = selectAllCheckbox.checked
    ? new Set(entries.map(getEntryKey))
    : new Set();
  render();
}

function setEntrySelected(key, selected) {
  if (selected) {
    selectedKeys.add(key);
  } else {
    selectedKeys.delete(key);
  }

  render();
}

function syncSelection() {
  const availableKeys = new Set(entries.map(getEntryKey));
  selectedKeys = new Set([...selectedKeys].filter((key) => availableKeys.has(key)));
}

function getEntryKey(entry) {
  return entry.key || entry.url;
}

function getSelectedEntries() {
  return entries.filter((entry) => selectedKeys.has(getEntryKey(entry)));
}

async function copyLinks() {
  const selectedEntries = getSelectedEntries();

  if (selectedEntries.length === 0) {
    return;
  }

  const text = selectedEntries.map((entry) => entry.url).join("\n");

  try {
    await navigator.clipboard.writeText(text);
    copyLinksButton.textContent = "Copied";
    window.setTimeout(() => {
      copyLinksButton.textContent = "Copy";
    }, 1400);
  } catch {
    copyLinksButton.textContent = "Copy Failed";
    window.setTimeout(() => {
      copyLinksButton.textContent = "Copy";
    }, 1400);
  }
}

function deleteSelected() {
  const selectedEntries = getSelectedEntries();

  if (selectedEntries.length === 0) {
    return;
  }

  const confirmed = window.confirm(formatDeletePrompt(selectedEntries.length));

  if (!confirmed) {
    return;
  }

  chrome.runtime.sendMessage({
    type: "job-link-saver:delete",
    keys: selectedEntries.map((entry) => entry.key).filter(Boolean)
  }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      summary.textContent = "Could not delete selected links.";
      return;
    }

    entries = response.entries || [];
    selectedKeys = new Set();
    render();
  });
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
    selectedKeys = new Set();
    render();
  });
}

function formatDeletePrompt(count) {
  return count === 1
    ? "Delete 1 selected job application link?"
    : `Delete ${count} selected job application links?`;
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

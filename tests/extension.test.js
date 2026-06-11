import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

const rootDir = path.resolve(".");

describe("manifest", () => {
  it("loads as a Manifest V3 extension with the expected entry points", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8"));

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background.service_worker).toBe("src/background.js");
    expect(manifest.content_scripts[0].all_frames).toBe(true);
    expect(manifest.action.default_popup).toBe("popup/popup.html");
  });
});

describe("background storage", () => {
  it("saves cleaned links and deduplicates repeated captures", async () => {
    const harness = createBackgroundHarness();

    await harness.dispatchMessage({
      type: "job-link-saver:save",
      payload: {
        url: "https://www.linkedin.com/jobs/view/123/?utm_source=feed&trk=public",
        pageUrl: "https://www.linkedin.com/jobs/view/123/?currentJobId=123",
        title: "Frontend Engineer",
        company: "Example Co",
        evidence: "Success message: Application submitted"
      }
    });

    await harness.dispatchMessage({
      type: "job-link-saver:save",
      payload: {
        url: "https://linkedin.com/jobs/view/123/?utm_campaign=again",
        title: "Frontend Engineer",
        company: "Example Co"
      }
    });

    const response = await harness.dispatchMessage({ type: "job-link-saver:list" });

    expect(response.entries).toHaveLength(1);
    expect(response.entries[0]).toMatchObject({
      title: "Frontend Engineer",
      company: "Example Co",
      captureCount: 2
    });
    expect(response.entries[0].url).toBe("https://linkedin.com/jobs/view/123/");
    expect(harness.badgeText).toBe("1");
  });

  it("clears saved links and resets the badge", async () => {
    const harness = createBackgroundHarness();

    await harness.dispatchMessage({
      type: "job-link-saver:save",
      payload: {
        url: "https://jobs.example.com/roles/frontend-engineer",
        title: "Frontend Engineer"
      }
    });

    const clearResponse = await harness.dispatchMessage({ type: "job-link-saver:clear" });
    const listResponse = await harness.dispatchMessage({ type: "job-link-saver:list" });

    expect(clearResponse).toEqual({ ok: true, entries: [] });
    expect(listResponse.entries).toEqual([]);
    expect(harness.badgeText).toBe("");
  });

  it("deletes only the requested saved links", async () => {
    const harness = createBackgroundHarness();

    const firstSave = await harness.dispatchMessage({
      type: "job-link-saver:save",
      payload: {
        url: "https://jobs.example.com/roles/frontend-engineer",
        title: "Frontend Engineer"
      }
    });
    const secondSave = await harness.dispatchMessage({
      type: "job-link-saver:save",
      payload: {
        url: "https://jobs.example.com/roles/backend-engineer",
        title: "Backend Engineer"
      }
    });

    const deleteResponse = await harness.dispatchMessage({
      type: "job-link-saver:delete",
      keys: [firstSave.entry.key]
    });

    expect(deleteResponse.ok).toBe(true);
    expect(deleteResponse.entries).toHaveLength(1);
    expect(deleteResponse.entries[0].key).toBe(secondSave.entry.key);
    expect(harness.badgeText).toBe("1");
  });

  it("rejects malformed delete requests", async () => {
    const harness = createBackgroundHarness();

    const response = await harness.dispatchMessage({
      type: "job-link-saver:delete",
      keys: "not-an-array"
    });

    expect(response.ok).toBe(false);
    expect(response.error).toContain("array of keys");
  });
});

describe("content script capture", () => {
  it("sends a save message after an apply action reaches a success state", async () => {
    const dom = new JSDOM(`
      <!doctype html>
      <html>
        <head>
          <title>Frontend Engineer - Example Co</title>
          <link rel="canonical" href="https://jobs.example.com/roles/frontend-engineer?utm_source=feed">
          <script type="application/ld+json">
            {
              "@type": "JobPosting",
              "title": "Frontend Engineer",
              "hiringOrganization": { "name": "Example Co" }
            }
          </script>
        </head>
        <body>
          <main>
            <h1>Frontend Engineer</h1>
            <button id="apply">Submit application</button>
            <section id="status">Your application has been successfully submitted.</section>
          </main>
        </body>
      </html>
    `, {
      url: "https://jobs.example.com/roles/frontend-engineer/apply",
      pretendToBeVisual: true,
      runScripts: "outside-only"
    });

    const messages = [];
    const { window } = dom;
    const script = fs.readFileSync(path.join(rootDir, "src/content-script.js"), "utf8");

    window.chrome = {
      runtime: {
        sendMessage(message, callback) {
          messages.push(message);
          callback?.({ ok: true });
        },
        lastError: null
      }
    };

    window.eval(script);
    window.document.querySelector("#apply").dispatchEvent(
      new window.MouseEvent("click", { bubbles: true })
    );

    await waitFor(() => messages.length > 0, 2500);

    expect(messages[0].type).toBe("job-link-saver:save");
    expect(messages[0].payload).toMatchObject({
      url: "https://jobs.example.com/roles/frontend-engineer",
      title: "Frontend Engineer",
      company: "Example Co"
    });
    expect(messages[0].payload.evidence).toContain("successfully submitted");
  });
});

describe("popup", () => {
  it("copies only selected saved applications", async () => {
    const dom = new JSDOM(fs.readFileSync(path.join(rootDir, "popup/popup.html"), "utf8"), {
      url: "chrome-extension://test/popup/popup.html",
      runScripts: "outside-only"
    });
    const { window } = dom;
    const sampleEntries = [
      {
        key: "frontend",
        title: "Frontend Engineer",
        company: "Example Co",
        platform: "jobs.example.com",
        url: "https://jobs.example.com/roles/frontend-engineer",
        firstDetectedAt: "2026-06-08T12:00:00.000Z",
        evidence: "Success message: Application submitted"
      },
      {
        key: "backend",
        title: "Backend Engineer",
        company: "Example Co",
        platform: "jobs.example.com",
        url: "https://jobs.example.com/roles/backend-engineer",
        firstDetectedAt: "2026-06-08T12:05:00.000Z",
        evidence: "Success message: Application submitted"
      }
    ];
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };

    window.chrome = {
      runtime: {
        sendMessage(message, callback) {
          if (message.type === "job-link-saver:list") {
            callback({ ok: true, entries: sampleEntries });
          }
        },
        lastError: null
      }
    };
    Object.defineProperty(window.navigator, "clipboard", { value: clipboard });

    window.eval(fs.readFileSync(path.join(rootDir, "popup/popup.js"), "utf8"));
    window.document.dispatchEvent(new window.Event("DOMContentLoaded"));

    expect(window.document.querySelector(".title").textContent).toBe("Frontend Engineer");
    expect(window.document.querySelector(".url").textContent).toBe(sampleEntries[0].url);
    expect(window.document.querySelector("#selectionSummary").textContent).toBe("0 selected");

    window.document.querySelectorAll(".selection-input")[1].click();
    expect(window.document.querySelector("#selectionSummary").textContent).toBe("1 selected");
    window.document.querySelector("#copyLinks").click();
    await Promise.resolve();

    expect(clipboard.writeText).toHaveBeenCalledWith(sampleEntries[1].url);
  });

  it("deletes selected saved applications", async () => {
    const dom = new JSDOM(fs.readFileSync(path.join(rootDir, "popup/popup.html"), "utf8"), {
      url: "chrome-extension://test/popup/popup.html",
      runScripts: "outside-only"
    });
    const { window } = dom;
    const sampleEntries = [
      {
        key: "frontend",
        title: "Frontend Engineer",
        url: "https://jobs.example.com/roles/frontend-engineer"
      },
      {
        key: "backend",
        title: "Backend Engineer",
        url: "https://jobs.example.com/roles/backend-engineer"
      }
    ];
    const confirm = vi.fn().mockReturnValue(true);
    let deleteKeys = [];

    window.chrome = {
      runtime: {
        sendMessage(message, callback) {
          if (message.type === "job-link-saver:list") {
            callback({ ok: true, entries: sampleEntries });
          }

          if (message.type === "job-link-saver:delete") {
            deleteKeys = message.keys;
            callback({ ok: true, entries: sampleEntries.filter((entry) => !message.keys.includes(entry.key)) });
          }
        },
        lastError: null
      }
    };
    window.confirm = confirm;

    window.eval(fs.readFileSync(path.join(rootDir, "popup/popup.js"), "utf8"));
    window.document.dispatchEvent(new window.Event("DOMContentLoaded"));

    window.document.querySelectorAll(".selection-input")[0].click();
    window.document.querySelector("#deleteSelected").click();

    expect(confirm).toHaveBeenCalledWith("Delete 1 selected job application link?");
    expect(deleteKeys).toEqual(["frontend"]);
    expect([...window.document.querySelectorAll(".title")].map((element) => element.textContent)).toEqual(["Backend Engineer"]);
  });
});

function createBackgroundHarness() {
  const storage = {};
  let messageListener;
  let badgeText = "";
  const chrome = {
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        }
      }
    },
    storage: {
      local: {
        get(defaults, callback) {
          callback({ ...defaults, ...storage });
        },
        set(values, callback) {
          Object.assign(storage, values);
          callback();
        }
      }
    },
    action: {
      setBadgeText({ text }) {
        badgeText = text;
      },
      setBadgeBackgroundColor: vi.fn()
    }
  };

  vm.runInNewContext(
    fs.readFileSync(path.join(rootDir, "src/background.js"), "utf8"),
    { chrome, URL, Date, Set, Array, String, Math }
  );

  return {
    get badgeText() {
      return badgeText;
    },
    dispatchMessage(message) {
      return new Promise((resolve) => {
        messageListener(message, { tab: { url: "https://jobs.example.com/roles/frontend-engineer" } }, resolve);
      });
    }
  };
}

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("Timed out waiting for condition");
}

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
});

describe("popup", () => {
  it("renders saved applications and exports URLs", async () => {
    const dom = new JSDOM(fs.readFileSync(path.join(rootDir, "popup/popup.html"), "utf8"), {
      url: "chrome-extension://test/popup/popup.html",
      runScripts: "outside-only"
    });
    const { window } = dom;
    const sampleEntries = [{
      title: "Frontend Engineer",
      company: "Example Co",
      platform: "jobs.example.com",
      url: "https://jobs.example.com/roles/frontend-engineer",
      firstDetectedAt: "2026-06-08T12:00:00.000Z",
      evidence: "Success message: Application submitted"
    }];
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

    window.document.querySelector("#copyLinks").click();
    await Promise.resolve();

    expect(clipboard.writeText).toHaveBeenCalledWith(sampleEntries[0].url);
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
        async get(defaults) {
          return { ...defaults, ...storage };
        },
        async set(values) {
          Object.assign(storage, values);
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

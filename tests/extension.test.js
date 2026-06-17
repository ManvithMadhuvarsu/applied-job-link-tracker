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
    expect(manifest.content_scripts[0].exclude_matches).toContain("https://mail.google.com/*");
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

  it("rejects saves from webmail pages", async () => {
    const harness = createBackgroundHarness();

    const response = await harness.dispatchMessage({
      type: "job-link-saver:save",
      payload: {
        url: "https://mail.google.com/mail/",
        pageUrl: "https://mail.google.com/mail/u/0/#inbox",
        title: "Search Try Gemini",
        evidence: "Success message: Thank you for applying"
      }
    }, { tab: { url: "https://mail.google.com/mail/u/0/#inbox" } });
    const listResponse = await harness.dispatchMessage({ type: "job-link-saver:list" });

    expect(response).toEqual({ ok: false, reason: "blocked_host" });
    expect(listResponse.entries).toEqual([]);
  });

  it("filters existing webmail entries from saved links", async () => {
    const harness = createBackgroundHarness([
      {
        key: "mail",
        url: "https://mail.google.com/mail/",
        pageUrl: "https://mail.google.com/mail/u/0/#inbox",
        title: "Search Try Gemini"
      },
      {
        key: "job",
        url: "https://jobs.example.com/roles/frontend-engineer",
        title: "Frontend Engineer"
      }
    ]);

    const response = await harness.dispatchMessage({ type: "job-link-saver:list" });

    expect(response.entries).toHaveLength(1);
    expect(response.entries[0].key).toBe("job");
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

  it("deletes saved links when identified by URL", async () => {
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
      keys: [firstSave.entry.url]
    });

    expect(deleteResponse.ok).toBe(true);
    expect(deleteResponse.entries).toHaveLength(1);
    expect(deleteResponse.entries[0].key).toBe(secondSave.entry.key);
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

  it("does not capture application emails in Gmail", async () => {
    const dom = new JSDOM(`
      <!doctype html>
      <html>
        <head>
          <title>Search Try Gemini</title>
        </head>
        <body>
          <main>
            <h1>Search Try Gemini</h1>
            <article>
              no-reply Job/Applied Thank you for applying to Agoda.
              Thanks for applying to the position of Associate Data Analyst.
            </article>
          </main>
        </body>
      </html>
    `, {
      url: "https://mail.google.com/mail/u/0/#inbox",
      pretendToBeVisual: true,
      runScripts: "outside-only"
    });

    const messages = [];
    const { window } = dom;

    window.chrome = {
      runtime: {
        sendMessage(message, callback) {
          messages.push(message);
          callback?.({ ok: true });
        },
        lastError: null
      }
    };

    window.eval(fs.readFileSync(path.join(rootDir, "src/content-script.js"), "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(messages).toEqual([]);
  });

  it("does not capture pages that merely discuss application-success phrases without an apply action", async () => {
    const dom = new JSDOM(`
      <!doctype html>
      <html>
        <head>
          <title>Job application link tracker extension - chat</title>
        </head>
        <body>
          <main>
            <h1>Job application link tracker extension</h1>
            <article>
              It detects likely application-completion signals, such as
              "your application has been successfully submitted" and
              "thanks for applying", then saves a cleaned direct job link.
              We discussed the candidate experience, resume parsing, and
              career page heuristics for this hiring tool in detail.
            </article>
          </main>
        </body>
      </html>
    `, {
      url: "https://example-chat.invalid/conversations/abc123",
      pretendToBeVisual: true,
      runScripts: "outside-only"
    });

    const messages = [];
    const { window } = dom;

    window.chrome = {
      runtime: {
        sendMessage(message, callback) {
          messages.push(message);
          callback?.({ ok: true });
        },
        lastError: null
      }
    };

    window.eval(fs.readFileSync(path.join(rootDir, "src/content-script.js"), "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 1800));

    expect(messages).toEqual([]);
  });

  it("keeps distinct applications separate even when the post-submit confirmation page shares a generic canonical URL", async () => {
    async function captureApplication(jobPath, jobTitle) {
      const dom = new JSDOM(`
        <!doctype html>
        <html>
          <head>
            <title>${jobTitle} - Careers</title>
          </head>
          <body>
            <main>
              <h1>${jobTitle}</h1>
              <p>Apply for this career opening and join our hiring team as a candidate.</p>
              <button id="apply">Submit application</button>
            </main>
          </body>
        </html>
      `, {
        url: `https://careers.example.com${jobPath}`,
        pretendToBeVisual: true,
        runScripts: "outside-only"
      });

      const messages = [];
      const { window } = dom;

      window.chrome = {
        runtime: {
          sendMessage(message, callback) {
            messages.push(message);
            callback?.({ ok: true });
          },
          lastError: null
        }
      };

      window.eval(fs.readFileSync(path.join(rootDir, "src/content-script.js"), "utf8"));
      window.document.querySelector("#apply").dispatchEvent(
        new window.MouseEvent("click", { bubbles: true })
      );

      // Simulate the ATS redirecting to a shared, job-agnostic confirmation
      // page (e.g. Workday/SmartRecruiters-style flows), the scenario that
      // was previously causing every application to collapse onto the same
      // saved entry.
      window.history.pushState(null, "", "https://careers.example.com/apply/confirmation");
      const canonical = window.document.createElement("link");
      canonical.rel = "canonical";
      canonical.href = "https://careers.example.com/apply/confirmation";
      window.document.head.appendChild(canonical);
      window.document.querySelector("main").innerHTML = "<p>Thanks for applying!</p>";

      await waitFor(() => messages.length > 0, 3000);
      return messages[0].payload.url;
    }

    const firstUrl = await captureApplication("/jobs/111/software-engineer", "Software Engineer");
    const secondUrl = await captureApplication("/jobs/222/data-analyst", "Data Analyst");

    expect(firstUrl).toBe("https://careers.example.com/jobs/111/software-engineer");
    expect(secondUrl).toBe("https://careers.example.com/jobs/222/data-analyst");
    expect(firstUrl).not.toBe(secondUrl);
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

  it("deletes selected saved applications that do not have internal keys", async () => {
    const dom = new JSDOM(fs.readFileSync(path.join(rootDir, "popup/popup.html"), "utf8"), {
      url: "chrome-extension://test/popup/popup.html",
      runScripts: "outside-only"
    });
    const { window } = dom;
    const legacyEntry = {
      title: "Legacy Job",
      url: "https://jobs.example.com/roles/legacy-job"
    };
    let deleteKeys = [];

    window.chrome = {
      runtime: {
        sendMessage(message, callback) {
          if (message.type === "job-link-saver:list") {
            callback({ ok: true, entries: [legacyEntry] });
          }

          if (message.type === "job-link-saver:delete") {
            deleteKeys = message.keys;
            callback({ ok: true, entries: [] });
          }
        },
        lastError: null
      }
    };
    window.confirm = vi.fn().mockReturnValue(true);

    window.eval(fs.readFileSync(path.join(rootDir, "popup/popup.js"), "utf8"));
    window.document.dispatchEvent(new window.Event("DOMContentLoaded"));

    window.document.querySelector(".selection-input").click();
    window.document.querySelector("#deleteSelected").click();

    expect(deleteKeys).toEqual([legacyEntry.url]);
    expect(window.document.querySelectorAll(".application")).toHaveLength(0);
  });

  it("falls back to popup storage when background delete messaging fails", async () => {
    const dom = new JSDOM(fs.readFileSync(path.join(rootDir, "popup/popup.html"), "utf8"), {
      url: "chrome-extension://test/popup/popup.html",
      runScripts: "outside-only"
    });
    const { window } = dom;
    let storedEntries = [
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
    let currentLastError = null;
    let badgeText = "";

    window.chrome = {
      runtime: {
        get lastError() {
          return currentLastError;
        },
        sendMessage(message, callback) {
          if (message.type === "job-link-saver:list") {
            callback({ ok: true, entries: storedEntries });
            return;
          }

          if (message.type === "job-link-saver:delete") {
            currentLastError = { message: "The message port closed before a response was received." };
            callback(undefined);
            currentLastError = null;
          }
        }
      },
      action: {
        setBadgeText({ text }) {
          badgeText = text;
        },
        setBadgeBackgroundColor: vi.fn()
      },
      storage: {
        local: {
          get(defaults, callback) {
            queueMicrotask(() => {
              callback({ ...defaults, jobApplicationLinks: storedEntries });
            });
          },
          set(values, callback) {
            queueMicrotask(() => {
              storedEntries = values.jobApplicationLinks;
              callback();
            });
          }
        }
      }
    };
    window.confirm = vi.fn().mockReturnValue(true);

    window.eval(fs.readFileSync(path.join(rootDir, "popup/popup.js"), "utf8"));
    window.document.dispatchEvent(new window.Event("DOMContentLoaded"));

    window.document.querySelectorAll(".selection-input")[0].click();
    window.document.querySelector("#deleteSelected").click();
    await waitFor(() => storedEntries.length === 1, 1000);

    expect(storedEntries.map((entry) => entry.key)).toEqual(["backend"]);
    expect(badgeText).toBe("1");
    expect([...window.document.querySelectorAll(".title")].map((element) => element.textContent)).toEqual(["Backend Engineer"]);
  });
});

function createBackgroundHarness(initialEntries = []) {
  const storage = { jobApplicationLinks: initialEntries };
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
    dispatchMessage(message, sender = { tab: { url: "https://jobs.example.com/roles/frontend-engineer" } }) {
      return new Promise((resolve) => {
        messageListener(message, sender, resolve);
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

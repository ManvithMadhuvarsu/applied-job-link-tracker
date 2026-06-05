(() => {
  if (window.__jobApplicationLinkSaverLoaded) {
    return;
  }

  window.__jobApplicationLinkSaverLoaded = true;

  const PENDING_TTL_MS = 2 * 60 * 1000;
  const SAVE_COOLDOWN_MS = 10 * 1000;
  const MAX_TEXT_SCAN = 16000;
  const KNOWN_JOB_HOSTS = [
    "linkedin.",
    "indeed.",
    "greenhouse.io",
    "lever.co",
    "ashbyhq.com",
    "myworkdayjobs.com",
    "workdayjobs.com",
    "smartrecruiters.com",
    "icims.com",
    "taleo.net",
    "jobvite.com",
    "workable.com",
    "breezy.hr",
    "bamboohr.com",
    "recruitee.com",
    "applytojob.com",
    "rippling.com",
    "personio.",
    "oraclecloud.com",
    "successfactors.",
    "naukri.com",
    "internshala.com",
    "wellfound.com",
    "hirist.com",
    "instahyre.com"
  ];

  const APPLICATION_ACTION_PATTERNS = [
    /\bapply\b/i,
    /\beasy apply\b/i,
    /\bquick apply\b/i,
    /\bsubmit application\b/i,
    /\bsend application\b/i,
    /\bfinish application\b/i,
    /\bcomplete application\b/i,
    /\bconfirm application\b/i
  ];

  const GENERIC_SUBMIT_PATTERNS = [
    /\bsubmit\b/i,
    /\bsend\b/i,
    /\bfinish\b/i,
    /\bcomplete\b/i,
    /\bconfirm\b/i
  ];

  const SUCCESS_PATTERNS = [
    /\bthanks?\s+for\s+(applying|submitting\s+your\s+application)\b/i,
    /\bthank\s+you\s+for\s+(applying|submitting\s+your\s+application)\b/i,
    /\byour\s+application\s+(has\s+been|was|is)\s+(successfully\s+)?(submitted|sent|received|completed)\b/i,
    /\bapplication\s+(submitted|sent|received|complete|completed)\b/i,
    /\byou\s+(have\s+)?(successfully\s+)?applied\b/i,
    /\bwe('?ve|\s+have)\s+received\s+your\s+application\b/i,
    /\bsuccessfully\s+submitted\b/i,
    /\balready\s+applied\b/i
  ];

  const STATUS_ELEMENT_PATTERNS = [
    /\bapplied\b/i,
    /\balready\s+applied\b/i,
    /\bapplication\s+(sent|submitted|received|complete|completed)\b/i
  ];

  const FALSE_POSITIVE_PATTERNS = [
    /\bbefore\s+you\s+submit\b/i,
    /\bsubmit\s+your\s+application\b/i,
    /\bstart\s+your\s+application\b/i,
    /\bnot\s+(yet\s+)?submitted\b/i,
    /\bsave\s+and\s+continue\b/i,
    /\bapplication\s+deadline\b/i,
    /\bapply\s+now\b/i
  ];

  const JOB_CONTEXT_PATTERN = /\b(job|career|careers|position|opening|vacanc|role|candidate|resume|cv|cover letter|recruit|hiring|employment|applicant|application)\b/i;
  const SUCCESS_URL_PATTERN = /\/(thank-you|thanks|confirmation|submitted|application-submitted|application_submitted|complete|completed|success|applied)(\/|$|\?)/i;

  const state = {
    pending: null,
    lastHref: location.href,
    recentSaves: new Map(),
    scanTimer: null
  };

  document.addEventListener("click", handleActivation, true);
  document.addEventListener("submit", handleSubmit, true);
  document.addEventListener("keydown", handleKeyboardActivation, true);
  window.addEventListener("pageshow", () => scheduleScan("page shown", 400));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      scheduleScan("page visible", 400);
    }
  });

  const observer = new MutationObserver(() => {
    scheduleScan("page changed", state.pending ? 500 : 1200);
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "class", "disabled", "title", "value"]
    });
  }

  setInterval(() => {
    if (location.href !== state.lastHref) {
      state.lastHref = location.href;
      scheduleScan("url changed", 400);
    } else if (isPendingFresh()) {
      scheduleScan("pending follow-up", 1200);
    }
  }, 1200);

  scheduleScan("initial page scan", 1200);

  function handleActivation(event) {
    const element = closestActionElement(event.target);

    if (!element || !isApplicationAction(element)) {
      return;
    }

    markPending("activation", element);
  }

  function handleSubmit(event) {
    const form = event.target;

    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    const formText = collapseText([
      form.getAttribute("aria-label"),
      form.getAttribute("name"),
      form.getAttribute("id"),
      getElementText(form, 1200),
      document.title,
      location.href
    ].join(" "));

    if (JOB_CONTEXT_PATTERN.test(formText) || /apply|application|resume|candidate|career/i.test(formText)) {
      markPending("form submit", form);
    }
  }

  function handleKeyboardActivation(event) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    const element = closestActionElement(document.activeElement);

    if (!element || !isApplicationAction(element)) {
      return;
    }

    markPending("keyboard activation", element);
  }

  function markPending(source, element) {
    state.pending = {
      at: Date.now(),
      source,
      beforeUrl: location.href,
      elementText: getActionText(element),
      title: getTitle(),
      jobUrl: getBestJobUrl()
    };

    scheduleScan(`${source} pending`, 600);
    scheduleScan(`${source} follow-up`, 1800);
    scheduleScan(`${source} late follow-up`, 5000);
  }

  function isApplicationAction(element) {
    const actionText = getActionText(element);

    if (!actionText) {
      return false;
    }

    if (APPLICATION_ACTION_PATTERNS.some((pattern) => pattern.test(actionText))) {
      return true;
    }

    const nearbyText = collapseText([
      actionText,
      getNearbyText(element),
      document.title,
      location.href
    ].join(" "));

    return GENERIC_SUBMIT_PATTERNS.some((pattern) => pattern.test(actionText))
      && /application|applicant|candidate|resume|cover letter|job|career|position/i.test(nearbyText);
  }

  function scheduleScan(reason, delay = 700) {
    window.clearTimeout(state.scanTimer);
    state.scanTimer = window.setTimeout(() => {
      scanForCompletion(reason);
    }, delay);
  }

  function scanForCompletion(reason) {
    const signal = detectCompletionSignal();

    if (!signal.shouldSave) {
      return;
    }

    const jobUrl = getBestJobUrl(state.pending?.jobUrl);
    const normalizedUrl = normalizeForMessage(jobUrl);
    const lastSavedAt = state.recentSaves.get(normalizedUrl) || 0;

    if (Date.now() - lastSavedAt < SAVE_COOLDOWN_MS) {
      return;
    }

    state.recentSaves.set(normalizedUrl, Date.now());

    const payload = {
      url: jobUrl,
      normalizedUrl,
      pageUrl: location.href,
      title: getTitle(),
      company: getCompany(),
      platform: location.hostname.replace(/^www\./i, ""),
      evidence: signal.evidence,
      source: `${state.pending?.source || "page scan"}; ${reason}`,
      detectedAt: new Date().toISOString()
    };

    chrome.runtime.sendMessage(
      { type: "job-link-saver:save", payload },
      () => {
        if (chrome.runtime.lastError) {
          return;
        }

        state.pending = null;
      }
    );
  }

  function detectCompletionSignal() {
    const recentPending = isPendingFresh();
    const urlLooksComplete = SUCCESS_URL_PATTERN.test(location.href);
    const successEvidence = findSuccessEvidence();
    const statusEvidence = findAppliedStatusEvidence();
    const jobLike = isJobLikePage();
    let confidence = 0;
    const evidence = [];

    if (recentPending) {
      confidence += 1;
      evidence.push(`Recent application action: ${state.pending.elementText || state.pending.source}`);
    }

    if (jobLike) {
      confidence += 1;
    }

    if (urlLooksComplete) {
      confidence += 2;
      evidence.push(`Completion-looking URL: ${location.href}`);
    }

    if (successEvidence) {
      confidence += 3;
      evidence.push(successEvidence);
    }

    if (statusEvidence) {
      confidence += recentPending ? 2 : 1;
      evidence.push(statusEvidence);
    }

    if (!recentPending && !successEvidence && !urlLooksComplete) {
      return { shouldSave: false, evidence: "" };
    }

    if (!jobLike && confidence < 5) {
      return { shouldSave: false, evidence: "" };
    }

    return {
      shouldSave: confidence >= 3,
      evidence: evidence.join(" | ").slice(0, 500)
    };
  }

  function findSuccessEvidence() {
    const text = getVisiblePageText();

    for (const pattern of SUCCESS_PATTERNS) {
      const match = pattern.exec(text);

      if (!match) {
        continue;
      }

      const start = Math.max(0, match.index - 80);
      const end = Math.min(text.length, match.index + match[0].length + 100);
      const snippet = collapseText(text.slice(start, end));

      if (FALSE_POSITIVE_PATTERNS.some((negativePattern) => negativePattern.test(snippet))
        && !/thank|received|success|already|submitted|completed|sent|applied/i.test(match[0])) {
        continue;
      }

      return `Success message: ${snippet}`;
    }

    return "";
  }

  function findAppliedStatusEvidence() {
    const elements = document.querySelectorAll("button, [role='button'], a, input, [aria-label], [data-testid], [class*='status'], [class*='applied']");
    const limit = Math.min(elements.length, 250);

    for (let index = 0; index < limit; index += 1) {
      const element = elements[index];

      if (!isVisible(element)) {
        continue;
      }

      const text = getActionText(element);

      if (!text || text.length > 180) {
        continue;
      }

      if (STATUS_ELEMENT_PATTERNS.some((pattern) => pattern.test(text))
        && !/\bnot\s+applied\b/i.test(text)) {
        return `Status element: ${text}`;
      }
    }

    return "";
  }

  function isPendingFresh() {
    return Boolean(state.pending && Date.now() - state.pending.at < PENDING_TTL_MS);
  }

  function isJobLikePage() {
    const host = location.hostname.toLowerCase();

    if (KNOWN_JOB_HOSTS.some((knownHost) => host.includes(knownHost))) {
      return true;
    }

    const text = collapseText([
      location.href,
      document.title,
      getVisiblePageText(5000)
    ].join(" "));

    return JOB_CONTEXT_PATTERN.test(text) && /apply|application|resume|candidate|career|hiring|position/i.test(text);
  }

  function getBestJobUrl(fallbackUrl = "") {
    const knownUrl = getKnownPlatformUrl();

    if (knownUrl) {
      return knownUrl;
    }

    const canonicalUrl = getCanonicalUrl();

    if (canonicalUrl) {
      return canonicalUrl;
    }

    const openGraphUrl = getMetaContent("property", "og:url") || getMetaContent("name", "twitter:url");

    if (openGraphUrl) {
      return cleanUrl(openGraphUrl);
    }

    if (fallbackUrl) {
      return cleanUrl(fallbackUrl);
    }

    return cleanUrl(location.href);
  }

  function getKnownPlatformUrl() {
    const host = location.hostname.toLowerCase();
    const href = location.href;

    if (host.includes("linkedin.")) {
      const url = new URL(location.href);
      const pathMatch = url.pathname.match(/\/jobs\/view\/(\d+)/i);
      const queryId = url.searchParams.get("currentJobId");
      const linkedJob = document.querySelector("a[href*='/jobs/view/']");
      const linkedMatch = linkedJob?.href?.match(/\/jobs\/view\/(\d+)/i);
      const id = pathMatch?.[1] || queryId || linkedMatch?.[1];

      if (id) {
        return `https://www.linkedin.com/jobs/view/${id}/`;
      }
    }

    if (host.includes("indeed.")) {
      const url = new URL(location.href);
      const jobKey = url.searchParams.get("jk") || url.searchParams.get("vjk");

      if (jobKey) {
        return `${url.origin}/viewjob?jk=${encodeURIComponent(jobKey)}`;
      }
    }

    if (host.includes("greenhouse.io")) {
      const url = new URL(location.href);
      const jobId = url.searchParams.get("gh_jid") || url.pathname.match(/\/jobs\/(\d+)/i)?.[1];

      if (jobId) {
        url.search = "";
        url.hash = "";
        return `${url.origin}${url.pathname.replace(/\/apply$/i, "")}${url.pathname.includes(jobId) ? "" : `?gh_jid=${encodeURIComponent(jobId)}`}`;
      }
    }

    if (host.includes("lever.co")) {
      const url = new URL(location.href);
      url.hash = "";
      url.search = "";
      return url.toString().replace(/\/apply\/?$/i, "");
    }

    return "";
  }

  function getCanonicalUrl() {
    const canonical = document.querySelector("link[rel='canonical'], link[rel~='canonical']");
    return canonical?.href ? cleanUrl(canonical.href) : "";
  }

  function getTitle() {
    const jsonLdTitle = getJobPostingJsonLdValue("title");
    const heading = document.querySelector("h1")?.innerText;
    const metaTitle = getMetaContent("property", "og:title") || getMetaContent("name", "twitter:title");

    return collapseText(jsonLdTitle || heading || metaTitle || document.title || "Untitled job").slice(0, 160);
  }

  function getCompany() {
    const jsonLdCompany = getJobPostingJsonLdCompany();

    if (jsonLdCompany) {
      return collapseText(jsonLdCompany).slice(0, 120);
    }

    const companySelectors = [
      "[data-testid*='company' i]",
      "[class*='company' i]",
      "[aria-label*='company' i]",
      ".topcard__org-name-link",
      ".jobs-unified-top-card__company-name"
    ];

    for (const selector of companySelectors) {
      const element = document.querySelector(selector);
      const text = element ? getElementText(element, 160) : "";

      if (text && text.length <= 120) {
        return collapseText(text);
      }
    }

    return "";
  }

  function getJobPostingJsonLdValue(key) {
    const postings = getJsonLdJobPostings();

    for (const posting of postings) {
      if (typeof posting[key] === "string") {
        return posting[key];
      }
    }

    return "";
  }

  function getJobPostingJsonLdCompany() {
    const postings = getJsonLdJobPostings();

    for (const posting of postings) {
      const org = posting.hiringOrganization;

      if (typeof org === "string") {
        return org;
      }

      if (org && typeof org.name === "string") {
        return org.name;
      }
    }

    return "";
  }

  function getJsonLdJobPostings() {
    const scripts = document.querySelectorAll("script[type='application/ld+json']");
    const postings = [];

    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent || "null");
        collectJobPostings(data, postings);
      } catch {
        // Ignore invalid site metadata.
      }
    }

    return postings;
  }

  function collectJobPostings(value, postings) {
    if (!value) {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => collectJobPostings(item, postings));
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    const type = value["@type"];

    if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) {
      postings.push(value);
    }

    if (Array.isArray(value["@graph"])) {
      value["@graph"].forEach((item) => collectJobPostings(item, postings));
    }
  }

  function getMetaContent(attribute, value) {
    return document.querySelector(`meta[${attribute}='${value}']`)?.content || "";
  }

  function closestActionElement(target) {
    if (!(target instanceof Element)) {
      return null;
    }

    return target.closest("button, a, input, textarea, select, [role='button'], [tabindex], [aria-label]");
  }

  function getActionText(element) {
    if (!element) {
      return "";
    }

    const parts = [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("value"),
      element.getAttribute("name"),
      element.getAttribute("id"),
      element.textContent
    ];

    return collapseText(parts.filter(Boolean).join(" ")).slice(0, 220);
  }

  function getNearbyText(element) {
    const form = element.closest("form");
    const section = element.closest("section, article, main, [role='main'], [data-testid], [class]");
    const source = form || section || element.parentElement;

    return source ? getElementText(source, 2000) : "";
  }

  function getElementText(element, maxLength = 1000) {
    return collapseText((element.innerText || element.textContent || "").slice(0, maxLength));
  }

  function getVisiblePageText(maxLength = MAX_TEXT_SCAN) {
    const root = document.querySelector("main, [role='main']") || document.body;

    if (!root) {
      return "";
    }

    return collapseText((root.innerText || root.textContent || "").slice(0, maxLength));
  }

  function isVisible(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);

    return rect.width > 0
      && rect.height > 0
      && style.visibility !== "hidden"
      && style.display !== "none"
      && Number(style.opacity || "1") > 0;
  }

  function cleanUrl(value) {
    try {
      const url = new URL(value, location.href);

      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return location.href;
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
      return location.href;
    }
  }

  function normalizeForMessage(value) {
    const url = new URL(cleanUrl(value));
    url.hostname = url.hostname.replace(/^www\./i, "").toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/g, "");
    return url.toString().toLowerCase();
  }

  function collapseText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }
})();

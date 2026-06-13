# Job Application Link Saver

A Chrome/Edge web extension that automatically saves direct job-post links when it detects that a job application has been submitted.

## What it does

- Watches job and ATS pages in the background.
- Detects likely application-completion signals, such as "Application submitted", "Thanks for applying", "You applied", submitted forms, and confirmation URLs.
- Saves a cleaned direct job link, title, company, platform, timestamp, and detection evidence.
- Deduplicates repeat captures of the same job.
- Lets you select saved jobs in the popup, then copy, export CSV, export JSON, or delete only those selected links.
- Keeps a separate Clear All action for wiping the full saved history.

## Install locally

1. Open Chrome or Edge.
2. Go to `chrome://extensions` or `edge://extensions`.
3. Enable `Developer mode`.
4. Choose `Load unpacked`.
5. Select the folder where you cloned this repository (the folder that
   contains `manifest.json`).

After that, the extension works automatically on HTTP and HTTPS pages, including embedded application frames. You do not need to click anything in the extension while applying.

## Manage saved links

Open the extension popup to review saved applications. Select one or more saved jobs, then use Copy, CSV, JSON, or Delete to act only on the selected links. Use Clear All only when you want to remove the entire saved list.

## Validate locally

Install dev dependencies and run the test suite:

```text
npm install
npm test
```

## Notes

This uses browser-side heuristics because job sites and applicant tracking systems do not expose one universal "application submitted" event. It should work well on common flows like LinkedIn, Indeed, Greenhouse, Lever, Ashby, Workday, SmartRecruiters, iCIMS, and similar platforms, but some sites may need a custom rule if they use unusual wording or hide confirmation messages inside private iframes.

The extension saves links to Chrome/Edge extension local storage. It copies links into its saved list automatically; it does not write every captured link to your system clipboard because most browsers restrict silent clipboard writes.

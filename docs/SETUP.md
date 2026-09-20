# First-run setup

For a clone on a **new machine**. Do this before sending mail. Product details after setup: [`PROJECT_HANDOFF.md`](PROJECT_HANDOFF.md).

Agents: also read root [`AGENTS.md`](../AGENTS.md). Start the stack with `npm run dev:terminal` on macOS.

## 1. Install Node and repo deps

Need **Node 22+** (API uses `node:sqlite`). Use nvm: `nvm use` (repo has `.nvmrc`).

```bash
npm install
npx playwright install chromium
```

Playwright’s bundled Chromium is what Jobright, Gmail, and LinkedIn automation use — not your everyday Chrome window.

## 2. Environment file

macOS / Linux:

```bash
cp .env.example .env
```

Windows (Command Prompt):

```bat
copy .env.example .env
```

Edit `.env` (repo root). It is gitignored. **Do not commit it.**

| Variable | Required? | What it does |
|---|---|---|
| `GEMINI_API_KEY` | Yes, for drafts | Company email generation |
| `JOBRIGHT_JOB_URL` | Yes, for lookup | Any Jobright job page you can open while logged in |
| `JOBRIGHT_DRY_RUN` | Set `false` | Default is dry-run (no real lookup) |
| `SALESQL_DRY_RUN` / `APOLLO_DRY_RUN` | Set `false` to reveal | Default dry-run avoids burning credits |
| `TEST_MODE` + `TEST_MODE_RECIPIENT_EMAIL` | Strongly yes at first | Redirects outbound mail to you |
| `GOOGLE_CLIENT_ID` / `SECRET` | Optional | OAuth path; **Setup → Open login** is enough for Playwright Gmail |
| `PUBLIC_TRACKING_BASE_URL` | Optional until tracked sends | Must be HTTPS or real tracked sends are blocked |
| `HUNTER_API_KEY` and other finders | Optional | Extra email APIs after Jobright / extensions |
| `*_EXTENSION_PATH` | Usually omit | Auto-detects Chrome’s unpacked extension folder on macOS, Windows, and Linux |

Get a Gemini key from Google AI Studio. Jobright URL: open [jobright.ai](https://jobright.ai), open any job posting, copy the `https://jobright.ai/jobs/info/...` URL.

## 3. Chrome extensions (install in Google Chrome)

Playwright cannot load Web Store extensions from Chrome itself at send time. You install them in **Google Chrome**, then the worker copies them into `apps/worker/data/` (gitignored).

In Chrome Web Store, add:

1. **SalesQL** — [chrome web store](https://chromewebstore.google.com/detail/salesql/lbdglhhdbgnknbdifhanfholehojlkgg)
2. **Apollo** — [chrome web store](https://chromewebstore.google.com/detail/apollo/alhgpfoeiimagjlnfekdhkjlkiomcapa)
3. **Streak** — [chrome web store](https://chromewebstore.google.com/detail/streak/jcgpgjhaendighananonflfmjjefjjlp)

Pin them. You do **not** need to load this repo’s `apps/extension` unless you want LinkedIn capture from the MV3 dashboard extension.

If Chrome stored an extension somewhere unusual, set `SALESQL_EXTENSION_PATH` / `APOLLO_EXTENSION_PATH` / `STREAK_EXTENSION_PATH` to that unpacked version folder (`.../Extensions/<id>/<version>_0`).

## 4. Streak in the Gmail automation browser

Stop any running worker first (it locks `gmail-profile`).

```bash
npm run install:streak -w @recruiter/worker
```

A headed Chromium window opens on the **automation** Gmail profile (`apps/worker/data/gmail-profile`). Sign into Gmail **in that window** and accept Streak. Close the window when done.

If you see SingletonLock / profile in use: quit the worker, close leftover “Google Chrome for Testing” windows, retry.

## 5. Start the app and keep it running

**macOS / Windows:** opens a real terminal window that survives Cursor agent cleanup.

```bash
npm run dev:terminal
```

On Windows that is a new Command Prompt. On macOS it is Terminal.app. On Linux it runs in the current shell.

Equivalent by hand (any OS — keep that terminal open):

```bash
npm run dev
```

Then:

- Dashboard: http://localhost:3000
- API: http://localhost:4000/health

Do **not** start `npm run dev` inside a Cursor agent shell if you need it to stay up. Those jobs get aborted (exit 137) and take the API/worker with them.

## 6. Setup tab (dashboard)

Open http://localhost:3000 → **Setup**.

1. **Gmail** → Open login → sign in (same automation profile as Streak).
2. **Jobright** → Open login → sign in.
3. **LinkedIn** → Open login → sign into LinkedIn, then SalesQL and Apollo in that window if they ask.
4. Click refresh on session status until each shows ready.
5. **Resume:** upload your PDF here. Files live in `apps/api/data/resumes/` (not in git). Swap resumes anytime in Setup; no code change needed.
6. Add at least one **sample email** if you want Gemini drafts.
7. Optional: footer, test-mode recipient (also set in `.env`), discovery toggles.

If Open login says the profile is busy, wait for capture/lookup to finish or stop the worker, then retry.

## 7. Optional: this repo’s capture extension

```bash
npm run build -w @recruiter/extension
```

Chrome → `chrome://extensions` → Developer mode → Load unpacked → `apps/extension/dist`.

## 8. Optional: tracking relay

Real open/click tracking needs a public HTTPS URL. See the relay section in [`README.md`](../README.md). Skip until you need tracking.

## Sanity checks

- [ ] `.env` exists locally and is **not** staged for git
- [ ] `curl -s http://127.0.0.1:4000/health` works
- [ ] Setup sessions: Gmail, Jobright, LinkedIn ready
- [ ] A resume is selected in Setup
- [ ] `TEST_MODE=true` for the first send
- [ ] Worker log is not stuck on `JOBRIGHT_JOB_URL is not set` or `Streak extension not found`

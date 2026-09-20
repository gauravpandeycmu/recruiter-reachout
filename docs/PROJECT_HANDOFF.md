# Recruiter Reachout — Project Handoff (v2)

**Audience:** a fresh Cursor/agent session that needs full product context without prior chat history.  
**Product:** local-first recruiter outreach — Chrome extension + React dashboard + Node API + Playwright worker. Capture LinkedIn recruiters, discover emails, generate company copy, schedule Gmail sends via Streak, track opens/clicks, gamify consistency with a daily company goal and a 3D Streak Grove.

**Last major product lock-in:** v2.0.0 — schedule-as-activity streak/goal semantics, company-batch Scheduled UX, Fun-zone streak ring, History/Scheduled animation polish.

Point new sessions at this file first:

```text
Read AGENTS.md and docs/SETUP.md for install/env/login.
Read docs/PROJECT_HANDOFF.md for product behavior, then continue from the user’s latest ask.
```

Also useful: root `README.md` (run/env), `apps/web/GROVE3D.md` (Three.js grove), `validation/manual-checks.md`.

---

## Why this product exists

Job search outreach is repetitive: find recruiters → get emails → write similar mail per company → send steadily without burning domains or breaking Gmail/Streak tracking. This app keeps the queue local, automates discovery and paced sending, and makes “show up every day” visible via Grove trees and a daily **company** goal (not “emails sent”).

---

## Monorepo map

Root: npm workspaces (`package.json`). Version **2.0.0** across packages.

| Path | Package | Role |
|------|---------|------|
| `apps/web` | `@recruiter/web` | React + Vite dashboard — **http://localhost:3000** |
| `apps/api` | `@recruiter/api` | Node HTTP API + SQLite — **http://localhost:4000** |
| `apps/worker` | `@recruiter/worker` | Playwright: email discovery, Gmail+Streak sends, LinkedIn capture |
| `apps/extension` | `@recruiter/extension` | Chrome MV3 — scrape recruiters from LinkedIn / Google / Bing |
| `apps/relay` | `@recruiter/relay` | Cloudflare Worker — public open/click tracking; syncs opaque events to API |
| `packages/shared` | `@recruiter/shared` | Shared types + email/validation/LinkedIn helpers |

**Canonical domain types:** `packages/shared/src/types.ts`  
**Web API client:** `apps/web/src/api.ts`  
**UI orchestration (large):** `apps/web/src/main.tsx`  
**Styles:** `apps/web/src/styles.css`

---

## Run locally

**Setup (clone, keys, Chrome extensions, Setup-tab logins):** [`docs/SETUP.md`](SETUP.md) and [`AGENTS.md`](../AGENTS.md).

On macOS, keep the stack alive in Terminal.app (not a Cursor agent shell):

```bash
npm run dev:terminal
```

Or:

```bash
npm install
npm run build -w @recruiter/shared
npm run dev   # api + web + worker concurrently
```

| Check | URL |
|-------|-----|
| Dashboard | http://localhost:3000 |
| API health | http://localhost:4000/health |

```bash
npm run typecheck
npm test
```

**API note:** `tsx` API does **not** hot-reload. After changing `apps/api/src/*`, kill the process on `:4000` and restart `npm run dev -w @recruiter/api` (exit code **143** = old process SIGTERM’d — normal).

**Extension:** `npm run build -w @recruiter/extension` → load `apps/extension/dist` in Chrome.

**Worker env (required):** `JOBRIGHT_JOB_URL`. Optional: `SALESQL_EXTENSION_PATH`, `STREAK_EXTENSION_PATH`, dry-run / auto-send flags.

---

## End-to-end pipeline

```text
Extension / LinkedIn capture
  → POST /api/candidates (active batch)
  → Worker discovery (Jobright → optional SalesQL)
  → Gemini company email draft
  → User edits preview ({firstName} / {fullName})
  → POST /api/send-queue/schedule  (Schedule click)
  → SendQueueItem + SendJob created; candidates archived from active batch
  → Worker: GET /api/automation/next-send → Playwright Gmail + Streak Send
  → POST /api/automation/send-result/:id
  → Tracking pixel / relay open+click
```

**Worker loop priority** (`apps/worker/src/index.ts`): **send → LinkedIn capture → email discovery → idle**.  
API may auto-spawn the worker if heartbeat is stale (`workerSupervisor.ts`).

### Gmail: two readiness paths

1. **OAuth** — `/api/gmail/auth-url` + callback; tokens encrypted in SQLite.  
2. **Browser session** — Setup opens headed Chromium profile `apps/worker/data/gmail-profile`.

**Real sends use Playwright + Streak extension**, not Gmail API send. Gmail’s native “Schedule send” breaks Streak tracking — worker always clicks **Send** with Streak on (`apps/worker/src/gmailSend.ts`).

`resolveGmailReady()` accepts OAuth **or** probed browser session.  
`assertCanSend()` / `sendGate.ts`: resume PDF, high-confidence email, HTTPS tracking base URL, no suppression/bounce/duplicate.

---

## UI tabs (dashboard)

Tab union: `"send" | "scheduled" | "setup" | "history" | "analytics"`.  
Persisted: `localStorage` key `recruiter-reachout.active-tab`.  
**Nav label for analytics = “Grove”.** Tabs use keep-alive panels + sliding pill (avoid remount thrash).

### Send

- Find recruiters (company + LinkedIn pages) or extension ingest.
- Today’s batch: multi-company, discovery status, SalesQL toggle; recipients paginated **5 / page** (`RECIPIENT_PAGE_SIZE`).
- Generate / edit shared company email; preview motion (fold → load → reveal).
- Schedule panel: presets (Now, Tomorrow 8/11, Coming Monday 8/11), datetime-local, interval chips **4 / 8 / 12** min → `scheduleSends`.
- Streak buddy card → jumps to Grove.
- **Send progress** for `send_now` jobs (those jobs are **hidden** from the Scheduled tab).

### Scheduled

- Groups upcoming sends by company (`groupUpcomingByCompany` in `sendHelpers.ts`).
- Excludes `jobMode === "send_now"`.
- Per company bar: **View/Hide**, **Remove** (whole removable batch), expand body.
- Expanded: shared email template edit (`updateScheduledCompanyBatch`), Change time (presets + rounded datetime), **Send now** (staggers ~4 min), people list **5 / page** (`SCHEDULED_PEOPLE_PAGE_SIZE`).
- Expand/collapse: short `grid-template-rows` height + opacity (no staggered row animations).
- Remove company: `is-leaving` exit shell fades/collapses (~280ms) **then** cancel API + refresh — avoids stuttery instant list jump.
- Laptop must stay on for worker; browser tab need not stay open.

### Grove (Analytics tab)

- **3D Streak Grove** — `StreakGrove3D.tsx` (Three.js); SVG fallback. Details: `apps/web/GROVE3D.md`.
- Planted trees = consecutive days the **daily company goal** was met (`goalProgress.streak`). Field-guide unlocks are sticky (`resolveGroveUnlockDays` + `grove-goal-unlock-days.v3`) so a later streak reset does not uproot collected species.
- A first-run clone is a **bare meadow**: 0 planted streak trees, 0 send events, 0 companies touched. Decorative foothill pines in the 3D scene are scenery, not plantings.
- Daily goal editor; celebration toast (dancing cat) when company goal met.
- **Useful:** cumulative scheduled-companies climb, 14-day trend, company leaderboard, health warnings (elsewhere / cards).
- **Fun zone:** usage stats (Jobright / SalesQL / Gemini / captures), hourly **schedule-click** chart, queue donuts, **streak ring** (“Keep the grove growing”).
- `goalProgress.sendStreak` / `longestSendStreak` are outreach-activity days (any schedule or send). They do **not** plant Grove trees.

### History

- Backlog table + legacy `scheduleToday` autopilot (cap-based; secondary path).
- Outreach history: company cards, search/sort; people **12 / page**.
- Expand/collapse is **instant** (no height animation — user preference after stuttery accordion).

### Setup

- Login sessions: Gmail+Streak, Jobright, LinkedIn (`openSetupLogin`).
- Test mode (redirect recipient + `[TEST MODE]` subject prefix).
- Grove weather location (IP / optional precise geolocation).
- Sample emails, resume PDF library, email footer (mail paper always light ink in dark mode), global subject/body, discovery settings (SalesQL auto-fallback **off by default** — quota).

### Theme / polish notes

- Dark mode: many panels forced to surface tokens; **email HTML previews stay light mail paper** (`--mail-ink`) so signature/name don’t wash out.
- Prefer existing visual language over redesigning whole screens.

---

## Streak, Grove, and daily goal (critical semantics)

### Daily goal = companies scheduled today (default **5**)

- Stored in SQLite `analytics_goal_settings`; default `dailySendGoal: 5` (`apps/api/src/store.ts`).
- **Counts:** distinct companies with a queue item created **today** in status `scheduled | queued | sent`, keyed by `send_queue.createdAt` + client timezone offset (`collectScheduledCompaniesByDay` in `apps/api/src/analytics.ts`).
- **One Schedule batch for one company = +1**, regardless of how many people are in the batch.
- Does **not** wait for Gmail delivery. Scheduling for Monday still credits **today** when the user clicks Schedule.
- UI: “X / Y companies today”. Field name `goalProgress.sentToday` is historical — it means companies scheduled, not Gmail sends.
- `goalProgress.streak` = consecutive days the **company goal** was met.
- Celebration: `shouldCelebrate` when met and not yet celebrated today → cat toast + `celebrateToday`.

### Outreach activity streak (`sendStreak`)

- An **activity day** = Gmail `type: "send"` event **OR** any active queue item whose `createdAt` falls that local day (`collectOutreachActivityDates`).
- `activityToday`, `sendStreak`, `longestSendStreak` measure days with any schedule-or-send action.
- Grove **trees** and field-guide unlocks use the company-goal streak (`goalProgress.streak` / `usage.longestStreak`), not this activity streak.

### Do not conflate

| Concept | Fields | Basis |
|---------|--------|--------|
| Company goal + goal streak / Grove trees | `sentToday`, `dailySendGoal`, `goalProgress.streak`, `usage.longestStreak` | Distinct companies scheduled that day; consecutive goal-met days plant trees |
| Outreach activity streak | `sendStreak`, `longestSendStreak`, `activityToday` | Any schedule-or-send activity that day |
| Motivation level | `motivation.*` | Lifetime **send events** milestone ladder |

### Client date gotcha

Analytics `date` must use **local YMD**, not `toISOString().slice(0,10)` (UTC shift can break “today”). See `apps/web/src/api.ts` / analytics fetch.

---

## Scheduling nuances

### Primary path: explicit schedule

`POST /api/send-queue/schedule` → `scheduleSends` → `scheduleCandidatesExplicit` (`apps/api/src/scheduler.ts`).

- Honors user `startAt` + `intervalMinutes` **exactly**.
- **Does not** reject/shift for daily/hourly/domain caps on this path (`skipPacing` when `mode === "schedule"`).
- Interval jitter on later slots still exists for natural spacing.
- Duplicates: candidate already `scheduled|queued` → rejected.
- On success: candidates **archived** out of active batch.

### Send now

- `mode: "send_now"` or start within ~90s (`isScheduleForNow`).
- **Pacing enforced** (daily/hourly/domain).
- Jobs spaced ~**4 minutes** (`SEND_NOW_GAP_MS`).
- Appear on Send progress UI, not Scheduled list.

### Reschedule

`POST /api/send-queue/reschedule` (`rescheduleQueuedSend` in `services.ts`):

- Per queue item; past times rejected; in-progress blocked.
- Company UI shifts all actionable items by the same delta, or Send now via `sendNow`.
- Send now from Scheduled tracks queue ids and can switch UI toward Send progress.

### Company batch APIs

- `POST /api/send-queue/update-company-batch` — rewrite subject/body for pending jobs in a company.
- `POST /api/send-queue/cancel` — by `candidateIds` or `queueItemIds`.
- `POST /api/send-queue/retry-failed`.

### Legacy backlog scheduler

History tab `scheduleToday` / `scheduleCandidates()` — auto rolls by caps (200/day, 100/hour, 100/domain). Secondary / older path.

### Pacing defaults

All scheduling and send-now paths use the same defaults: 200/day, 100/hour, and 100/domain.

---

## Analytics metric definitions

Built by `buildAnalyticsSummary()` (`apps/api/src/analytics.ts`). Client sends `date`, `tzOffset`, `localHour`.

| Metric | Meaning |
|--------|---------|
| `today.sent` | Gmail send events today (local) |
| `today.discovered` | Emails discovered today |
| `today.companiesReached` | Distinct companies with a **send event** today |
| `goalProgress.sentToday` | Distinct companies **scheduled** today |
| `daily[].scheduledCompanies` | Same, per day |
| `cumulativeSends` | Running sum of scheduled companies (14-day window) — legend may say “Sent” historically but means scheduled companies |
| `hourly[].sent` | Queue items by **schedule-click hour** (`createdAt`), not delivery hour |
| `queueBreakdown` | scheduled+queued / sent / failed / paused / other |
| `companies[]` | Leaderboard (sent, people, ready unsent, with email) |
| `usage.*` | Fun zone provider/stats |
| `health[]` | Nudge-style warnings (still computed; Fun-zone Nudge card removed) |
| `motivation` | Send-count milestones |

Timezone: day buckets use client `tzOffsetMinutes`. Tests cover Pacific vs UTC.

---

## Key API surface

Defined in `apps/api/src/server.ts`. Highlights:

| Area | Endpoints |
|------|-----------|
| State | `GET /api/state` (includes `upcomingSends`) |
| Candidates | `POST /api/candidates`, bulk, patch, clear active, discovery |
| Content / resumes | content CRUD, resume upload |
| Send queue | `/schedule`, `/cancel`, `/reschedule`, `/retry-failed`, `/update-company-batch`, `/schedule-today` |
| Automation | `/next-discovery`, `/next-send`, `/send-result/:id`, worker-status, LinkedIn capture |
| Gmail | auth-url, callback, status, disconnect |
| Setup | session-status, open-login, test-mode |
| Analytics | `GET /api/analytics`, `GET\|POST /api/analytics/goal` |
| History / backlog | `/api/history/companies`, `/api/backlog/jobs` |
| Tracking | `/t/open/:id.gif`, `/t/click/:id`, `/api/tracking/sync` |
| Weather | `GET /api/weather` |

---

## Storage

### SQLite

- Path: `apps/api/data/recruiter-reachout.sqlite` (`store.ts`), WAL, JSON blob rows.
- Tables include: candidates, send_queue, send_jobs, tracking_events, gmail_accounts, company_content, analytics_goal_settings, worker_status, weather_cache, …

### Files

- Resumes: `apps/api/data/resumes/`
- Worker profiles: `apps/worker/data/{gmail,jobright,salesql}-profile/`
- Worker logs under `apps/worker/data/`

### Relay

Cloudflare KV — opaque tracking IDs only (no recruiter PII / tokens).

---

## Edge cases & gotchas (checklist)

1. **Schedule ≠ Gmail send** for `today.sent`, but schedule **does** count for goal + outreach streak.
2. Explicit schedule **bypasses** pacing caps; send-now does not.
3. Never use Gmail native Schedule send if Streak tracking matters.
4. SalesQL auto-fallback off by default (monthly quota).
5. Scheduling archives candidates from active batch; “Remove all” archives — re-save from extension to reactivate.
6. Only **high-confidence** emails can send (`sendGate.ts`).
7. Real sends need HTTPS `PUBLIC_TRACKING_BASE_URL`.
8. Test mode needs a recipient email or sends fail.
9. Worker needs `STREAK_EXTENSION_PATH` for real Gmail+Streak sends.
10. Grove 3D: Strict Mode double-mount handled; HMR often needs **hard reload** after scene edits.
11. `send_now` jobs hidden from Scheduled tab.
12. Analytics local date, not UTC `toISOString` date.
13. Dark mode must not recolor mail preview ink.
14. History expand = instant; Scheduled expand = short height; Scheduled remove = leave animation then API.
15. Store self-repairs some bad company/name/LinkedIn duplicates on load.
16. Gemini usage may be estimated from drafts when LLM events missing.

---

## Tech stack

| Layer | Stack |
|-------|-------|
| Monorepo | npm workspaces, TypeScript, Vitest |
| Web | React, Vite, Three.js (`three@0.185.1`) |
| API | Node `http`, `tsx`, `node:sqlite` |
| Worker | Playwright + persistent Chromium + extensions |
| Extension | Chrome MV3 |
| Relay | Cloudflare Workers + KV |
| AI | Google Gemini (`GEMINI_API_KEY`) |
| Weather (Grove) | Open-Meteo + ipwho.is |

---

## Env vars (quick)

```bash
GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI=http://localhost:4000/api/gmail/callback
TOKEN_ENCRYPTION_KEY
PUBLIC_TRACKING_BASE_URL   # HTTPS required for real sends
RELAY_SYNC_TOKEN
GEMINI_API_KEY
DAILY_INTAKE_LIMIT=300
DAILY_SEND_LIMIT=200
HOURLY_SEND_LIMIT=100
DOMAIN_DAILY_SEND_LIMIT=100
TEST_MODE / TEST_MODE_RECIPIENT_EMAIL
JOBRIGHT_JOB_URL           # worker required
SALESQL_EXTENSION_PATH / STREAK_EXTENSION_PATH
```

---

## Suggested reading order for a new session

1. **This file** — product truth + edge cases  
2. `README.md` — run / relay deploy  
3. `packages/shared/src/types.ts` — domain model  
4. `apps/api/src/analytics.ts` + `test/analytics.test.ts` — goal/streak contracts  
5. `apps/api/src/services.ts` + `scheduler.ts` — schedule / reschedule / send-now  
6. `apps/web/src/main.tsx` — UI behavior  
7. `apps/worker/src/index.ts` + `gmailSend.ts` — automation  
8. `apps/web/GROVE3D.md` — only if touching the 3D grove  

---

## What “almost done” means (v2 snapshot)

Locked in for day-to-day use:

- Capture → discover → draft → **schedule by company** → worker sends with Streak  
- Daily **company** goal (default 5) + Grove outreach streak from schedule-or-send days  
- Scheduled tab company batches (edit template, reschedule, send now, remove, pagination)  
- Grove 3D + Fun-zone streak ring + analytics charts  
- History directory + backlog tools  
- Setup sessions, resumes, footer, test mode, weather  

Likely future polish (not blocking handoff): trim `main.tsx` size, more Grove asset polish, production relay hardening, extension versioning beyond local load.

# Manual Validation Checks

Run these checks after each meaningful change.

## Setup

- `npm install` completes.
- `npm run typecheck` completes.
- `npm test` completes.
- `npm run dev` starts API and dashboard.
- `http://localhost:4000/health` returns `{ "ok": true }`.
- `http://localhost:4000/api/env/status` reports only expected local-development warnings.

## Gmail OAuth

- Dashboard Connect Gmail opens Google OAuth.
- Callback stores the connected Gmail account without exposing tokens to the browser.
- Dashboard shows the connected Gmail address.
- Disconnect Gmail clears local token storage and blocks sending.
- Token refresh works through mocked tests and real self-send validation.

## Extension Collection

- LinkedIn profile page returns one candidate with name and URL.
- LinkedIn/Google/Bing result page returns unique profile URLs.
- Empty or unsupported page shows zero candidates without crashing.
- Saving candidates makes them visible in the dashboard after refresh.

## Content And Preview

- Fixed subject/body are stored without rewriting.
- `{firstName}` renders correctly for at least 20 candidates.
- Candidates without a first name are flagged in preview.
- Resume PDF upload succeeds and the selected filename is shown in the dashboard.
- Preview says the resume will be attached.

## Email Discovery

- Known company domain generates common email patterns.
- Invalid domains do not get high confidence.
- Manual override of selected email is reflected in preview.
- Draft MIME includes the uploaded PDF attachment when Gmail credentials are configured.

## Tracking

- Preview includes an open tracking pixel.
- Real-send preview uses `PUBLIC_TRACKING_BASE_URL`, not localhost.
- `apps/relay/wrangler.toml` has real Cloudflare KV namespace IDs.
- `npx wrangler deploy` publishes the Worker on an HTTPS `workers.dev` URL.
- `/health` on the deployed Worker returns `{ "ok": true }`.
- Tracking pixel endpoint records an open event.
- Tracked redirect endpoint records click and redirects to the target.
- Public relay records open and click events using opaque tracking IDs.
- `/sync/events` returns 401 without `Authorization: Bearer <RELAY_SYNC_TOKEN>`.
- `/sync/events` returns stored KV events with the correct token.
- Local sync pulls relay events into SQLite and maps them to candidates.

## Controlled Send

- Send remains explicit and user-approved.
- Duplicate LinkedIn URLs are upserted rather than duplicated.
- Candidate state transitions are visible in the dashboard.
- Queue defaults to 300/day intake, 50/day sending, 5/hour, and 5/domain/day.
- A 300-candidate simulated day schedules 50 today and rolls over 250.
- Medium/low/blocked confidence emails are not auto-sent.
- Suppressed/bounced/do-not-contact candidates never enter the send queue.

## Email Verification

- Missing MX blocks generated emails.
- Malformed domains are blocked.
- Public/manual company pattern evidence creates high-confidence guesses.
- Repeated bounces downgrade or block the company pattern.
- Bad names like `LinkedIn Member`, company pages, job pages, and initials-only names are blocked.

## Company Workflow

- Company search links open Google/Bing queries.
- Extension can collect candidates from the result pages.
- You can queue at least 20 candidates without opening Gmail.
- Dashboard shows backlog by job: collected, scheduled, rolled over, sent, failed, suppressed.

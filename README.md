# Recruiter Reachout

Chrome extension plus local dashboard/API for email-only recruiter outreach.

**Current product truth (v2):** see [`docs/PROJECT_HANDOFF.md`](docs/PROJECT_HANDOFF.md) — features, streak/goal semantics, scheduling edge cases, APIs, and gotchas for new sessions.

## What Works In V2

- Capture visible recruiter candidates from LinkedIn profiles, LinkedIn search, Google, or Bing pages.
- Store candidates in a local queue.
- Paste your fixed email subject/body and use `{firstName}` or `{fullName}` placeholders.
- Upload and store your resume PDF locally so Gmail drafts/sends can attach the real file.
- Generate free pattern-based email guesses from a company domain.
- Preview final email HTML with a tracking pixel.
- Record draft/send/open/click events.
- Create company search links for `site:linkedin.com/in` recruiter discovery.
- Connect Gmail through OAuth and refresh access tokens automatically.
- Queue large recruiter backlogs locally with a conservative default send cap.
- Use a public tracking relay for real open/click tracking while keeping your DB local.
- Schedule company batches (exact times), reschedule / send-now from the Scheduled tab.
- Daily **company** goal (default 5) + Grove outreach streak from schedule-or-send activity.
- 3D Streak Grove + Fun-zone streak ring and analytics.

Gmail OAuth endpoints, MIME generation, and Gmail API draft/send calls are prepared. Real Gmail actions are intentionally gated until credentials are configured and the manual test flow passes.

## Run Locally

```bash
npm install
npm run build -w @recruiter/shared
npm run dev
```

Then open:

- Dashboard: `http://localhost:3000`
- API health: `http://localhost:4000/health`

Optional Gmail/tracking env vars:

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:4000/api/gmail/callback
TOKEN_ENCRYPTION_KEY=generate-a-long-random-string
PUBLIC_TRACKING_BASE_URL=https://your-free-relay.example.com
RELAY_SYNC_TOKEN=generate-another-random-string
DAILY_INTAKE_LIMIT=300
DAILY_SEND_LIMIT=50
HOURLY_SEND_LIMIT=5
DOMAIN_DAILY_SEND_LIMIT=5
```

## Free Public Tracking Relay

The app keeps recruiter data and Gmail tokens local. Real email tracking still needs a public HTTPS URL because recipients cannot load `localhost`.

The relay in `apps/relay` is intentionally tiny:

- It accepts public `/t/open/<trackingId>.gif` requests.
- It accepts public `/t/click/<trackingId>?url=...` requests and redirects.
- It exposes `/sync/events` protected by `RELAY_SYNC_TOKEN`.
- It stores only opaque tracking IDs and event metadata, not recruiter names, emails, resumes, or Gmail tokens.

Deploy it on Cloudflare Workers free tier with KV:

```bash
npm install
npm run build -w @recruiter/relay
npx wrangler login
cd apps/relay
npx wrangler kv namespace create TRACKING_EVENTS
npx wrangler kv namespace create TRACKING_EVENTS --preview
```

Copy the returned `id` and `preview_id` into `apps/relay/wrangler.toml`, replacing the placeholder values.

Create a long random sync token and store it as a Worker secret:

```bash
npx wrangler secret put RELAY_SYNC_TOKEN
npx wrangler deploy
```

After deploy, Cloudflare prints a Worker URL like `https://recruiter-reachout-relay.<your-subdomain>.workers.dev`. Use that exact HTTPS URL locally:

```bash
PUBLIC_TRACKING_BASE_URL=https://recruiter-reachout-relay.<your-subdomain>.workers.dev
RELAY_SYNC_TOKEN=<same-token-you-put-in-wrangler>
```

Quick relay checks:

```bash
curl https://recruiter-reachout-relay.<your-subdomain>.workers.dev/health
curl -I https://recruiter-reachout-relay.<your-subdomain>.workers.dev/t/open/test-tracking-id.gif
curl -H "Authorization: Bearer <token>" https://recruiter-reachout-relay.<your-subdomain>.workers.dev/sync/events
```

The local dashboard/API can then sync those public relay events back into local SQLite using the same `RELAY_SYNC_TOKEN`.

## Gmail OAuth

Create a Google Cloud OAuth client and add this redirect URI:

```text
http://localhost:4000/api/gmail/callback
```

Then set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. In the dashboard, click **Connect Gmail** and complete the Google consent screen.

## Queue Policy

The app is designed for local intake of about 20 jobs/day and 15 recruiters/job:

- Intake cap: 300 candidates/day.
- Default send cap: 50 emails/day.
- Per-hour cap: 5 emails/hour.
- Per-company/domain cap: 5/day.
- High confidence emails can be scheduled.
- Medium confidence emails require draft/review.
- Low/blocked emails are not sent.
- Unsent candidates roll over to later days.

## Load The Extension

1. Run `npm run build -w @recruiter/extension`.
2. Open `chrome://extensions`.
3. Enable Developer Mode.
4. Click Load unpacked.
5. Select `apps/extension/dist`.

## Manual Validation Flow

1. Start API and dashboard.
2. Open a LinkedIn recruiter profile or search result page.
3. Click the extension and collect visible recruiters.
4. Save selected candidates.
5. Open the dashboard and confirm the candidate data.
6. Paste your fixed email content and upload your resume PDF.
7. Enter the company email domain and generate guesses.
8. Pick the best email guess.
9. Preview the email and confirm `{firstName}` rendered correctly.
10. Create a draft payload, then use controlled send only after checking test accounts.
11. Sync tracking events from the relay after sending.

## Test Commands

```bash
npm run typecheck
npm test
```

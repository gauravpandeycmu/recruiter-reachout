# Recruiter Reachout

Local dashboard + API + Playwright worker for recruiter email outreach (Gmail + Streak). Optional Chrome capture extension.

**New clone / agent setup:** read [`AGENTS.md`](AGENTS.md) then follow [`docs/SETUP.md`](docs/SETUP.md).  
**Product behavior after setup:** [`docs/PROJECT_HANDOFF.md`](docs/PROJECT_HANDOFF.md).

Secrets stay in a local `.env` (gitignored). Copy [`.env.example`](.env.example). Do not commit keys.

## Quick start

```bash
npm install
npx playwright install chromium
cp .env.example .env   # fill GEMINI_API_KEY, JOBRIGHT_JOB_URL, TEST_MODE_RECIPIENT_EMAIL
```

Install SalesQL, Apollo, and Streak in **Google Chrome**, then:

```bash
npm run install:streak -w @recruiter/worker
npm run dev:terminal    # macOS: opens Terminal.app so the stack is not killed with Cursor agent shells
```

- Dashboard: http://localhost:3000  
- API health: http://localhost:4000/health  
- Setup tab: Open login for Gmail, Jobright, LinkedIn; upload your resume PDF there

Full extension + login steps: [`docs/SETUP.md`](docs/SETUP.md).

```bash
npm run typecheck
npm test
```

## Free public tracking relay

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

After deploy, Cloudflare prints a Worker URL like `https://recruiter-reachout-relay.<your-subdomain>.workers.dev`. Put that URL and the same token in local `.env` as `PUBLIC_TRACKING_BASE_URL` and `RELAY_SYNC_TOKEN`.

## Gmail OAuth (optional)

Playwright Setup login is enough for sends. If you also want OAuth, create a Google Cloud OAuth client with redirect URI:

```text
http://localhost:4000/api/gmail/callback
```

Then set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`.

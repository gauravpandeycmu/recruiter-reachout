# Agent instructions (read first)

This file is for **setup only**. Read it and [`docs/SETUP.md`](docs/SETUP.md) before installing, editing `.env`, opening login browsers, or starting the app.

## Do not leak secrets

- Never commit `.env`, `client_secret*.json`, SQLite files, resumes, or Playwright profile dirs.
- Leave the owner’s **local** `.env` alone unless they asked you to edit it. GitHub copies must use `.env.example` with empty values.
- Do not print API keys in chat or logs.
- A clone’s first API boot creates an empty local SQLite file under `apps/api/data/` (gitignored). Do not copy someone else’s database into a fresh clone.

## Start the app so it stays up

Cursor agent shells get aborted. That kills `npm run dev` if you start it there.

On macOS or Windows, start the stack outside Cursor agent shells:

```bash
npm run dev:terminal
```

Then wait until `http://localhost:3000` and `http://localhost:4000/health` respond. Dashboard: `http://localhost:3000`.

Do not keep restarting API/worker from agent shells unless the user asked you to debug a crash.

## Setup checklist (in order)

Follow the numbered steps in [`docs/SETUP.md`](docs/SETUP.md). Short version:

1. `npm install` and `npx playwright install chromium`
2. Copy `.env.example` → `.env` and fill keys
3. Install Chrome extensions (SalesQL, Apollo, Streak) in **Google Chrome**
4. `npm run install:streak -w @recruiter/worker` (stop the worker first if Gmail profile is locked)
5. `npm run dev:terminal`
6. Setup tab → Open login for Gmail, Jobright, LinkedIn (sign in to SalesQL/Apollo in that LinkedIn window)
7. Upload a resume PDF in Setup (local only; not in git)
8. Keep `TEST_MODE=true` until the user is ready for real recruiter mail

Product behavior after setup: [`docs/PROJECT_HANDOFF.md`](docs/PROJECT_HANDOFF.md).

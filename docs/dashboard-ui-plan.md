# Dashboard UI rebuild — handoff plan

Written by Sonnet after a full pass over the codebase, for the next session (Fable) to execute the UI work without re-deriving context. Read this instead of re-exploring the repo.

## The flow this app supports (confirmed, already working end-to-end)

1. User searches LinkedIn (recruiter + company name) → gets a list of profiles.
2. User clicks the Chrome extension → **"Save all visible profiles"** button ([apps/extension/src/popup.tsx](../apps/extension/src/popup.tsx)) → parses the page ([apps/extension/src/parser.ts](../apps/extension/src/parser.ts)) → `POST /api/candidates/bulk` with `{ candidates, company }`. This already works, already dedupes against active/previously-contacted candidates. **Nothing to build here** — this is the "one button loads all LinkedIn profiles" step the user described.
3. Candidates land in the dashboard's "Current send list" panel ([apps/web/src/main.tsx](../apps/web/src/main.tsx)), already tagged with the company name from step 2.
4. Email discovery is **fully automatic and already running**: `apps/worker` polls `GET /api/automation/next-discovery`, drives real browser automation against **Jobright first, SalesQL as fallback** ([apps/worker/src/discoveryChain.ts](../apps/worker/src/discoveryChain.ts)), and reports back via `POST /api/candidates/:id/email-discovered` → `recordDiscoveryResult` ([apps/api/src/services.ts:409](../apps/api/src/services.ts)), which sets `candidate.email` directly. SalesQL has a monthly quota gate. **This is "job[right] and salesql, the thing we've implemented"** — it is the only email-finding system now; nothing else should touch `candidate.email` before send.
5. User adds sample emails (voice library) and optionally a job description, then generates personalized content per company via Gemini Flash ([apps/api/src/personalization.ts](../apps/api/src/personalization.ts) — just rewritten this session, see below).
6. User hits **Send** / **Send all** → `sendCandidate` ([apps/api/src/services.ts:617](../apps/api/src/services.ts)) renders the email, checks `sendGate.ts`/`scheduler.ts` pacing caps (daily/hourly/per-domain limits — **already implemented**, this is the "don't get blocked" mechanism the user wants, no changes needed), and sends via Gmail.

## What was just removed this session (dead code — don't go looking for it, don't try to "restore" it)

The old "enrichment / pattern-guessing" system predates the Jobright/SalesQL worker and was never fully wired to anything real (`ENRICHMENT_API_URL` was never configured — it's not even in the README's env var list). It overlapped confusingly with the real discovery pipeline and was actively **breaking the Send flow** (the UI called `enrichCandidate()` — which always threw "GEMINI... not configured"-style errors — right before every send). Deleted:

- `apps/api/src/enrichment.ts`, `apps/api/src/patternDiscovery.ts` (full files, deleted)
- `verifyCandidateEmails`, `validateRecruiterName`, MX-based pattern scoring from `apps/api/src/verification.ts` (file now only keeps `createSuppression`/`learnFromBounce`, which the real bounce-handling pipeline in `bounces.ts` still needs — left untouched)
- `guessEmails`, `selectedEmailForGuesses`, `enrichCandidate`, the `hasMx` helper from `apps/api/src/services.ts`
- Routes `POST /api/candidates/:id/enrich`, `POST /api/candidates/:id/guess-email`, `POST /api/patterns/discover`, `GET /api/patterns/:domain` from `server.ts`
- Client functions `enrichCandidate`, `guessEmail`, `discoverPatterns` from `apps/web/src/api.ts`
- The "Enrich email" / "Enrich emails for all" buttons everywhere in `main.tsx`, and the pre-send `enrichCandidate()` calls in `runSend`/`runSendAll` (these were dead-end calls that could only fail)
- Corresponding dead tests (`enrichment.test.ts`, `patternDiscovery.test.ts`, `verification.test.ts`, one `services.test.ts` case)

Typecheck and full test suite pass after removal (all workspaces green). `EmailGuess`/`EmailPattern`/`CompanyEmailPattern` **types** in `@recruiter/shared` were intentionally kept — the real discovery pipeline still emits a guess-shaped record with `pattern: "api_verified"` for display, and bounce handling still downgrades company patterns.

## What was just rebuilt this session (personalization — already done, no action needed unless quality tuning is wanted)

`apps/api/src/personalization.ts` now takes `{ company, samples, companyFact?, roleTitle?, jobDescription? }`. Single Gemini Flash call with a structured prompt (voice-matching rules from the user's own samples, hard length/tone rules, banned-AI-phrase list), then a deterministic validator (`validateGeneratedEmail`) checks the output for a dropped `{firstName}` token, length, banned phrases, and leftover `[placeholder]` text. Only if a rule is broken does a second "repair" Gemini call run (fix-only, same voice) — so clean output costs one call, broken output costs two, and a critic/second-agent is not needed. Wired through `apps/api/src/services.ts:288` (`generateContentForCompany`), `server.ts:254`, `apps/web/src/api.ts` (`generateCompanyContent`), and the dashboard already has inputs for role title and a paste-the-JD textarea.

**This part is not clutter and should stay as-is.** The UI work below is about *where* these inputs live, not changing what they do.

## The actual UI problem to fix

`apps/web/src/main.tsx` is one 700-line component with ~11 flat `.panel` cards in a CSS grid ([styles.css:36](../apps/web/src/styles.css)), all given equal visual weight, in roughly the order they were built rather than the order the user actually acts on them. Specific pain points to solve — **how** to solve them is Fable's call, not prescribed here:

1. **The personalization inputs are disconnected from the candidate list they apply to.** The user has to re-type a company name into a separate "Generate content for company" text box even though the company is already known — it's sitting right there tagged on every candidate the extension just imported two panels up. Typing it again is pure friction and the kind of thing that makes the page feel cluttered rather than like one flow.
2. **No sense of "here's today's batch, act on it."** Candidates, the job-description/personalization step, and the send action are three separate cards with no visual line connecting "these candidates" → "this generated email" → "send to these candidates." A user landing on the page cold shouldn't have to hunt across the grid to figure out what to do next.
3. **Equal visual weight for a rarely-touched action (adding sample emails) and the core repeated action (generate + send for today's batch).** Samples get added once in a while to build the voice library; batch send happens every session. The layout doesn't reflect that difference in frequency/importance at all.
4. **History/reporting panels (backlog scheduler, backlog-by-company, outreach history) compete for the same space as the live action panels**, even though they're look-back/reference material, not something the user is manipulating each session.
5. **Now that the dead enrichment/guessing code is gone** (see above), there's no more "Enrich" step in the middle of the flow — candidates arrive from the extension already tagged with company, and email discovery now happens entirely in the background via Jobright/SalesQL. The UI's copy and layout still assumes a manual enrich step existed; it doesn't anymore, and the flow is simpler than the current panel count suggests.

Constraints Fable should design within (not layout prescriptions, just facts about the data/actions that any design has to account for):
- Candidates already carry `.company` from capture — a good design would never make the user retype it.
- `generateCompanyContent(company, { jobDescription, roleTitle, companyFact })` is the one call that produces personalized content; only `company` and (optionally) `jobDescription` matter in practice — `roleTitle`/`companyFact` are minor, secondary inputs.
- Email discovery is async and backgrounded (the worker fills in `candidate.email` over time) — the UI should communicate "waiting on discovery" vs "ready to send" per candidate without requiring a manual trigger.
- Sample-email management (the voice library) is cross-company and low-frequency — it doesn't need to live next to the batch-specific controls.
- Gmail connect, resume upload, and the Google/Bing search-link generator ("Company queue") are setup/pre-capture concerns, not part of the repeating generate → send loop.
- Backlog/history tables are reporting, not action surfaces.

Feel free to reach for real visual hierarchy (primary vs. secondary panels, tabs, collapsible sections, whatever reads best) rather than another flat grid of same-sized cards — the current design's biggest failure is treating everything as equally important.

### Decided: dashboard-only, no extension change

User confirmed the extension popup does **not** need a job-description field. JD entry lives only in the dashboard, wherever Fable's design puts it. Don't touch `apps/extension/src/popup.tsx` or the `/api/candidates/bulk` payload for this — no cross-app change needed.

## File map for the session that does this work

- `apps/web/src/main.tsx` — the whole dashboard, needs restructuring
- `apps/web/src/api.ts` — client already has everything needed (`generateCompanyContent`, `addEmailSample`/`listEmailSamples`/`removeEmailSample`, `sendCandidate`, `nextDiscoveryCandidate`); no new endpoints required
- `apps/web/src/styles.css` — flat `.panel`/`.grid` today, free to redesign
- `apps/extension/src/popup.tsx` — out of scope for this pass, don't touch

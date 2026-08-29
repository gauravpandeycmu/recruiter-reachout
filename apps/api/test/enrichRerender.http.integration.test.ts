import { afterEach, describe, expect, it } from "vitest";
import { seedReady, startHttpApp, type HttpApp } from "./helpers/httpApp.js";
import { scheduleSends, updatePendingSendJobContent } from "../src/services.js";
import { createLinkedInProfileEnrichJob } from "../src/linkedinProfileEnrichJobs.js";

describe("linkedin enrich re-renders a pending send job's greeting", () => {
  let app: HttpApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("refreshes a scheduled send from 'Hi Recruiter' to the real name when enrich fills it in", async () => {
    app = await startHttpApp();

    // A person captured with only a placeholder name ("Recruiter") but a known
    // email — reachable when SalesQL finds the address before the LinkedIn
    // profile enrich pass fills the real name.
    const person = seedReady(app, "Recruiter", "Acme", "person@acme.com");

    // Schedule their send now, while the name is still the placeholder: the
    // pending job's rendered greeting freezes as "Hi Recruiter,".
    const scheduled = await scheduleSends(app.store, {
      candidateIds: [person.id],
      startAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      intervalMinutes: 12,
      mode: "schedule",
    });
    const jobId = scheduled.jobs[0]?.id ?? "";
    expect(jobId).not.toBe("");
    expect(app.store.getSendJob(jobId)?.textBody).toContain("Hi Recruiter,");
    expect(app.store.getSendJob(jobId)?.subject).toContain("Recruiter");

    // The enrich pass later resolves the real name for this candidate.
    const enrichJob = createLinkedInProfileEnrichJob(app.store, {
      candidateId: person.id,
      linkedinUrl: "https://www.linkedin.com/in/real-name-enrich",
    });
    const result = await app.fetchJson(
      `/api/automation/linkedin-profile-enrich-result/${enrichJob.id}`,
      {
        method: "POST",
        body: JSON.stringify({ success: true, fullName: "Jordan Lee" }),
        expectStatus: 200,
      },
    );
    expect(result.status).toBe(200);

    // Candidate name updated AND the still-pending send job re-rendered so the
    // recruiter is greeted by their real name, not the placeholder.
    const candidate = app.store.listCandidates().find((c) => c.id === person.id);
    expect(candidate?.fullName).toBe("Jordan Lee");
    const refreshed = app.store.getSendJob(jobId);
    expect(refreshed?.status).toBe("pending");
    expect(refreshed?.textBody).toContain("Hi Jordan,");
    expect(refreshed?.textBody).not.toContain("Hi Recruiter,");
    expect(refreshed?.subject).toContain("Jordan");
    expect(refreshed?.subject).not.toContain("Recruiter");
  });

  it("applies the real name (and re-renders the greeting) even when the enrich FAILS on the photo", async () => {
    app = await startHttpApp();

    // LinkedIn enrich commonly finds the person's name (page H1) but no
    // scrape-able profile photo (private/limited profile, or the scraper
    // refusing a generic/viewer avatar). The worker then reports success:false
    // WITH fullName set. The name must still land over the placeholder — and the
    // already-scheduled send must stop greeting "Hi Recruiter,".
    const person = seedReady(app, "Recruiter", "Acme", "nophoto@acme.com");
    const scheduled = await scheduleSends(app.store, {
      candidateIds: [person.id],
      startAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      intervalMinutes: 12,
      mode: "schedule",
    });
    const jobId = scheduled.jobs[0]?.id ?? "";
    expect(app.store.getSendJob(jobId)?.textBody).toContain("Hi Recruiter,");

    const enrichJob = createLinkedInProfileEnrichJob(app.store, {
      candidateId: person.id,
      linkedinUrl: "https://www.linkedin.com/in/no-photo-enrich",
    });
    const result = await app.fetchJson(
      `/api/automation/linkedin-profile-enrich-result/${enrichJob.id}`,
      {
        method: "POST",
        // Photo lookup failed, but the scraper still returned the real name.
        body: JSON.stringify({
          success: false,
          failureReason: "Could not find this person's profile photo on LinkedIn.",
          fullName: "Jordan Lee",
        }),
        expectStatus: 200,
      },
    );
    expect(result.status).toBe(200);

    // Name applied over the placeholder despite the photo miss...
    const candidate = app.store.listCandidates().find((c) => c.id === person.id);
    expect(candidate?.fullName).toBe("Jordan Lee");
    // ...and no phantom photo was set from a failed enrich.
    expect(candidate?.profilePhotoUrl).toBeFalsy();
    // ...and the pending send greeting was refreshed to the real name.
    const refreshed = app.store.getSendJob(jobId);
    expect(refreshed?.status).toBe("pending");
    expect(refreshed?.textBody).toContain("Hi Jordan,");
    expect(refreshed?.textBody).not.toContain("Hi Recruiter,");
    // The enrich job itself is still recorded as failed.
    expect(app.store.getLinkedInProfileEnrichJob(enrichJob.id)?.status).toBe("failed");
  });

  it("leaves an already-sent/non-pending job untouched when enrich lands late", async () => {
    app = await startHttpApp();
    const person = seedReady(app, "Recruiter", "Acme", "late@acme.com");
    const scheduled = await scheduleSends(app.store, {
      candidateIds: [person.id],
      startAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      intervalMinutes: 12,
      mode: "schedule",
    });
    const jobId = scheduled.jobs[0]?.id ?? "";
    // The send already went out before enrich resolved — mark it completed.
    const job = app.store.getSendJob(jobId)!;
    app.store.upsertSendJob({ ...job, status: "completed", updatedAt: new Date().toISOString() });
    const sentBody = app.store.getSendJob(jobId)?.textBody;

    const enrichJob = createLinkedInProfileEnrichJob(app.store, {
      candidateId: person.id,
      linkedinUrl: "https://www.linkedin.com/in/late-name-enrich",
    });
    await app.fetchJson(`/api/automation/linkedin-profile-enrich-result/${enrichJob.id}`, {
      method: "POST",
      body: JSON.stringify({ success: true, fullName: "Jordan Lee" }),
      expectStatus: 200,
    });

    // The completed job's frozen body must not be rewritten (it reflects what
    // was actually sent). Only the candidate name gets updated.
    expect(app.store.getSendJob(jobId)?.textBody).toBe(sentBody);
    expect(app.store.getSendJob(jobId)?.textBody).toContain("Hi Recruiter,");
    expect(app.store.listCandidates().find((c) => c.id === person.id)?.fullName).toBe("Jordan Lee");
  });

  it("only re-renders the enriched candidate — a co-scheduled colleague's edited copy is untouched", async () => {
    app = await startHttpApp();
    // Two people at the same company: one placeholder-name person about to be
    // enriched, and a colleague whose pending send the user hand-edited.
    const target = seedReady(app, "Recruiter", "Acme", "target@acme.com");
    const colleague = seedReady(app, "Dana Ruiz", "Acme", "dana@acme.com");
    const scheduled = await scheduleSends(app.store, {
      candidateIds: [target.id, colleague.id],
      startAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      intervalMinutes: 12,
      mode: "schedule",
    });
    const colleagueJobId = scheduled.jobs.find((j) => j.candidateId === colleague.id)?.id ?? "";
    expect(colleagueJobId).not.toBe("");
    // Colleague's copy is hand-edited to something the template would never produce.
    await updatePendingSendJobContent(app.store, colleagueJobId, {
      subject: "Custom subject for Dana only",
      body: "Handwritten note just for Dana — do not touch.",
    });
    const colleagueBefore = app.store.getSendJob(colleagueJobId)?.textBody;
    const colleagueSubjectBefore = app.store.getSendJob(colleagueJobId)?.subject;

    const enrichJob = createLinkedInProfileEnrichJob(app.store, {
      candidateId: target.id,
      linkedinUrl: "https://www.linkedin.com/in/target-enrich",
    });
    await app.fetchJson(`/api/automation/linkedin-profile-enrich-result/${enrichJob.id}`, {
      method: "POST",
      body: JSON.stringify({ success: true, fullName: "Jordan Lee" }),
      expectStatus: 200,
    });

    // Colleague's hand-edited job must be byte-for-byte untouched.
    expect(app.store.getSendJob(colleagueJobId)?.textBody).toBe(colleagueBefore);
    expect(app.store.getSendJob(colleagueJobId)?.subject).toBe(colleagueSubjectBefore);
    expect(colleagueBefore).toContain("Handwritten note just for Dana");
  });

  it("does NOT overwrite a real (non-placeholder) name when enrich returns a different one", async () => {
    app = await startHttpApp();
    // The user captured / typed a genuine name that is neither "Recruiter" nor an
    // email-derived guess. A later enrich scraping a differently-formatted name
    // ("Robert Smith Jr") must NOT clobber the name the user actually chose — the
    // placeholder guard (looksPlaceholder) is what protects it.
    const person = seedReady(app, "Bob Smith", "Acme", "bsmith@acme.com");
    const enrichJob = createLinkedInProfileEnrichJob(app.store, {
      candidateId: person.id,
      linkedinUrl: "https://www.linkedin.com/in/bob-smith-real",
    });
    await app.fetchJson(`/api/automation/linkedin-profile-enrich-result/${enrichJob.id}`, {
      method: "POST",
      body: JSON.stringify({ success: true, fullName: "Robert Smith Jr" }),
      expectStatus: 200,
    });
    // Name untouched — enrich only upgrades placeholders, never a chosen name.
    expect(app.store.listCandidates().find((c) => c.id === person.id)?.fullName).toBe("Bob Smith");
  });

  it("upgrades an email-DERIVED placeholder name (not literally 'Recruiter') to the enriched name", async () => {
    app = await startHttpApp();
    // Manual-add / search-card intake derives a placeholder name straight from the
    // email local part ("d.wong@acme.com" -> "D Wong", greeting "Hi D,"). That name
    // is a guess, so enrich finding the real "Diane Wong" must replace it AND
    // re-render the already-scheduled greeting — the third looksPlaceholder arm
    // (existing.fullName === guessFullNameFromEmail(existing.email)).
    const person = seedReady(app, "D Wong", "Acme", "d.wong@acme.com");
    const scheduled = await scheduleSends(app.store, {
      candidateIds: [person.id],
      startAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      intervalMinutes: 12,
      mode: "schedule",
    });
    const jobId = scheduled.jobs[0]?.id ?? "";
    expect(jobId).not.toBe("");
    expect(app.store.getSendJob(jobId)?.textBody).toContain("Hi D,");

    const enrichJob = createLinkedInProfileEnrichJob(app.store, {
      candidateId: person.id,
      linkedinUrl: "https://www.linkedin.com/in/diane-wong",
    });
    await app.fetchJson(`/api/automation/linkedin-profile-enrich-result/${enrichJob.id}`, {
      method: "POST",
      body: JSON.stringify({ success: true, fullName: "Diane Wong" }),
      expectStatus: 200,
    });

    const candidate = app.store.listCandidates().find((c) => c.id === person.id);
    expect(candidate?.fullName).toBe("Diane Wong");
    expect(candidate?.firstName).toBe("Diane");
    const refreshed = app.store.getSendJob(jobId);
    expect(refreshed?.textBody).toContain("Hi Diane,");
    expect(refreshed?.textBody).not.toContain("Hi D,");
  });
});

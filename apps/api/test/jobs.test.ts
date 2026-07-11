import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assignCandidateToJob, createCandidate, createJob } from "../src/services.js";
import { Store } from "../src/store.js";

describe("job assignment", () => {
  it("creates jobs and assigns candidates to them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    const job = store.upsertJob(createJob({ companyName: "Example", roleTitle: "SWE" }));
    const candidate = store.upsertCandidate(createCandidate({ fullName: "Jane Doe", email: "jane@example.com" }));

    await expect(assignCandidateToJob(store, candidate.id, job.id)).resolves.toMatchObject({
      id: candidate.id,
      jobId: job.id,
    });
    await expect(assignCandidateToJob(store, candidate.id, "missing")).rejects.toThrow("Job not found");

    store.close();
    await rm(directory, { recursive: true, force: true });
  });
});

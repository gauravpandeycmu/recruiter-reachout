import type { Page } from "playwright";
import type { LinkedInProfileEnrichJob } from "@recruiter/shared";
import type { WorkerApiClient } from "./apiClient.js";
import { scrapeLinkedInProfilePage } from "./linkedinProfileScrape.js";

export interface LinkedInProfileEnrichPassResult {
  result: "worked" | "idle";
  job?: LinkedInProfileEnrichJob;
}

export async function runLinkedInProfileEnrichPass(input: {
  apiClient: WorkerApiClient;
  page: Page;
  log: (message: string) => void;
}): Promise<LinkedInProfileEnrichPassResult> {
  const job = await input.apiClient.fetchNextLinkedInProfileEnrichJob();
  if (!job) {
    return { result: "idle" };
  }

  input.log(`Enriching LinkedIn profile for candidate ${job.candidateId}…`);
  await input.apiClient
    .reportWorkerStatus({
      phase: "capturing",
      message: "Fetching LinkedIn profile photo…",
      candidateId: job.candidateId,
    })
    .catch(() => undefined);

  try {
    const scraped = await scrapeLinkedInProfilePage(input.page, job.linkedinUrl);
    if (!scraped.profilePhotoUrl) {
      await input.apiClient.reportLinkedInProfileEnrichResult(job.id, {
        success: false,
        failureReason: "Could not find this person's profile photo on LinkedIn (avoided generic/viewer avatars).",
        fullName: scraped.fullName,
      });
      input.log(`Profile enrich failed for ${job.candidateId}: no subject photo.`);
      return { result: "worked", job };
    }
    if (!/profile-displayphoto|\/dms\/image\//i.test(scraped.profilePhotoUrl)) {
      await input.apiClient.reportLinkedInProfileEnrichResult(job.id, {
        success: false,
        failureReason: "Scraped image did not look like a LinkedIn profile photo.",
        fullName: scraped.fullName,
      });
      return { result: "worked", job };
    }
    await input.apiClient.reportLinkedInProfileEnrichResult(job.id, {
      success: true,
      profilePhotoUrl: scraped.profilePhotoUrl,
      fullName: scraped.fullName,
    });
    input.log(
      `Profile enrich ok for ${job.candidateId}: photo=${Boolean(scraped.profilePhotoUrl)} name=${scraped.fullName ?? "—"}`,
    );
    return { result: "worked", job };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await input.apiClient.reportLinkedInProfileEnrichResult(job.id, {
      success: false,
      failureReason: message,
    });
    input.log(`Profile enrich failed for ${job.candidateId}: ${message}`);
    return { result: "worked", job };
  }
}

import type { Page } from "playwright";
import type { LinkedInCaptureJob } from "@recruiter/shared";
import type { WorkerApiClient } from "./apiClient.js";
import { captureCompanyRecruiters } from "./linkedinSearchCapture.js";

export interface LinkedInCapturePassResult {
  result: "worked" | "idle";
  job?: LinkedInCaptureJob;
}

export async function runLinkedInCapturePass(input: {
  apiClient: WorkerApiClient;
  page: Page;
  log: (message: string) => void;
}): Promise<LinkedInCapturePassResult> {
  const job = await input.apiClient.fetchNextLinkedInCaptureJob();
  if (!job) {
    return { result: "idle" };
  }

  input.log(`Capturing LinkedIn recruiters for ${job.companyName} (${job.pages} page(s))…`);
  await input.apiClient
    .reportWorkerStatus({
      phase: "capturing",
      message: `Finding ${job.companyName} recruiters on LinkedIn…`,
    })
    .catch(() => undefined);

  try {
    const profiles = await captureCompanyRecruiters(input.page, {
      companyName: job.companyName,
      pages: job.pages,
      log: input.log,
    });
    if (profiles.length === 0) {
      await input.apiClient.reportLinkedInCaptureResult(job.id, {
        success: false,
        failureReason: "No profiles found on LinkedIn search pages. Check login or try another company spelling.",
      });
      input.log(`Capture for ${job.companyName} found 0 profiles.`);
      return { result: "worked", job };
    }

    const reported = await input.apiClient.reportLinkedInCaptureResult(job.id, {
      success: true,
      candidates: profiles.map((profile) => ({
        fullName: profile.fullName,
        firstName: profile.firstName,
        title: profile.title,
        location: profile.location,
        linkedinUrl: profile.linkedinUrl,
        profilePhotoUrl: profile.profilePhotoUrl,
        company: job.companyName,
      })),
    });
    input.log(
      `Capture for ${job.companyName}: saved ${reported.savedCount ?? 0}, skipped ${reported.skippedCount ?? 0}.`,
    );
    await input.apiClient
      .reportWorkerStatus({
        phase: "idle",
        message: `Imported ${reported.savedCount ?? 0} ${job.companyName} recruiter(s).`,
      })
      .catch(() => undefined);
    return { result: "worked", job };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await input.apiClient.reportLinkedInCaptureResult(job.id, {
      success: false,
      failureReason: message,
    });
    await input.apiClient
      .reportWorkerStatus({
        phase: "error",
        message: `LinkedIn capture failed: ${message}`,
      })
      .catch(() => undefined);
    input.log(`Capture failed for ${job.companyName}: ${message}`);
    return { result: "worked", job };
  }
}

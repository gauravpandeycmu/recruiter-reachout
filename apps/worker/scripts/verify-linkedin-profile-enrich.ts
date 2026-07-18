/**
 * Verify LinkedIn profile photo enrich against known SeatGeek photos in the live store.
 *
 * Usage: npx tsx apps/worker/scripts/verify-linkedin-profile-enrich.ts
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { findRepoRoot } from "../src/paths.js";
import { scrapeLinkedInProfilePage } from "../src/linkedinProfileScrape.js";

const API = (process.env.WORKER_API_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");
const OUT = resolve(findRepoRoot(), "apps/worker/data/photo-verify");

function assetKey(url: string): string {
  const match = url.match(/\/(AQ[A-Za-z0-9_-]{8,})/);
  if (match?.[1]) {
    return match[1];
  }
  return createHash("sha1").update(url.split("?")[0] ?? url).digest("hex").slice(0, 16);
}

async function download(url: string): Promise<Buffer | undefined> {
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        referer: "https://www.linkedin.com/",
      },
    });
    if (!response.ok) {
      return undefined;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return undefined;
  }
}

function bytesFingerprint(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const state = (await (await fetch(`${API}/api/state`)).json()) as {
    upcomingSends?: Array<{
      fullName: string;
      company?: string;
      email?: string;
      candidateId: string;
      linkedinUrl?: string;
      profilePhotoUrl?: string;
    }>;
  };
  const samples = (state.upcomingSends ?? [])
    .filter((row) => /seatgeek/i.test(row.company ?? "") && row.linkedinUrl && row.profilePhotoUrl)
    .slice(0, 3);

  if (samples.length === 0) {
    throw new Error("No SeatGeek upcoming people with LinkedIn + photo to verify against.");
  }

  const salesqlDir = resolve(findRepoRoot(), "apps/worker/data/salesql-profile");
  const context = await chromium.launchPersistentContext(salesqlDir, {
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = context.pages()[0] ?? (await context.newPage());

  const results: Array<Record<string, unknown>> = [];
  try {
    for (const sample of samples) {
      console.log(`\n=== ${sample.fullName} ===`);
      console.log(`DB photo: ${sample.profilePhotoUrl}`);
      const scraped = await scrapeLinkedInProfilePage(page, sample.linkedinUrl!);
      console.log(`Scraped:  ${scraped.profilePhotoUrl ?? "(none)"} name=${scraped.fullName ?? "(none)"}`);

      const dbKey = assetKey(sample.profilePhotoUrl!);
      const scrapedKey = scraped.profilePhotoUrl ? assetKey(scraped.profilePhotoUrl) : "";
      const keyMatch = Boolean(scrapedKey && dbKey && scrapedKey === dbKey);

      const [dbBytes, scrapedBytes] = await Promise.all([
        download(sample.profilePhotoUrl!),
        scraped.profilePhotoUrl ? download(scraped.profilePhotoUrl) : Promise.resolve(undefined),
      ]);
      if (dbBytes) {
        writeFileSync(resolve(OUT, `${sample.fullName.replace(/\s+/g, "_")}-db.jpg`), dbBytes);
      }
      if (scrapedBytes) {
        writeFileSync(resolve(OUT, `${sample.fullName.replace(/\s+/g, "_")}-scraped.jpg`), scrapedBytes);
      }
      const byteMatch =
        Boolean(dbBytes && scrapedBytes) && bytesFingerprint(dbBytes!) === bytesFingerprint(scrapedBytes!);

      const ok = keyMatch || byteMatch;
      console.log(`assetKey db=${dbKey} scraped=${scrapedKey || "—"} match=${keyMatch}`);
      console.log(
        `bytes db=${dbBytes ? bytesFingerprint(dbBytes) : "—"} scraped=${scrapedBytes ? bytesFingerprint(scrapedBytes) : "—"} match=${byteMatch}`,
      );
      console.log(ok ? "PASS" : "FAIL");
      results.push({
        name: sample.fullName,
        ok,
        keyMatch,
        byteMatch,
        dbKey,
        scrapedKey,
        scrapedName: scraped.fullName,
      });
    }
  } finally {
    await context.close();
  }

  const passed = results.filter((row) => row.ok).length;
  console.log(`\n${passed}/${results.length} photo matches`);
  if (passed === 0) {
    process.exitCode = 1;
  }

  // E2E enrich for Maggie (missing photo) via API + worker claim path
  const maggie = (state.upcomingSends ?? []).find(
    (row) => /maggie orem/i.test(row.fullName) && row.linkedinUrl && !row.profilePhotoUrl,
  );
  if (maggie) {
    console.log(`\nQueuing enrich for Maggie (${maggie.candidateId})…`);
    const create = await fetch(`${API}/api/automation/linkedin-profile-enrich`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidateId: maggie.candidateId, linkedinUrl: maggie.linkedinUrl }),
    });
    console.log("enqueue", create.status, await create.text());
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

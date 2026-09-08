/** Safe manual smoke check: opens compose, reads availability, closes it, never types or sends. */
import "../src/loadEnv.js";
import { closePersistentBrowserContext, launchPersistentBrowserContext } from "../src/browserContext.js";
import { processLinkedInMessageTask } from "../src/linkedinMessagingPass.js";
import { resolveWorkerDataDir } from "../src/paths.js";

const linkedinUrl = process.argv[2]?.trim();
if (!linkedinUrl?.startsWith("https://www.linkedin.com/in/")) {
  throw new Error("Pass an absolute LinkedIn /in/ profile URL.");
}

const userDataDir = resolveWorkerDataDir(process.env.SALESQL_USER_DATA_DIR, "apps/worker/data/salesql-profile");
const context = await launchPersistentBrowserContext({ userDataDir, headless: true });
try {
  const page = context.pages()[0] ?? (await context.newPage());
  const result = await processLinkedInMessageTask(page, {
    id: "safe-manual-check",
    candidateId: "safe-manual-check",
    linkedinUrl,
    action: "check",
    createdAt: new Date().toISOString(),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await closePersistentBrowserContext(context, userDataDir);
}

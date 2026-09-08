/** Manual smoke test: fills compose and attaches a resume, but never clicks Send. */
import "../src/loadEnv.js";
import { closePersistentBrowserContext, launchPersistentBrowserContext } from "../src/browserContext.js";
import { processLinkedInMessageTask } from "../src/linkedinMessagingPass.js";
import { resolveWorkerDataDir } from "../src/paths.js";

const [linkedinUrl, resumePath] = process.argv.slice(2);
if (!linkedinUrl?.startsWith("https://www.linkedin.com/in/")) throw new Error("Pass a LinkedIn /in/ URL.");
if (!resumePath) throw new Error("Pass a resume PDF path.");

const userDataDir = resolveWorkerDataDir(process.env.SALESQL_USER_DATA_DIR, "apps/worker/data/salesql-profile");
const context = await launchPersistentBrowserContext({ userDataDir, headless: true });
try {
  const page = context.pages()[0] ?? (await context.newPage());
  const result = await processLinkedInMessageTask(page, {
    id: "safe-manual-prepare",
    candidateId: "safe-manual-prepare",
    linkedinUrl,
    action: "prepare",
    subject: "Draft test - do not send",
    message: "Hi Elona,\n\nThis is a local draft-fill test. It will not be sent.",
    resumePath,
    resumeFileName: "resume.pdf",
    createdAt: new Date().toISOString(),
  });
  const dialog = page.locator('[role="dialog"]').last();
  const bodyText = await dialog.locator('[contenteditable="true"][role="textbox"], textarea[placeholder*="message" i]').first().textContent().catch(() => "");
  const attachmentVisible = await dialog.getByText(/\.pdf/i).first().isVisible({ timeout: 5_000 }).catch(() => false);
  process.stdout.write(`${JSON.stringify({ ...result, bodyFilled: /local draft-fill test/i.test(bodyText ?? ""), attachmentVisible })}\n`);
} finally {
  await closePersistentBrowserContext(context, userDataDir);
}

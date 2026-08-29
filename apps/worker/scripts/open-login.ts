/**
 * Opens a headed Chromium window for one-time login.
 * Usage: npx tsx scripts/open-login.ts gmail|jobright|linkedin
 *
 * LinkedIn loads SalesQL + Apollo so you can sign into those sidebars.
 * Stop the worker first if it already holds this profile lock.
 */
import "../src/loadEnv.js";
import {
  closePersistentBrowserContext,
  launchPersistentBrowserContext,
  prepareChromiumUserDataDir,
} from "../src/browserContext.js";
import { loginUrlFor, profileDirFor } from "../src/setupSessions.js";
import { tryPrepareStreakExtension, waitForStreakServiceWorker } from "../src/streakExtension.js";
import { waitForSalesqlServiceWorker } from "../src/salesqlExtension.js";
import { waitForApolloServiceWorker } from "../src/apolloExtension.js";
import { resolveLinkedInOverlayExtensions } from "../src/linkedinOverlayExtensions.js";

const kind = (process.argv[2] ?? "gmail") as "gmail" | "jobright" | "linkedin";

async function main(): Promise<void> {
  const profileDir = profileDirFor(kind);
  const streakPath = kind === "gmail" ? tryPrepareStreakExtension(process.env.STREAK_EXTENSION_PATH) : undefined;
  const overlay = kind === "linkedin" ? resolveLinkedInOverlayExtensions() : { salesqlPath: undefined, apolloPath: undefined, paths: [] };
  const extensionPaths = kind === "gmail" ? (streakPath ? [streakPath] : undefined) : kind === "linkedin" ? overlay.paths : undefined;

  console.log(`Opening ${kind} login browser (headed)…`);
  console.log(`Profile: ${profileDir}`);
  console.log(`URL: ${loginUrlFor(kind)}`);
  if (kind === "gmail" && !streakPath) {
    console.log("Note: Streak extension not found — Gmail login will still work; install Streak before sending.");
  }
  if (kind === "linkedin") {
    console.log(`SalesQL extension: ${overlay.salesqlPath ?? "not found"}`);
    console.log(`Apollo extension: ${overlay.apolloPath ?? "not found"}`);
  }

  prepareChromiumUserDataDir(profileDir);

  let context;
  try {
    context = await launchPersistentBrowserContext({
      userDataDir: profileDir,
      headless: false,
      extensionPaths,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/SingletonLock|ProcessSingleton|user data directory is already in use/i.test(message)) {
      throw new Error(
        `Profile already in use for ${kind}. Stop the worker (and any other Chromium using this profile), then try Open login browser again.`,
      );
    }
    throw error;
  }

  if (kind === "gmail" && streakPath) {
    await waitForStreakServiceWorker(context, 30000).catch(() => {
      console.log("Streak extension service worker still starting.");
    });
  }
  if (kind === "linkedin") {
    if (overlay.salesqlPath) {
      await waitForSalesqlServiceWorker(context, 30000).catch(() => {
        console.log("SalesQL service worker still starting.");
      });
    }
    if (overlay.apolloPath) {
      await waitForApolloServiceWorker(context, 30000).catch(() => {
        console.log("Apollo service worker still starting.");
      });
    }
  }

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(loginUrlFor(kind), { waitUntil: "domcontentloaded", timeout: 60000 });

  if (kind === "linkedin") {
    await page.waitForTimeout(4000);
    const apolloAuth = context.pages().find((item) => /apollo\.io/i.test(item.url()));
    if (apolloAuth && /onboarding|login|sign/i.test(apolloAuth.url())) {
      await apolloAuth.bringToFront();
      console.log("\nApollo is not signed in. Sign in on this Apollo tab, then close the window when LinkedIn + Apollo + SalesQL are ready.");
    }
  }

  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    await closePersistentBrowserContext(context, profileDir);
    process.exit(0);
  };

  // Keep process alive until the user closes the browser window.
  context.on("close", () => {
    void closePersistentBrowserContext(undefined, profileDir).finally(() => {
      if (!finished) {
        finished = true;
        process.exit(0);
      }
    });
  });
  process.on("SIGINT", () => {
    void finish();
  });
  process.on("SIGTERM", () => {
    void finish();
  });

  if (kind === "linkedin") {
    console.log("\nSign in to LinkedIn. Then open the SalesQL and Apollo sidebars and sign in there if asked. Close the browser window when done.");
  } else {
    console.log("\nSign in if prompted. Close the browser window when done.");
  }
  await new Promise(() => {});
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

/**
 * Fast cookie-based session probe for Setup → Refresh session status.
 * Outputs JSON to stdout. Does not navigate to Gmail/Jobright/LinkedIn.
 */
import "../src/loadEnv.js";
import { probeAllSessionsFast } from "../src/setupSessions.js";
import { tryPrepareStreakExtension } from "../src/streakExtension.js";

async function main(): Promise<void> {
  const streakPath = tryPrepareStreakExtension(process.env.STREAK_EXTENSION_PATH);
  const status = await probeAllSessionsFast({
    gmailExtensionPaths: streakPath ? [streakPath] : undefined,
  });

  if (!streakPath && status.gmail.ready) {
    status.gmail.message = `${status.gmail.message} (Streak not installed — install before sending.)`;
  }

  process.stdout.write(JSON.stringify(status));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message);
  process.exit(1);
});

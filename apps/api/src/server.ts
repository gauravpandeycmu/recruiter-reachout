import "./loadEnv.js";
import { audit, auditError, configureAuditLog } from "@recruiter/shared/auditLog";
import { createApiServer } from "./apiServer.js";
import { bindLlmUsageToStore } from "./llmUsage.js";
import {
  cleanupDeadPausedReserves,
  cleanupStalePausedDuplicates,
  healOrphanedScheduledSendJobs,
  rebalancePendingCompanyBlocks,
} from "./services.js";
import { Store } from "./store.js";
import { ensureWorkerRunningIfNeeded } from "./workerSupervisor.js";

const port = Number(process.env.PORT ?? 4000);
const WORKER_AMBIENT_CHECK_MS = Number(process.env.WORKER_AMBIENT_CHECK_MS ?? 60_000);
configureAuditLog({ source: "api" });
audit("api.starting", { port });

const store = new Store();

await store.load();
bindLlmUsageToStore(store);

// Heal corrupt schedules: drop History/cancel ghost pauses, superseded paused dupes,
// compact ~50m stretch / collisions, recreate only true missing-job orphans.
{
  const deadPaused = cleanupDeadPausedReserves(store);
  const cleaned = cleanupStalePausedDuplicates(store);
  const fixed = rebalancePendingCompanyBlocks(store);
  const healed = healOrphanedScheduledSendJobs(store);
  audit("api.startup_heal", {
    deadPausedCleared: deadPaused.cancelled,
    pausedCancelled: cleaned.cancelled,
    rebalanceShifted: fixed.shifted.length,
    orphansHealed: healed.healed,
    shiftedSample: fixed.shifted.slice(0, 8),
  });
  if (
    deadPaused.cancelled > 0 ||
    cleaned.cancelled > 0 ||
    fixed.shifted.length > 0 ||
    healed.healed > 0
  ) {
    await store.save();
  }
}

// Battery: only spawn the worker when there's an actual reason to (a send due
// soon, an in-progress send, or pending discovery/capture/enrich work) —
// every explicit action (schedule, Send-now, reschedule, a new discovery
// candidate, a new capture/enrich job) still force-wakes it directly via
// ensureWorkerRunning, unaffected by this ambient check.
void ensureWorkerRunningIfNeeded(store).catch((error) => {
  auditError("api.ensure_worker_failed", error);
});
setInterval(() => {
  void ensureWorkerRunningIfNeeded(store).catch((error) => {
    auditError("api.ensure_worker_failed", error);
  });
}, WORKER_AMBIENT_CHECK_MS);

const server = createApiServer(store);

server.listen(port, () => {
  audit("api.listening", { port, url: `http://localhost:${port}` });
  console.log(`Recruiter Reachout API running on http://localhost:${port}`);
});

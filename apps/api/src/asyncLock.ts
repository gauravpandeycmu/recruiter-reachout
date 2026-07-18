const queues = new Map<string, Promise<unknown>>();

/**
 * Serializes async work per key. Two calls with the same key never run their
 * bodies concurrently — the second waits for the first to settle (success or
 * failure) before starting. Used to close double-click/client-retry races on
 * send/schedule/reschedule, where two overlapping calls for the same
 * candidate could otherwise both pass validation and each create a real,
 * independently-sendable job.
 */
export function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const tail = queues.get(key) ?? Promise.resolve();
  const result = tail.then(fn, fn);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, settled);
  // Drop the entry once this is the last queued call for the key — otherwise
  // every distinct candidateId ever locked stays in the map for the life of
  // the process.
  settled.then(() => {
    if (queues.get(key) === settled) {
      queues.delete(key);
    }
  });
  return result;
}

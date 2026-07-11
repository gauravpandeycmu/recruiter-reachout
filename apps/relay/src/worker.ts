import { handleRelayRequest, KvRelayStore, type RelayKvNamespace } from "./relay.js";

export interface RelayWorkerEnv {
  TRACKING_EVENTS: RelayKvNamespace;
  RELAY_SYNC_TOKEN: string;
}

export default {
  async fetch(request: Request, env: RelayWorkerEnv): Promise<Response> {
    if (!env.TRACKING_EVENTS) {
      return json({ error: "TRACKING_EVENTS KV binding is missing." }, 500);
    }
    if (!env.RELAY_SYNC_TOKEN) {
      return json({ error: "RELAY_SYNC_TOKEN is missing." }, 500);
    }
    return handleRelayRequest(request, new KvRelayStore(env.TRACKING_EVENTS), env.RELAY_SYNC_TOKEN);
  },
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

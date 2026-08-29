import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiClient } from "../src/apiClient.js";

let server: Server;
let baseUrl: string;
let lastDiscoveredBody: unknown;
let nextDiscoveryCallCount = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;

      if (req.method === "GET" && req.url === "/api/automation/pending-work") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            hasInProgressSend: false,
            hasDiscovery: true,
            hasCapture: false,
            hasEnrich: false,
          }),
        );
        return;
      }
      if (req.method === "GET" && req.url === "/api/automation/next-discovery") {
        nextDiscoveryCallCount += 1;
        if (nextDiscoveryCallCount > 1) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "No candidates need discovery." }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "candidate-1", fullName: "Jane Doe" }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/automation/can-use-provider/salesql") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ provider: "salesql", monthKey: "2026-07", allowed: true, used: 0, limit: 50 }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/automation/can-use-provider/apollo") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ provider: "apollo", monthKey: "2026-07", allowed: true, used: 0, limit: 50 }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/candidates/candidate-1/email-discovered") {
        lastDiscoveredBody = body;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "candidate-1", email: "jane@example.com" }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/candidates/candidate-1/send") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ note: "Gmail message sent." }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/candidates/failing/send") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Daily send limit reached." }));
        return;
      }

      if (req.method === "POST" && req.url === "/api/automation/worker-status") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ...body,
            lastHeartbeatAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        );
        return;
      }
      if (req.method === "GET" && req.url === "/api/automation/discovery-settings") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ salesqlAutoFallback: false, updatedAt: new Date().toISOString() }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://localhost:${port}`;
});

afterAll(() => {
  server.close();
});

describe("worker apiClient", () => {
  it("fetches pending-work without claiming a discovery candidate", async () => {
    const client = createApiClient({ baseUrl });
    const before = nextDiscoveryCallCount;
    const pending = await client.fetchPendingWork();
    expect(pending).toMatchObject({
      hasDiscovery: true,
      hasInProgressSend: false,
      hasCapture: false,
      hasEnrich: false,
    });
    expect(nextDiscoveryCallCount).toBe(before);
  });

  it("fetches the next discovery candidate", async () => {
    const client = createApiClient({ baseUrl });
    const candidate = await client.fetchNextDiscoveryCandidate();
    expect(candidate).toMatchObject({ id: "candidate-1", fullName: "Jane Doe" });
  });

  it("returns undefined (rather than throwing) when there is nothing left to discover", async () => {
    const client = createApiClient({ baseUrl });
    const candidate = await client.fetchNextDiscoveryCandidate();
    expect(candidate).toBeUndefined();
  });

  it("posts discovery outcomes to the email-discovered endpoint", async () => {
    const client = createApiClient({ baseUrl });
    const updated = await client.reportDiscoveryResult("candidate-1", {
      status: "found",
      email: "jane@example.com",
      provider: "jobright",
    });

    expect(updated).toMatchObject({ id: "candidate-1", email: "jane@example.com" });
    expect(lastDiscoveredBody).toEqual({ status: "found", email: "jane@example.com", provider: "jobright" });
  });

  it("fetches provider quota status", async () => {
    const client = createApiClient({ baseUrl });
    const quota = await client.fetchCanUseProvider("salesql");
    expect(quota).toMatchObject({ provider: "salesql", allowed: true, limit: 50 });
    const apollo = await client.fetchCanUseProvider("apollo");
    expect(apollo).toMatchObject({ provider: "apollo", allowed: true, limit: 50 });
  });

  it("reports worker status heartbeats", async () => {
    const client = createApiClient({ baseUrl });
    const status = await client.reportWorkerStatus({
      phase: "looking_up",
      message: "Looking up Jane Doe via Jobright…",
      candidateId: "candidate-1",
      candidateName: "Jane Doe",
      provider: "jobright",
    });
    expect(status).toMatchObject({
      phase: "looking_up",
      message: "Looking up Jane Doe via Jobright…",
      candidateName: "Jane Doe",
    });
    expect(status.lastHeartbeatAt).toBeTruthy();
  });

  it("fetches discovery settings", async () => {
    const client = createApiClient({ baseUrl });
    const settings = await client.fetchDiscoverySettings();
    expect(settings.salesqlAutoFallback).toBe(false);
  });

  it("triggers a send and returns the response payload on success", async () => {
    const client = createApiClient({ baseUrl });
    const result = await client.triggerSend("candidate-1");
    expect(result).toEqual({ note: "Gmail message sent." });
  });

  it("throws the API's error message when triggering a send fails", async () => {
    const client = createApiClient({ baseUrl });
    await expect(client.triggerSend("failing")).rejects.toThrow("Daily send limit reached.");
  });
});

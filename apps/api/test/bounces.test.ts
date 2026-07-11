import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyBounce, parseBounceMessage, parseGmailMessageText } from "../src/bounces.js";
import { Store } from "../src/store.js";

describe("bounce parsing", () => {
  it("parses hard bounce samples", () => {
    const parsed = parseBounceMessage("Delivery failed for jane.doe@example.com 5.1.1 user unknown address not found");
    expect(parsed).toMatchObject({
      email: "jane.doe@example.com",
      domain: "example.com",
      statusCode: "5.1.1",
      kind: "hard",
    });
  });

  it("parses soft bounce samples", () => {
    expect(parseBounceMessage("Temporary failure for jane@example.com 4.2.2 mailbox full").kind).toBe("soft");
  });

  it("keeps unknown bounce text as needs review", () => {
    expect(parseBounceMessage("Something happened for jane@example.com").kind).toBe("unknown");
  });

  it("creates suppression and downgrades patterns for hard bounces idempotently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    store.upsertCompanyEmailPattern({
      domain: "example.com",
      pattern: "first.last",
      confidence: "high",
      bounceCount: 2,
      lastVerifiedAt: "now",
    });

    const parsed = parseBounceMessage("Delivery failed for jane.doe@example.com 5.1.1 user unknown");
    applyBounce(store, parsed, "message-1");
    applyBounce(store, parsed, "message-1");

    expect(store.listBounces()).toHaveLength(1);
    expect(store.listSuppressions()[0]).toMatchObject({ email: "jane.doe@example.com" });
    expect(store.listCompanyEmailPatterns()[0]?.confidence).toBe("blocked");

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("extracts text from Gmail payload bodies", () => {
    const text = Buffer.from("Hard bounce for jane@example.com").toString("base64url");
    expect(parseGmailMessageText({ payload: { body: { data: text } } })).toContain("jane@example.com");
  });
});

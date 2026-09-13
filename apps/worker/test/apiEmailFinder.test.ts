import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverEmailViaGetProspectApi,
  discoverEmailViaHunterApi,
  discoverEmailViaProspeoApi,
} from "../src/apiEmailFinder.js";

afterEach(() => vi.unstubAllGlobals());

describe("API email finders", () => {
  it("marks Prospeo unavailable after an explicit insufficient-credit response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "INSUFFICIENT_CREDITS" }), { status: 400 }),
      ),
    );

    await expect(discoverEmailViaProspeoApi("https://linkedin.com/in/person", "prospeo-key")).resolves.toEqual({
      status: "not_found",
      provider: "prospeo",
      creditSpent: false,
      providerUnavailableReason: "quota_exhausted",
    });
  });

  it("treats Prospeo NO_MATCH as a clean miss", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "NO_MATCH" }), { status: 400 })),
    );

    await expect(discoverEmailViaProspeoApi("https://linkedin.com/in/person", "prospeo-key")).resolves.toEqual({
      status: "not_found",
      provider: "prospeo",
      creditSpent: false,
    });
  });

  it("requests only a verified email from Prospeo", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ response: { email: "person@company.com" } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await discoverEmailViaProspeoApi("https://linkedin.com/in/person", "prospeo-key");
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      only_verified_email: true,
      data: { linkedin_url: "https://linkedin.com/in/person" },
    });
  });

  it("reads Prospeo's nested email object and prefers the tagged company over personal email", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            person: {
              personal_emails: ["person@gmail.com"],
              email: { status: "VERIFIED", revealed: true, email: "person@intercom.com" },
            },
            company: { name: "Intercom" },
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      discoverEmailViaProspeoApi("https://linkedin.com/in/person", "prospeo-key", "Intercom"),
    ).resolves.toEqual({
      status: "found",
      provider: "prospeo",
      email: "person@intercom.com",
      creditSpent: true,
    });
  });

  it("falls back to personal email and rejects previous-employer work email", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ person: { emails: ["person@old-company.com", "person@gmail.com"] } }),
          { status: 200 },
        ),
      ),
    );

    const result = await discoverEmailViaProspeoApi(
      "https://linkedin.com/in/person",
      "prospeo-key",
      "New Company",
    );
    expect(result).toMatchObject({ status: "found", email: "person@gmail.com" });
  });

  it("does not count a Prospeo re-enrichment as a newly spent credit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            free_enrichment: true,
            person: { email: { status: "VERIFIED", revealed: true, email: "person@company.com" } },
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      discoverEmailViaProspeoApi("https://linkedin.com/in/person", "prospeo-key", "Company"),
    ).resolves.toMatchObject({ status: "found", creditSpent: false });
  });

  it("marks Hunter unavailable on credit exhaustion but not on transient 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: [{ id: "rate_limit" }] }), { status: 429 })),
    );
    await expect(discoverEmailViaHunterApi("https://linkedin.com/in/person", "hunter-key")).resolves.toEqual({
      status: "not_found",
      provider: "hunter",
      creditSpent: false,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "out of credits" }), { status: 402 })),
    );
    await expect(discoverEmailViaHunterApi("https://linkedin.com/in/person", "hunter-key")).resolves.toEqual({
      status: "not_found",
      provider: "hunter",
      creditSpent: false,
      providerUnavailableReason: "quota_exhausted",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ data: { email: "person@acme.com", emails: ["person@gmail.com", "person@acme.com"] } }),
          { status: 200 },
        ),
      ),
    );
    await expect(
      discoverEmailViaHunterApi("https://linkedin.com/in/person", "hunter-key", "Acme", "Jane Doe"),
    ).resolves.toMatchObject({ status: "found", provider: "hunter", email: "person@acme.com", creditSpent: true });
  });

  it("uses Hunter LinkedIn-handle first, then name/company fallback", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ id: "not_found", details: "profile missing" }] }), { status: 404 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { email: "luke@ewi.org" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      discoverEmailViaHunterApi("https://linkedin.com/in/luke-mohr", "hunter-key", "EWI", "Luke Mohr"),
    ).resolves.toMatchObject({ status: "found", provider: "hunter", email: "luke@ewi.org" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("linkedin_handle=luke-mohr");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("full_name=Luke");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("company=EWI");
  });

  it("treats Hunter LinkedIn-handle 404 as a clean miss", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ errors: [{ id: "not_found", details: "profile missing" }] }), { status: 404 }),
      ),
    );
    await expect(discoverEmailViaHunterApi("https://linkedin.com/in/unknown", "hunter-key")).resolves.toEqual({
      status: "not_found",
      provider: "hunter",
      creditSpent: false,
    });
  });

  it("marks GetProspect unavailable on credit exhaustion and prefers company email", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "out of credits" }), { status: 402 })),
    );
    await expect(
      discoverEmailViaGetProspectApi("https://linkedin.com/in/person", "gp-key", "Acme", "Jane Doe"),
    ).resolves.toEqual({
      status: "not_found",
      provider: "getprospect",
      creditSpent: false,
      providerUnavailableReason: "quota_exhausted",
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { email: "person@acme.com" } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      discoverEmailViaGetProspectApi("https://linkedin.com/in/person", "gp-key", "Acme", "Jane Doe"),
    ).resolves.toMatchObject({ status: "found", provider: "getprospect", email: "person@acme.com", creditSpent: true });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("api.getprospect.com/v2/email-finder");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("company=Acme");
  });
});

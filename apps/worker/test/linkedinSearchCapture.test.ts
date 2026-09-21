// @vitest-environment jsdom
import type { Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { SCRAPE_VISIBLE_PEOPLE, captureCompanyRecruiters, tryApplyCurrentCompanyFilter, withLinkedInSearchPage, type ScrapedLinkedInProfile } from "../src/linkedinSearchCapture.js";

function fakePage(overrides: {
  goto?: (url: string) => Promise<void>;
  url?: () => string;
  evaluate?: () => Promise<ScrapedLinkedInProfile[]>;
  fill?: (value: string) => Promise<void>;
} = {}): Page {
  const fill = vi.fn(overrides.fill ?? (async () => undefined));
  const page = {
    getByRole: () => ({ first: () => ({ waitFor: async () => undefined, click: async () => undefined }) }),
    locator: (selector: string) => selector.startsWith("input")
      ? { last: () => ({ waitFor: async () => undefined, fill }) }
      : {
          first: () => ({ waitFor: async () => undefined, click: async () => undefined }),
          last: () => ({
            waitFor: async () => undefined,
            click: async () => undefined,
            scrollIntoViewIfNeeded: async () => undefined,
          }),
        },
    waitForURL: async () => undefined,
    waitForSelector: vi.fn(async () => undefined),
    goto: vi.fn(overrides.goto ?? (async () => undefined)),
    url: vi.fn(overrides.url ?? (() => "https://www.linkedin.com/search/results/people/?currentCompany=%5B%221%22%5D")),
    mouse: { wheel: vi.fn(async () => undefined) },
    evaluate: vi.fn(overrides.evaluate ?? (async () => [])),
  } as unknown as Page;
  Object.assign(page, { fill });
  return page;
}

/** Runs the page.evaluate payload against the jsdom document, like Playwright would. */
function scrape(): ScrapedLinkedInProfile[] {
  // eslint-disable-next-line no-eval
  return eval(SCRAPE_VISIBLE_PEOPLE) as ScrapedLinkedInProfile[];
}

function card(inner: string): string {
  return `<div role="listitem">${inner}</div>`;
}

describe("LinkedIn search capture scraper", () => {
  it("associates photos by the wrapping profile link, never a mutual's face", () => {
    document.body.innerHTML = [
      card(`
        <a href="https://www.linkedin.com/in/sakshi-palta">
          <img src="https://media.licdn.com/x/profile-displayphoto-shrink_100/sakshi.jpg" alt="" />
        </a>
        <a href="https://www.linkedin.com/in/sakshi-palta"><span>Sakshi Palta</span></a>
        <p>Senior Recruiter at T-Mobile</p>
        <p>Bellevue, Washington, United States</p>
        <a href="https://www.linkedin.com/in/graham-loucks">
          <img src="https://media.licdn.com/x/profile-displayphoto-shrink_100/graham.jpg" alt="" />
          Graham Loucks is a mutual connection
        </a>
      `),
      card(`
        <a href="https://www.linkedin.com/in/no-photo-person"><span>No Photo</span></a>
        <a href="https://www.linkedin.com/in/no-photo-person"><span>No Photo Person</span></a>
        <p>Recruiter at T-Mobile</p>
        <a href="https://www.linkedin.com/in/someone-else">
          <img src="https://media.licdn.com/x/profile-displayphoto-shrink_100/someone.jpg" alt="" />
        </a>
      `),
      card(`
        <a href="https://www.linkedin.com/in/third-person">
          <img src="https://media.licdn.com/x/profile-displayphoto-shrink_100/third.jpg" alt="" />
          <span>Third Person</span>
        </a>
        <p>Talent Acquisition at T-Mobile</p>
      `),
    ].join("");

    const results = scrape();
    const byName = new Map(results.map((r) => [r.fullName, r]));

    expect(byName.get("Sakshi Palta")?.profilePhotoUrl).toContain("sakshi.jpg");
    expect(byName.get("Sakshi Palta")?.title).toBe("Senior Recruiter at T-Mobile");
    expect(byName.get("Sakshi Palta")?.location).toContain("Bellevue");
    // A card whose only photo belongs to someone else yields NO photo.
    expect(byName.get("No Photo Person")?.profilePhotoUrl).toBeUndefined();
    expect(byName.get("Third Person")?.profilePhotoUrl).toContain("third.jpg");
    // Mutual connections never become candidates.
    expect(results.map((r) => r.linkedinUrl)).not.toContain("https://www.linkedin.com/in/graham-loucks");
  });

  it("cleans 'View X's profile' anchor text into a name", () => {
    document.body.innerHTML = [
      card(`<a href="https://www.linkedin.com/in/a-b"><span>View Ada Lovelace's profile</span></a><p>Recruiter</p>`),
      card(`<a href="https://www.linkedin.com/in/c-d"><span>Grace Hopper Grace Hopper</span></a><p>Sourcer</p>`),
      card(`<a href="https://www.linkedin.com/in/e-f"><span>Alan Turing</span></a><p>Recruiter</p>`),
    ].join("");

    const names = scrape().map((r) => r.fullName);
    expect(names).toEqual(["Ada Lovelace", "Grace Hopper", "Alan Turing"]);
  });
});

describe("withLinkedInSearchPage", () => {
  it("sets page=2+ on a filtered search URL and strips page=1", () => {
    const filtered = "https://www.linkedin.com/search/results/people/?keywords=recruiter&currentCompany=%5B%221441%22%5D";
    expect(withLinkedInSearchPage(filtered, 2)).toContain("page=2");
    expect(withLinkedInSearchPage(filtered, 2)).toContain("currentCompany=");
    expect(withLinkedInSearchPage(`${filtered}&page=2`, 1)).not.toMatch(/[?&]page=/);
  });
});

describe("captureCompanyRecruiters", () => {
  it("applies the company filter once, then paginates the filtered search", async () => {
    vi.useFakeTimers();
    try {
      const gotos: string[] = [];
      const page = fakePage({
        goto: async (url) => {
          gotos.push(url);
        },
        evaluate: async () => {
          const n = Math.max(1, gotos.length);
          return [{
            fullName: `Person ${n}`,
            firstName: "Person",
            linkedinUrl: `https://www.linkedin.com/in/p${n}`,
          }];
        },
      });

      const resultPromise = captureCompanyRecruiters(page, { companyName: "Acme", pages: 3 });
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(gotos).toHaveLength(3);
      expect(gotos[0]).not.toMatch(/currentCompany/);
      expect(gotos[0]).not.toMatch(/[?&]page=/);
      expect(gotos[1]).toMatch(/currentCompany=/);
      expect(gotos[1]).toMatch(/page=2/);
      expect(gotos[2]).toMatch(/page=3/);
      expect((page as Page & { fill: ReturnType<typeof vi.fn> }).fill).toHaveBeenCalledOnce();
      expect(result.map((profile) => profile.linkedinUrl)).toEqual([
        "https://www.linkedin.com/in/p1",
        "https://www.linkedin.com/in/p2",
        "https://www.linkedin.com/in/p3",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not scrape or use keyword fallback when company filtering fails", async () => {
    vi.useFakeTimers();
    try {
      const page = fakePage({ url: () => "https://www.linkedin.com/search/results/people/?keywords=Recruiter" });
      const result = captureCompanyRecruiters(page, { companyName: "Microsoft", pages: 1 });
      const assertion = expect(result).rejects.toThrow(/Current company filter/);
      await vi.runAllTimersAsync();
      await assertion;
      expect(page.goto).toHaveBeenCalledOnce();
      expect(page.evaluate).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("keeps profiles captured from earlier pages when a later page fails", async () => {
    vi.useFakeTimers();
    try {
      const page1Profile: ScrapedLinkedInProfile = {
        fullName: "Ada Lovelace",
        firstName: "Ada",
        linkedinUrl: "https://www.linkedin.com/in/ada-lovelace",
      };
      let evaluateCalls = 0;
      const page = fakePage({
        goto: async (url) => {
          if (url.includes("page=2")) {
            throw new Error("net::ERR_CONNECTION_TIMED_OUT");
          }
        },
        evaluate: async () => {
          evaluateCalls += 1;
          return [page1Profile];
        },
      });

      const resultPromise = captureCompanyRecruiters(page, { companyName: "Acme", pages: 2 });
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toEqual([page1Profile]);
      expect(evaluateCalls).toBe(1);
      expect(page.goto).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still throws when the very first page fails with nothing captured yet", async () => {
    vi.useFakeTimers();
    try {
      const page = fakePage({
        url: () => "https://www.linkedin.com/checkpoint/challenge",
      });

      const resultPromise = captureCompanyRecruiters(page, { companyName: "Acme", pages: 2 });
      const assertion = expect(resultPromise).rejects.toThrow(/not logged in/i);
      await vi.runAllTimersAsync();
      await assertion;
      expect(page.goto).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("tryApplyCurrentCompanyFilter", () => {
  it("selects the exact company and applies LinkedIn's filter", async () => {
    vi.useFakeTimers();
    try {
      const trigger = { first: () => trigger, waitFor: vi.fn(async () => undefined), isVisible: vi.fn(async () => true), click: vi.fn(async () => undefined) };
      const apply = { first: () => apply, last: () => apply, isVisible: vi.fn(async () => true), waitFor: vi.fn(async () => undefined), click: vi.fn(async () => undefined) };
      const option = { first: () => option, isVisible: vi.fn(async () => true), waitFor: vi.fn(async () => undefined), click: vi.fn(async () => undefined) };
      const input = { last: () => input, waitFor: vi.fn(async () => undefined), fill: vi.fn(async () => undefined) };
      const page = {
        getByRole: vi.fn((role: string, options?: { name: RegExp }) => {
          if (role === "option") return option;
          return options && /show results|apply/i.test(options.name.source) ? apply : trigger;
        }),
        locator: vi.fn((selector: string) => selector.startsWith("input") ? input : {
          filter: () => option,
          first: () => option,
        }),
        waitForURL: vi.fn(async () => undefined),
        url: vi.fn(() => "https://www.linkedin.com/search/results/people/?keywords=Recruiter&currentCompany=%5B%221441%22%5D"),
      } as unknown as Page;

      const resultPromise = tryApplyCurrentCompanyFilter(page, "Figma");
      await vi.runAllTimersAsync();
      await expect(resultPromise).resolves.toBe(true);
      expect(input.fill).toHaveBeenCalledWith("Figma");
      expect(option.click).toHaveBeenCalledOnce();
      expect(apply.click).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back cleanly when LinkedIn's company filter is unavailable", async () => {
    const hidden = { first: () => hidden, isVisible: vi.fn(async () => false) };
    const page = { getByRole: vi.fn(() => hidden) } as unknown as Page;
    await expect(tryApplyCurrentCompanyFilter(page, "Figma")).resolves.toBe(false);
  });
});

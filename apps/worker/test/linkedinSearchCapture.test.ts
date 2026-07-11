// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { SCRAPE_VISIBLE_PEOPLE, type ScrapedLinkedInProfile } from "../src/linkedinSearchCapture.js";

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

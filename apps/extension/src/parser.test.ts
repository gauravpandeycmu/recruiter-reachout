import { describe, expect, it } from "vitest";
import {
  dedupeRepeatedName,
  inferCompanyFromSearchUrl,
  inferNameFromText,
  parseCurrentPage,
  parseSearchResults,
} from "./parser";

describe("extension parser", () => {
  it("infers names from LinkedIn search anchor text", () => {
    expect(inferNameFromText("Jane Doe - Technical Recruiter | LinkedIn")).toBe("Jane Doe");
    expect(inferNameFromText("View Jane Doe's profile")).toBe("Jane Doe");
    expect(inferNameFromText("View profile for John Smith")).toBe("John Smith");
    expect(inferNameFromText("Zacarias L. Pabalan and Connor Quilici are mutual connections")).toBe("");
    expect(inferNameFromText("LinkedIn Login")).toBe("");
  });

  it("dedupes LinkedIn doubled names from visible + sr-only spans", () => {
    expect(dedupeRepeatedName("Jake Walton Jake Walton")).toBe("Jake Walton");
    expect(dedupeRepeatedName("Caroline CrowCaroline Crow")).toBe("Caroline Crow");
    expect(dedupeRepeatedName("Amanda Mencio Amanda Mencio")).toBe("Amanda Mencio");
    expect(dedupeRepeatedName("Jane Doe")).toBe("Jane Doe");
  });

  it("parses unique LinkedIn profile links from search result pages", () => {
    document.body.innerHTML = `
      <div>
        <a href="https://www.linkedin.com/in/jane-doe?trk=abc">Jane Doe - Technical Recruiter | LinkedIn</a>
      </div>
      <div>
        <a href="https://www.linkedin.com/in/jane-doe?trk=def">Jane Doe - Technical Recruiter | LinkedIn</a>
      </div>
      <div>
        <a href="https://www.linkedin.com/in/john-smith">John Smith - Talent Acquisition</a>
      </div>
      <div>
        <a href="https://www.linkedin.com/company/example">Example Company</a>
      </div>
      <div>
        <a href="https://www.linkedin.com/jobs/view/123">Recruiter job</a>
      </div>
      <div>
        <a href="https://www.linkedin.com/in/zacarias-pabalan">Zacarias L. Pabalan and Connor Quilici are mutual connections</a>
      </div>
    `;

    const candidates = parseSearchResults(document);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.fullName).toBe("Jane Doe");
  });

  it("extracts names from visible LinkedIn result cards", () => {
    document.body.innerHTML = `
      <li>
        <img src="https://media.licdn.com/profile/sam.jpg" alt="Sam Taylor" />
        <a href="https://www.linkedin.com/in/sam-taylor/?miniProfileUrn=abc">View Sam Taylor's profile</a>
        <span>Senior Technical Recruiter</span>
        <span>Pittsburgh, United States</span>
      </li>
      <li>
        <a href="https://www.linkedin.com/in/priya-shah/">Priya Shah</a>
        <span>Talent Acquisition Partner</span>
      </li>
    `;

    const candidates = parseSearchResults(document);
    expect(candidates).toMatchObject([
      {
        fullName: "Sam Taylor",
        title: "Senior Technical Recruiter",
        location: "Pittsburgh, United States",
        linkedinUrl: "https://www.linkedin.com/in/sam-taylor",
        profilePhotoUrl: "https://media.licdn.com/profile/sam.jpg",
      },
      {
        fullName: "Priya Shah",
        title: "Talent Acquisition Partner",
      },
    ]);
  });

  it("uses aria-hidden name span and ignores doubled textContent", () => {
    document.body.innerHTML = `
      <li class="reusable-search__result-container">
        <a href="https://www.linkedin.com/in/jake-walton">
          <span aria-hidden="true">Jake Walton</span>
          <span class="visually-hidden">Jake Walton</span>
        </a>
        <span>Recruiter</span>
      </li>
      <li class="reusable-search__result-container">
        <a href="https://www.linkedin.com/in/caroline-crow">
          Caroline Crow Caroline Crow
        </a>
      </li>
    `;

    const candidates = parseSearchResults(document);
    expect(candidates.map((c) => c.fullName)).toEqual(["Jake Walton", "Caroline Crow"]);
  });

  it("keeps profiles when only the LinkedIn slug can supply a name", () => {
    document.body.innerHTML = `
      <div role="listitem">
        <a href="/in/sara-manchester-14b3a451/">
          <span>Connect</span>
        </a>
      </div>
    `;

    const candidates = parseSearchResults(document);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      fullName: "Sara Manchester",
      linkedinUrl: "https://www.linkedin.com/in/sara-manchester-14b3a451",
    });
  });

  it("uses profile labels and full result cards instead of noisy card text", () => {
    document.body.innerHTML = `
      <li class="reusable-search__result-container">
        <div>
          <img data-delayed-url="https://media.licdn.com/profile/utkarsh.jpg" alt="Utkarsh Pandey" />
        </div>
        <div>
          <a aria-label="View Utkarsh Pandey's profile" href="https://www.linkedin.com/in/neoanoman">
            Utkarsh Pandey • 2ndEngineering @ MetaNew York, New York, United StatesConnect
          </a>
          <span>Engineering @ Meta</span>
          <span>New York, New York, United States</span>
        </div>
      </li>
    `;

    expect(parseSearchResults(document)).toMatchObject([
      {
        fullName: "Utkarsh Pandey",
        linkedinUrl: "https://www.linkedin.com/in/neoanoman",
        profilePhotoUrl: "https://media.licdn.com/profile/utkarsh.jpg",
      },
    ]);
  });

  it("does not capture mutual connection profile links as search results", () => {
    document.body.innerHTML = `
      <li class="reusable-search__result-container">
        <a aria-label="View Utkarsh Pandey's profile" href="https://www.linkedin.com/in/utkarshpandeyiiml">
          Utkarsh Pandey
        </a>
        <span>Growth Manager @ PocketFM</span>
        <div>
          <a href="https://www.linkedin.com/in/tanmayatripathi">Tanmaya Tripathi</a>,
          <a href="https://www.linkedin.com/in/gowtham-r-512114657">Gowtham Ramachandra</a>
          and 9 other mutual connections
        </div>
      </li>
      <li class="reusable-search__result-container">
        <a aria-label="View Another Person's profile" href="https://www.linkedin.com/in/another-person">
          Another Person
        </a>
      </li>
    `;

    const candidates = parseSearchResults(document);
    expect(candidates.map((candidate) => candidate.fullName)).toEqual(["Utkarsh Pandey", "Another Person"]);
    expect(candidates.map((candidate) => candidate.linkedinUrl)).not.toContain("https://www.linkedin.com/in/tanmayatripathi");
  });

  it("associates photos by wrapping profile link when alt is empty (2025 LinkedIn DOM)", () => {
    document.body.innerHTML = `
      <div role="listitem">
        <a href="https://www.linkedin.com/in/sakshi-palta">
          <img src="https://media.licdn.com/dms/image/v2/profile-displayphoto-shrink_100/sakshi.jpg" alt="" />
        </a>
        <a href="https://www.linkedin.com/in/sakshi-palta"><span>Sakshi Palta</span></a>
        <p>Senior Recruiter at T-Mobile</p>
        <a href="https://www.linkedin.com/in/graham-loucks">
          <img src="https://media.licdn.com/dms/image/v2/profile-displayphoto-shrink_100/graham.jpg" alt="" />
          Graham Loucks is a mutual connection
        </a>
      </div>
      <div role="listitem">
        <a href="https://www.linkedin.com/in/no-photo-person"><span>No Photo Person</span></a>
        <p>Recruiter at T-Mobile</p>
        <a href="https://www.linkedin.com/in/someone-else">
          <img src="https://media.licdn.com/dms/image/v2/profile-displayphoto-shrink_100/someone.jpg" alt="" />
        </a>
      </div>
    `;

    const candidates = parseSearchResults(document);
    const byUrl = new Map(candidates.map((c) => [c.linkedinUrl, c]));
    expect(byUrl.get("https://www.linkedin.com/in/sakshi-palta")?.profilePhotoUrl).toContain("sakshi.jpg");
    expect(byUrl.get("https://www.linkedin.com/in/no-photo-person")?.profilePhotoUrl).toBeUndefined();
    expect(candidates.map((c) => c.linkedinUrl)).not.toContain("https://www.linkedin.com/in/graham-loucks");
  });

  it("reads lazy-loaded photos from presence-entity wrappers", () => {
    document.body.innerHTML = `
      <li class="reusable-search__result-container">
        <div class="entity-result">
          <a href="https://www.linkedin.com/in/jane-recruiter?miniProfileUrn=abc">
            <div class="presence-entity presence-entity--size-3">
              <img
                src="https://static.licdn.com/scds/common/u/images/logos/ghosts/person/ghost_person.svg"
                data-delayed-url="https://media.licdn.com/dms/image/v2/profile-displayphoto-shrink_100/jane.jpg"
                alt=""
                class="presence-entity__image"
              />
            </div>
          </a>
          <a aria-label="View Jane Recruiter's profile" href="https://www.linkedin.com/in/jane-recruiter?miniProfileUrn=abc">
            <span aria-hidden="true">Jane Recruiter</span>
          </a>
          <p>Senior Technical Recruiter at Google</p>
        </div>
      </li>
    `;

    expect(parseSearchResults(document)).toMatchObject([
      {
        fullName: "Jane Recruiter",
        linkedinUrl: "https://www.linkedin.com/in/jane-recruiter",
        profilePhotoUrl: "https://media.licdn.com/dms/image/v2/profile-displayphoto-shrink_100/jane.jpg",
      },
    ]);
  });

  it("never assigns a mutual connection's photo to a search result", () => {
    document.head.innerHTML = "";
    document.title = "Search | LinkedIn";
    document.body.innerHTML = `
      <li class="reusable-search__result-container">
        <img src="https://media.licdn.com/profile/mutual-friend.jpg" alt="Graham Loucks" />
        <a href="https://www.linkedin.com/in/sakshi-palta"><span aria-hidden="true">Sakshi Palta</span></a>
        <span>Recruiter</span>
        <img src="https://media.licdn.com/profile/sakshi.jpg" alt="Sakshi Palta" />
      </li>
      <li class="reusable-search__result-container">
        <img src="https://media.licdn.com/profile/mutual-only.jpg" alt="Someone Else" />
        <a href="https://www.linkedin.com/in/no-photo-person"><span aria-hidden="true">No Photo Person</span></a>
      </li>
    `;

    const candidates = parseSearchResults(document);
    expect(candidates[0]).toMatchObject({
      fullName: "Sakshi Palta",
      profilePhotoUrl: "https://media.licdn.com/profile/sakshi.jpg",
    });
    expect(candidates[1]?.fullName).toBe("No Photo Person");
    expect(candidates[1]?.profilePhotoUrl).toBeUndefined();
  });

  it("suggests company from non-generic LinkedIn search keywords", () => {
    expect(inferCompanyFromSearchUrl("https://www.linkedin.com/search/results/people/?keywords=recruiter%20OpenAI")).toBe("OpenAI");
    expect(inferCompanyFromSearchUrl("https://www.linkedin.com/search/results/people/?keywords=technical%20recruiter")).toBeUndefined();
  });

  it("returns parse results with company suggestion without overriding explicit popup company", () => {
    document.body.innerHTML = `
      <div>
        <a href="https://www.linkedin.com/in/jane-doe">Jane Doe - Recruiter</a>
      </div>
    `;

    const result = parseCurrentPage(document, "https://www.linkedin.com/search/results/people/?keywords=recruiter%20Anthropic");
    expect(result.companySuggestion).toBe("Anthropic");
    expect(result.candidates[0]).toMatchObject({ fullName: "Jane Doe" });
  });

  it("parses a LinkedIn profile page and auto-suggests company from headline", () => {
    document.body.innerHTML = `
      <h1>Sara Manchester</h1>
      <div>Technical Recruiter at Google</div>
      <div>New York, United States</div>
      <a href="https://www.linkedin.com/company/google/">Google</a>
      <img src="https://media.licdn.com/profile/sara.jpg" alt="Sara Manchester" />
    `;

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/sara-manchester-14b3a451/");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      fullName: "Sara Manchester",
      company: "Google",
      linkedinUrl: "https://www.linkedin.com/in/sara-manchester-14b3a451/",
    });
    expect(result.companySuggestion).toBe("Google");
  });

  it("accepts single-letter last initials like Ivan R from h1 and slug", () => {
    document.head.innerHTML = "";
    document.title = "LinkedIn";
    document.body.innerHTML = `
      <h1>Ivan R</h1>
      <div class="text-body-medium">Technical Recruiter at Apple</div>
    `;

    const fromH1 = parseCurrentPage(document, "https://www.linkedin.com/in/ivan-r-20971a190/");
    expect(fromH1.candidates[0]).toMatchObject({
      fullName: "Ivan R",
      firstName: "Ivan",
      company: "Apple",
      linkedinUrl: "https://www.linkedin.com/in/ivan-r-20971a190/",
    });

    document.body.innerHTML = `<div class="text-body-medium">Technical Recruiter at Apple</div>`;
    document.title = "LinkedIn";
    const fromSlug = parseCurrentPage(document, "https://www.linkedin.com/in/ivan-r-20971a190/");
    expect(fromSlug.candidates[0]).toMatchObject({
      fullName: "Ivan R",
      company: "Apple",
    });
  });

  it("infers names that use a last initial", () => {
    expect(inferNameFromText("Ivan R - Technical Recruiter | LinkedIn")).toBe("Ivan R");
    expect(inferNameFromText("View Ivan R's profile")).toBe("Ivan R");
  });

  it("parses profile name from document title when h1 is missing", () => {
    document.body.innerHTML = `
      <div class="text-body-medium">Sr. Recruiter (Hardware Technology) at Apple</div>
      <a href="https://www.linkedin.com/company/apple/">Apple</a>
    `;
    document.title = "David Sneed | LinkedIn";

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/davidsneed/");
    expect(result.candidates[0]).toMatchObject({
      fullName: "David Sneed",
      company: "Apple",
    });
    expect(result.companySuggestion).toBe("Apple");
  });

  it("parses profile name from a leading-notification-count document title", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = `<div class="text-body-medium">Sr. Recruiter at Apple</div>`;
    document.title = "(3) David Sneed | LinkedIn";

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/davidsneed/");
    expect(result.candidates[0]?.fullName).toBe("David Sneed");
  });

  it("parses profile name from JSON-LD when the DOM and title give nothing", () => {
    document.head.innerHTML = "";
    document.title = "LinkedIn";
    document.body.innerHTML = `
      <script type="application/ld+json">
        {"@context":"https://schema.org","@graph":[{"@type":"WebPage","name":"LinkedIn"},{"@type":"Person","name":"David Sneed","jobTitle":"Sr. Recruiter"}]}
      </script>
      <div class="text-body-medium">Sr. Recruiter at Apple</div>
    `;

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/davidsneed/");
    expect(result.candidates[0]).toMatchObject({ fullName: "David Sneed", company: "Apple" });
  });

  it("parses profile name from the top-card photo alt, ignoring sidebar people", () => {
    document.head.innerHTML = "";
    document.title = "LinkedIn";
    document.body.innerHTML = `
      <div class="pv-top-card">
        <img src="https://media.licdn.com/profile/david.jpg" alt="David Sneed" />
      </div>
      <aside>
        <img src="https://media.licdn.com/profile/other.jpg" alt="Other Person" />
      </aside>
      <div class="text-body-medium">Sr. Recruiter at Apple</div>
    `;

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/davidsneed/");
    expect(result.candidates[0]?.fullName).toBe("David Sneed");
  });

  it("parses profile name from og:title when h1 and title are noisy", () => {
    document.head.innerHTML = `<meta property="og:title" content="Priya Shah | LinkedIn" />`;
    document.body.innerHTML = `<div>Talent Acquisition Partner at Meta</div>`;
    document.title = "LinkedIn";

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/priya-shah/");
    expect(result.candidates[0]?.fullName).toBe("Priya Shah");
    expect(result.companySuggestion).toBe("Meta");
  });

  it("prefers the first top-card company button over headline product/domain text", () => {
    document.head.innerHTML = "";
    document.title = "Stanislav Beliaev | LinkedIn";
    document.body.innerHTML = `
      <section class="artdeco-card pv-top-card">
        <h1>Stanislav Beliaev</h1>
        <div class="text-body-medium">Co-Founder &amp; CTO at GetFluently.App (YC W24), ex Nvidia</div>
        <div class="ph5">
          <a href="https://www.linkedin.com/company/fluently/">
            <span aria-hidden="true">Fluently</span>
            <span class="visually-hidden">Fluently</span>
          </a>
          <a href="https://www.linkedin.com/company/y-combinator/">
            <span aria-hidden="true">Y Combinator</span>
          </a>
        </div>
      </section>
    `;

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/stanislav-beliaev/");
    expect(result.candidates[0]).toMatchObject({
      fullName: "Stanislav Beliaev",
      company: "Fluently",
    });
    expect(result.companySuggestion).toBe("Fluently");
  });

  it("prefers the headline company over 'You both worked at X' insight links", () => {
    document.head.innerHTML = "";
    document.title = "(3) David Sneed | LinkedIn";
    document.body.innerHTML = `
      <nav class="global-nav">
        <img src="https://media.licdn.com/profile/viewer-me.jpg" alt="Gaurav Pandey" />
      </nav>
      <section class="artdeco-card pv-top-card">
        <img class="pv-top-card-profile-picture__image" src="https://media.licdn.com/profile/david.jpg" alt="David Sneed" />
        <h1>David Sneed</h1>
        <div class="text-body-medium">Sr. Recruiter (Hardware Technology) at Apple More Visit my website Message Follow</div>
        <a href="https://www.linkedin.com/company/google/">You both worked at GoogleDavid worked at Google before you started</a>
      </section>
    `;

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/davidsneed/");
    expect(result.candidates[0]).toMatchObject({
      fullName: "David Sneed",
      company: "Apple",
      title: "Sr. Recruiter (Hardware Technology) at Apple",
      profilePhotoUrl: "https://media.licdn.com/profile/david.jpg",
    });
    expect(result.companySuggestion).toBe("Apple");
  });

  it("returns no photo on a profile page rather than another person's photo", () => {
    document.head.innerHTML = "";
    document.title = "Jane Doe | LinkedIn";
    document.body.innerHTML = `
      <nav class="global-nav">
        <img src="https://media.licdn.com/profile/viewer-me.jpg" alt="Gaurav Pandey" />
      </nav>
      <h1>Jane Doe</h1>
      <div class="text-body-medium">Recruiter at Acme</div>
    `;

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/jane-doe/");
    expect(result.candidates[0]?.fullName).toBe("Jane Doe");
    expect(result.candidates[0]?.profilePhotoUrl).toBeUndefined();
  });

  it("prefers data-delayed-url over transparent placeholder src on search cards", () => {
    document.body.innerHTML = `
      <li class="reusable-search__result-container">
        <img src="https://static.licdn.com/scds/common/u/images/logos/ghosts/person/ghost_person.svg" data-delayed-url="https://media.licdn.com/dms/image/v2/profile-displayphoto/sam.jpg" alt="Sam Taylor" />
        <a href="https://www.linkedin.com/in/sam-taylor/">Sam Taylor</a>
      </li>
    `;

    const candidates = parseSearchResults(document);
    expect(candidates[0]?.profilePhotoUrl).toBe("https://media.licdn.com/dms/image/v2/profile-displayphoto/sam.jpg");
  });

  it("reads profile photo from JSON-LD Person.image", () => {
    document.head.innerHTML = `
      <script type="application/ld+json">
        {"@context":"https://schema.org","@type":"Person","name":"Priya Shah","image":"https://media.licdn.com/dms/image/v2/profile-displayphoto/priya.jpg"}
      </script>
    `;
    document.body.innerHTML = `<h1>Priya Shah</h1><div>Recruiter at Meta</div>`;

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/priya-shah/");
    expect(result.candidates[0]?.profilePhotoUrl).toBe("https://media.licdn.com/dms/image/v2/profile-displayphoto/priya.jpg");
  });

  it("reads profile photo from aria-label on the profile picture button", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = `
      <section class="artdeco-card" data-member-id="1">
        <button aria-label="Open Alex Chen’s profile photo">
          <img src="https://static.licdn.com/scds/common/u/images/logos/ghosts/person/ghost_person.svg" data-delayed-url="https://media.licdn.com/dms/image/v2/profile-displayphoto/alex.jpg" alt="" />
        </button>
        <h1>Alex Chen</h1>
        <div class="text-body-medium">Recruiter at Stripe</div>
      </section>
    `;

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/alex-chen/");
    expect(result.candidates[0]?.profilePhotoUrl).toBe("https://media.licdn.com/dms/image/v2/profile-displayphoto/alex.jpg");
  });

  it("infers company from at/@ headline text when no company link exists", () => {
    document.body.innerHTML = `
      <h1>Jane Doe</h1>
      <div>Senior Recruiter @ OpenAI · San Francisco, United States</div>
    `;

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/jane-doe");
    expect(result.companySuggestion).toBe("OpenAI");
  });
});

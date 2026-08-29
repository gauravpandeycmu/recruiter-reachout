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

  it("keeps a vanity-slug surname of 6+ letters (no opaque id) instead of stripping it as an id", () => {
    document.body.innerHTML = `
      <div role="listitem">
        <a href="/in/jenny-anderson/">
          <span>Connect</span>
        </a>
      </div>
    `;

    const candidates = parseSearchResults(document);
    // Old id-strip regex treated "-anderson" (8 alnum, no digit) as an opaque id,
    // leaving "jenny" (a single word) → no name → the recruiter was dropped.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      fullName: "Jenny Anderson",
      linkedinUrl: "https://www.linkedin.com/in/jenny-anderson",
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

  it("parses an engineering profile headline without recruiter-fallback / location glue", () => {
    document.head.innerHTML = "";
    document.title = "SWAMINATHAN PISUPATI | LinkedIn";
    document.body.innerHTML = `
      <div class="pv-text-details__left-panel">
        <h1>SWAMINATHAN PISUPATI</h1>
        <div class="text-body-medium">Principal Software Engineering Lead at Microsoft</div>
        <span class="text-body-small">Redmond, Washington, United States</span>
        <button>Microsoft</button>
      </div>
      <aside>
        <div class="text-body-medium">Recruiter @ Microsoft</div>
        <div>recruiting #QualityThroughData #LeadWithData</div>
      </aside>
      <a href="https://www.linkedin.com/company/microsoft/">Microsoft</a>
    `;

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/swaminathan-pisupati-2b941992/");
    expect(result.candidates[0]).toMatchObject({
      fullName: "SWAMINATHAN PISUPATI",
      title: "Principal Software Engineering Lead at Microsoft",
      company: "Microsoft",
      location: "Redmond, Washington, United States",
    });
  });

  it("uses JSON-LD jobTitle when the top-card headline node is missing", () => {
    document.head.innerHTML = `
      <script type="application/ld+json">
        {"@context":"https://schema.org","@graph":[{"@type":"Person","name":"Christian Kotitschke","jobTitle":"Principal Software Engineering Lead - Windows Servicing and Delivery at Microsoft"}]}
      </script>
    `;
    document.title = "Christian Kotitschke | LinkedIn";
    document.body.innerHTML = `
      <h1>Christian Kotitschke</h1>
      <div>recruiting #QualityThroughData #LeadWithData #DataAndInsights</div>
      <div>Windows Servicing and Delivery at Microsoft Redmond, Washington</div>
      <a href="https://www.linkedin.com/company/microsoft/">Microsoft</a>
    `;

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/christiankotitschke/");
    expect(result.candidates[0]).toMatchObject({
      fullName: "Christian Kotitschke",
      title: "Principal Software Engineering Lead - Windows Servicing and Delivery at Microsoft",
      company: "Microsoft",
    });
    expect(result.candidates[0]?.title).not.toMatch(/#/);
    expect(result.candidates[0]?.location ?? "").not.toMatch(/Windows Servicing/);
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

  it("does not invent a photo when LinkedIn only shows a ghost avatar", () => {
    document.body.innerHTML = `
      <li class="reusable-search__result-container">
        <a href="https://www.linkedin.com/in/no-photo-person">
          <div class="presence-entity">
            <img
              class="ghost-person presence-entity__image"
              src="https://media.licdn.com/dms/image/v2/profile-displayphoto-shrink_100/some-default.jpg"
              alt=""
            />
          </div>
        </a>
        <a href="https://www.linkedin.com/in/no-photo-person"><span aria-hidden="true">No Photo Person</span></a>
        <p>Recruiter at Acme</p>
        <a href="https://www.linkedin.com/in/mutual-friend">
          <img src="https://media.licdn.com/dms/image/v2/profile-displayphoto/mutual.jpg" alt="Mutual Friend" />
        </a>
      </li>
    `;

    const candidates = parseSearchResults(document);
    expect(candidates[0]?.fullName).toBe("No Photo Person");
    expect(candidates[0]?.profilePhotoUrl).toBeUndefined();
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

  it("parses profile names that include a parenthesized surname and still prefills company", () => {
    document.head.innerHTML = `
      <meta property="og:title" content="Jenny Laton (Hsu) | LinkedIn" />
    `;
    document.title = "Jenny Laton (Hsu) | LinkedIn";
    document.body.innerHTML = `
      <section class="artdeco-card pv-top-card">
        <h1>Jenny Laton (Hsu)</h1>
        <div class="text-body-medium">Talent Acquisition at Netflix</div>
        <button aria-label="Current company: Netflix">
          <span aria-hidden="true">Netflix</span>
        </button>
      </section>
    `;

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/jennyhsu2/");
    expect(result.candidates[0]).toMatchObject({
      fullName: "Jenny Laton (Hsu)",
      firstName: "Jenny",
      company: "Netflix",
    });
    expect(result.companySuggestion).toBe("Netflix");
  });

  it("ignores LinkedIn utility text like 'Skip to search' and still picks the actual current company", () => {
    document.head.innerHTML = "";
    document.title = "Jenny Laton (Hsu) | LinkedIn";
    document.body.innerHTML = `
      <section class="pv-top-card">
        <div class="pv-text-details__left-panel">
          <button><span aria-hidden="true">Skip to search</span></button>
          <h1>Jenny Laton (Hsu)</h1>
          <div class="text-body-medium">Talent Acquisition at Netflix</div>
        </div>
        <div class="pv-text-details__right-panel">
          <button aria-label="Current company: Netflix">
            <img alt="Netflix logo" />
            <span aria-hidden="true">Netflix</span>
          </button>
          <button aria-label="Education: Cal Poly Pomona">
            <span aria-hidden="true">Cal Poly Pomona</span>
          </button>
        </div>
      </section>
    `;

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/jennyhsu2/");
    expect(result.candidates[0]?.company).toBe("Netflix");
    expect(result.companySuggestion).toBe("Netflix");
  });

  it("parses the newer LinkedIn profile layout where name is an h2 and company is a button in main content", () => {
    document.head.innerHTML = "";
    document.title = "Amrita Jain | LinkedIn";
    document.body.innerHTML = `
      <main>
        <section aria-label="Primary content">
          <button><span>Skip to search</span></button>
          <a href="https://www.linkedin.com/in/amritajain007/">
            <h2>Amrita Jain</h2>
          </a>
          <p>· 3rd</p>
          <p>Principal Software Engineer at NVIDIA</p>
          <p>San Jose, California, United States</p>
          <button aria-label="NVIDIA">
            <figure></figure>
            <p>NVIDIA</p>
          </button>
          <button aria-label="Texas Executive Education | The University of Texas at Austin">
            <figure></figure>
            <p>Texas Executive Education | The University of Texas at Austin</p>
          </button>
        </section>
      </main>
    `;

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/amritajain007/");
    expect(result.candidates[0]).toMatchObject({
      fullName: "Amrita Jain",
      title: "Principal Software Engineer at NVIDIA",
      company: "NVIDIA",
      location: "San Jose, California, United States",
    });
    expect(result.companySuggestion).toBe("NVIDIA");
  });

  it("prefers the right-side company chip over follow buttons in founder profiles", () => {
    document.head.innerHTML = "";
    document.title = "Prasanna K Ram | LinkedIn";
    document.body.innerHTML = `
      <main>
        <section aria-label="Primary content">
          <h1>Prasanna K Ram</h1>
          <p>Founder & CEO, ChatOps.health | Digital Transformation | Applied AI | Enterprise Systems</p>
          <p>Chennai, Tamil Nadu, India</p>
          <button>Follow</button>
          <button>Message</button>
          <button>Visit my website</button>
          <button>More</button>
          <button aria-label="ChatOps.health">
            <figure></figure>
            <p>ChatOps.health</p>
          </button>
          <button aria-label="Birla Institute of Technology and Science, Pilani">
            <figure></figure>
            <p>Birla Institute of Technology and Science, Pilani</p>
          </button>
        </section>
      </main>
    `;

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/prasannakram/");
    expect(result.candidates[0]).toMatchObject({
      fullName: "Prasanna K Ram",
      company: "ChatOps.health",
      title: "Founder & CEO, ChatOps.health | Digital Transformation | Applied AI | Enterprise Systems",
    });
    expect(result.companySuggestion).toBe("ChatOps.health");
  });

  it("prefers the right-side company chip over the headline in founder profiles", () => {
    document.head.innerHTML = "";
    document.title = "Senthil Kumar P | LinkedIn";
    document.body.innerHTML = `
      <main>
        <section aria-label="Primary content">
          <h1>Senthil Kumar P</h1>
          <p>Co-Founder at VAMOSYS</p>
          <p>Chennai, Tamil Nadu, India</p>
          <button>Message</button>
          <button>Follow</button>
          <button>More</button>
          <button aria-label="VAMOSYS">
            <figure></figure>
            <p>VAMOSYS</p>
          </button>
          <button aria-label="Madurai Kamaraj University">
            <figure></figure>
            <p>Madurai Kamaraj University</p>
          </button>
        </section>
      </main>
    `;

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/senthil-kumar-p-vamosys/");
    expect(result.candidates[0]).toMatchObject({
      fullName: "Senthil Kumar P",
      company: "VAMOSYS",
      title: "Co-Founder at VAMOSYS",
      location: "Chennai, Tamil Nadu, India",
    });
    expect(result.companySuggestion).toBe("VAMOSYS");
  });

  it("ignores image credential overlays and still picks the current company", () => {
    document.head.innerHTML = "";
    document.title = "Deepa Pandian | LinkedIn";
    document.body.innerHTML = `
      <main>
        <section aria-label="Primary content">
          <h1>Deepa Pandian</h1>
          <p>HR Manager</p>
          <p>VAMOSYS</p>
          <p>Chennai, Tamil Nadu, India</p>
          <a href="https://bizmagnets.ai">bizmagnets.ai</a>
          <button aria-label="This image has content credentials."><figure></figure></button>
          <button>Message</button>
          <button>Follow</button>
        </section>
      </main>
    `;

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/deepa-pandian-91a6531a0/");
    expect(result.candidates[0]).toMatchObject({
      fullName: "Deepa Pandian",
      title: "HR Manager",
      company: "VAMOSYS",
      location: "Chennai, Tamil Nadu, India",
    });
    expect(result.companySuggestion).toBe("VAMOSYS");
  });

  it("reads the company from the top affiliation pair even when only text lines are available", () => {
    document.head.innerHTML = "";
    document.title = "Nithya G | LinkedIn";
    document.body.innerHTML = `
      <main>
        <section aria-label="Primary content">
          <h1>Nithya G</h1>
          <p>CPO @ ChatOps.health | Making hospital discharges predictable | WhatsApp-native hospital workflows.</p>
          <p>ChatOps.health · Kandaswami Kandars College</p>
          <p>Chennai, Tamil Nadu, India</p>
          <button>Message</button>
          <button>Follow</button>
          <button>More</button>
        </section>
        <section>
          <h2>About</h2>
          <p>I’m the Chief Product Officer at BizMagnets.</p>
        </section>
      </main>
    `;

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/nithyasenthilkumar/");
    expect(result.candidates[0]).toMatchObject({
      fullName: "Nithya G",
      title: "CPO @ ChatOps.health | Making hospital discharges predictable | WhatsApp-native hospital workflows.",
      company: "ChatOps.health",
      location: "Chennai, Tamil Nadu, India",
    });
    expect(result.companySuggestion).toBe("ChatOps.health");
  });

  it("does not let highlights overwrite the current company from the live profile", () => {
    document.head.innerHTML = "";
    document.title = "Ruchi Bhatia | LinkedIn";
    document.body.innerHTML = `
      <main>
        <section aria-label="Primary content">
          <h1>Ruchi Bhatia</h1>
          <p>Technical Product Marketing at AWS | Youngest 3x Kaggle Grandmaster | Speaker | Empowering Early Career Professionals to Break into Tech</p>
          <p>Amazon Web Services (AWS) · Carnegie Mellon University</p>
          <p>San Francisco Bay Area</p>
        </section>
        <section>
          <h2>Highlights</h2>
          <p>You both worked at Carnegie Mellon University and Google</p>
        </section>
      </main>
    `;

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/ruchi798/");
    expect(result.candidates[0]).toMatchObject({
      fullName: "Ruchi Bhatia",
      title: "Technical Product Marketing at AWS | Youngest 3x Kaggle Grandmaster | Speaker | Empowering Early Career Professionals to Break into Tech",
      company: "Amazon Web Services (AWS)",
      location: "San Francisco Bay Area",
    });
    expect(result.companySuggestion).toBe("Amazon Web Services (AWS)");
  });

  it("uses the Experience Present role instead of a previous employer in About", () => {
    document.head.innerHTML = "";
    document.title = "Emily McLaughlin | LinkedIn";
    document.body.innerHTML = `
      <section class="artdeco-card pv-top-card">
        <h1>Emily McLaughlin</h1>
        <div class="text-body-medium">Leading product vision and strategy for next-generation AI platforms</div>
        <a href="https://www.linkedin.com/company/astrobotic/">You both worked at Astrobotic</a>
      </section>
      <section>
        <p>Previously at Astrobotic and Actalent. Grateful for my time at Argo AI.</p>
      </section>
      <section class="artdeco-card">
        <div id="experience"></div>
        <h2>Experience</h2>
        <ul>
          <li>
            <a href="https://www.linkedin.com/company/citi/">
              <span aria-hidden="true">Citi</span>
            </a>
            <span>Director, Product Strategy</span>
            <span>Jan 2024 - Present · 2 yrs</span>
          </li>
          <li>
            <a href="https://www.linkedin.com/company/astrobotic/">
              <span aria-hidden="true">Astrobotic</span>
            </a>
            <span>Senior People Operations Partner</span>
            <span>Jul 2023 - Jan 2024</span>
          </li>
        </ul>
      </section>
    `;

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/emilyomclaughlin/");
    expect(result.candidates[0]).toMatchObject({
      fullName: "Emily McLaughlin",
      company: "Citi",
      linkedinCompanySlug: "citi",
    });
    expect(result.companySuggestion).toBe("Citi");
  });

  it("reads current company from a top-card button when LinkedIn has no /company/ link", () => {
    document.head.innerHTML = "";
    document.title = "Emily McLaughlin | LinkedIn";
    document.body.innerHTML = `
      <section class="pv-top-card">
        <h1>Emily McLaughlin</h1>
        <div class="pv-text-details__right-panel">
          <button aria-label="Current company: Citi">
            <img alt="Citi logo" />
            <span aria-hidden="true">Citi</span>
          </button>
          <button aria-label="Education University of Pittsburgh">
            <span aria-hidden="true">University of Pittsburgh</span>
          </button>
        </div>
        <button>Message</button>
        <button>Follow</button>
      </section>
    `;

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/emilyomclaughlin/");
    expect(result.companySuggestion).toBe("Citi");
  });

  it("reads current company from JSON-LD worksFor", () => {
    document.head.innerHTML = `
      <script type="application/ld+json">
        {"@context":"https://schema.org","@type":"Person","name":"Emily McLaughlin","jobTitle":"Director, Product Strategy","worksFor":{"@type":"Organization","name":"Citi"}}
      </script>
    `;
    document.title = "Emily McLaughlin | LinkedIn";
    document.body.innerHTML = `
      <h1>Emily McLaughlin</h1>
      <div class="text-body-medium">Leading product vision and strategy for next-generation AI platforms</div>
    `;

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/emilyomclaughlin/");
    expect(result.companySuggestion).toBe("Citi");
  });

  it("does not take an 'ex Company' headline as the current employer", () => {
    document.head.innerHTML = "";
    document.title = "Stanislav Beliaev | LinkedIn";
    document.body.innerHTML = `
      <h1>Stanislav Beliaev</h1>
      <div class="text-body-medium">Co-Founder &amp; CTO at Fluently, ex Nvidia</div>
    `;

    const result = parseCurrentPage(document, "https://www.linkedin.com/in/stanislav-beliaev/");
    expect(result.companySuggestion).toBe("Fluently");
  });
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMAIL_FOOTER,
  extractFirstName,
  footerToHtml,
  generateEmailGuesses,
  renderEmail,
  stripBareJobUrls,
  textToHtml,
} from "../src/index.js";

describe("email helpers", () => {
  it("extracts first names from noisy LinkedIn names", () => {
    expect(extractFirstName("Jane Doe, MBA")).toBe("Jane");
    expect(extractFirstName("José Smith (Hiring)")).toBe("José");
  });

  it("generates work email guesses from public patterns", () => {
    const guesses = generateEmailGuesses("Jane Doe", "https://www.example.com", "first.last");
    expect(guesses[0]).toMatchObject({
      email: "jane.doe@example.com",
      confidence: "high",
    });
    expect(guesses.map((guess) => guess.email)).toContain("jdoe@example.com");
  });

  it("renders only supported name placeholders", () => {
    const rendered = renderEmail(
      {
        id: "1",
        fullName: "Jane Doe",
        firstName: "Jane",
        emailCandidates: [],
        status: "new",
        createdAt: "now",
        updatedAt: "now",
        isActive: true,
      },
      {
        subject: "Hello {firstName}",
        body: "Hi {firstName},\n\nPlease see my resume.",
      },
    );
    expect(rendered.subject).toBe("Hello Jane");
    expect(rendered.body).toContain("Hi Jane,");
    expect(rendered.textBody).toContain("Hi Jane,");
    expect(rendered.missingPlaceholders).toEqual([]);
  });

  it("appends an enabled footer to text and html bodies", () => {
    const rendered = renderEmail(
      {
        id: "1",
        fullName: "Jane Doe",
        firstName: "Jane",
        email: "jane@example.com",
        emailCandidates: [],
        status: "new",
        createdAt: "now",
        updatedAt: "now",
        isActive: true,
      },
      {
        subject: "Hello {firstName}",
        body: "Hi {firstName},",
        footer: {
          ...DEFAULT_EMAIL_FOOTER,
          enabled: true,
        },
      },
    );
    expect(rendered.textBody).toContain("Hi Jane,");
    expect(rendered.textBody).toContain("Gaurav Pandey");
    expect(rendered.textBody).toContain("Portfolio: https://www.gauravpandey.site/");
    expect(rendered.htmlBody).toContain("Carnegie Mellon University");
    expect(rendered.htmlBody).toContain('href="https://www.gauravpandey.site/"');
    expect(rendered.htmlBody).toContain("#C41230");
  });

  it("skips footer when disabled", () => {
    const rendered = renderEmail(
      {
        id: "1",
        fullName: "Jane Doe",
        firstName: "Jane",
        emailCandidates: [],
        status: "new",
        createdAt: "now",
        updatedAt: "now",
        isActive: true,
      },
      {
        subject: "Hello {firstName}",
        body: "Hi {firstName},",
        footer: { ...DEFAULT_EMAIL_FOOTER, enabled: false },
      },
    );
    expect(rendered.textBody).toBe("Hi Jane,");
    expect(rendered.textBody).not.toContain("Gaurav Pandey");
  });

  it("strips bare job URLs from HTML and only hyperlinks the job ID", () => {
    const html = textToHtml(
      "Hi Jane,\n\nSaw https://jobs.acme.com/778812 — reaching out about 778812.",
      {
        jobUrl: "https://jobs.acme.com/778812",
        linkTexts: ["778812"],
      },
    );
    expect(html).toMatch(/>778812<\/a>/);
    expect(html.match(/href="https:\/\/jobs\.acme\.com\/778812"/g)?.length).toBe(1);
    expect(html).not.toMatch(/(?<!href=")https:\/\/jobs\.acme\.com\/778812/);
  });

  it("strips parenthetical bare job URLs from the body", () => {
    const html = textToHtml(
      "Hi Jane,\n\nReaching out about 778812 (https://jobs.acme.com/778812).",
      {
        jobUrl: "https://jobs.acme.com/778812",
        linkTexts: ["778812"],
      },
    );
    expect(html).toContain('href="https://jobs.acme.com/778812"');
    expect(html).toContain(">778812</a>");
    expect(html.match(/<a\b/g)?.length).toBe(1);
    expect(html).not.toContain("(https://");
  });

  it("links the job ID only once across the whole body", () => {
    const html = textToHtml(
      "Hi Jane,\n\nReaching out about 778812.\n\nHappy to chat about 778812 anytime.",
      {
        jobUrl: "https://jobs.acme.com/778812",
        linkTexts: ["778812", "Software Engineer"],
      },
    );
    expect(html.match(/href="https:\/\/jobs\.acme\.com\/778812"/g)?.length).toBe(1);
    expect(html.match(/>778812<\/a>/g)?.length).toBe(1);
    expect(html).not.toContain(">Software Engineer</a>");
  });

  it("renders jobUrl onto job ID mentions in the HTML body", () => {
    const rendered = renderEmail(
      {
        id: "1",
        fullName: "Jane Doe",
        firstName: "Jane",
        email: "jane@example.com",
        emailCandidates: [],
        status: "new",
        createdAt: "now",
        updatedAt: "now",
        isActive: true,
      },
      {
        subject: "Hello {firstName}",
        body: "Hi {firstName},\n\nInterested in req 778812.",
        jobUrl: "https://jobs.acme.com/778812",
        jobIds: ["778812"],
      },
    );
    expect(rendered.htmlBody).toContain('href="https://jobs.acme.com/778812"');
    expect(rendered.htmlBody).toContain(">778812</a>");
    expect(rendered.body).toContain("778812");
    expect(rendered.body).not.toContain("<a ");
  });

  it("stripBareJobUrls removes careers URLs from plain text", () => {
    const cleaned = stripBareJobUrls(
      "Hi Jane,\n\nSaw https://jobs.acme.com/778812 — reaching out.\n\nThanks",
      "https://jobs.acme.com/778812",
    );
    expect(cleaned).not.toContain("https://jobs.acme.com/778812");
    expect(cleaned).toContain("reaching out");
  });

  it("footerToHtml includes signature name and portfolio link", () => {
    const html = footerToHtml({ ...DEFAULT_EMAIL_FOOTER, enabled: true });
    expect(html).toContain("Gaurav Pandey");
    expect(html).toContain('href="https://www.gauravpandey.site/"');
    expect(html).toContain("#C41230");
  });
});

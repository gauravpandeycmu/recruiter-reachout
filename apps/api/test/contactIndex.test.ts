import { describe, expect, it } from "vitest";
import { ContactIndex, collectEmails, normalizeLinkedInUrl } from "../src/contactIndex.js";
import type { RecruiterCandidate } from "@recruiter/shared";

function candidate(partial: Partial<RecruiterCandidate> & Pick<RecruiterCandidate, "id" | "fullName">): RecruiterCandidate {
  const now = new Date().toISOString();
  return {
    firstName: partial.fullName.split(" ")[0] ?? partial.fullName,
    status: "new",
    createdAt: now,
    updatedAt: now,
    emailCandidates: [],
    ...partial,
  };
}

describe("contactIndex", () => {
  it("normalizes LinkedIn URLs for lookup", () => {
    expect(normalizeLinkedInUrl("https://www.linkedin.com/in/Jane-Doe/?trk=abc")).toBe(
      "https://www.linkedin.com/in/jane-doe",
    );
    expect(normalizeLinkedInUrl("https://www.linkedin.com/in/jane-doe/")).toBe(
      "https://www.linkedin.com/in/jane-doe",
    );
  });

  it("indexes primary and candidate emails", () => {
    const person = candidate({
      id: "1",
      fullName: "Jane Doe",
      email: "Jane.Doe@Example.com",
      emailCandidates: [{ email: "jdoe@example.com", pattern: "firstlast", confidence: "medium", reason: "pattern" }],
    });
    expect(collectEmails(person).sort()).toEqual(["jane.doe@example.com", "jdoe@example.com"]);
  });

  it("finds by LinkedIn and email after rebuild and updates", () => {
    const index = new ContactIndex();
    const first = candidate({
      id: "a",
      fullName: "Ada Lovelace",
      linkedinUrl: "https://www.linkedin.com/in/ada/",
      email: "ada@example.com",
    });
    index.rebuild([first]);
    expect(index.findByLinkedIn("https://www.linkedin.com/in/ada?trk=1")?.id).toBe("a");
    expect(index.findByEmail("ADA@example.com")?.id).toBe("a");

    const updated = { ...first, email: "ada.new@example.com", updatedAt: new Date().toISOString() };
    index.indexCandidate(updated);
    expect(index.findByEmail("ada@example.com")).toBeUndefined();
    expect(index.findByEmail("ada.new@example.com")?.id).toBe("a");
    expect(index.size()).toBe(1);
  });
});

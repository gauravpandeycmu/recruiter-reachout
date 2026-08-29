import { describe, expect, it } from "vitest";
import {
  dedupeRepeatedPersonName,
  extractFirstName,
  isValidEmail,
  normalizeWhitespace,
  requireFields,
  validateCandidateInput,
} from "../src/validation.js";

describe("normalizeWhitespace", () => {
  it("collapses runs of whitespace and trims", () => {
    expect(normalizeWhitespace("  Jane\u00a0\n Doe  ")).toBe("Jane Doe");
  });
});

describe("dedupeRepeatedPersonName", () => {
  it("collapses exact doubled LinkedIn names", () => {
    expect(dedupeRepeatedPersonName("Jane Doe Jane Doe")).toBe("Jane Doe");
    expect(dedupeRepeatedPersonName("Jane DoeJane Doe")).toBe("Jane Doe");
  });

  it("leaves normal names alone", () => {
    expect(dedupeRepeatedPersonName("Jane Doe")).toBe("Jane Doe");
    expect(dedupeRepeatedPersonName("Madonna")).toBe("Madonna");
  });
});

describe("extractFirstName", () => {
  it("strips titles and parenthetical noise", () => {
    expect(extractFirstName("Jane Doe, MBA")).toBe("Jane");
    expect(extractFirstName("José Smith (Hiring)")).toBe("José");
  });

  it("normalizes obvious all-caps and all-lowercase greetings", () => {
    expect(extractFirstName("SWAMINATHAN PISUPATI")).toBe("Swaminathan");
    expect(extractFirstName("christopher magalotti")).toBe("Christopher");
    expect(extractFirstName("AJ Lee")).toBe("AJ");
    expect(extractFirstName("DeShawn Smith")).toBe("DeShawn");
  });
});

describe("isValidEmail / validateCandidateInput", () => {
  it("accepts basic emails and rejects malformed ones", () => {
    expect(isValidEmail("jane@acme.com")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
  });

  it("requires a full name and validates optional email/LinkedIn", () => {
    expect(validateCandidateInput({})).toContain("Candidate full name is required.");
    expect(validateCandidateInput({ fullName: "J" })).toContain("Candidate full name is required.");
    expect(validateCandidateInput({ fullName: "Jane Doe", email: "bad" })).toContain(
      "Candidate email is invalid.",
    );
    expect(
      validateCandidateInput({ fullName: "Jane Doe", linkedinUrl: "linkedin.com/in/jane" }),
    ).toContain("LinkedIn URL must be absolute.");
    expect(validateCandidateInput({ fullName: "Jane Doe", email: "jane@acme.com" })).toEqual([]);
  });
});

describe("requireFields", () => {
  it("lists missing keys", () => {
    expect(requireFields({ a: 1, b: "", c: null }, ["a", "b", "c", "d"])).toEqual([
      "b is required.",
      "c is required.",
      "d is required.",
    ]);
  });
});

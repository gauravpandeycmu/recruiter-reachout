import type { RecruiterCandidate } from "./types.js";

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Collapse LinkedIn doubled names like "Jane Doe Jane Doe". */
export function dedupeRepeatedPersonName(value: string): string {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return "";
  }
  const exact = normalized.match(/^(.+?)\s+\1$/i);
  if (exact?.[1] && /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(exact[1])) {
    return exact[1];
  }
  const glued = normalized.match(/^(.+?)\1$/i);
  if (glued?.[1] && /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(glued[1])) {
    return glued[1];
  }
  const parts = normalized.split(/\s+/);
  if (parts.length >= 4 && parts.length % 2 === 0) {
    const half = parts.length / 2;
    const left = parts.slice(0, half).join(" ");
    const right = parts.slice(half).join(" ");
    if (left.toLowerCase() === right.toLowerCase() && /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(left)) {
      return left;
    }
  }
  return normalized;
}

export function extractFirstName(fullName: string): string {
  const cleaned = dedupeRepeatedPersonName(fullName)
    .replace(/\([^)]*\)/g, "")
    .replace(/[,|].*$/, "");
  const firstName = cleaned.split(" ").filter(Boolean)[0] ?? "";
  // LinkedIn occasionally yields SHOUTING or all-lowercase names. Normalize
  // obvious cases while preserving short initialisms such as AJ and mixed-case
  // names such as DeShawn or McKayla.
  if (firstName.length >= 3 && (firstName === firstName.toUpperCase() || firstName === firstName.toLowerCase())) {
    return `${firstName.charAt(0).toUpperCase()}${firstName.slice(1).toLowerCase()}`;
  }
  return firstName;
}

export function isValidEmail(value: string): boolean {
  return emailRegex.test(value.trim().toLowerCase());
}

export function validateCandidateInput(input: Partial<RecruiterCandidate>): string[] {
  const errors: string[] = [];
  if (!input.fullName || normalizeWhitespace(input.fullName).length < 2) {
    errors.push("Candidate full name is required.");
  }
  if (input.email && !isValidEmail(input.email)) {
    errors.push("Candidate email is invalid.");
  }
  if (input.linkedinUrl && !input.linkedinUrl.startsWith("http")) {
    errors.push("LinkedIn URL must be absolute.");
  }
  return errors;
}

export function requireFields<T extends Record<string, unknown>>(
  input: T,
  fields: Array<keyof T>,
): string[] {
  return fields
    .filter((field) => input[field] === undefined || input[field] === null || input[field] === "")
    .map((field) => `${String(field)} is required.`);
}

import { describe, expect, it } from "vitest";
import { loginUrlFor, profileDirFor } from "../src/setupSessions.js";
import { STREAK_EXTENSION_ID } from "../src/streakExtension.js";

describe("setup session helpers", () => {
  it("maps login kinds to profile dirs and URLs", () => {
    expect(loginUrlFor("gmail")).toContain("mail.google.com");
    expect(loginUrlFor("jobright")).toContain("jobright");
    expect(loginUrlFor("linkedin")).toContain("linkedin.com");
    expect(profileDirFor("gmail")).toContain("gmail-profile");
    expect(profileDirFor("linkedin")).toContain("salesql-profile");
  });
});

describe("streak extension", () => {
  it("uses the Streak Email Tracking extension id", () => {
    expect(STREAK_EXTENSION_ID).toBe("jcgpgjhaendighananonflfmjjefjjlp");
  });
});

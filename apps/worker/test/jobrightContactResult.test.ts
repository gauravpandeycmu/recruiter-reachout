import { describe, expect, it } from "vitest";
import {
  classifyJobrightContactToast,
  contactResultFromSignals,
  JOBRIGHT_CONTACT_RESULT_TEXT,
  pickJobrightRevealEmail,
} from "../src/jobrightContactResult.js";

describe("classifyJobrightContactToast", () => {
  it("recognizes the live found toast", () => {
    expect(classifyJobrightContactToast("✅ Contact Info Found!")).toBe("found");
    expect(classifyJobrightContactToast("Contact Info Found")).toBe("found");
  });

  it("does not treat a miss toast as found just because it contains those words", () => {
    expect(classifyJobrightContactToast("No Contact Info Found")).toBe("not_found");
    expect(classifyJobrightContactToast("Contact Info Not Found!")).toBe("not_found");
    expect(classifyJobrightContactToast("No contact found")).toBe("not_found");
    expect(classifyJobrightContactToast("Contact not found")).toBe("not_found");
    expect(classifyJobrightContactToast("Couldn't find contact info")).toBe("not_found");
  });

  it("returns unknown for unrelated copy", () => {
    expect(classifyJobrightContactToast("Find Any Email")).toBe("unknown");
    expect(classifyJobrightContactToast("")).toBe("unknown");
  });
});

describe("JOBRIGHT_CONTACT_RESULT_TEXT", () => {
  it("matches both found and miss toasts so waitForContactResult does not sit for 90s on a miss", () => {
    expect(JOBRIGHT_CONTACT_RESULT_TEXT.test("Contact Info Found!")).toBe(true);
    expect(JOBRIGHT_CONTACT_RESULT_TEXT.test("Contact Info Not Found!")).toBe(true);
    expect(JOBRIGHT_CONTACT_RESULT_TEXT.test("No Contact Info Found")).toBe(true);
  });
});

describe("contactResultFromSignals", () => {
  it("maps a miss toast to a conclusive not-found (not a timeout)", () => {
    expect(contactResultFromSignals({ toastText: "Contact Info Not Found!" })).toEqual({ found: false });
    expect(contactResultFromSignals({ toastText: "No Contact Info Found" }).timedOut).toBeUndefined();
  });

  it("maps the found toast plus Connect Now to found", () => {
    expect(
      contactResultFromSignals({
        toastText: "✅ Contact Info Found! Ephin Principal Recruiter @ Google",
        connectNowVisible: true,
      }),
    ).toMatchObject({ found: true });
  });

  it("treats Connect Now with no toast copy as found (heading copy drifted)", () => {
    expect(contactResultFromSignals({ connectNowVisible: true })).toEqual({ found: true });
  });

  it("does not let Connect Now override an explicit miss toast", () => {
    expect(
      contactResultFromSignals({
        toastText: "Contact Info Not Found!",
        connectNowVisible: true,
      }),
    ).toEqual({ found: false });
  });

  it("keeps a wait timeout as timedOut so Jobright retries instead of parking the person", () => {
    expect(contactResultFromSignals({ timedOut: true })).toEqual({ found: false, timedOut: true });
  });
});

describe("pickJobrightRevealEmail", () => {
  it("picks the reveal-modal email and ignores the LinkedIn URL field", () => {
    expect(
      pickJobrightRevealEmail([
        "https://www.linkedin.com/in/ephinjose/",
        "ephinj@google.com",
        "Seeking Your Advice on Software Engineer - New Grad Position at Google",
      ]),
    ).toBe("ephinj@google.com");
  });

  it("returns undefined when no field looks like an email", () => {
    expect(pickJobrightRevealEmail(["https://www.linkedin.com/in/jane/", "Hello there"])).toBeUndefined();
  });
});

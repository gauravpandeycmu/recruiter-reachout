import { describe, expect, it } from "vitest";
import { extractGeminiResponseText, extractJsonObjectText } from "../src/geminiResponse.js";

describe("extractGeminiResponseText", () => {
  it("joins non-thought answer parts and ignores Gemma thought parts", () => {
    const text = extractGeminiResponseText({
      candidates: [
        {
          content: {
            parts: [
              { thought: true, text: "reasoning…" },
              { text: '{"subject":"Hi"}' },
            ],
          },
        },
      ],
    });
    expect(text).toBe('{"subject":"Hi"}');
  });

  it("falls back to concatenating all parts when every part is a thought", () => {
    const text = extractGeminiResponseText({
      candidates: [
        {
          content: {
            parts: [{ thought: true, text: "only thinking" }],
          },
        },
      ],
    });
    expect(text).toBe("only thinking");
  });

  it("returns empty string for empty payloads", () => {
    expect(extractGeminiResponseText({})).toBe("");
    expect(extractGeminiResponseText({ candidates: [] })).toBe("");
  });
});

describe("extractJsonObjectText", () => {
  it("strips markdown fences around JSON", () => {
    expect(extractJsonObjectText('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("pulls the first object out of preamble + trailing notes", () => {
    expect(extractJsonObjectText('Here you go:\n{"subject":"Hi","body":"Yo"}\nThanks!')).toBe(
      '{"subject":"Hi","body":"Yo"}',
    );
  });

  it("returns cleaned text unchanged when it is already parseable JSON", () => {
    expect(extractJsonObjectText('{"ok":true}')).toBe('{"ok":true}');
  });

  it("returns empty input as empty", () => {
    expect(extractJsonObjectText("   ")).toBe("");
  });
});

/** Shared helpers for Gemini / Gemma generateContent payloads. */

export interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string; thought?: boolean }>;
    };
  }>;
}

/** Prefer the final answer part; Gemma may prepend a `thought: true` reasoning part. */
export function extractGeminiResponseText(payload: GeminiResponse): string {
  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  const answerParts = parts.filter((part) => !part.thought && typeof part.text === "string" && part.text.trim());
  if (answerParts.length > 0) {
    return answerParts.map((part) => part.text ?? "").join("").trim();
  }
  return parts
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

/** Pull the first JSON object out of model text (fences, preamble, trailing notes). */
export function extractJsonObjectText(text: string): string {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (!cleaned) {
    return cleaned;
  }
  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    // continue
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return cleaned.slice(start, end + 1);
  }
  return cleaned;
}

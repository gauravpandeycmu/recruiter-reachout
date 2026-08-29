import type { EmailSample } from "@recruiter/shared";
import { extractJobIdFromUrl, extractJobIds, isOpaqueAtsJobId, stripBareJobUrls } from "@recruiter/shared";
import { extractGeminiResponseText, extractJsonObjectText, type GeminiResponse } from "./geminiResponse.js";
import type { GenerationProgressStep } from "./jobPosting.js";
import { recordLlmUsage } from "./llmUsage.js";

export type { GenerationProgressStep };
export { extractGeminiResponseText, extractJsonObjectText } from "./geminiResponse.js";

export interface GenerateContentInput {
  company: string;
  samples: EmailSample[];
  companyFact?: string;
  roleTitle?: string;
  jobDescription?: string;
  /** Public URL for the job posting — hyperlinked onto the job ID once in the sent HTML. */
  jobUrl?: string;
  /** Optional LinkedIn post by the recruiter (or about the company) to reference naturally. */
  linkedinPost?: string;
  /**
   * LinkedIn headline/title one-liners for people in this outreach batch
   * (e.g. "Technical Recruiter at Apple", "Engineering Manager").
   * Used to write for a recruiter vs a hiring manager correctly.
   */
  recipientTitles?: string[];
  /**
   * When true, write a warmer, slightly longer email that shows genuine fondness
   * for what the company builds (Gemini-style passion beat).
   */
  passionate?: boolean;
}

export type RecipientAudience = "recruiter" | "hiring_manager" | "mixed" | "unknown";

export interface GeneratedContent {
  subject: string;
  body: string;
  linkedinSubject: string;
  linkedinMessage: string;
  /** Model id used for this generation (e.g. gemma-4-31b-it). */
  model: string;
  /** Rule violations that survived the repair pass. Content is still usable; review before sending. */
  warnings?: string[];
}

const DEFAULT_MODEL = "gemma-4-31b-it";
// Keep enough of the posting for requirements while reserving prompt budget for
// the candidate evidence and the two channel-specific drafts.
const MAX_JOB_DESCRIPTION_CHARS = 4500;
const MAX_LINKEDIN_POST_CHARS = 4000;
// Cold outreach should be substantial enough to establish relevance but still
// scannable. The prompt targets 60-100 words and this deterministic ceiling
// prevents the repair pass from accepting cover-letter-length drafts.
const MAX_BODY_WORDS = 110;
const MAX_BODY_WORDS_PASSIONATE = 200;
const MAX_SUBJECT_CHARS = 60;
const MAX_LINKEDIN_WORDS = 60;
const MAX_LINKEDIN_CHARS = 400;
/** Full/truncated UUIDs and long hexadecimal ATS keys should not appear in outreach prose. */
const OPAQUE_ATS_ID_FRAGMENT_IN_BODY_RE =
  /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f-]{0,14}|[0-9a-f]{20,32})\b/i;

function normalizeHttpUrl(value?: string): string | undefined {
  const raw = value?.trim();
  if (!raw) {
    return undefined;
  }
  try {
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(withProtocol);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Keep both the overview and late qualification sections for long postings. */
function compactJobDescription(value?: string): string | undefined {
  const text = value?.trim();
  if (!text || text.length <= MAX_JOB_DESCRIPTION_CHARS) {
    return text || undefined;
  }
  const tailChars = 1_500;
  const headChars = MAX_JOB_DESCRIPTION_CHARS - tailChars - 48;
  return `${text.slice(0, headChars).trimEnd()}\n\n[...middle of posting omitted...]\n\n${text.slice(-tailChars).trimStart()}`;
}

const ROLE_TOKEN_STOP_WORDS = new Set([
  "software",
  "engineer",
  "engineering",
  "senior",
  "junior",
  "staff",
  "role",
  "full",
  "time",
  "united",
  "states",
]);

function normalizedRoleText(value?: string): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function linkedinPostClearlyMatchesTarget(
  roleTitle?: string,
  jobDescription?: string,
  linkedinPost?: string,
): boolean {
  const post = linkedinPost?.trim();
  if (!post) {
    return false;
  }
  const normalizedPost = normalizedRoleText(post);
  const normalizedRole = normalizedRoleText(roleTitle);
  if (normalizedRole && normalizedPost.includes(normalizedRole)) {
    return true;
  }
  const baseRole = normalizedRole
    .replace(/\b(?:i{1,4}|[1-4])\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (baseRole.length >= 8 && normalizedPost.includes(baseRole)) {
    return true;
  }
  const roleTokens = normalizedRole
    .split(" ")
    .filter((token) => (token.length >= 4 || /\d/.test(token)) && !ROLE_TOKEN_STOP_WORDS.has(token));
  if (roleTokens.some((token) => normalizedPost.includes(token))) {
    return true;
  }
  const targetIds = new Set(extractJobIds(jobDescription));
  return extractJobIds(post).some((id) => targetIds.has(id));
}

const RECRUITER_TITLE_RE =
  /\b(recruiter|talent acquisition|talent partner|sourcer|staffing|people partner|hr business partner|university recruiter|campus recruiter|technical recruiting)\b/i;
const HIRING_MANAGER_TITLE_RE =
  /\b(hiring manager|engineering manager|software manager|product manager|director|head of|vp\b|vice president|team lead|tech lead|engineering lead|manager)\b/i;
const TITLE_NOISE_RE =
  /\b(?:reach out|market value|doesn['’]t|they['’]re|commented|reposted|view my profile)\b/i;

function isUsableRecipientTitle(title: string): boolean {
  return title.length <= 180 && !TITLE_NOISE_RE.test(title);
}

/**
 * Stock phrases that make cold email read as templated/AI-written. The prompt
 * bans them; the validator catches any that slip through so the repair pass
 * can strip them.
 */
/** Always banned — empty AI fluff even in passionate mode. */
const BANNED_PHRASES_ALWAYS = [
  "leverage",
  "delve",
  "esteemed",
  "aligns perfectly",
  "aligns well",
  "i would be a great fit",
  "don't hesitate to",
  "dear hiring manager",
  "to whom it may concern",
  "innovative culture",
  "exciting mission",
  "sheer scale",
  "marketing ecosystem",
];

/**
 * Roles that explicitly ask candidates to change how they engineer with AI
 * need more than a generic AI mention. These expressions identify that kind
 * of target and the concrete, verified T-Mobile evidence that can support it.
 */
const DISTINCTIVE_AI_WORKFLOW_CONTEXT_RE =
  /\b(?:coding agents?|automated verification|continuous benchmark(?:ing)?|llmops|agentic workflows?|llm-as-a-judge|model strengths?|failure modes?)\b/i;
const DISTINCTIVE_AI_WORKFLOW_FOCUS_RE =
  /\b(?:ai[- ]assisted (?:development|engineering)|ai[- ]native (?:development|engineering|practices?)|coding agents?|automated verification|continuous benchmark(?:ing)?|llmops|agentic workflows?|evaluation|production (?:ai )?(?:reliability|systems?|infrastructure)|failure modes?)\b/i;
const DISTINCTIVE_AI_WORKFLOW_PROOF_RE =
  /\b(?:llm[- ]as[- ]a[- ]judge|deterministic (?:tool )?(?:checks?|validation)|gitlab ci\/?cd|cross-repository|canary releases?|flagger|automatically roll(?:ed|ing)? back|validated \d+ workflows?|scenarios? concurrently|evaluation framework)\b/i;
const GENERIC_MATCH_CLAIM_RE =
  /\b(?:aligns?(?:\s+(?:very|particularly|closely|strongly|perfectly|well))?\s+with|fits?\s+(?:well\s+)?with|(?:great|strong|perfect)\s+(?:fit|match)\b)/i;
const CONCRETE_ACCOMPLISHMENT_RE =
  /\b(?:built|engineered|developed|implemented|optimized|reduced|scaled|resolved|automated|designed|architected|deployed|migrated|validated|gated|provisioned|operated|eliminated|streamlined|remediated)\b/i;

/** Banned only in the short/default mode — passionate mode allows warmer openers. */
const BANNED_PHRASES_DEFAULT_ONLY = [
  "i hope this email finds you well",
  "i hope this finds you well",
  "i am writing to express",
  "i'm writing to express",
  "i am reaching out to express",
  "passionate",
  "resonates with me",
  "i look forward to hearing from you",
];

/** Phrases that assume the recipient owns an engineering team — wrong for recruiters. */
const RECRUITER_BANNED_TEAM_PHRASES = [
  "your team",
  "on your team",
  "join your team",
  "with your team",
  "for your team",
];

export function classifyRecipientAudience(titles: string[] | undefined): RecipientAudience {
  const cleaned = (titles ?? [])
    .map((title) => title.trim())
    .filter((title) => Boolean(title) && isUsableRecipientTitle(title));
  if (cleaned.length === 0) {
    return "unknown";
  }
  let recruiterHits = 0;
  let managerHits = 0;
  for (const title of cleaned) {
    const isRecruiter = RECRUITER_TITLE_RE.test(title);
    const isManager = HIRING_MANAGER_TITLE_RE.test(title) && !isRecruiter;
    if (isRecruiter) {
      recruiterHits += 1;
    } else if (isManager) {
      managerHits += 1;
    }
  }
  if (recruiterHits > 0 && managerHits > 0) {
    return "mixed";
  }
  if (recruiterHits > 0) {
    return "recruiter";
  }
  if (managerHits > 0) {
    return "hiring_manager";
  }
  return "unknown";
}

function uniqueTitles(titles: string[] | undefined, limit = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const title of titles ?? []) {
    const cleaned = title.replace(/\s+/g, " ").trim();
    if (!cleaned || !isUsableRecipientTitle(cleaned)) {
      continue;
    }
    const key = cleaned.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(cleaned);
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

/**
 * Generates a personalized subject/body for a target company from the user's
 * past sample emails, using Gemini. Single generation call, then deterministic
 * validation; only if a rule is broken does a second (repair) call run.
 * Configure GEMINI_API_KEY (+ optional GEMINI_MODEL) in .env.
 */
export async function generateCompanyEmailContent(
  input: GenerateContentInput,
  onProgress?: (step: GenerationProgressStep) => void,
): Promise<GeneratedContent> {
  if (!input.company?.trim()) {
    throw new Error("Company name is required to generate personalized content.");
  }
  if (input.samples.length === 0) {
    throw new Error("Add at least one sample email before generating personalized content.");
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured. Add it to .env to enable personalization.");
  }

  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;

  onProgress?.("voice");
  onProgress?.("draft");
  const draft = sanitizeGeneratedEmail(
    parseGeneratedContent(await callGemini(buildPersonalizationPrompt(input), apiKey, model, "email_draft")),
    input.jobUrl,
  );
  onProgress?.("review");
  const issues = validateGeneratedEmail(draft, input.samples, input);
  if (issues.length === 0) {
    onProgress?.("polish");
    return { ...draft, model };
  }

  onProgress?.("polish");
  const repaired = sanitizeGeneratedEmail(
    parseGeneratedContent(
      await callGemini(buildRepairPrompt(draft, issues, input.company, input.passionate), apiKey, model, "email_repair"),
    ),
    input.jobUrl,
  );
  const remaining = validateGeneratedEmail(repaired, input.samples, input);
  if (remaining.length > 0) {
    return { ...repaired, model, warnings: remaining };
  }
  return { ...repaired, model };
}

function sanitizeGeneratedEmail(
  content: Pick<GeneratedContent, "subject" | "body" | "linkedinSubject" | "linkedinMessage">,
  jobUrl?: string,
): Pick<GeneratedContent, "subject" | "body" | "linkedinSubject" | "linkedinMessage"> {
  const scrubDashes = (value: string) =>
    value
      .replace(/\s*[—–]\s*/g, ", ")
      .replace(/,\s*,+/g, ",")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  const normalizeCompletedInternship = (value: string) =>
    value
      .replace(
        /\bI(?:'m| am)\s+currently\s+interning\s+at\s+T-Mobile\s+building\s+AI\s+infrastructure\s+and\s+backend\s+systems\b/gi,
        "I recently completed an Agentic AI internship at T-Mobile, where I built AI infrastructure and backend systems",
      )
      .replace(
        /\bI(?:'m| am)\s+currently\s+interning\s+at\s+T-Mobile\s+building\s+backend\s+systems\b/gi,
        "I recently completed an internship at T-Mobile, where I built backend systems",
      )
      .replace(
        /\bI(?:'m| am)\s+currently\s+interning\s+at\s+T-Mobile\s+focusing\s+on\s+backend\s+systems\s+and\s+AI\s+infrastructure\b/gi,
        "I recently completed an Agentic AI internship at T-Mobile, focused on backend systems and AI infrastructure",
      );
  return {
    subject: scrubDashes(content.subject),
    linkedinSubject: scrubDashes(content.linkedinSubject),
    body: stripBareJobUrls(normalizeCompletedInternship(scrubDashes(content.body)), jobUrl),
    linkedinMessage: stripBareJobUrls(normalizeCompletedInternship(scrubDashes(content.linkedinMessage)), jobUrl),
  };
}

async function callGemini(prompt: string, apiKey: string, model: string, purpose: "email_draft" | "email_repair" = "email_draft"): Promise<string> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.6, responseMimeType: "application/json" },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Gemini API failed (${response.status}): ${await response.text()}`);
  }

  const payload = (await response.json()) as GeminiResponse;
  const text = extractGeminiResponseText(payload);
  recordLlmUsage({
    purpose,
    model,
    promptChars: prompt.length,
    responseChars: text.length,
  });
  return text;
}

function buildAudienceSection(audience: RecipientAudience, titles: string[]): string[] {
  const titleLine =
    titles.length > 0
      ? `- Actual LinkedIn titles in this batch: ${titles.map((title) => `"${title}"`).join("; ")}`
      : "- No LinkedIn titles were provided for this batch.";

  if (audience === "hiring_manager") {
    return [
      "== AUDIENCE (hiring manager / eng lead — NOT a recruiter) ==",
      titleLine,
      "These people own or lead a team/product. Write like you are asking to contribute to their work.",
      '- "your team" / joining their group is fine when it fits.',
      "- Lead with one technically credible result they can evaluate, then connect it to one distinctive responsibility in the posting.",
      "- Keep the ask narrow: ask them to consider or take a quick look at this specific application, not for a meeting, career advice, or a list of openings.",
      "",
    ];
  }

  if (audience === "mixed") {
    return [
      "== AUDIENCE (mixed: recruiters AND managers in this batch) ==",
      titleLine,
      "Write language that works for both: focus on open roles / openings at the company, not \"your team\".",
      "- Do NOT say \"your team\", \"join your team\", or assume the reader manages engineers.",
      "- Prefer \"roles you're hiring for\", \"openings at {company}\", or \"software engineering roles\".",
      "- Lead with resume-legible signal; keep jargon light enough for a recruiter and concrete enough for a manager.",
      "",
    ];
  }

  // Default: recruiter (explicit or unknown — this product's primary use case)
  return [
    "== AUDIENCE (recruiter / talent — NOT a hiring manager) ==",
    titleLine,
    audience === "unknown"
      ? "No clear titles were provided, so assume a recruiter who screens and routes candidates to open reqs."
      : "These people screen and route candidates to open reqs. They usually do NOT own an engineering team.",
    "- Lead with resume-legible signal a recruiter can act on fast: the exact role/level being targeted, plus one recognizable result from the samples.",
    "- Make it easy to route: be clear about the kind of role wanted so they can match a req or forward it.",
    "- Skip deep technical jargon; keep proof concrete but plainly legible to a non-engineer.",
    "- Keep the ask narrow: ask them to consider or route this specific application, not for a meeting, career advice, or a list of openings.",
    '- NEVER say "your team", "join your team", "on your team", or anything that assumes they manage engineers.',
    '- Prefer "roles you\'re hiring for", "openings you support", "reqs you\'re filling", or "software engineering roles at {company}".',
    "",
  ];
}

export function buildPersonalizationPrompt(input: GenerateContentInput): string {
  const company = input.company.trim();
  const roleTitle = input.roleTitle?.trim();
  const companyFact = input.companyFact?.trim();
  const jobDescription = compactJobDescription(input.jobDescription);
  const linkedinPost = input.linkedinPost?.trim().slice(0, MAX_LINKEDIN_POST_CHARS);
  const jobUrl = normalizeHttpUrl(input.jobUrl);
  const titles = uniqueTitles(input.recipientTitles);
  const audience = classifyRecipientAudience(titles);
  const passionate = Boolean(input.passionate);

  const sampleBlocks = input.samples
    .map((sample, index) => `--- SAMPLE ${index + 1} ---\nSubject: ${sample.subject}\nBody:\n${sample.body}`)
    .join("\n\n");

  const lines: string[] = [];

  if (passionate) {
    lines.push(
      "== PASSIONATE MODE (ON — NON-NEGOTIABLE) ==",
      `You MUST write a warmer, slightly LONGER email (~110-160 words) that shows genuine fondness for ${company}.`,
      "This is different from the short default outreach. If you write a short generic note with no company-fondness beat, you have failed.",
      "Required shape:",
      "1. Brief warm opener optional (\"I hope you are doing well\") if samples use one.",
      `2. Strong interest in the role/opening at ${company} (include job/req ID in the hook when one exists).`,
      `3. COMPANY FONDNESS (required, 1-2 full sentences): sound like a person who actually cares about ${company}'s work, not like you skimmed a marketing page.`,
      "   GOOD (human): the kind of systems/product they build, why that craft is interesting, a plain observation from experience or common knowledge.",
      "   Example vibe: \"I've always liked how Epsilon sits in the middle of real marketing systems. The data problems get serious at that scale.\"",
      "   BAD (AI/brochure): copying flashy stats from the JD (\"400 billion consumer actions daily\"), \"marketing ecosystem\", \"sheer scale at which the company operates\", or other press-release language.",
      "   Prefer qualitative craft over numbers. If a number is in the JD, do NOT paste it; rephrase the idea in everyday words.",
      "   Forbidden generics: \"innovative culture\", \"exciting mission\", \"great company\".",
      "4. Who you are + proof from the samples, tied to THIS company's work.",
      "5. Resume ask + warm close in the samples' style.",
      "Good pattern (adapt to this company; do NOT invent events the job seeker attended):",
      `  "I am writing to express my strong interest in the ${roleTitle || "role"} at ${company}.`,
      `   I've always been drawn to [plain description of what ${company} builds], and I'm eager to bring my background in [skills from samples] to that work."`,
      "",
    );
  }

  lines.push(
    "You ghost-write cold outreach emails from a job seeker.",
    passionate
      ? `The goal: a warm, sincere email that clearly shows fondness for what ${company} builds — still worth a busy recruiter's reply.`
      : "The only goal: an email a busy recipient can read in 15 seconds, immediately see this person is worth a reply, and act on.",
    "",
    ...buildAudienceSection(audience, titles),
    "== VOICE (from samples) ==",
    "The samples at the bottom were written by the job seeker for OTHER companies, often in unrelated industries. Use them carefully:",
    "- KEEP: greeting style, sentence rhythm, formality, closing style, and candidate facts about the job seeker themselves (school/program, years of experience, employer names, general skills like Java, distributed systems, product work).",
    passionate
      ? `- DROP: industry angles from the samples that do not fit ${company}. DO write fondness for ${company}'s own domain/products.`
      : "- DROP: industry angles, product domains, and company-specific hooks from the samples. If a sample pitched crypto/Web3/fintech/healthcare/etc. for that sample's company, do NOT copy that angle onto a different target.",
    "- Prefer broadly transferable software/product engineering signal over niche domain work that only made sense for the sample's company.",
    "- Do NOT include a sign-off or signature block (no 'Best,', name, school, phone, or portfolio). A global footer is appended automatically.",
    "- Never invent new accomplishments, employers, schools, or skills that do not appear in the samples.",
    "- Contractions and plain words are good. It must read like a person typed it quickly, not like a cover letter.",
    "- Never use em dashes (—) or en dashes (–). Use a comma, period, or a short new sentence instead. Hyphenated words like full-time are fine.",
    "",
  );

  if (!passionate) {
    lines.push(
      "== STRUCTURE (three short moves, ~60-100 words total) ==",
      "This job seeker's emails that get replies all follow the same shape. Follow it:",
      "1. HOOK (one sentence): after the greeting, state the concrete reason for writing - their LinkedIn post, the specific opening (include the job/req ID here when one exists), or how the job seeker found them. Straight in; zero warm-up sentences.",
      "2. WHO + PROOF (one short paragraph): who the job seeker is (program/school, years of experience, employer names from the samples), then one plain sentence tying 2-4 transferable skills/experiences to THIS company's work — not to the sample's industry.",
      "3. ASK (one sentence): end with one specific, low-effort action, usually asking them to consider, review, or route this application. Mention the attached resume in that same sentence when natural. A brief 'Thank you for your time' may follow, but drop 'I look forward to hearing from you' and other ceremonial filler.",
      "Enthusiasm for the company helps and fits inside move 1 or 2 as a single clause - but only when pointed at something concrete (the specific opening, a provided fact or post, or a widely known product/business of this company). Show it through the detail; never say the word itself, and never generic mission-gushing ('I admire your innovative culture'). If there is nothing specific to point at, skip it.",
      "Nothing else. No extra paragraph about the company's mission, no restating the resume.",
      "",
    );
  }

  lines.push(
    "== TARGET ==",
    `- Company: ${company}`,
    roleTitle
      ? `- Role applying for: ${roleTitle}`
      : "- Role applying for: (not specified; frame as software engineering / product engineering unless the job description says otherwise — do NOT copy a niche role angle from the samples)",
    companyFact
      ? `- One verified fact about the company you may mention naturally: ${companyFact}`
      : `- No extra company fact provided. Use widely known, stable public knowledge of what ${company} does (industry and flagship products/business). Example: Apple → consumer devices, software, services — not crypto. Do not invent recent news, funding, team names, or unverified details.`,
    passionate ? `- Passionate mode is ON for ${company}. The company-fondness beat is mandatory.` : "",
    "",
  );

  if (!jobDescription) {
    lines.push(
      "== NO JOB DESCRIPTION ==",
      `- Still tailor to ${company}: pick sample credentials this recipient would care about, and frame the ask around roles that fit what the company is known for.`,
      "- Never transplant the sample's industry onto this company just because it appeared in a sample.",
      "",
    );
  }

  if (jobDescription) {
    const jobIds = extractJobIds(jobDescription);
    const urlJobId = extractJobIdFromUrl(jobUrl);
    const primaryIds = jobIds.length > 0 ? jobIds : urlJobId ? [urlJobId] : [];
    lines.push(
      "== JOB DESCRIPTION ==",
      jobDescription,
      "",
      "== HOW TO TAILOR TO THE JOB DESCRIPTION ==",
      "- Pick the 1-2 accomplishments from the samples that best match what this job asks for. Lead with those; drop everything else.",
      "- The proof paragraph must connect one distinctive requirement from this posting to one verified candidate accomplishment. Name the mechanism, evaluation method, system, or outcome that makes the connection credible.",
      "- Avoid generic match claims such as \"aligns well\" or a bare list of skills. Show the match through shared concrete terms from the posting and the candidate evidence.",
      "- For AI-assisted engineering roles, prefer specific proof such as deterministic checks, LLM-as-a-judge evaluation, CI/CD integration, concurrent scenarios, or canary-release gating when those details match the posting.",
      "- Do not claim domain experience the candidate evidence does not establish. For example, connect transferable distributed-systems and verification work to a database role without claiming database-internals experience.",
      "- Echo one or two concrete terms from the job description (product, team, stack) so it is obviously written for this role - but only terms that actually appear in it.",
      "- Do not summarize the job description back to the recipient, and do not claim any skill it asks for unless the samples show it.",
      "",
    );
    if (primaryIds.length > 0 && isOpaqueAtsJobId(primaryIds[0])) {
      const role = roleTitle || "the opening";
      lines.push(
        "== JOB / REQ ID (opaque ATS identifier — do not paste) ==",
        `- Detected posting ID: ${primaryIds[0]}`,
        "- This is a machine-oriented ATS identifier. Do NOT paste it into the subject or body — it looks broken and recruiters do not route on it in email.",
        `- Mention the role title naturally in the hook instead (e.g. "reaching out about the ${role} role").`,
        "- Do not invent a shorter/truncated version of the identifier either.",
        "- Do NOT paste the job posting URL into the email — the send pipeline hyperlinks the role title once.",
        "",
      );
    } else if (primaryIds.length > 0) {
      lines.push(
        "== JOB / REQ ID (required) ==",
        `- Detected ID(s): ${primaryIds.join(", ")}`,
        "- Recruiters route by ID. Put the primary ID in the HOOK — ideally the first sentence after the greeting, or the subject if it still fits under 60 characters.",
        `- Good patterns: "reaching out about ${primaryIds[0]}", "interested in req ${primaryIds[0]}", "applying to ${primaryIds[0]} (${roleTitle || "the opening"})".`,
        "- Mention the ID exactly as written above. Do not invent extra IDs. If multiple IDs appear, use the first/primary one unless the posting clearly marks another as primary.",
        "- Do NOT paste the job posting URL into the email — the send pipeline hyperlinks this ID once.",
        "",
      );
    } else {
      lines.push(
        "== JOB / REQ ID ==",
        "- If the job description includes a job ID, requisition ID, posting ID, or similar code, mention that exact ID early in the hook (first sentence after the greeting is best).",
        "- If the only ID is an opaque ATS identifier, skip it and mention the role title instead.",
        "- If no ID is present, do not invent one.",
        "",
      );
    }
    if (jobUrl) {
      const uuidPrimary = primaryIds[0] && isOpaqueAtsJobId(primaryIds[0]);
      lines.push(
        "== JOB POSTING LINK ==",
        `- A job posting URL exists (${jobUrl}), but do NOT paste that URL into the subject or body.`,
        uuidPrimary
          ? `- Mention the role title (${roleTitle || "the opening"}) in the body. The send pipeline turns that title into one clickable link.`
          : primaryIds[0]
            ? `- Mention only the job/req ID (${primaryIds[0]}) in the body. The send pipeline turns that single ID into one clickable link.`
            : "- If you mention a job/req ID, the send pipeline turns that ID into a clickable link.",
        "- Do not write https://…, www.…, or any bare careers URL in the email body.",
        "",
      );
    }
  } else if (jobUrl) {
    const urlJobId = extractJobIdFromUrl(jobUrl);
    if (urlJobId && isOpaqueAtsJobId(urlJobId)) {
      const role = roleTitle || "the opening";
      lines.push(
        "== JOB / REQ ID (opaque ATS identifier — do not paste) ==",
        `- Detected posting ID from the URL: ${urlJobId}`,
        "- This is a machine-oriented ATS identifier. Do NOT paste it (or any truncated form) into the email.",
        `- Mention the role title naturally (e.g. "reaching out about the ${role} role"). The send pipeline hyperlinks the role title once.`,
        "- Do NOT paste the job posting URL into the email body.",
        "",
      );
    } else if (urlJobId) {
      lines.push(
        "== JOB / REQ ID (required) ==",
        `- Detected ID from the posting URL: ${urlJobId}`,
        `- Mention ${urlJobId} early in the hook (e.g. "reaching out about ${urlJobId}"). The send pipeline hyperlinks that ID once.`,
        "- Do NOT paste the job posting URL into the email body.",
        "",
      );
    }
    lines.push(
      "== JOB POSTING LINK ==",
      `- A job posting URL exists (${jobUrl}), but do NOT paste that URL into the subject or body.`,
      urlJobId && isOpaqueAtsJobId(urlJobId)
        ? `- Mention the role (${roleTitle || "the opening"}) early. The send pipeline hyperlinks the role title once — never paste the opaque identifier.`
        : roleTitle
          ? `- Mention the role (${roleTitle}) early. Mention the job/req ID if known — the send pipeline hyperlinks the ID only, once.`
          : "- Mention the opening early. Mention the job/req ID if known — the send pipeline hyperlinks the ID only, once.",
      "- Do not write https://…, www.…, or any bare careers URL in the email body.",
      "",
    );
  }

  if (linkedinPost) {
    const postMatchesTarget = linkedinPostClearlyMatchesTarget(roleTitle, jobDescription, linkedinPost);
    lines.push(
      "== LINKEDIN POST (post text pasted by the job seeker — not a LinkedIn URL) ==",
      linkedinPost,
      "",
      "== HOW TO USE THE LINKEDIN POST ==",
      "- Optionally open with a brief, natural nod to something specific in the post (topic, advice, hiring note, or detail) — e.g. that you saw their post about X.",
      "- When the post describes a distinctive way of working or must-have trait, carry that idea into the email's proof paragraph and connect it to verified candidate evidence. Do not reserve the useful post detail for LinkedIn only.",
      "- Keep it to one short clause or sentence; do not quote long stretches or summarize the whole post.",
      "- Only reference details that actually appear in the post text above. Never invent what they posted.",
      "- If the post is unrelated to hiring/roles, still use one concrete detail as a human opener, then pivot to the ask.",
      "- Do not force a post reference if it would sound awkward; a light touch is better than a forced one.",
      "- Never invent or include a linkedin.com URL.",
      postMatchesTarget
        ? "- The post contains role/req details that corroborate this target, so it is safe to say the post led you to this specific opening."
        : "- IMPORTANT: The post does not clearly name or corroborate this target role/req. Do not imply that the post advertised this job or team. If you reference the post, keep it separate from the sentence naming the target role; otherwise omit the post reference.",
      "",
    );
  }

  const extraContextBits = [
    jobDescription && "job description",
    jobUrl && "job posting link",
    companyFact && "company fact",
    linkedinPost && "LinkedIn post",
  ].filter(Boolean);
  const audienceRule =
    audience === "hiring_manager"
      ? "- Recipient is a hiring manager / eng lead: \"your team\" is allowed when natural."
      : '- Recipient is a recruiter (or mixed/unknown): NEVER say "your team" / "join your team". Talk about roles, openings, or reqs instead.';

  if (passionate) {
    lines.push(
      "== HARD RULES (passionate mode) ==",
      "- Body: aim for 110-160 words (hard cap 200). Include the company-fondness beat; this mode is allowed to be warmer and a bit longer.",
      '- Subject: under 60 characters, front-loaded. Role + strongest credential works well.',
      "- Keep the token {firstName} exactly as-is wherever the recipient's first name goes. Never replace or drop it.",
      "- Strong interest language is encouraged when concrete (e.g. \"strong interest in … at {company}\", \"impressed by …\", \"eager to … at {company}\").",
      "- Company fondness must sound human: plain craft/product language. Do NOT paste brochure stats or JD marketing numbers (no \"X billion … daily\").",
      "- Still avoid empty fluff: no \"innovative culture\", \"exciting mission\", \"leverage\", \"delve\", \"esteemed\", \"aligns perfectly\", \"sheer scale\", \"marketing ecosystem\".",
      "- Never use em dashes (—) or en dashes (–).",
      "- Never invent events the job seeker attended, news, funding, or skills not in the samples.",
      audienceRule,
      extraContextBits.length
        ? `- Ground the fondness beat in widely known facts about ${company} and/or the provided ${extraContextBits.join(" / ")}, but rephrase in everyday words — never copy flashy metrics.`
        : `- Ground the fondness beat in widely known facts about what ${company} does (products / business), in everyday words.`,
      `- Never copy a sample's niche domain onto ${company} unless it clearly matches this company or appears in the provided job description / company fact / LinkedIn post.`,
      "- A resume PDF is attached; mention it only if the samples mention theirs.",
      "",
    );
  } else {
    lines.push(
      "== HARD RULES ==",
      "- Body: aim for 60-100 words (hard cap 110), following the three-move structure above, plain text.",
      '- Subject: 60 characters or fewer, direct and informative. Front-load the exact role or req, then at most one relevant credential if it fits. No clickbait, vague "quick note", all-caps urgency, or credential laundry lists.',
      "- Keep the token {firstName} exactly as-is wherever the recipient's first name goes. Never replace or drop it.",
      "- If a target role/level is known (above), name it plainly so the recipient can match it to a req; otherwise use a sensible software/product engineering framing for this company — not a niche industry from the samples.",
      "- Exactly one ask at the end: a specific, low-effort request to consider, review, or route this application. Never a meeting demand or multiple requests. A short thank-you is fine; omit 'I look forward to hearing from you'.",
      '- Never make open-ended, self-serving asks ("what roles are available", "can you help me find a job", "any opportunities?"). A polite, specific ask the recipient can act on is what works.',
      audienceRule,
      extraContextBits.length
        ? `- You may use widely known facts about what ${company} does, plus the provided ${extraContextBits.join(" / ")}. Do not invent recent news, funding, posts, or team names.`
        : `- You may use widely known facts about what ${company} does (industry / flagship products). Do not invent recent news, funding, posts, or team names.`,
      `- Never copy a sample's niche domain (crypto, Web3, blockchain, DeFi, etc.) onto ${company} unless that domain clearly matches this company or appears in the provided job description / company fact / LinkedIn post.`,
      '- Never use these phrases or anything in their family: "I hope this email finds you well", "I am writing to express", "Dear Hiring Manager", "passionate", "leverage", "delve", "esteemed", "aligns well", "fits well", "great fit", or "strong match".',
      "- The proof paragraph must contain one concrete accomplishment, not a bare list introduced by 'my background in'.",
      "- Never use em dashes (—) or en dashes (–). Use a comma, period, or a short new sentence instead.",
      "- A resume PDF is attached to the email; mention it only if the samples mention theirs.",
      "",
    );
  }

  lines.push(
    "== VERIFIED CANDIDATE EVIDENCE BANK (choose ONE strongest proof) ==",
    "Use one accomplishment that best matches the target. Do not cram multiple metrics into one email, and never turn this into a resume summary.",
    "",
    "RECENT AI EXPERIENCE (T-Mobile; use when relevant):",
    "The job seeker recently completed an Agentic AI internship at T-Mobile in Seattle.",
    "This internship is completed, not ongoing. Never say the job seeker is currently interning at T-Mobile.",
    "Verified work you may draw from:",
    "- Built an autonomous voice-agent validation framework with OpenAI Realtime APIs for T-Mobile's 611 assistant.",
    "- Simulated multi-turn calls and validated 10 workflows with deterministic tool checks and LLM-as-a-judge evaluation.",
    "- Put agent validation into cross-repository GitLab CI/CD, using ephemeral Kubernetes environments and running 10 scenarios concurrently.",
    "- Gated Flagger canary releases with agent validation, automatically rolling back failures or progressively increasing production traffic.",
    "Use this evidence prominently when the role, job description, company fact, or LinkedIn post concerns AI, agents, LLMs, voice AI, evaluation, platform/infra, CI/CD, Kubernetes, or production reliability.",
    "When AI is not relevant, mention T-Mobile briefly as recognizable engineering experience or choose stronger matching evidence from the samples. Never force the word AI repeatedly.",
    "",
    "PRODUCTION / BACKEND EXPERIENCE (Epsilon):",
    "- Reduced data-ingestion latency from 30 seconds to 5 seconds by introducing asynchronous fetching and refactoring bottleneck APIs using Kibana logs.",
    "- Served as a primary on-call engineer for 2+ years and resolved 80+ Kubernetes microservice production issues, including pod, deployment, and service outages.",
    "- Built a TestNG API automation suite for critical data feeds, increasing end-to-end testing frequency from weekly to hourly.",
    "- Reduced AWS resource utilization by 60% by reviewing SnapLogic pipeline architecture and adding granular recovery checkpoints.",
    "- Built an Amazon Bedrock prototype to improve search over Datahub feed payloads.",
    "",
    "DISTRIBUTED SYSTEMS / DATA / CLOUD PROJECTS:",
    "- Built a Spark pipeline over 1 TB of Twitter JSON plus a Go/gRPC ranking API; migrated it to Aurora and EKS with Terraform and scaled it beyond 7,000 RPS.",
    "- Built a LangGraph support assistant with RAG evidence checks and an evaluation harness over 50 labeled tickets, reaching 96% triage accuracy.",
    "- Built an AWS autoscaling service with ALB, Auto Scaling Groups, CloudWatch, Python, and Terraform, tuning it against dynamic RPS targets.",
    "For database, backend, infrastructure, reliability, data-platform, security, or cloud roles, prefer the closest Epsilon/project proof above instead of forcing the T-Mobile AI story.",
    "",
    "== OUTPUT ==",
    "Return one email plus a LinkedIn subject and LinkedIn message, grounded in the same strongest evidence, but do not make them identical.",
    "LinkedIn message rules:",
    "- Provide a LinkedIn subject line under 60 characters. It should feel human and specific, not salesy or clickbait.",
    "- Aim for 35-55 words; hard caps are 60 words and 400 characters. This is a LinkedIn message/InMail, not a connection request. Conversational, no sign-off, and no 'Would you be open to connecting?' ending.",
    "- Keep {firstName} exactly as-is. Open exactly as 'Hi {firstName},' followed by a blank line, then the message.",
    linkedinPost
      ? '- Because a post was provided, the LinkedIn message MUST begin its hook with "I saw your post about ..." and name one specific, accurate detail from that post before pivoting to the role.'
      : "- With no post provided, lead with the specific role/company reason for connecting. Never claim you saw a post.",
    "- Use one concrete proof point, preferably the T-Mobile agentic-AI work when the target context is AI-related.",
    "- If helpful, end with a very short final paragraph noting that the resume is attached and asking them to take a quick look at the application. Do not mention connecting.",
    "- Do not use generic networking filler such as 'I would love to connect and learn more about your journey.'",
    'Strict JSON only, exactly {"subject": string, "body": string, "linkedinSubject": string, "linkedinMessage": string}. Use \\n for line breaks in the body and LinkedIn message. No markdown fences, no commentary.',
    "",
    "== SAMPLES (voice + transferable credentials only; ignore each sample's target-company industry) ==",
    sampleBlocks,
  );

  return lines.join("\n");
}

export function buildRepairPrompt(
  draft: Pick<GeneratedContent, "subject" | "body" | "linkedinSubject" | "linkedinMessage">,
  issues: string[],
  company?: string,
  passionate?: boolean,
): string {
  return [
    "You wrote this cold outreach email from a job seeker to a recruiter:",
    "",
    company ? `Target company: ${company.trim()}` : "",
    passionate
      ? "Mode: passionate — keep the warmer company-fondness beat; do not strip it down to a short generic note."
      : "",
    `Subject: ${draft.subject}`,
    "Body:",
    draft.body,
    "LinkedIn subject:",
    draft.linkedinSubject,
    "LinkedIn message:",
    draft.linkedinMessage,
    "",
    "It breaks these rules:",
    ...issues.map((issue) => `- ${issue}`),
    "",
    passionate
      ? "Rewrite it fixing ONLY these problems. Keep the warm company-fondness and transferable credentials; drop any niche industry angle that does not fit the target company."
      : "Rewrite it fixing ONLY these problems. Keep the voice and transferable credentials; drop any niche industry angle that does not fit the target company.",
    "Keep the token {firstName} exactly as-is wherever the recruiter's first name goes.",
    'Respond with strict JSON only, exactly {"subject": string, "body": string, "linkedinSubject": string, "linkedinMessage": string}. Use \\n for line breaks. No markdown fences, no commentary.',
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Deterministic checks for the failure modes that actually make generated
 * cold email bad: dropped {firstName} token, rambling length, templated
 * AI phrases, leftover bracket placeholders, and niche sample-domain leakage
 * (e.g. crypto/Web3 copied onto Apple).
 */
export function validateGeneratedEmail(
  content: Pick<GeneratedContent, "subject" | "body"> & { linkedinSubject?: string; linkedinMessage?: string },
  samples: EmailSample[],
  context?: Pick<
    GenerateContentInput,
    | "company"
    | "companyFact"
    | "jobDescription"
    | "jobUrl"
    | "linkedinPost"
    | "roleTitle"
    | "recipientTitles"
    | "passionate"
  >,
): string[] {
  const issues: string[] = [];
  const combined = `${content.subject}\n${content.body}`;
  const combinedLower = combined.toLowerCase();
  const targetContext = [
    context?.roleTitle,
    context?.jobDescription,
    context?.linkedinPost,
    context?.companyFact,
  ]
    .filter(Boolean)
    .join("\n");
  const linkedinMessage = content.linkedinMessage?.trim();

  if (linkedinMessage) {
    const linkedinWordCount = linkedinMessage.split(/\s+/).length;
    if (linkedinWordCount > MAX_LINKEDIN_WORDS) {
      issues.push(`The LinkedIn message is ${linkedinWordCount} words; cut it to ${MAX_LINKEDIN_WORDS} words or fewer.`);
    }
    if (linkedinMessage.length > MAX_LINKEDIN_CHARS) {
      issues.push(
        `The LinkedIn message is ${linkedinMessage.length} characters; cut it to ${MAX_LINKEDIN_CHARS} characters or fewer.`,
      );
    }
    if (!linkedinMessage.includes("{firstName}")) {
      issues.push("The LinkedIn message must keep the {firstName} token.");
    }
    if (!/^Hi \{firstName\},\n\n/.test(linkedinMessage)) {
      issues.push('The LinkedIn message must begin with "Hi {firstName}," followed by a blank line.');
    }
    if (context?.linkedinPost?.trim() && !/\bi saw your post\b/i.test(linkedinMessage)) {
      issues.push('The LinkedIn message must say "I saw your post" because post text was provided.');
    }
    if (!context?.linkedinPost?.trim() && /\bi saw your post\b/i.test(linkedinMessage)) {
      issues.push("Remove the LinkedIn-post claim because no post text was provided.");
    }
    if (/\bopen to connecting\b/i.test(linkedinMessage)) {
      issues.push('Do not end the LinkedIn message with "open to connecting" language.');
    }
    if (/\b(?:i(?:'m| am)\s+currently\s+interning|currently\s+interning|i(?:'m| am)\s+interning|interning)\b.*\bt-mobile\b/i.test(linkedinMessage)) {
      issues.push("The T-Mobile internship is completed, so the LinkedIn message cannot describe it as current.");
    }
  }

  const linkedinSubject = content.linkedinSubject?.trim();
  if (linkedinSubject) {
    if (linkedinSubject.length > 60) {
      issues.push(`The LinkedIn subject is ${linkedinSubject.length} characters; shorten it to 60 characters or fewer.`);
    }
    if (/\bconnect(?:ing)?\b/i.test(linkedinSubject)) {
      issues.push("Do not make the LinkedIn subject about connecting.");
    }
  }

  const samplesUseToken = samples.some((sample) => `${sample.subject}\n${sample.body}`.includes("{firstName}"));
  if (samplesUseToken && !combined.includes("{firstName}")) {
    issues.push("The {firstName} token is missing; include it exactly as {firstName} where the recipient's first name goes.");
  }

  const wordCount = content.body.trim().split(/\s+/).length;
  const maxWords = context?.passionate ? MAX_BODY_WORDS_PASSIONATE : MAX_BODY_WORDS;
  if (wordCount > maxWords) {
    issues.push(
      context?.passionate
        ? `The body is ${wordCount} words; keep passionate emails under ${MAX_BODY_WORDS_PASSIONATE} words.`
        : `The body is ${wordCount} words; cut it to ${MAX_BODY_WORDS} words or fewer.`,
    );
  }

  const hasRichTargetContext = Boolean(context?.jobDescription?.trim() || context?.linkedinPost?.trim());
  if (hasRichTargetContext && !context?.passionate) {
    if (wordCount < 55) {
      issues.push(
        `The body is only ${wordCount} words despite having job/post context; write a concise 60-100 word note with one concrete proof point.`,
      );
    }
    if (!CONCRETE_ACCOMPLISHMENT_RE.test(content.body)) {
      issues.push(
        "Replace the bare skills/background list with one concrete verified accomplishment (what was built or improved, how, and a result when available).",
      );
    }
  }

  if (GENERIC_MATCH_CLAIM_RE.test(content.body)) {
    issues.push(
      "Remove the generic fit/alignment claim. Demonstrate relevance by connecting one concrete accomplishment to one specific requirement.",
    );
  }

  if (
    context?.linkedinPost?.trim() &&
    context?.jobDescription?.trim() &&
    context?.roleTitle?.trim() &&
    !linkedinPostClearlyMatchesTarget(context.roleTitle, context.jobDescription, context.linkedinPost) &&
    /\bi saw your post about\b/i.test(content.body)
  ) {
    issues.push(
      "The LinkedIn post does not clearly corroborate this target role or req. Do not imply that the post advertised this job/team; separate the post reference from the role or omit it.",
    );
  }

  if (context?.passionate) {
    const companyName = context.company?.trim();
    if (companyName && !combinedLower.includes(companyName.toLowerCase())) {
      issues.push(`Mention ${companyName} when showing why you're interested in them.`);
    }
    if (wordCount < 85) {
      issues.push(
        "Passionate mode requires a longer email (~110-160 words) with a clear company-fondness beat — this draft is too short/generic.",
      );
    }
    const hasFondness =
      /impressed|eager to|strong interest|excited about|drawn to|care about|admir(?:e|ation)|fond of|what .+ builds|engineering culture|scope of work|product(?:s)? you|your (?:platform|product|exchange|devices|software)|always (?:liked|been)|data problems|kind of (?:work|systems)/i.test(
        content.body,
      );
    if (!hasFondness) {
      issues.push(
        "Add 1-2 concrete sentences of fondness for what this company builds (a product, craft, or culture detail) — not generic praise.",
      );
    }
    if (/\d[\d,]{2,}\s*(billion|million|trillion)/i.test(content.body)) {
      issues.push(
        "Drop brochure-style stats (e.g. '400 billion…'). Describe the company's work in plain human terms instead.",
      );
    }
  }

  if (/[—–]/.test(combined)) {
    issues.push("Replace em/en dashes (— / –) with a comma, period, or a short new sentence so it reads more human.");
  }

  if (/\b(?:i(?:'m| am)\s+currently\s+interning|currently\s+interning|i(?:'m| am)\s+interning|interning)\b.*\bt-mobile\b/i.test(combined)) {
    issues.push("The T-Mobile internship is completed, so the email cannot describe it as current.");
  }

  if (content.subject.length > MAX_SUBJECT_CHARS) {
    issues.push(`The subject is ${content.subject.length} characters; shorten it to under 60 characters.`);
  }

  for (const phrase of context?.passionate ? BANNED_PHRASES_ALWAYS : [...BANNED_PHRASES_ALWAYS, ...BANNED_PHRASES_DEFAULT_ONLY]) {
    if (combinedLower.includes(phrase)) {
      issues.push(`Remove the phrase "${phrase}"; it reads as templated.`);
    }
  }

  if (DISTINCTIVE_AI_WORKFLOW_CONTEXT_RE.test(targetContext)) {
    const namesDistinctiveFocus = DISTINCTIVE_AI_WORKFLOW_FOCUS_RE.test(content.body);
    const givesConcreteProof = DISTINCTIVE_AI_WORKFLOW_PROOF_RE.test(content.body);
    if (!namesDistinctiveFocus || !givesConcreteProof) {
      issues.push(
        "Add a concrete AI-workflow bridge: name the posting's distinctive engineering focus and connect it to verified evidence such as deterministic checks, LLM-as-a-judge evaluation, CI/CD integration, concurrent scenarios, or canary-release gating. Do not settle for a generic skills-match sentence.",
      );
    }
  }

  const placeholder = combined.match(/\[(?:[A-Za-z][A-Za-z ]{1,30})\]/);
  if (placeholder) {
    issues.push(`Remove the unfilled placeholder ${placeholder[0]}; write the real content instead.`);
  }

  const jobIds = extractJobIds(context?.jobDescription);
  const urlJobId = extractJobIdFromUrl(context?.jobUrl);
  const primaryId = jobIds[0] ?? urlJobId;
  if (primaryId && isOpaqueAtsJobId(primaryId)) {
    // Machine-oriented ATS IDs should never appear in the body (full or truncated).
    if (OPAQUE_ATS_ID_FRAGMENT_IN_BODY_RE.test(combined)) {
      issues.push(
        "Remove the opaque ATS identifier (and any truncated form of it) from the email — mention the role title instead.",
      );
    }
    const roleTitle = context?.roleTitle?.trim();
    if (roleTitle && !combinedLower.includes(roleTitle.toLowerCase())) {
      issues.push(
        `Mention the role title (${roleTitle}) early in the email — ideally in the first sentence after the greeting.`,
      );
    }
  } else if (primaryId && !combinedLower.includes(primaryId.toLowerCase())) {
    issues.push(
      `Mention the job/req ID (${primaryId}) early in the email — ideally in the first sentence after the greeting.`,
    );
  }

  const jobUrl = normalizeHttpUrl(context?.jobUrl);
  if (jobUrl) {
    const urlLower = jobUrl.toLowerCase();
    const urlHostPath = (() => {
      try {
        const parsed = new URL(jobUrl);
        return `${parsed.host}${parsed.pathname}`.toLowerCase();
      } catch {
        return urlLower;
      }
    })();
    if (combinedLower.includes(urlLower) || combinedLower.includes(urlHostPath) || /https?:\/\//i.test(combined)) {
      issues.push(
        primaryId && isOpaqueAtsJobId(primaryId)
          ? "Remove the bare job posting URL from the email body. Mention the role title — it will be hyperlinked automatically on send."
          : "Remove the bare job posting URL from the email body. Mention only the job/req ID — it will be hyperlinked automatically on send.",
      );
    }
  }

  const leaked = findLeakedNicheDomain(combinedLower, context);
  if (leaked) {
    issues.push(
      `Remove the niche domain angle "${leaked}" — it came from a sample for a different industry and does not fit ${context?.company?.trim() || "this company"}. Use transferable credentials instead.`,
    );
  }

  const audience = classifyRecipientAudience(context?.recipientTitles);
  if (audience !== "hiring_manager") {
    for (const phrase of RECRUITER_BANNED_TEAM_PHRASES) {
      if (combinedLower.includes(phrase)) {
        issues.push(
          `Remove "${phrase}" — this recipient is a recruiter (or mixed/unknown), not a hiring manager. Talk about roles/openings/reqs instead of their team.`,
        );
        break;
      }
    }
  }

  return issues;
}

/** Niche domains that often leak from samples into unrelated company emails. */
const NICHE_DOMAIN_PACKS: Array<{ label: string; terms: string[]; allowedHints: string[] }> = [
  {
    label: "crypto/Web3",
    terms: [
      "web3",
      "crypto",
      "cryptocurrency",
      "cryptopedia",
      "blockchain",
      "defi",
      "nft",
      "decentralized",
      "smart contract",
      "solidity",
      "ethereum",
      "bitcoin",
    ],
    allowedHints: [
      "crypto",
      "web3",
      "blockchain",
      "coinbase",
      "binance",
      "kraken",
      "consensys",
      "ripple",
      "circle",
      "opensea",
      "ethereum",
      "bitcoin",
      "defi",
      "nft",
    ],
  },
];

function findLeakedNicheDomain(
  emailLower: string,
  context?: Pick<GenerateContentInput, "company" | "companyFact" | "jobDescription" | "jobUrl" | "linkedinPost" | "roleTitle">,
): string | undefined {
  const allowedContext = [
    context?.company,
    context?.companyFact,
    context?.jobDescription,
    context?.jobUrl,
    context?.linkedinPost,
    context?.roleTitle,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  for (const pack of NICHE_DOMAIN_PACKS) {
    if (pack.allowedHints.some((hint) => allowedContext.includes(hint))) {
      continue;
    }
    const hit = pack.terms.find((term) => emailLower.includes(term));
    if (hit) {
      return pack.label;
    }
  }
  return undefined;
}

export function parseGeneratedContent(text: string): Pick<GeneratedContent, "subject" | "body" | "linkedinSubject" | "linkedinMessage"> {
  const cleaned = extractJsonObjectText(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Gemini response was not valid JSON.");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Gemini response was not a JSON object.");
  }

  const subject = (parsed as Record<string, unknown>).subject;
  const body = (parsed as Record<string, unknown>).body;
  const linkedinSubject = (parsed as Record<string, unknown>).linkedinSubject;
  const linkedinMessage = (parsed as Record<string, unknown>).linkedinMessage;
  if (
    typeof subject !== "string" ||
    !subject.trim() ||
    typeof body !== "string" ||
    !body.trim() ||
    typeof linkedinSubject !== "string" ||
    !linkedinSubject.trim() ||
    typeof linkedinMessage !== "string" ||
    !linkedinMessage.trim()
  ) {
    throw new Error("Gemini response is missing a usable subject/body/LinkedIn subject/LinkedIn message.");
  }

  return {
    subject: subject.trim(),
    body: body.trim(),
    linkedinSubject: linkedinSubject.trim(),
    linkedinMessage: linkedinMessage.trim(),
  };
}

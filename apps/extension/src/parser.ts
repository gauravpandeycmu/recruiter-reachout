import { extractFirstName, normalizeWhitespace } from "@recruiter/shared";

export interface PageCandidate {
  fullName: string;
  firstName: string;
  title?: string;
  company?: string;
  /** LinkedIn /company/{slug} for the current role, when the profile exposes one. */
  linkedinCompanySlug?: string;
  location?: string;
  linkedinUrl?: string;
  profilePhotoUrl?: string;
}

export interface PageParseResult {
  candidates: PageCandidate[];
  companySuggestion?: string;
}

export function parseCurrentPage(documentRef: Document, href: string): PageParseResult {
  if (isLinkedInProfileUrl(href)) {
    const candidate = parseLinkedInProfile(documentRef, href);
    return {
      candidates: candidate ? [candidate] : [],
      companySuggestion: candidate?.company,
    };
  }
  const candidates = parseSearchResults(documentRef);
  return {
    candidates,
    companySuggestion:
      inferSelectedCompanyFromSearchPage(documentRef, href, candidates) ??
      inferCompanyFromSearchUrl(href) ??
      inferCompanyFromPage(candidates),
  };
}

export function isLinkedInProfileUrl(href: string | undefined): boolean {
  return Boolean(href && /linkedin\.com\/in\//i.test(href));
}

export function parseLinkedInProfile(documentRef: Document, href: string): PageCandidate | undefined {
  const fullName = inferProfileFullName(documentRef, href);
  if (!fullName) {
    return undefined;
  }
  // Keep newlines: the title regex relies on line boundaries so it stops before
  // action-bar text ("More", "Message", "Follow") that follows the headline.
  const rawText = documentRef.body?.innerText || documentRef.body?.textContent || "";
  const text = normalizeWhitespace(rawText);
  const headline =
    sanitizeHeadline(readTopCardHeadline(documentRef)) ||
    sanitizeHeadline(firstHeadlineLineFromRawText(rawText) ?? "") ||
    sanitizeHeadline(jobTitleFromJsonLd(documentRef) ?? "") ||
    undefined;
  // Recruiter-word fallback is last resort only, and must look like a real title
  // (not hashtags / About fluff like "recruiting #QualityThroughData…").
  const recruiterFallback = sanitizeHeadline(
    rawText.match(
      /(?:Sr\.?\s+|Senior\s+|Lead\s+|Principal\s+|Staff\s+)?(?:Technical\s+)?(?:Recruiter|Talent Acquisition|Sourcer|Recruiting)(?:\s+(?:Partner|Specialist|Manager|Lead))?(?:\s+[@@]\s+[^\n.#]{2,40}|\s+at\s+[^\n.#]{2,40})?/i,
    )?.[0] ?? "",
  );
  const title =
    headline ||
    (recruiterFallback && !looksLikeHashtagNoise(recruiterFallback) ? recruiterFallback : undefined) ||
    undefined;
  const location = extractProfileLocation(documentRef, rawText);
  const inferred = inferCompanyFromProfile(documentRef, text, title);
  const profilePhotoUrl = extractProfilePhotoForPerson(documentRef, fullName, href);
  return {
    fullName,
    firstName: extractFirstName(fullName),
    title,
    company: inferred.company,
    linkedinCompanySlug: inferred.linkedinCompanySlug,
    location,
    linkedinUrl: href.split("?")[0],
    profilePhotoUrl,
  };
}

/** Prefer the top-card headline only — page-wide `.text-body-medium` often hits
 *  sidebar / "People also viewed" recruiter cards first on eng profiles. */
function readTopCardHeadline(documentRef: Document): string {
  const scoped = documentRef.querySelector(
    [
      ".pv-text-details__left-panel .text-body-medium",
      "main [role='main'] .text-body-medium",
      "main [aria-label='Primary content'] .text-body-medium",
      "section.artdeco-card .text-body-medium",
      ".ph5 .text-body-medium",
      "[data-generated-suggestion-target] .text-body-medium",
    ].join(", "),
  )?.textContent;
  if (scoped?.trim()) {
    return scoped;
  }
  const nearby = primaryContentLines(documentRef).find((line) => looksLikeHeadlineLine(line));
  if (nearby) {
    return nearby;
  }
  // Fall back to first medium body text only if it doesn't look like sidebar noise.
  const first = documentRef.querySelector(".text-body-medium")?.textContent ?? "";
  return first;
}

function jobTitleFromJsonLd(documentRef: Document): string | undefined {
  for (const script of documentRef.querySelectorAll('script[type="application/ld+json"]')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent ?? "");
    } catch {
      continue;
    }
    const nodes: unknown[] = Array.isArray(parsed) ? [...parsed] : [parsed];
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { "@graph"?: unknown[] })["@graph"])) {
      nodes.push(...((parsed as { "@graph": unknown[] })["@graph"]));
    }
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const record = node as Record<string, unknown>;
      if (record["@type"] === "Person" && typeof record.jobTitle === "string" && record.jobTitle.trim()) {
        return record.jobTitle.trim();
      }
    }
  }
  return undefined;
}

function looksLikeHashtagNoise(value: string): boolean {
  return /#\w/.test(value) || /^recruiting\b/i.test(value.trim());
}

/**
 * Location must be a short City, Region line — never a job title glued onto
 * "Redmond, Washington" (greedy `[A-Z][A-Za-z .]+` previously swallowed headlines).
 */
function extractProfileLocation(documentRef: Document, rawText: string): string | undefined {
  const fromDom =
    normalizeWhitespace(
      documentRef.querySelector(
        [
          ".pv-text-details__left-panel .text-body-small",
          ".ph5 .text-body-small",
          "span.text-body-small.inline",
        ].join(", "),
      )?.textContent ?? "",
    ) || undefined;
  if (fromDom && isPlausibleLocation(fromDom)) {
    return fromDom.slice(0, 80);
  }
  const nearby = primaryContentLines(documentRef).find((line) => isPlausibleLocation(line));
  if (nearby) {
    return nearby.slice(0, 80);
  }
  for (const line of rawText.split(/\n+/)) {
    const cleaned = normalizeWhitespace(line);
    const match = cleaned.match(
      /\b([A-Z][a-zA-Z .'-]{1,40}),\s*(United States|USA|US|[A-Z][a-zA-Z ]{2,20})\b/,
    );
    if (!match) continue;
    const candidate = `${match[1]}, ${match[2]}`;
    if (isPlausibleLocation(candidate) && !/\bat\b/i.test(candidate)) {
      return candidate.slice(0, 80);
    }
  }
  return undefined;
}

function isPlausibleLocation(value: string): boolean {
  const v = value.trim();
  if (v.length < 3 || v.length > 80) return false;
  if (looksLikeUtilityText(v)) return false;
  if (/^[·•]\s*\d/.test(v) || /^·\s*(1st|2nd|3rd|\d+(?:st|nd|rd|th))$/i.test(v)) return false;
  if (!/,/.test(v) && !/\barea\b/i.test(v)) return false;
  // Job-title leakage: "Principal … at Microsoft Redmond, Washington"
  if (
    /\b(Engineer|Engineering|Manager|Director|Lead|Recruiter|Software|Principal|Staff|Founder|Co-Founder|CEO|CTO|COO|President|VP|Vice President)\b/i.test(
      v,
    ) &&
    /\bat\b/i.test(v)
  ) {
    return false;
  }
  if (/#\w/.test(v)) return false;
  return true;
}

/** Trim action-bar text, doubled visible+sr-only twins, and emoji off a headline. */
function sanitizeHeadline(value: string): string {
  const deduped = dedupeRepeatedName(normalizeWhitespace(value));
  const cut = deduped.split(/\s+(?:More|Message|Follow|Connect|Pending|Visit my website|Contact info)\b/i)[0] ?? "";
  return normalizeWhitespace(cut.replace(/[\u{E000}-\u{F8FF}\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}️]/gu, " ")).slice(0, 180);
}

function firstHeadlineLineFromRawText(rawText: string): string | undefined {
  for (const line of rawText.split(/\n+/).map((entry) => normalizeWhitespace(entry))) {
    if (!line) {
      continue;
    }
    if (/^(about|activity|featured|highlights|experience|top skills)$/i.test(line)) {
      break;
    }
    if (looksLikeHeadlineLine(line) && !looksLikeHashtagNoise(line)) {
      return line;
    }
  }
  return undefined;
}

function primaryContentLines(documentRef: Document): string[] {
  const root =
    documentRef.querySelector("main [aria-label='Primary content']") ??
    documentRef.querySelector("main [role='main']") ??
    documentRef.querySelector("main");
  if (!(root instanceof HTMLElement)) {
    return [];
  }
  const selectors = "h1, h2, h3, p, span, a";
  const lines: string[] = [];
  for (const node of root.querySelectorAll<HTMLElement>(selectors)) {
    const text = normalizeWhitespace(node.textContent ?? "");
    if (!text) {
      continue;
    }
    if ((node.tagName === "H2" || node.tagName === "H3") && /^(about|activity|featured|highlights|experience|top skills)$/i.test(text)) {
      break;
    }
    if (node.querySelector(selectors)) {
      continue;
    }
    if (text.length <= 140) {
      lines.push(text);
    }
    if (lines.length >= 80) {
      break;
    }
  }
  return lines;
}

function looksLikeHeadlineLine(value: string): boolean {
  const v = value.trim();
  if (v.length < 6 || v.length > 180) return false;
  if (/^[·•]\s*\d/.test(v) || /^(\d+\+?\s+)?connections?$/i.test(v)) return false;
  if (/^(contact info|message|follow|more|pending)$/i.test(v)) return false;
  if (isPlausibleLocation(v)) return false;
  return /(?:\bat\b|\||engineer|engineering|recruiter|manager|director|architect|developer|product|software|founder|lead|scientist|marketing|officer|chief|ceo|cto|coo|cpo|vp|president|head\b|@)/i.test(
    v,
  );
}

function inferCompanyFromHeroLines(documentRef: Document): { company?: string } {
  const lines = primaryContentLines(documentRef);
  const pairCompany = affiliationPairCompany(lines);
  if (pairCompany) {
    return { company: pairCompany };
  }
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || looksLikeUtilityText(line) || looksLikeSchool(line) || isPlausiblePersonName(line)) {
      continue;
    }
    if (looksLikeHeadlineLine(line)) {
      continue;
    }
    const pairMatch = line.match(/^(.{2,60}?)\s*·\s*(.{2,80})$/);
    if (pairMatch?.[1]) {
      const first = cleanCompanyName(pairMatch[1]);
      if (looksLikeCompanyName(first) && !looksLikeSchool(first) && !looksLikeProfileAction(first)) {
        return { company: first };
      }
    }
    if (
      looksLikeCompanyName(line) &&
      !looksLikeSchool(line) &&
      !looksLikeProfileAction(line) &&
      !isPlausibleLocation(line) &&
      !looksLikeWebsiteLine(line) &&
      !looksLikeOpenToWorkLine(line) &&
      !/^[·•]\s*\d/.test(line)
    ) {
      return { company: cleanCompanyName(line) };
    }
  }
  return {};
}

function affiliationPairCompany(lines: string[]): string | undefined {
  for (const raw of lines) {
    const line = raw.trim();
    const pairMatch = line.match(/^(.{2,80}?)\s*·\s*(.{2,100})$/);
    if (!pairMatch?.[1] || !pairMatch[2]) {
      continue;
    }
    const first = cleanCompanyName(pairMatch[1]);
    const second = normalizeWhitespace(pairMatch[2]);
    if (!first || !looksLikeCompanyName(first) || looksLikeSchool(first) || isPlausibleLocation(first)) {
      continue;
    }
    if (looksLikeSchool(second)) {
      return first;
    }
  }
  return undefined;
}

/** Resolve profile name from h1, meta tags, title, or URL slug — LinkedIn often delays/hides h1. */
export function inferProfileFullName(documentRef: Document, href: string): string | undefined {
  const headingCandidates = [...documentRef.querySelectorAll("h1, h2")]
    .map((el) => normalizeWhitespace(el.textContent ?? ""))
    .filter((name) => isPlausiblePersonName(name));
  if (headingCandidates[0]) {
    return headingCandidates[0];
  }

  const topCard = documentRef.querySelector(
    [
      ".pv-text-details__left-panel h1",
      ".pv-text-details__left-panel h2",
      ".ph5 h1",
      ".ph5 h2",
      "section.artdeco-card h1",
      "section.artdeco-card h2",
      "[data-member-id] h1",
      "[data-member-id] h2",
      "main [aria-label='Primary content'] h1",
      "main [aria-label='Primary content'] h2",
    ].join(", "),
  );
  const topCardName = normalizeWhitespace(topCard?.textContent ?? "");
  if (isPlausiblePersonName(topCardName)) {
    return topCardName;
  }

  const fromJsonLd = nameFromJsonLd(documentRef);
  if (fromJsonLd) {
    return fromJsonLd;
  }

  const fromPhotoAlt = nameFromProfilePhotoAlt(documentRef);
  if (fromPhotoAlt) {
    return fromPhotoAlt;
  }

  const ogTitle = documentRef.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ?? "";
  const fromOg = cleanDocumentTitleName(ogTitle);
  if (fromOg) {
    return fromOg;
  }

  const fromTitle = cleanDocumentTitleName(documentRef.title ?? "");
  if (fromTitle) {
    return fromTitle;
  }

  const fromSlug = nameFromLinkedInSlug(href);
  if (fromSlug) {
    return fromSlug;
  }
  return undefined;
}

function cleanDocumentTitleName(raw: string): string | undefined {
  const cleaned = normalizeWhitespace(
    raw
      .replace(/^\s*\(\d+\+?\)\s*/, "") // logged-in notification count: "(3) David Sneed | LinkedIn"
      .replace(/\s*\|\s*LinkedIn.*$/i, "")
      .replace(/\s*-\s*LinkedIn.*$/i, "")
      .replace(/\s*\(\d+\+?\)$/g, ""),
  );
  return isPlausiblePersonName(cleaned) ? cleaned : undefined;
}

/** LinkedIn profile pages embed a Person node in JSON-LD — survives DOM redesigns. */
function nameFromJsonLd(documentRef: Document): string | undefined {
  for (const script of documentRef.querySelectorAll('script[type="application/ld+json"]')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent ?? "");
    } catch {
      continue;
    }
    const nodes: unknown[] = Array.isArray(parsed) ? [...parsed] : [parsed];
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { "@graph"?: unknown[] })["@graph"])) {
      nodes.push(...((parsed as { "@graph": unknown[] })["@graph"]));
    }
    for (const node of nodes) {
      if (!node || typeof node !== "object") {
        continue;
      }
      const record = node as Record<string, unknown>;
      if (record["@type"] === "Person" && typeof record.name === "string") {
        const name = dedupeRepeatedName(normalizeWhitespace(record.name));
        if (isPlausiblePersonName(name)) {
          return name;
        }
      }
    }
  }
  return undefined;
}

/**
 * The top-card profile photo's alt text is exactly the member's name. Scoped to
 * top-card/profile-picture containers so sidebar "people also viewed" photos
 * (which also carry person-name alts) are never picked up.
 */
function nameFromProfilePhotoAlt(documentRef: Document): string | undefined {
  const images = documentRef.querySelectorAll<HTMLImageElement>(
    [
      'img[class*="pv-top-card-profile-picture"]',
      ".pv-top-card img",
      'button[class*="profile-picture"] img',
      'img[class*="profile-photo-edit"]',
      ".ph5 img",
    ].join(", "),
  );
  for (const image of images) {
    const alt = dedupeRepeatedName(normalizeWhitespace(image.alt ?? ""));
    if (isPlausiblePersonName(alt) && !/\b(logo|company|school|background|cover)\b/i.test(alt)) {
      return alt;
    }
  }
  return undefined;
}

function nameFromLinkedInSlug(href: string): string | undefined {
  try {
    const path = href.includes("://") || href.startsWith("/")
      ? new URL(href, "https://www.linkedin.com").pathname
      : href;
    const slug = path.match(/\/in\/([^/]+)/i)?.[1] ?? href.match(/\/in\/([^/?#]+)/i)?.[1];
    if (!slug || slug.length < 3) {
      return undefined;
    }
    // Drop trailing opaque ids: sara-manchester-14b3a451 → sara-manchester
    // Keep short initials: ivan-r-20971a190 → ivan-r
    // Only strip a trailing segment that actually looks like a LinkedIn id — a
    // 6+ char alnum run that CONTAINS A DIGIT. A pure-alphabetic surname of 6+
    // letters (a vanity slug like jenny-anderson / mary-jane-watson) is a real
    // name part, not an id, and must be kept — otherwise the slug fallback drops
    // the last name (or returns no name at all, dropping the candidate).
    const withoutTrailingId = decodeURIComponent(slug).replace(/-(?=[a-z0-9]*\d)[a-z0-9]{6,}$/i, "");
    const words = withoutTrailingId
      .replace(/[-_]+/g, " ")
      .replace(/\d+/g, " ")
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 1 || /^[A-Za-z]$/.test(word));
    if (words.length >= 2) {
      const name = words
        .map((w) => (w.length === 1 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
        .join(" ");
      return isPlausiblePersonName(name) ? name : undefined;
    }
    if (words.length === 1 && words[0] && words[0].length >= 4) {
      const camel = words[0].replace(/([a-z])([A-Z])/g, "$1 $2");
      if (camel.includes(" ")) {
        const name = camel
          .split(/\s+/)
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(" ");
        return isPlausiblePersonName(name) ? name : undefined;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isPlausiblePersonName(value: string): boolean {
  if (!value || value.length < 2 || value.length > 80) {
    return false;
  }
  if (/^(linkedin|home|feed|notifications|messaging|jobs|my network)$/i.test(value)) {
    return false;
  }
  if (/\b(recruiter|jobs|search|login|feed|company|hiring|people|posts|view|message|connect)\b/i.test(value)) {
    return false;
  }
  const tokens = value.trim().split(/\s+/);
  if (tokens.length < 2) {
    // Single token only when it looks like a real capitalized name
    return /^[A-Z][a-zA-Z.'-]{1,40}$/.test(value) && value !== value.toUpperCase() && !/[.@]/.test(value);
  }
  // Allow "Jane Doe", "Ivan R", "Mary J. Smith"
  const first = tokens[0] ?? "";
  if (!/^[A-Za-z]{2,}[a-zA-Z.'-]*$/.test(first)) {
    return false;
  }
  return tokens.slice(1).every(
    (token) =>
      /^[A-Za-z](\.|$)/.test(token) ||
      /^[A-Za-z]{2,}[a-zA-Z.'-]*$/.test(token) ||
      /^\([A-Za-z]{2,}[a-zA-Z.'-]*\)$/.test(token),
  );
}

export function parseSearchResults(documentRef: Document): PageCandidate[] {
  const byUrl = new Map<string, PageCandidate>();

  // Prefer stable result-card roots when present; LinkedIn also flattens cards with
  // display:contents, so we always fall back to scanning profile anchors.
  const cardRoots = [
    ...documentRef.querySelectorAll<HTMLElement>(
      [
        "li.reusable-search__result-container",
        "div.entity-result",
        "div.reusable-search__result-container",
        "[data-chameleon-result-urn]",
        'div[role="listitem"]',
        "li[data-occludable-job-id]",
      ].join(", "),
    ),
  ];

  if (cardRoots.length > 0) {
    for (const card of cardRoots) {
      const candidate = candidateFromSearchCard(card);
      if (candidate?.linkedinUrl && !byUrl.has(candidate.linkedinUrl)) {
        byUrl.set(candidate.linkedinUrl, candidate);
      }
    }
  }

  const anchors = [...documentRef.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"], a[href*="linkedin.com/in/"]')];
  for (const anchor of anchors) {
    if (isMutualConnectionLink(anchor)) {
      continue;
    }
    const container = findResultContainer(anchor);
    if (container && primaryProfileAnchor(container) !== anchor) {
      continue;
    }
    const url = normalizeProfileUrl(anchor.href);
    if (!url || byUrl.has(url)) {
      continue;
    }
    // Don't require layout visibility — LinkedIn often uses display:contents / zero-size wrappers.
    if (isExplicitlyHidden(anchor)) {
      continue;
    }
    const fullName =
      nameForProfileUrl(container ?? anchor, url) ||
      inferNameFromImage(container) ||
      nameFromLinkedInSlug(url) ||
      "";
    if (!fullName) {
      continue;
    }
    const containerText = normalizeWhitespace(container?.textContent ?? anchor.textContent ?? "");
    byUrl.set(url, {
      fullName,
      firstName: extractFirstName(fullName),
      title: extractTitle(containerText),
      company: inferCompanyFromSearchCard(container ?? anchor),
      location: extractLocation(containerText),
      linkedinUrl: url,
      profilePhotoUrl: photoForSearchCard(container ?? anchor, url, fullName),
    });
  }

  return [...byUrl.values()].slice(0, 50);
}

function candidateFromSearchCard(card: HTMLElement): PageCandidate | undefined {
  const anchor = primaryProfileAnchor(card);
  if (!anchor) {
    return undefined;
  }
  const url = normalizeProfileUrl(anchor.href);
  if (!url) {
    return undefined;
  }
  const fullName =
    nameForProfileUrl(card, url) ||
    inferNameFromImage(card) ||
    inferNameFromCardTitle(card) ||
    "";
  if (!fullName) {
    return undefined;
  }
  const containerText = normalizeWhitespace(card.textContent ?? "");
  return {
    fullName,
    firstName: extractFirstName(fullName),
    title: extractTitle(containerText),
    company: inferCompanyFromSearchCard(card),
    location: extractLocation(containerText),
    linkedinUrl: url,
    profilePhotoUrl: photoForSearchCard(card, url, fullName),
  };
}

/** Shortest clean name among anchors that point at this profile — matches LinkedIn's DOM. */
function nameForProfileUrl(root: ParentNode, profileUrl: string): string {
  const linkedinUrl = normalizeProfileUrl(profileUrl);
  if (!linkedinUrl) {
    return "";
  }
  const names: string[] = [];
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]')) {
    if (isMutualConnectionLink(anchor) || normalizeProfileUrl(anchor.href) !== linkedinUrl) {
      continue;
    }
    const candidate = inferNameFromAnchor(anchor);
    if (candidate && /[A-Za-z]{2,}\s+[A-Za-z]{1,}/.test(candidate)) {
      names.push(candidate);
    }
  }
  names.sort((a, b) => a.length - b.length);
  return names[0] || nameFromLinkedInSlug(linkedinUrl) || "";
}

/**
 * Search cards contain OTHER people's faces too (mutual-connection avatars).
 * LinkedIn's 2025 DOM often leaves avatar alt empty — the reliable signal is the
 * wrapping profile link (avatar link and name link share the same /in/ href).
 * Ghost placeholders must stay undefined — never invent a face.
 */
function photoForSearchCard(
  root: ParentNode | undefined,
  profileUrl: string,
  fullName: string,
): string | undefined {
  if (!root) {
    return undefined;
  }
  const linkedinUrl = normalizeProfileUrl(profileUrl);
  const target = fullName.trim().toLowerCase();
  if (!linkedinUrl || !target) {
    return undefined;
  }

  // Prefer images inside THIS person's own profile anchors only.
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]')) {
    if (normalizeProfileUrl(anchor.href) !== linkedinUrl) {
      continue;
    }
    for (const img of anchor.querySelectorAll<HTMLImageElement>("img")) {
      const url = imageUrl(img);
      if (url) {
        return url;
      }
    }
  }

  // Exact full-name alt match only — never partial / includes matching (wrong faces).
  for (const img of root.querySelectorAll<HTMLImageElement>("img")) {
    const alt = dedupeRepeatedName(normalizeWhitespace(img.alt ?? "")).toLowerCase();
    if (alt !== target) {
      continue;
    }
    const wrap = img.closest('a[href*="/in/"]');
    const wrapUrl =
      wrap && "href" in wrap ? normalizeProfileUrl(String((wrap as HTMLAnchorElement).href)) : "";
    if (wrapUrl && wrapUrl !== linkedinUrl) {
      continue;
    }
    const url = imageUrl(img);
    if (url) {
      return url;
    }
  }

  return undefined;
}

function inferNameFromCardTitle(card: HTMLElement): string {
  const titleNode = card.querySelector<HTMLElement>(
    '.entity-result__title-text span[aria-hidden="true"], .entity-result__title-text, span.entity-result__title-text',
  );
  if (titleNode) {
    return inferNameFromText(titleNode.textContent ?? "");
  }
  return "";
}

export function inferCompanyFromSearchUrl(href: string): string | undefined {
  try {
    const url = new URL(href);
    const keywords = url.searchParams.get("keywords") ?? "";
    const companyWords = keywords
      .split(/\s+/)
      .filter((word) => word && !/^(recruiter|technical|talent|acquisition|sourcer|people|hr)$/i.test(word));
    return companyWords.length > 0 ? normalizeWhitespace(companyWords.join(" ")) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A selected LinkedIn company facet is more authoritative than free-text
 * keywords. Prefer explicit company-labelled chips; when LinkedIn only exposes
 * a generic selected pill, use the common employer parsed from the result cards.
 */
export function inferSelectedCompanyFromSearchPage(
  documentRef: Document,
  href: string,
  candidates: PageCandidate[] = [],
): string | undefined {
  const explicitlyLabelled = [
    ...documentRef.querySelectorAll<HTMLElement>(
      [
        '[aria-label*="current company" i]',
        '[aria-label*="company filter" i]',
        '[data-control-name*="current_company" i]',
        '[data-test-filter-value*="company" i]',
      ].join(", "),
    ),
  ];
  for (const node of explicitlyLabelled) {
    const value =
      cleanSelectedFilterCompany(node.getAttribute("aria-label") ?? "") ??
      cleanSelectedFilterCompany(node.textContent ?? "");
    if (value) return value;
  }

  let hasCompanyFacet = false;
  try {
    const url = new URL(href);
    hasCompanyFacet = [...url.searchParams.keys()].some((key) => /(?:current|facet).*compan/i.test(key));
  } catch {
    // Ignore malformed URLs; explicit DOM labels above still work.
  }
  if (!hasCompanyFacet) return undefined;

  // LinkedIn's selected company pill is normally just a green button whose
  // accessible label is the company itself (for example, "Figma"). It does
  // not consistently say "Current company", so read selected filter pills
  // after confirming that the URL really contains a company facet.
  const selectedPill = [...documentRef.querySelectorAll<HTMLElement>(
    'button[aria-pressed="true"], button[aria-checked="true"], .search-reusables__filter-pill-button',
  )]
    .map((node) => normalizeWhitespace(node.textContent ?? node.getAttribute("aria-label") ?? ""))
    .map((value) => value.replace(/[\s▾▼]+$/g, "").trim())
    .find((value) =>
      Boolean(value) &&
      !/^(people|united states|locations?|actively hiring|all filters|1st|2nd|3rd\+?)$/i.test(value) &&
      looksLikeCompanyName(value) &&
      !looksLikeSchool(value),
    );
  if (selectedPill) return cleanCompanyName(selectedPill);

  const companies = candidates
    .map((candidate) => candidate.company?.trim())
    .filter((company): company is string => Boolean(company));
  if (companies.length > 0) {
    const counts = new Map<string, { label: string; count: number }>();
    for (const company of companies) {
      const key = company.toLowerCase();
      const entry = counts.get(key) ?? { label: company, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
    const common = [...counts.values()].sort((a, b) => b.count - a.count)[0];
    if (common && common.count >= Math.max(1, Math.ceil(companies.length / 2))) {
      return common.label;
    }
  }

  return undefined;
}

function cleanSelectedFilterCompany(raw: string): string | undefined {
  const value = normalizeWhitespace(raw)
    .replace(/^(?:current compan(?:y|ies)|company filter)\b\s*[:\-]?\s*/i, "")
    .replace(/\s+filter\b.*$/i, "")
    .replace(/^filter\b.*$/i, "")
    .replace(/\s*[,.]?\s*clicking\b.*$/i, "")
    .replace(/\s*[,.]?\s*(?:remove|selected)\b.*$/i, "")
    .trim();
  return looksLikeCompanyName(value) && !looksLikeSchool(value) ? cleanCompanyName(value) : undefined;
}

function inferCompanyFromSearchCard(root: ParentNode): string | undefined {
  const selectors = [
    ".entity-result__primary-subtitle",
    ".entity-result__summary",
    "[data-anonymize='job-title']",
    "[class*='primary-subtitle']",
  ];
  const lines = [
    ...selectors.flatMap((selector) =>
      [...root.querySelectorAll<HTMLElement>(selector)].map((node) => normalizeWhitespace(node.textContent ?? "")),
    ),
    ...(root.textContent ?? "").split(/\n+/).map((line) => normalizeWhitespace(line)),
  ];
  for (const line of lines) {
    const company = inferCompanyFromHeadline(line);
    if (company && looksLikeCompanyName(company) && !looksLikeSchool(company)) {
      return company;
    }
  }
  return undefined;
}

export function inferNameFromText(text: string): string {
  if (/\b(mutual connections?|connections? in common)\b/i.test(text)) {
    return "";
  }
  const profileViewMatch = text.match(/^View\s+(.+?)(?:'|\u2019)s\s+profile\b/i);
  if (profileViewMatch?.[1]) {
    const fromProfileLabel = dedupeRepeatedName(normalizeWhitespace(profileViewMatch[1]));
    if (fromProfileLabel && /[A-Za-z]{2,}\s+[A-Za-z]{1,}/.test(fromProfileLabel) && fromProfileLabel.length <= 80) {
      return fromProfileLabel;
    }
  }
  const withoutLinkedIn = text
    .replace(/^View\s+\S+\s+profile\s+$/i, "")
    .replace(/^View\s+(.+?)(?:'|\u2019)s\s+profile.*$/i, "$1")
    .replace(/^View\s+profile\s+for\s+(.+)$/i, "$1")
    .replace(/\s*\|\s*LinkedIn.*$/i, "")
    .replace(/\s*-\s*LinkedIn.*$/i, "")
    .replace(/\s*-\s*(?:Technical Recruiter|Recruiter|Talent Acquisition|Sourcer).*$/i, "")
    .replace(/\s*(?:•|·|\|).*$/i, "")
    .replace(/\s+(?:2nd|3rd|1st)\s*degree.*$/i, "")
    .replace(/\b(?:Connect|Follow|Message|Pending)\b.*$/i, "");
  const possible = dedupeRepeatedName(normalizeWhitespace(withoutLinkedIn).split("\n")[0] ?? "");
  if (
    !possible ||
    possible.length > 80 ||
    /\s+and\s+.*\bare\b/i.test(possible) ||
    containsJobTitleNoise(possible)
  ) {
    return "";
  }
  // Require at least "First Last" or "First L" (initial)
  if (!/^[A-Za-z]{2,}[a-zA-Z.'-]*(\s+[A-Za-z](\.|$)|(\s+[A-Za-z]{2,}[a-zA-Z.'-]*)+)$/.test(possible)) {
    return "";
  }
  return possible;
}

function containsJobTitleNoise(value: string): boolean {
  if (/\b(jobs|search|login|feed|company|hiring|people|posts)\b/i.test(value)) {
    return true;
  }
  if (/\bview\b/i.test(value) && !/^View\s+/i.test(value)) {
    return true;
  }
  if (/\b(recruiter|talent acquisition|sourcer)\b/i.test(value)) {
    const tokens = value.trim().split(/\s+/);
    if (tokens.length === 2 && /^[A-Z][a-z]+$/.test(tokens[0] ?? "") && /^[A-Z][a-z]+$/.test(tokens[1] ?? "")) {
      return false;
    }
    return true;
  }
  return false;
}

/** LinkedIn often concatenates visible + sr-only name: "Jake Walton Jake Walton". */
export function dedupeRepeatedName(value: string): string {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return "";
  }
  // Exact doubled phrase: "Ada Lovelace Ada Lovelace"
  const exact = normalized.match(/^(.+?)\s+\1$/i);
  if (exact?.[1] && /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(exact[1])) {
    return exact[1];
  }
  // Concatenated without space: "Ada LovelaceAda Lovelace"
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

function inferNameFromAnchor(anchor: HTMLAnchorElement): string {
  // Prefer the visible aria-hidden name span — LinkedIn duplicates the name in a
  // visually-hidden twin, which makes textContent "First Last First Last".
  const hiddenVisible = [...anchor.querySelectorAll<HTMLElement>('span[aria-hidden="true"]')]
    .map((el) => inferNameFromText(el.textContent ?? ""))
    .find(Boolean);
  if (hiddenVisible) {
    return hiddenVisible;
  }
  const ariaLabel = anchor.getAttribute("aria-label") ?? "";
  return inferNameFromText(ariaLabel) || inferNameFromText(anchor.textContent ?? "");
}

function inferNameFromImage(root: ParentNode | undefined): string {
  if (!root) {
    return "";
  }
  const image = [...root.querySelectorAll<HTMLImageElement>("img")]
    .find((img) => inferNameFromText(img.alt ?? ""));
  return image ? inferNameFromText(image.alt ?? "") : "";
}

function findResultContainer(anchor: HTMLAnchorElement): HTMLElement | undefined {
  const strongContainer = anchor.closest<HTMLElement>(
    'li, .reusable-search__result-container, .entity-result, [data-chameleon-result-urn], div[role="listitem"]',
  );
  if (strongContainer) {
    return strongContainer;
  }
  let current: HTMLElement | null = anchor;
  for (let depth = 0; depth < 8 && current?.parentElement; depth += 1) {
    current = current.parentElement;
    const profileLinks = [...current.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"], a[href*="linkedin.com/in/"]')]
      .filter((link) => !isMutualConnectionLink(link) && normalizeProfileUrl(link.href));
    if (profileLinks.length === 1 && (current.querySelector("img") || current.textContent)) {
      return current;
    }
  }
  return anchor.closest<HTMLElement>("div") ?? undefined;
}

function primaryProfileAnchor(container: HTMLElement): HTMLAnchorElement | undefined {
  return [...container.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"], a[href*="linkedin.com/in/"]')]
    .find((anchor) => !isMutualConnectionLink(anchor) && normalizeProfileUrl(anchor.href) && !isExplicitlyHidden(anchor));
}

function isMutualConnectionLink(anchor: HTMLAnchorElement): boolean {
  const selfText = normalizeWhitespace(
    `${anchor.getAttribute("aria-label") ?? ""} ${anchor.textContent ?? ""}`,
  );
  if (/\b(mutual connections?|connections? in common)\b/i.test(selfText)) {
    return true;
  }
  // Only inspect a tight mutual row — never the whole result card (that hides the real person).
  const mutualRow = anchor.closest("div, p, span, li");
  if (
    mutualRow &&
    !mutualRow.matches(
      '[role="listitem"], .entity-result, .reusable-search__result-container, [data-chameleon-result-urn]',
    )
  ) {
    const rowText = normalizeWhitespace(mutualRow.textContent ?? "");
    if (/\b(mutual connections?|connections? in common)\b/i.test(rowText) && rowText.length <= 280) {
      return true;
    }
  }
  return false;
}

function normalizeProfileUrl(href: string): string {
  const match = href.match(/\/in\/([^/?#]+)/i);
  const slug = match?.[1] ? decodeURIComponent(match[1]).replace(/\/$/, "") : "";
  if (!slug || /^(unavailable|edit|detail)$/i.test(slug)) {
    return "";
  }
  // Reject obvious non-profile paths that still match /in/
  if (slug.includes(".")) {
    return "";
  }
  return `https://www.linkedin.com/in/${slug}`;
}

function isExplicitlyHidden(element: HTMLElement): boolean {
  if (element.hasAttribute("hidden") || element.tagName === "TEMPLATE") {
    return true;
  }
  // Only treat the element itself as AT-hidden — LinkedIn puts the *visible*
  // name inside span[aria-hidden="true"], so do not walk ancestors.
  if (element.getAttribute("aria-hidden") === "true") {
    return true;
  }
  try {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return true;
    }
  } catch {
    // jsdom / non-browser
  }
  return false;
}

function extractTitle(text: string): string | undefined {
  return text.match(/\b(?:(?:Senior|Lead|Principal|Technical)\s+)?(?:Technical Recruiter|Recruiter|Talent Acquisition(?: Partner| Specialist| Manager)?|Sourcer)\b/i)?.[0];
}

function extractLocation(text: string): string | undefined {
  const withoutTitle = extractTitle(text) ? text.replace(extractTitle(text) ?? "", " ") : text;
  return withoutTitle.match(/\b[A-Z][A-Za-z.]+(?:\s+[A-Z][A-Za-z.]+){0,3},\s*(?:United States|USA|US)\b/)?.[0];
}

function inferCompanyFromPage(candidates: PageCandidate[]): string | undefined {
  const companies = candidates.map((candidate) => candidate.company).filter(Boolean) as string[];
  return companies[0];
}

/**
 * Prefer the current Experience role (date range includes Present), then JSON-LD
 * worksFor, then the top-card employer chip, then looser hero text and headline.
 * Do not scan the rest of the page — About / activity / "You both worked at"
 * routinely mention previous employers.
 */
export function inferCompanyFromProfile(
  documentRef: Document,
  _bodyText: string,
  title?: string,
): { company?: string; linkedinCompanySlug?: string } {
  const fromExperience = inferCompanyFromCurrentExperience(documentRef);
  if (fromExperience.company) {
    return fromExperience;
  }
  const fromJsonLd = inferCompanyFromJsonLd(documentRef);
  if (fromJsonLd.company) {
    return fromJsonLd;
  }
  const fromTopCard = inferCompanyFromTopCard(documentRef);
  if (fromTopCard.company) {
    return fromTopCard;
  }
  const fromHero = inferCompanyFromHeroLines(documentRef);
  if (fromHero.company) {
    return fromHero;
  }
  const fromHeadline = inferCompanyFromHeadline(title);
  if (fromHeadline) {
    return { company: fromHeadline };
  }
  return {};
}

function inferCompanyFromCurrentExperience(documentRef: Document): {
  company?: string;
  linkedinCompanySlug?: string;
} {
  const section = findExperienceSection(documentRef);
  if (!section) {
    return {};
  }
  const presentMarks = [...section.querySelectorAll("span, time, div, p")].filter((node) => {
    const text = normalizeWhitespace(node.textContent ?? "");
    return text.length > 0 && text.length <= 80 && /\bPresent\b/i.test(text);
  });
  const scopes =
    presentMarks.length > 0
      ? presentMarks.map(
          (node) =>
            node.closest("li") ??
            node.closest("[class*='pvs-entity']") ??
            node.closest("[class*='artdeco-list']") ??
            section,
        )
      : [];
  for (const scope of scopes) {
    if (!scope) {
      continue;
    }
    const found = companyFromScope(scope);
    if (found.company) {
      return found;
    }
    const parent = scope.parentElement?.closest("li") ?? scope.parentElement;
    if (parent && parent !== section) {
      const fromParent = companyFromScope(parent);
      if (fromParent.company) {
        return fromParent;
      }
    }
  }
  for (const item of section.querySelectorAll("li")) {
    const text = normalizeWhitespace(item.textContent ?? "");
    if (!/\bPresent\b/i.test(text)) {
      continue;
    }
    const found = companyFromScope(item);
    if (found.company) {
      return found;
    }
  }
  return {};
}

function findExperienceSection(documentRef: Document): HTMLElement | undefined {
  const anchor = documentRef.querySelector<HTMLElement>(
    "#experience, #experience-section, [id='experience']",
  );
  if (anchor) {
    return (
      anchor.closest("section") ??
      anchor.parentElement ??
      (anchor.nextElementSibling instanceof HTMLElement ? anchor.nextElementSibling : undefined) ??
      anchor
    );
  }
  for (const heading of documentRef.querySelectorAll("h2, h3")) {
    const label = normalizeWhitespace(heading.textContent ?? "");
    if (/^experience$/i.test(label)) {
      return heading.closest("section") ?? heading.parentElement ?? undefined;
    }
  }
  return undefined;
}

function companyFromScope(scope: Element): { company?: string; linkedinCompanySlug?: string } {
  const links = [...scope.querySelectorAll<HTMLAnchorElement>('a[href*="/company/"]')].filter(
    (link) => !/\/school\//i.test(link.getAttribute("href") ?? ""),
  );
  for (const link of links) {
    const name = companyLabelFromTopCardLink(link);
    if (!name || !looksLikeCompanyName(name) || looksLikeSchool(name)) {
      continue;
    }
    return {
      company: cleanCompanyName(name),
      linkedinCompanySlug: linkedInCompanySlug(link.getAttribute("href") ?? link.href),
    };
  }
  return {};
}

function inferCompanyFromJsonLd(documentRef: Document): { company?: string; linkedinCompanySlug?: string } {
  for (const script of documentRef.querySelectorAll('script[type="application/ld+json"]')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent ?? "");
    } catch {
      continue;
    }
    const nodes: unknown[] = Array.isArray(parsed) ? [...parsed] : [parsed];
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { "@graph"?: unknown[] })["@graph"])) {
      nodes.push(...((parsed as { "@graph": unknown[] })["@graph"]));
    }
    for (const node of nodes) {
      if (!node || typeof node !== "object") {
        continue;
      }
      const record = node as Record<string, unknown>;
      if (record["@type"] !== "Person") {
        continue;
      }
      const worksFor = record.worksFor;
      const orgs = Array.isArray(worksFor) ? worksFor : worksFor ? [worksFor] : [];
      for (const org of orgs) {
        if (!org || typeof org !== "object") {
          continue;
        }
        const name = typeof (org as { name?: unknown }).name === "string" ? (org as { name: string }).name.trim() : "";
        if (name && looksLikeCompanyName(name) && !looksLikeSchool(name)) {
          const url = typeof (org as { url?: unknown }).url === "string" ? (org as { url: string }).url : "";
          return { company: cleanCompanyName(name), linkedinCompanySlug: linkedInCompanySlug(url) };
        }
      }
    }
  }
  return {};
}

/**
 * First company chip in the top card is almost always current employer.
 * Later chips are often school / accelerator (Y Combinator, university).
 * LinkedIn 2025 often uses a <button> here, not a /company/ link.
 */
function inferCompanyFromTopCard(documentRef: Document): { company?: string; linkedinCompanySlug?: string } {
  const roots = [
    ...documentRef.querySelectorAll<HTMLElement>(
      [
        ".pv-text-details__left-panel",
        ".pv-text-details__right-panel",
        "main [aria-label='Primary content']",
        "main [role='main']",
        ".ph5 .pb2",
        ".ph5",
        "section.artdeco-card.pv-top-card",
        ".pv-top-card",
        '[class*="pv-top-card"]',
      ].join(", "),
    ),
  ];
  const scopes = roots.length > 0 ? roots : documentRef.body ? [documentRef.body] : [];
  for (const root of scopes) {
    const nodes = [
      ...root.querySelectorAll<HTMLElement>(
        [
          "a[href*='/company/']",
          "button[aria-label*='Current company']",
          "button[aria-label*='current company']",
          "button[aria-label*='Company']",
          "button[aria-label*='company']",
          "button:has(img[alt*='logo'])",
          "button:has(figure)",
          "button:has(p)",
          "button:has(span[aria-hidden='true'])",
          "a[href*='/school/']",
        ].join(", "),
      ),
    ].filter((node) => {
      if (node.closest(".pvs-profile-actions, .pv-top-card-v2-ctas, [class*='profile-actions']")) {
        return false;
      }
      if (node instanceof HTMLAnchorElement && /\/school\//i.test(node.getAttribute("href") ?? "")) {
        return false;
      }
      return !isExplicitlyHidden(node);
    });
    for (const node of nodes) {
      if (node instanceof HTMLAnchorElement && /\/school\//i.test(node.getAttribute("href") ?? node.href)) {
        continue;
      }
      const name =
        node instanceof HTMLAnchorElement ? companyLabelFromTopCardLink(node) : companyLabelFromChip(node);
      if (!name || !looksLikeCompanyName(name) || looksLikeSchool(name) || looksLikeProfileAction(name)) {
        continue;
      }
      if (/\b(you both|worked at|before you|started|mutual|also viewed)\b/i.test(name)) {
        continue;
      }
      const href = node instanceof HTMLAnchorElement ? node.getAttribute("href") ?? node.href : "";
      return { company: cleanCompanyName(name), linkedinCompanySlug: linkedInCompanySlug(href) };
    }
  }
  return {};
}

function companyLabelFromChip(node: HTMLElement): string {
  const directParagraphs = [...node.querySelectorAll<HTMLElement>("p")]
    .map((el) => dedupeRepeatedName(normalizeWhitespace(el.textContent ?? "")))
    .filter(
      (text) =>
        text.length >= 2 &&
        text.length <= 60 &&
        !looksLikeUtilityText(text) &&
        !looksLikeSchool(text) &&
        !looksLikeWebsiteLine(text),
    );
  if (directParagraphs[0]) {
    return directParagraphs[0];
  }
  const ariaHidden = [...node.querySelectorAll<HTMLElement>('span[aria-hidden="true"]')]
    .map((el) => dedupeRepeatedName(normalizeWhitespace(el.textContent ?? "")))
    .find((text) => text.length >= 2 && text.length <= 60 && !looksLikeUtilityText(text));
  if (ariaHidden) {
    return ariaHidden;
  }
  const ariaLabel = normalizeWhitespace(node.getAttribute("aria-label") ?? "")
    .replace(/^(current company|company|education)\s*[:\-]?\s*/i, "")
    .replace(/\s+logo$/i, "")
    .replace(/^logo\s+for\s+/i, "");
  if (ariaLabel && looksLikeCompanyName(ariaLabel) && !looksLikeUtilityText(ariaLabel)) {
    return ariaLabel;
  }
  const imgAlt = normalizeWhitespace(node.querySelector("img")?.alt ?? "")
    .replace(/\s+logo$/i, "")
    .replace(/^logo\s+for\s+/i, "");
  if (imgAlt && looksLikeCompanyName(imgAlt) && !looksLikeSchool(imgAlt) && !looksLikeUtilityText(imgAlt)) {
    return imgAlt;
  }
  const text = dedupeRepeatedName(normalizeWhitespace(node.textContent ?? ""));
  return looksLikeUtilityText(text) ? "" : text;
}

function companyLabelFromTopCardLink(link: HTMLAnchorElement): string {
  const directParagraphs = [...link.querySelectorAll<HTMLElement>("p")]
    .map((el) => dedupeRepeatedName(normalizeWhitespace(el.textContent ?? "")))
    .filter((text) => text.length >= 2 && text.length <= 60 && !looksLikeUtilityText(text) && !looksLikeSchool(text));
  if (directParagraphs[0]) {
    return directParagraphs[0];
  }
  const ariaHidden = [...link.querySelectorAll<HTMLElement>('span[aria-hidden="true"]')]
    .map((el) => dedupeRepeatedName(normalizeWhitespace(el.textContent ?? "")))
    .find((text) => text.length >= 2 && text.length <= 60 && !looksLikeUtilityText(text));
  if (ariaHidden) {
    return ariaHidden;
  }
  const ariaLabel = normalizeWhitespace(link.getAttribute("aria-label") ?? "")
    .replace(/\s+logo$/i, "")
    .replace(/^logo\s+for\s+/i, "");
  if (ariaLabel && looksLikeCompanyName(ariaLabel) && !looksLikeUtilityText(ariaLabel)) {
    return ariaLabel;
  }
  const imgAlt = normalizeWhitespace(link.querySelector("img")?.alt ?? "")
    .replace(/\s+logo$/i, "")
    .replace(/^logo\s+for\s+/i, "");
  if (imgAlt && looksLikeCompanyName(imgAlt) && !looksLikeUtilityText(imgAlt)) {
    return imgAlt;
  }
  const text = dedupeRepeatedName(normalizeWhitespace(link.textContent ?? ""));
  return looksLikeUtilityText(text) ? "" : text;
}

function inferCompanyFromHeadline(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }
  const stripped = stripFormerEmployerPhrases(title);
  // Stop before "(YC…)", bullets, etc.
  const atMatch = stripped.match(
    /(?:\bat\b|@)\s+([A-Z][A-Za-z0-9&.,' -]{1,60}?)(?=\s*[\u00B7|·•,(]|\s+(?:United States|USA|US)\b|$)/i,
  );
  if (atMatch?.[1]) {
    return cleanCompanyName(atMatch[1]);
  }
  const pipeMatch = stripped.match(/\|\s*([A-Z][A-Za-z0-9&.,' -]{1,60}?)\s*$/);
  if (pipeMatch?.[1] && !looksLikeSchool(pipeMatch[1])) {
    return cleanCompanyName(pipeMatch[1]);
  }
  return undefined;
}

function stripFormerEmployerPhrases(value: string): string {
  return value
    .replace(/\(\s*ex\b[^)]*\)/gi, " ")
    .replace(/,\s*ex\b.+$/i, " ")
    .replace(/\b(?:formerly|previously)\s+(?:at\s+)?[A-Z][A-Za-z0-9&.,' -]{1,40}/gi, " ");
}

function linkedInCompanySlug(href: string | undefined): string | undefined {
  if (!href) {
    return undefined;
  }
  try {
    const path = href.includes("://") || href.startsWith("/")
      ? new URL(href, "https://www.linkedin.com").pathname
      : href;
    const slug = path.match(/\/company\/([^/]+)/i)?.[1];
    if (!slug || /^\d+$/.test(slug)) {
      return undefined;
    }
    return decodeURIComponent(slug).replace(/\/$/, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function looksLikeSchool(name: string): boolean {
  return /\b(university|college|school|polytechnic|high school|institute of technology)\b/i.test(name);
}

function cleanCompanyName(value: string): string {
  const trimmed = value.trim();
  const keepAcronymParens = trimmed.match(/\(([A-Z0-9&.-]{2,12})\)\s*$/)?.[1];
  const withoutParens = keepAcronymParens
    ? trimmed.replace(/\(([A-Z0-9&.-]{2,12})\)\s*$/i, " ")
    : trimmed.replace(/\([^)]*\)/g, " ");
  const cleaned = normalizeWhitespace(
    withoutParens
      .replace(/\s+ex\b.*$/i, "")
      .replace(/\s+(?:since|for)\s+(?:the\s+last\s+)?(?:\d+\s+)?(?:days?|weeks?|months?|years?|[A-Z][a-z]+\s+\d{4}).*$/i, "")
      .replace(/[|·•,]+$/g, ""),
  );
  return keepAcronymParens ? `${cleaned} (${keepAcronymParens})`.trim() : cleaned;
}

function looksLikeProfileAction(name: string): boolean {
  return /^(message|connect|follow|more|pending|ignore|withdraw|contact info|visit my website|open to work|add section|resources|notify|share)$/i.test(
    name.trim(),
  );
}

function looksLikeUtilityText(name: string): boolean {
  return /^(skip to search|skip to main content|skip to primary content|skip to aside|skip to footer|close jump menu|search|home|my network|jobs|messaging|notifications|me|for business|try premium for|advertise|this image has content credentials\.?|view image|profile photo)$/i.test(
    name.trim(),
  );
}

/** Reject link texts that are sentences/insights ("You both worked at Google") rather than company names. */
function looksLikeCompanyName(name: string): boolean {
  if (!name || name.length < 2 || name.length > 60) {
    return false;
  }
  if (looksLikeProfileAction(name)) {
    return false;
  }
  if (looksLikeUtilityText(name)) {
    return false;
  }
  if (/^(follow|see all|company|linkedin|show all|more)$/i.test(name)) {
    return false;
  }
  if (/^(?:she\s*\/\s*her|he\s*\/\s*him|they\s*\/\s*them|she|her|he|him|they|them)$/i.test(name.trim())) {
    return false;
  }
  if (
    /^(?:(?:senior|sr\.?|junior|jr\.?|lead|principal|staff|technical|chief|head|founding)\s+)*(?:(?:software|ios|android|backend|frontend|full[ -]?stack|data|product|engineering)\s+)*(?:engineer|developer|recruiter|sourcer|manager|director|architect|designer|scientist|analyst|consultant|specialist)$/i.test(
      name.trim(),
    )
  ) {
    return false;
  }
  if (/^[·•]\s*\d/.test(name) || /^(\d+\+?\s+)?connections?$/i.test(name)) {
    return false;
  }
  if (/\b(you both|worked at|before you|started|mutual|connections?|followers?|also viewed|in common)\b/i.test(name)) {
    return false;
  }
  if (/\b(founder|co-founder|engineer|engineering|recruiter|manager|director|architect|developer|product|software|marketing|officer|chief|ceo|cto|coo|cpo|vp|president)\b/i.test(name) && /(?:\bat\b|@|,)/i.test(name)) {
    return false;
  }
  if (looksLikeWebsiteLine(name) || looksLikeOpenToWorkLine(name)) {
    return false;
  }
  return name.split(/\s+/).length <= 6;
}

function looksLikeWebsiteLine(name: string): boolean {
  return /\b(?:https?:\/\/|www\.|\.com\b|\.ai\b|\.io\b|\.org\b|\.net\b)\b/i.test(name);
}

function looksLikeOpenToWorkLine(name: string): boolean {
  return /\bopen to work\b|on-site|hybrid|remote/i.test(name);
}

/**
 * Profile pages are full of other people's photos (nav "me" avatar, "people
 * also viewed"), so only accept an image whose alt names this person, or the
 * top-card profile picture. Returning nothing beats returning the wrong face.
 */
function extractProfilePhotoForPerson(
  documentRef: Document,
  fullName: string,
  profileUrl?: string,
): string | undefined {
  if (profileUrl) {
    const scopes = [
      documentRef.querySelector(".pv-top-card"),
      documentRef.querySelector("section.artdeco-card"),
      documentRef.querySelector("main"),
      documentRef.body,
    ].filter((node): node is HTMLElement => node instanceof HTMLElement);
    for (const scope of scopes) {
      const fromProfileLink = photoForSearchCard(scope, profileUrl, fullName);
      if (fromProfileLink) {
        return fromProfileLink;
      }
    }
  }

  const fromJsonLd = profilePhotoFromJsonLd(documentRef);
  if (fromJsonLd) {
    return fromJsonLd;
  }

  const ogImage = documentRef.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content;
  if (isUsablePhotoUrl(ogImage) && looksLikeProfilePhotoUrl(ogImage)) {
    return ogImage;
  }

  const fromAria = profilePhotoFromAriaLabel(documentRef, fullName);
  if (fromAria) {
    return fromAria;
  }

  const target = fullName.toLowerCase();
  const images = [...documentRef.querySelectorAll<HTMLImageElement>("img")];
  const byAlt = images.find((img) => {
    if (isGhostPhotoElement(img)) {
      return false;
    }
    const alt = dedupeRepeatedName(normalizeWhitespace(img.alt ?? "")).toLowerCase();
    return alt === target && isUsablePhotoUrl(imageUrl(img));
  });
  if (byAlt) {
    return imageUrl(byAlt);
  }

  // Do not grab a random top-card /dms/image — that is how wrong faces leak in
  // when the member has no profile photo.
  return undefined;
}

function profilePhotoFromJsonLd(documentRef: Document): string | undefined {
  for (const script of documentRef.querySelectorAll('script[type="application/ld+json"]')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent ?? "");
    } catch {
      continue;
    }
    const nodes: unknown[] = Array.isArray(parsed) ? [...parsed] : [parsed];
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { "@graph"?: unknown[] })["@graph"])) {
      nodes.push(...((parsed as { "@graph": unknown[] })["@graph"]));
    }
    for (const node of nodes) {
      if (!node || typeof node !== "object") {
        continue;
      }
      const record = node as Record<string, unknown>;
      if (record["@type"] !== "Person") {
        continue;
      }
      const image = record.image;
      const url =
        typeof image === "string"
          ? image
          : image && typeof image === "object" && typeof (image as Record<string, unknown>).url === "string"
            ? String((image as Record<string, unknown>).url)
            : undefined;
      if (isUsablePhotoUrl(url) && looksLikeProfilePhotoUrl(url)) {
        return url;
      }
    }
  }
  return undefined;
}

function profilePhotoFromAriaLabel(documentRef: Document, fullName: string): string | undefined {
  const target = fullName.trim().toLowerCase();
  if (!target) {
    return undefined;
  }
  const nodes = documentRef.querySelectorAll<HTMLElement>(
    'button[aria-label], img[aria-label], [role="img"][aria-label], a[aria-label]',
  );
  for (const node of nodes) {
    const label = normalizeWhitespace(node.getAttribute("aria-label") ?? "").toLowerCase();
    if (!label.includes(target) || !/\b(profile|photo|picture)\b/i.test(label)) {
      continue;
    }
    if (node instanceof HTMLImageElement) {
      const url = imageUrl(node);
      if (url) {
        return url;
      }
    }
    const nested = node.querySelector("img");
    if (nested) {
      const url = imageUrl(nested);
      if (url) {
        return url;
      }
    }
  }
  return undefined;
}

function looksLikeProfilePhotoUrl(value: string): boolean {
  return /media\.licdn\.com|profile-displayphoto|profile-shrink|licdn\.com\/dms\/image/i.test(value);
}

function isGhostPhotoElement(image: HTMLImageElement): boolean {
  const bits = [
    image.className,
    image.getAttribute("class") ?? "",
    image.parentElement?.className ?? "",
    image.getAttribute("src") ?? "",
  ].join(" ");
  return /ghost_person|ghosts\/person|ghost-person|\bghost\b/i.test(bits);
}

function isUsablePhotoUrl(value: string | undefined): value is string {
  return Boolean(
    value &&
      /^https?:\/\//i.test(value) &&
      !/data:image|ghost|static\/img\/transparent|default-avatar|company-logo|school-logo|background-cover|logo\.licdn/i.test(
        value,
      ) &&
      (/profile-displayphoto|profile-shrink|media\.licdn\.com\/(dms\/image|profile)\//i.test(value) ||
        /licdn\.com\/dms\/image/i.test(value)),
  );
}

function firstUrlFromSrcset(srcset: string | null | undefined): string | undefined {
  if (!srcset) {
    return undefined;
  }
  const first = srcset.split(",")[0]?.trim().split(/\s+/)[0];
  return first || undefined;
}

function imageUrl(image: HTMLImageElement): string | undefined {
  const delayed = image.getAttribute("data-delayed-url") ?? undefined;
  const ghostAttr = image.getAttribute("data-ghost-url") ?? undefined;

  // Explicit lazy-load URLs win (LinkedIn shows a ghost until these resolve).
  if (isUsablePhotoUrl(delayed)) {
    return delayed;
  }
  if (isUsablePhotoUrl(ghostAttr)) {
    return ghostAttr;
  }

  // Still a ghost placeholder with no real lazy URL — member has no photo.
  // Do not fall back to src/currentSrc (recycled or default CDN faces).
  if (isGhostPhotoElement(image)) {
    return undefined;
  }

  for (const value of [firstUrlFromSrcset(image.getAttribute("srcset")), image.currentSrc, image.src]) {
    if (isUsablePhotoUrl(value)) {
      return value;
    }
  }
  return undefined;
}

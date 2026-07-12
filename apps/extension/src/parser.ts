import { extractFirstName, normalizeWhitespace } from "@recruiter/shared";

export interface PageCandidate {
  fullName: string;
  firstName: string;
  title?: string;
  company?: string;
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
    companySuggestion: inferCompanyFromSearchUrl(href) ?? inferCompanyFromPage(candidates),
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
    sanitizeHeadline(
      documentRef.querySelector(".text-body-medium, .pv-text-details__left-panel .text-body-medium, [data-generated-suggestion-target] .text-body-medium")
        ?.textContent ?? "",
    ) || undefined;
  const title =
    headline ||
    sanitizeHeadline(
      rawText.match(
        /(?:Sr\.?\s+|Senior\s+|Lead\s+|Principal\s+|Staff\s+)?(?:Technical\s+)?(?:Recruiter|Talent Acquisition|Sourcer|Recruiting)[^\n.]{0,80}/i,
      )?.[0] ?? "",
    ) || undefined;
  const location = text.match(/[A-Z][A-Za-z .]+,\s*(?:United States|USA|US|[A-Z][A-Za-z ]+)/)?.[0];
  const company = inferCompanyFromProfile(documentRef, text, title);
  const profilePhotoUrl = extractProfilePhotoForPerson(documentRef, fullName, href);
  return {
    fullName,
    firstName: extractFirstName(fullName),
    title,
    company,
    location,
    linkedinUrl: href.split("?")[0],
    profilePhotoUrl,
  };
}

/** Trim action-bar text, doubled visible+sr-only twins, and emoji off a headline. */
function sanitizeHeadline(value: string): string {
  const deduped = dedupeRepeatedName(normalizeWhitespace(value));
  const cut = deduped.split(/\s+(?:More|Message|Follow|Connect|Pending|Visit my website|Contact info)\b/i)[0] ?? "";
  return normalizeWhitespace(cut.replace(/[\u{E000}-\u{F8FF}\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}️]/gu, " ")).slice(0, 120);
}

/** Resolve profile name from h1, meta tags, title, or URL slug — LinkedIn often delays/hides h1. */
export function inferProfileFullName(documentRef: Document, href: string): string | undefined {
  const h1Candidates = [...documentRef.querySelectorAll("h1")]
    .map((el) => normalizeWhitespace(el.textContent ?? ""))
    .filter((name) => isPlausiblePersonName(name));
  if (h1Candidates[0]) {
    return h1Candidates[0];
  }

  const topCard = documentRef.querySelector(
    ".pv-text-details__left-panel h1, .ph5 h1, section.artdeco-card h1, [data-member-id] h1",
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
    const withoutTrailingId = decodeURIComponent(slug).replace(/-[a-z0-9]{6,}$/i, "");
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
    return /^[A-Z][a-zA-Z.'-]{1,40}$/.test(value);
  }
  // Allow "Jane Doe", "Ivan R", "Mary J. Smith"
  const first = tokens[0] ?? "";
  if (!/^[A-Za-z]{2,}[a-zA-Z.'-]*$/.test(first)) {
    return false;
  }
  return tokens.slice(1).every((token) => /^[A-Za-z](\.|$)/.test(token) || /^[A-Za-z]{2,}[a-zA-Z.'-]*$/.test(token));
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

function isVisible(element: HTMLElement): boolean {
  if (isExplicitlyHidden(element)) {
    return false;
  }
  try {
    const rect = element.getBoundingClientRect();
    return rect.width >= 0 && rect.height >= 0;
  } catch {
    return true;
  }
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
 * Prefer the top-card company button (first /company/ link in the profile header).
 * LinkedIn shows current employer there as a short label ("Fluently"); headline text
 * often uses a product/domain form ("GetFluently.App") or "ex Nvidia" noise.
 * Fall back to headline / other company links / body text.
 */
export function inferCompanyFromProfile(
  documentRef: Document,
  bodyText: string,
  title?: string,
): string | undefined {
  const fromTopCard = inferCompanyFromTopCard(documentRef);
  if (fromTopCard) {
    return fromTopCard;
  }
  const fromHeadline = inferCompanyFromHeadline(title);
  if (fromHeadline) {
    return fromHeadline;
  }
  const fromLink = inferCompanyFromCompanyLink(documentRef);
  if (fromLink) {
    return fromLink;
  }
  const headlineSlice = bodyText.slice(0, 500);
  return inferCompanyFromProfileText(headlineSlice) ?? inferCompanyFromProfileText(bodyText);
}

/**
 * First company pill in the top card is almost always current employer.
 * Later pills are often school / accelerator (Y Combinator, university).
 */
function inferCompanyFromTopCard(documentRef: Document): string | undefined {
  const roots = [
    ...documentRef.querySelectorAll<HTMLElement>(
      [
        ".pv-text-details__left-panel",
        ".ph5 .pb2",
        ".ph5",
        "section.artdeco-card.pv-top-card",
        ".pv-top-card",
        '[class*="pv-top-card"]',
        "main section.artdeco-card",
      ].join(", "),
    ),
  ];
  const scopes = roots.length > 0 ? roots : documentRef.body ? [documentRef.body] : [];
  for (const root of scopes) {
    const links = [...root.querySelectorAll<HTMLAnchorElement>('a[href*="/company/"]')].filter(
      (link) => !/\/school\//i.test(link.getAttribute("href") ?? "") && !isExplicitlyHidden(link),
    );
    for (const link of links) {
      const name = companyLabelFromTopCardLink(link);
      if (!name || !looksLikeCompanyName(name)) {
        continue;
      }
      if (/\b(you both|worked at|before you|started|mutual|also viewed)\b/i.test(name)) {
        continue;
      }
      return cleanCompanyName(name);
    }
  }
  return undefined;
}

function companyLabelFromTopCardLink(link: HTMLAnchorElement): string {
  const ariaHidden = [...link.querySelectorAll<HTMLElement>('span[aria-hidden="true"]')]
    .map((el) => dedupeRepeatedName(normalizeWhitespace(el.textContent ?? "")))
    .find((text) => text.length >= 2 && text.length <= 60);
  if (ariaHidden) {
    return ariaHidden;
  }
  const ariaLabel = normalizeWhitespace(link.getAttribute("aria-label") ?? "")
    .replace(/\s+logo$/i, "")
    .replace(/^logo\s+for\s+/i, "");
  if (ariaLabel && looksLikeCompanyName(ariaLabel)) {
    return ariaLabel;
  }
  const imgAlt = normalizeWhitespace(link.querySelector("img")?.alt ?? "")
    .replace(/\s+logo$/i, "")
    .replace(/^logo\s+for\s+/i, "");
  if (imgAlt && looksLikeCompanyName(imgAlt)) {
    return imgAlt;
  }
  return dedupeRepeatedName(normalizeWhitespace(link.textContent ?? ""));
}

function inferCompanyFromCompanyLink(documentRef: Document): string | undefined {
  const links = [...documentRef.querySelectorAll<HTMLAnchorElement>('a[href*="/company/"]')];
  // Prefer experience / top-card company links over sidebar "People also viewed" noise.
  const ranked = links
    .map((link) => {
      const name = companyLabelFromTopCardLink(link);
      const href = link.getAttribute("href") ?? "";
      let score = 0;
      if (!looksLikeCompanyName(name)) {
        return null;
      }
      if (/\b(you both|worked at|before you|started|mutual|also viewed)\b/i.test(name)) {
        return null;
      }
      try {
        if (!isVisible(link)) {
          score -= 2;
        }
      } catch {
        // jsdom may lack layout
      }
      if (/\/company\/[^/]+\/?$/i.test(href) || /\/company\/[^/?]+/i.test(href)) {
        score += 2;
      }
      const nearTop = link.closest(".pv-text-details__left-panel, .ph5, .artdeco-card, section, .pv-top-card");
      if (nearTop) {
        score += 3;
      }
      // Experience section company names are strong signals
      if (link.closest("#experience, #experience-section, section.experience-section")) {
        score += 4;
      }
      return { name, score };
    })
    .filter((entry): entry is { name: string; score: number } => Boolean(entry))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.name;
}

function inferCompanyFromHeadline(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }
  // Stop before "(YC…)", "ex Nvidia", bullets, etc.
  const atMatch = title.match(
    /(?:\bat\b|@)\s+([A-Z][A-Za-z0-9&.,' -]{1,60}?)(?=\s*[\u00B7|·•,(]|\s+(?:United States|USA|US|ex)\b|$)/i,
  );
  if (atMatch?.[1]) {
    return cleanCompanyName(atMatch[1]);
  }
  const pipeMatch = title.match(/\|\s*([A-Z][A-Za-z0-9&.,' -]{1,60}?)\s*$/);
  if (pipeMatch?.[1]) {
    return cleanCompanyName(pipeMatch[1]);
  }
  return undefined;
}

function inferCompanyFromProfileText(text: string): string | undefined {
  // "Sr. Recruiter (Hardware Technology) at Apple" / "Recruiter at Apple · Bay Area"
  const match = text.match(
    /(?:\bat\b|@)\s+([A-Z][A-Za-z0-9][A-Za-z0-9&.,' -]{0,58}?)(?=\s*[\u00B7|·•,]|\s+(?:United States|USA|US)\b|\s+[A-Z][a-z]|$)/,
  );
  if (match?.[1]) {
    return cleanCompanyName(match[1]);
  }
  const parenAt = text.match(
    /\)\s+at\s+([A-Z][A-Za-z0-9][A-Za-z0-9&.,' -]{0,58}?)(?=\s*[\u00B7|·•,]|\s|$)/i,
  );
  if (parenAt?.[1]) {
    return cleanCompanyName(parenAt[1]);
  }
  const loose = text.match(/(?:\bat\b|@)\s+([A-Z][A-Za-z0-9&.,' -]{1,60})\b/);
  if (loose?.[1]) {
    return cleanCompanyName(loose[1]);
  }
  return undefined;
}

function cleanCompanyName(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/\([^)]*\)/g, " ")
      .replace(/\s+ex\b.*$/i, "")
      .replace(/[|·•,]+$/g, ""),
  );
}

/** Reject link texts that are sentences/insights ("You both worked at Google") rather than company names. */
function looksLikeCompanyName(name: string): boolean {
  if (!name || name.length < 2 || name.length > 60) {
    return false;
  }
  if (/^(follow|see all|company|linkedin|show all|more)$/i.test(name)) {
    return false;
  }
  if (/\b(you both|worked at|before you|started|mutual|connections?|followers?|also viewed|in common)\b/i.test(name)) {
    return false;
  }
  return name.split(/\s+/).length <= 6;
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

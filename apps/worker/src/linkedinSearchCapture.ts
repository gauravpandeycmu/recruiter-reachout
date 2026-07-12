import type { Page } from "playwright";

export interface ScrapedLinkedInProfile {
  fullName: string;
  firstName: string;
  title?: string;
  location?: string;
  linkedinUrl: string;
  profilePhotoUrl?: string;
}

const LINKEDIN_GEO_UNITED_STATES = '["103644278"]';

function buildLinkedInPeopleSearchUrl(input: {
  companyName: string;
  titleKeyword?: string;
  location?: string;
  page?: number;
}): string {
  const company = input.companyName.trim();
  const location = (input.location ?? "United States").trim() || "United States";
  const titleKeyword = (input.titleKeyword ?? "recruiter").trim() || "recruiter";
  const linkedinParams = new URLSearchParams({
    keywords: `${titleKeyword} ${company}`.trim(),
    origin: "GLOBAL_SEARCH_HEADER",
  });
  if (/united states|usa|^us$/i.test(location)) {
    linkedinParams.set("geoUrn", LINKEDIN_GEO_UNITED_STATES);
  }
  if (input.page && input.page > 1) {
    linkedinParams.set("page", String(input.page));
  }
  return `https://www.linkedin.com/search/results/people/?${linkedinParams.toString()}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Browser-side scraper, kept as a string so tsx/esbuild cannot inject `__name`
 * helpers into the Playwright page.evaluate payload.
 *
 * Verified against the 2025 LinkedIn people-search DOM:
 *  - Each result is a `div[role="listitem"]` (one person per card).
 *  - The person's own photo is the FIRST, largest (~48px) <img> in the card;
 *    any 24px images are mutual-connection thumbnails. Image alt is empty,
 *    so we associate by card scope + size, never by alt text.
 *  - The first `a[href*="/in/"]` is the person; later ones are mutual connections.
 *  - Headline and location are the first two `<p>` after the name.
 */
export const SCRAPE_VISIBLE_PEOPLE = `(() => {
  var normalize = function (v) { return String(v || "").replace(/\\s+/g, " ").trim(); };
  var dedupeName = function (value) {
    var n = normalize(value);
    if (!n) return "";
    var exact = n.match(/^(.+?)\\s+\\1$/i);
    if (exact && exact[1] && /[A-Za-z]{2,}\\s+[A-Za-z]{2,}/.test(exact[1])) return exact[1];
    var glued = n.match(/^(.+?)\\1$/i);
    if (glued && glued[1] && /[A-Za-z]{2,}\\s+[A-Za-z]{2,}/.test(glued[1])) return glued[1];
    var parts = n.split(/\\s+/);
    if (parts.length >= 4 && parts.length % 2 === 0) {
      var half = parts.length / 2;
      var left = parts.slice(0, half).join(" ");
      var right = parts.slice(half).join(" ");
      if (left.toLowerCase() === right.toLowerCase() && /[A-Za-z]{2,}\\s+[A-Za-z]{2,}/.test(left)) return left;
    }
    return n;
  };
  var cleanName = function (text) {
    var n = normalize(text).split(/\\s*[•·|]/)[0];
    n = n.replace(/^View\\s+/i, "").replace(/['\\u2019]s\\s+profile\\b.*$/i, "");
    n = n.replace(/[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2190}-\\u{21FF}\\u{2B00}-\\u{2BFF}\\uFE0F]/gu, "");
    n = normalize(n);
    n = n.replace(/\\s+(?:1st|2nd|3rd)\\b.*$/i, "");
    n = dedupeName(n);
    n = n.replace(/\\s+(?:View|Verified|Connect|Message|Follow|Following)$/i, "").trim();
    return n;
  };
  var firstNameOf = function (fullName) { return fullName.split(/\\s+/)[0] || fullName; };
  var normalizeUrl = function (href) {
    try {
      var url = new URL(href, "https://www.linkedin.com");
      var m = url.pathname.match(/\\/in\\/([^/?#]+)/i);
      if (!m || !m[1]) return undefined;
      var slug = decodeURIComponent(m[1]).replace(/\\/$/, "");
      if (!slug || /^(unavailable|edit|detail)$/i.test(slug) || slug.indexOf(".") !== -1) return undefined;
      return "https://www.linkedin.com/in/" + slug;
    } catch (e) { return undefined; }
  };
  var usablePhoto = function (src) {
    return Boolean(
      src &&
      /^https?:\\/\\//i.test(src) &&
      /profile-displayphoto/i.test(src) &&
      !/ghost|data:image|static\\/img\\/transparent/i.test(src)
    );
  };
  var isGhostImg = function (img) {
    var bits = [img.className || "", (img.parentElement && img.parentElement.className) || "", img.getAttribute("src") || "", img.getAttribute("alt") || ""].join(" ");
    return /ghost_person|ghosts\\/person|ghost-person|\\bghost\\b/i.test(bits);
  };
  var imgSrc = function (img) {
    var delayed = img.getAttribute("data-delayed-url") || "";
    if (isGhostImg(img) && !usablePhoto(delayed)) return "";
    if (usablePhoto(delayed)) return delayed;
    return img.currentSrc || img.src || delayed || "";
  };
  var isLocation = function (t) {
    return /(?:,\\s*(?:United States|USA|Canada|United Kingdom))\\b|,\\s*[A-Z]{2}\\b|\\bArea\\b|\\bGreater\\b|\\bMetropolitan\\b/.test(t);
  };

  // Choose the card container that wraps at least 3 profile links.
  var selectors = ["div[role='listitem']", "li.reusable-search__result-container", ".entity-result", "main li"];
  var cards = [];
  for (var i = 0; i < selectors.length; i++) {
    var els = Array.prototype.slice.call(document.querySelectorAll(selectors[i]));
    var withProfile = els.filter(function (e) { return e.querySelector('a[href*="/in/"]'); });
    if (withProfile.length >= 3) { cards = withProfile; break; }
  }

  var byUrl = new Map();
  for (var c = 0; c < cards.length; c++) {
    var card = cards[c];
    var anchors = Array.prototype.slice.call(card.querySelectorAll('a[href*="/in/"]'));
    if (anchors.length === 0) continue;
    var primary = anchors[0];
    var linkedinUrl = normalizeUrl(primary.href);
    if (!linkedinUrl || byUrl.has(linkedinUrl)) continue;

    // Name: shortest clean text among anchors pointing to THIS person.
    var nameCandidates = [];
    for (var a = 0; a < anchors.length; a++) {
      if (normalizeUrl(anchors[a].href) !== linkedinUrl) continue;
      var candidate = cleanName(anchors[a].textContent || "");
      if (candidate && /[A-Za-z]{2,}\\s+[A-Za-z]{1,}/.test(candidate)) nameCandidates.push(candidate);
    }
    nameCandidates.sort(function (x, y) { return x.length - y.length; });
    var fullName = nameCandidates[0] || "";
    if (!fullName || fullName.length < 2 || /linkedin member|linkedin|^recruiter$/i.test(fullName)) continue;

    // Headline + location: the informative <p> elements that are not the name.
    var paras = Array.prototype.slice.call(card.querySelectorAll("p"))
      .map(function (p) { return normalize(p.textContent); })
      .filter(function (t) {
        if (!t || t.length < 2) return false;
        if (t.toLowerCase().indexOf(fullName.toLowerCase()) !== -1) return false;
        if (/^(?:•\\s*)?(?:1st|2nd|3rd)\\b/i.test(t)) return false;
        if (/mutual connection|connections? in common/i.test(t)) return false;
        return true;
      });
    var location = undefined;
    var headline = undefined;
    var currentRole = undefined;
    for (var p = 0; p < paras.length; p++) {
      var text = paras[p];
      if (!location && isLocation(text)) { location = text; continue; }
      var currentMatch = text.match(/^Current:\\s*(.+)$/i);
      if (currentMatch) { if (!currentRole) currentRole = normalize(currentMatch[1]); continue; }
      if (!headline && !isLocation(text)) headline = text;
    }
    if (!headline) headline = currentRole;

    // Photo: only trust an image whose wrapping link points at THIS person's
    // profile (the avatar link and name link always share the href), or whose
    // alt text names them. Never guess by size/position - mutual-connection
    // avatars in the same card are how wrong faces were captured.
    var imgs = Array.prototype.slice.call(card.querySelectorAll("img"));
    var photo = undefined;
    for (var im = 0; im < imgs.length; im++) {
      var img = imgs[im];
      var src = imgSrc(img);
      if (!usablePhoto(src)) continue;
      var wrap = img.closest ? img.closest("a[href*='/in/']") : null;
      var wrapUrl = wrap ? normalizeUrl(wrap.href) : undefined;
      if (wrapUrl === linkedinUrl) { photo = src; break; }
      var alt = normalize(img.alt || "").toLowerCase();
      if (alt && alt.indexOf(fullName.toLowerCase()) !== -1) { photo = src; break; }
    }

    byUrl.set(linkedinUrl, {
      fullName: fullName,
      firstName: firstNameOf(fullName),
      title: headline || undefined,
      location: location || undefined,
      linkedinUrl: linkedinUrl,
      profilePhotoUrl: photo || undefined,
    });
  }

  return Array.from(byUrl.values()).slice(0, 50);
})()`;

/**
 * Scrapes LinkedIn people-search result cards from the current page DOM.
 */
export async function scrapeVisiblePeopleResults(page: Page): Promise<ScrapedLinkedInProfile[]> {
  // Scroll through the results so every card's avatar lazy-loads before we read it.
  for (let i = 0; i < 8; i += 1) {
    await page.mouse.wheel(0, 800);
    await delay(400);
  }
  await page.mouse.wheel(0, -4000).catch(() => undefined);
  await delay(1200);

  const found = (await page.evaluate(SCRAPE_VISIBLE_PEOPLE)) as ScrapedLinkedInProfile[] | undefined;
  return Array.isArray(found) ? found : [];
}

export async function captureCompanyRecruiters(
  page: Page,
  input: { companyName: string; pages: number; log?: (message: string) => void },
): Promise<ScrapedLinkedInProfile[]> {
  const log = input.log ?? (() => undefined);
  const pages = Math.min(3, Math.max(1, input.pages));
  const byUrl = new Map<string, ScrapedLinkedInProfile>();

  for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
    const url = buildLinkedInPeopleSearchUrl({
      companyName: input.companyName,
      location: "United States",
      page: pageNumber,
    });
    log(`LinkedIn capture page ${pageNumber}/${pages}: ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await delay(2500);

    const current = page.url();
    if (/\/login|\/checkpoint|\/authwall/i.test(current)) {
      throw new Error("LinkedIn session is not logged in. Open Setup → LinkedIn login, then retry.");
    }

    const found = await scrapeVisiblePeopleResults(page);
    log(`Page ${pageNumber}: found ${found.length} profile(s)`);
    for (const profile of found) {
      if (!byUrl.has(profile.linkedinUrl)) {
        byUrl.set(profile.linkedinUrl, profile);
      }
    }
    if (pageNumber < pages) {
      await delay(2000 + Math.floor(Math.random() * 1500));
    }
  }

  return [...byUrl.values()];
}

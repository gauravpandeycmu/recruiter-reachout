import type { Page } from "playwright";

export interface ScrapedLinkedInProfilePage {
  fullName?: string;
  profilePhotoUrl?: string;
}

/**
 * Browser-side scraper for a single LinkedIn profile page.
 * Kept as a string so tsx cannot inject `__name` into page.evaluate.
 *
 * Never trust og:image / global first profile-displayphoto — those often resolve to
 * the *viewer's* avatar. Prefer the top-card image tied to this profile's /in/ slug
 * or an alt/aria label that names the person.
 */
export const SCRAPE_LINKEDIN_PROFILE_PAGE = `(() => {
  var normalize = function (v) { return String(v || "").replace(/\\s+/g, " ").trim(); };
  var slugFromPath = function (path) {
    var m = String(path || "").match(/\\/in\\/([^/?#]+)/i);
    return m && m[1] ? decodeURIComponent(m[1]).replace(/\\/$/, "").toLowerCase() : "";
  };
  var looksPhoto = function (url) {
    if (!url || typeof url !== "string") return false;
    if (/data:|spacer|ghost|placeholder|sprite|static\\.licdn|company-logo/i.test(url)) return false;
    return /media\\.licdn\\.com|licdn\\.com\\/dms\\/image|profile-displayphoto/i.test(url);
  };
  var isGhost = function (img) {
    var bits = [img.className || "", (img.parentElement && img.parentElement.className) || "", img.getAttribute("src") || "", img.getAttribute("alt") || ""].join(" ");
    return /ghost_person|ghosts\\/person|ghost-person|\\bghost\\b/i.test(bits);
  };
  var imgUrl = function (img) {
    if (!img || isGhost(img)) return "";
    var delayed = img.getAttribute("data-delayed-url") || "";
    if (looksPhoto(delayed)) return delayed;
    return img.currentSrc || img.src || delayed || "";
  };
  var pageSlug = slugFromPath(location.pathname);
  var fullName = "";
  var h1 = document.querySelector("main h1, .pv-top-card h1, h1");
  if (h1) fullName = normalize(h1.textContent || "");
  if (!fullName) {
    var title = normalize(document.title || "").split(/[|\\-–—]/)[0];
    if (title && !/linkedin/i.test(title)) fullName = title;
  }
  var nameLower = fullName.toLowerCase();

  var candidates = [];
  var push = function (url, score, why) {
    if (!looksPhoto(url)) return;
    candidates.push({ url: url, score: score, why: why });
  };

  // 1) Anchor wrapping this profile slug → inner profile-displayphoto (best)
  var anchors = Array.prototype.slice.call(document.querySelectorAll('a[href*="/in/"]'));
  for (var a = 0; a < anchors.length; a++) {
    var href = anchors[a].getAttribute("href") || anchors[a].href || "";
    if (!pageSlug || slugFromPath(href) !== pageSlug) continue;
    var imgs = Array.prototype.slice.call(anchors[a].querySelectorAll("img"));
    for (var i = 0; i < imgs.length; i++) {
      var src = imgUrl(imgs[i]);
      if (!src) continue;
      var score = /profile-displayphoto/i.test(src) ? 100 : 70;
      var rect = imgs[i].getBoundingClientRect ? imgs[i].getBoundingClientRect() : { width: 0, height: 0 };
      if (rect.width >= 64 && rect.height >= 64) score += 15;
      push(src, score, "profile-link");
    }
  }

  // 2) Top card / main images whose alt or aria names this person
  var scopes = [
    document.querySelector(".pv-top-card"),
    document.querySelector("section.artdeco-card"),
    document.querySelector("main"),
  ].filter(Boolean);
  for (var s = 0; s < scopes.length; s++) {
    var scopedImgs = Array.prototype.slice.call(scopes[s].querySelectorAll("img"));
    for (var j = 0; j < scopedImgs.length; j++) {
      var img = scopedImgs[j];
      var src2 = imgUrl(img);
      if (!src2) continue;
      var alt = normalize(img.alt || img.getAttribute("aria-label") || "").toLowerCase();
      var score2 = /profile-displayphoto/i.test(src2) ? 50 : 20;
      if (nameLower && alt && (alt === nameLower || alt.indexOf(nameLower) >= 0)) score2 += 40;
      var r2 = img.getBoundingClientRect ? img.getBoundingClientRect() : { width: 0, height: 0 };
      if (r2.width >= 80 && r2.height >= 80) score2 += 10;
      // Prefer images near the top of the page (top card)
      if (r2.top >= 0 && r2.top < 420) score2 += 8;
      push(src2, score2, "scoped");
    }
  }

  // 3) JSON-LD Person.image (usually the profile subject)
  var scripts = Array.prototype.slice.call(document.querySelectorAll('script[type="application/ld+json"]'));
  for (var k = 0; k < scripts.length; k++) {
    try {
      var parsed = JSON.parse(scripts[k].textContent || "null");
      var nodes = Array.isArray(parsed) ? parsed.slice() : [parsed];
      if (parsed && parsed["@graph"]) nodes = nodes.concat(parsed["@graph"]);
      for (var n = 0; n < nodes.length; n++) {
        var node = nodes[n];
        if (!node || node["@type"] !== "Person") continue;
        var image = node.image;
        var url = typeof image === "string" ? image : (image && image.url);
        push(url, 85, "jsonld");
      }
    } catch (e) {}
  }

  candidates.sort(function (a, b) { return b.score - a.score; });
  var best = candidates[0];
  // Never fall back to og:image — too often the viewer or a generic card image.
  return {
    fullName: fullName || undefined,
    profilePhotoUrl: best ? best.url : undefined,
    debug: best ? { why: best.why, score: best.score, count: candidates.length } : { count: 0 },
  };
})()`;

export async function scrapeLinkedInProfilePage(
  page: Page,
  linkedinUrl: string,
): Promise<ScrapedLinkedInProfilePage> {
  await page.goto(linkedinUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  // Profile chrome + lazy images inject after first paint.
  await page.waitForSelector("main h1, .pv-top-card h1, h1", { timeout: 8_000 }).catch(() => undefined);
  await page.waitForTimeout(1800);
  const scraped = (await page.evaluate(SCRAPE_LINKEDIN_PROFILE_PAGE)) as ScrapedLinkedInProfilePage & {
    debug?: { why?: string; score?: number; count?: number };
  };
  return {
    fullName: scraped.fullName?.trim() || undefined,
    profilePhotoUrl: scraped.profilePhotoUrl?.trim() || undefined,
  };
}

const express = require("express");
const path = require("path");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;
const JML_HOST = "www.jml-immobilier.fr";

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function normalizeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== JML_HOST) {
    throw new Error("Seules les URLs https://www.jml-immobilier.fr/ sont acceptées.");
  }
  return url.toString();
}

function absoluteUrl(value) {
  if (!value) return null;
  try {
    return new URL(value, "https://www.jml-immobilier.fr").toString();
  } catch {
    return null;
  }
}

function cleanText(value) {
  return String(value || "").replace(/\\s+/g, " ").trim();
}

function firstText($, selectors) {
  for (const selector of selectors) {
    const value = cleanText($(selector).first().text());
    if (value) return value;
  }
  return null;
}

function collectImages($) {
  const candidates = [];
  const push = (value, score = 0, order = 0) => {
    const full = absoluteUrl(value);
    if (!full) return;
    const lower = full.toLowerCase();

    // Never take branding, diagnostics, maps or social-media assets.
    if (
      lower.includes("logo") ||
      lower.includes("favicon") ||
      lower.includes("icon") ||
      lower.includes("dpe") ||
      lower.includes("diagnostic") ||
      lower.includes("map") ||
      lower.includes("plan") ||
      lower.includes("tiktok") ||
      lower.includes("facebook") ||
      lower.includes("instagram")
    ) return;

    candidates.push({ url: full, score, order });
  };

  let order = 0;

  // JSON-LD is useful, but it can contain images from related/recommended
  // properties. Keep it as a fallback rather than mixing it with the main
  // gallery when a real gallery is found in the page DOM.
  const jsonLdCandidates = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).contents().text();
      const data = JSON.parse(raw);
      const walk = (node) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) return node.forEach(walk);
        if (Array.isArray(node.image)) {
          node.image.forEach((img) => {
            const value = typeof img === "string" ? img : img?.url || img?.contentUrl;
            if (value) jsonLdCandidates.push(value);
          });
        }
        Object.values(node).forEach(walk);
      };
      walk(data);
    } catch {}
  });

  // Look for the page's actual gallery container first. This is the critical
  // distinction: JML pages can contain a second carousel for other properties.
  const gallerySelectors = [
    '[class*="gallery"]',
    '[class*="galerie"]',
    '[id*="gallery"]',
    '[id*="galerie"]',
    '[class*="fancybox"]',
    '[class*="swiper"]',
    '[class*="carousel"]'
  ];

  const galleryNodes = [];
  for (const selector of gallerySelectors) {
    $(selector).each((_, el) => {
      const $el = $(el);
      const count = $el.find('a, img').length;
      if (count >= 2) galleryNodes.push({ el, count, selector });
    });
  }

  // Prefer the largest gallery-like container near the top of the property
  // page. Related-property carousels are normally farther down the DOM.
  galleryNodes.sort((a, b) => {
    const posA = $(a.el).index();
    const posB = $(b.el).index();
    return (b.count - a.count) * 1000 + (posA - posB);
  });

  let galleryUrls = [];
  if (galleryNodes.length) {
    const chosen = galleryNodes[0].el;
    const $gallery = $(chosen);

    $gallery.find('a, img').each((_, el) => {
      const $el = $(el);
      const attrs = [
        $el.attr("href"),
        $el.attr("data-src"),
        $el.attr("data-image"),
        $el.attr("data-original"),
        $el.attr("data-fancybox"),
        $el.attr("data-large-image"),
        $el.attr("src"),
        $el.attr("data-lazy-src"),
        $el.attr("data-large")
      ];
      attrs.forEach((value) => {
        if (value) {
          const before = candidates.length;
          push(value, 100, order++);
          if (candidates.length > before) galleryUrls.push(absoluteUrl(value));
        }
      });
    });
  }

  // If the gallery container was not identified, collect DOM image/link
  // candidates while preserving document order.
  if (!galleryUrls.length) {
    $('a, img').each((_, el) => {
      const $el = $(el);
      const attrs = [
        $el.attr("href"),
        $el.attr("data-src"),
        $el.attr("data-image"),
        $el.attr("data-original"),
        $el.attr("data-fancybox"),
        $el.attr("data-large-image"),
        $el.attr("src"),
        $el.attr("data-lazy-src"),
        $el.attr("data-large")
      ];
      const classText = ($el.attr("class") || "").toLowerCase();
      const score = /gallery|galerie|photo|fancybox|swiper|carousel/.test(classText) ? 80 : 30;
      attrs.forEach((value) => push(value, score, order++));
    });
  }

  const unique = new Map();
  for (const item of candidates) {
    const existing = unique.get(item.url);
    if (!existing || item.score > existing.score) unique.set(item.url, item);
  }

  let result = [...unique.values()]
    .sort((a, b) => a.order - b.order)
    .map((item) => item.url);

  // If a genuine gallery was found, do not append JSON-LD or recommended
  // property images. JSON-LD is only a fallback when no gallery was found.
  if (!galleryUrls.length && result.length === 0) {
    result = jsonLdCandidates.map((url) => absoluteUrl(url)).filter(Boolean);
  }

  return [...new Set(result)].slice(0, 20);
}

function parsePrice(text) {
  if (!text) return null;
  const normalized = String(text).replace(/\\u00a0/g, " ").replace(/\\s+/g, " ").trim();
  const match = normalized.match(/([0-9][0-9 .]{2,})\\s*€/);
  return match ? match[1].replace(/\\s+/g, " ").trim() + " €" : null;
}

function extractPrice($, bodyText) {
  const selectors = [
    "[class*='prix']",
    "[class*='price']",
    "[itemprop='price']",
    "meta[property='product:price:amount']",
    "meta[itemprop='price']"
  ];

  for (const selector of selectors) {
    $(selector).each((_, el) => {
      if (extractPrice.value) return;
      const raw = $(el).attr("content") || $(el).text();
      const parsed = parsePrice(raw);
      if (parsed) extractPrice.value = parsed;
    });
    if (extractPrice.value) break;
  }

  if (extractPrice.value) {
    const value = extractPrice.value;
    extractPrice.value = null;
    return value;
  }

  const matches = [...bodyText.matchAll(/([0-9][0-9 .]{2,})\\s*€/g)]
    .map((m) => m[1].replace(/\\s+/g, " ").trim() + " €");
  return matches.length ? matches[0] : null;
}
extractPrice.value = null;

function parseListing(html, sourceUrl) {
  const $ = cheerio.load(html);
  const title = firstText($, ["h1", "title"]);
  const bodyText = cleanText($("body").text());

  const images = collectImages($);

  const property = {
    title,
    price: extractPrice($, bodyText),
    sourceUrl,
    location: null,
    surface: null,
    terrain: null,
    rooms: null,
    bedrooms: null,
    description: firstText($, [".description", ".descriptif", "[class*='description']"]),
    images,
    imageCount: images.length,
    retrievedAt: new Date().toISOString()
  };

  const locationMatch = bodyText.match(/([A-ZÉÈÀÙÂÊÎÔÛÇ][A-Za-zÀ-ÿ' -]+)\\s*\\((0[0-9]{4})\\)/);
  if (locationMatch) property.location = `${locationMatch[1].trim()} (${locationMatch[2]})`;

  const surfaceMatch = bodyText.match(/(?:Surface habitable|Surface|surface)\\s*:?\\s*([0-9]+(?:[.,][0-9]+)?)\\s*m²/i);
  if (surfaceMatch) property.surface = surfaceMatch[1].replace(",", ".") + " m²";

  const terrainMatch = bodyText.match(/(?:Terrain|terrain)\\s*:?\\s*([0-9]+(?:[.,][0-9]+)?)\\s*m²/i);
  if (terrainMatch) property.terrain = terrainMatch[1].replace(",", ".") + " m²";

  const bedroomsMatch = bodyText.match(/([0-9]+)\\s*chambre(?:s)?/i);
  if (bedroomsMatch) property.bedrooms = Number(bedroomsMatch[1]);

  const roomsMatch = bodyText.match(/([0-9]+)\\s*pièce(?:s)?/i);
  if (roomsMatch) property.rooms = Number(roomsMatch[1]);

  return property;
}

app.post("/api/scrape", async (req, res) => {
  try {
    const sourceUrl = normalizeUrl(req.body?.url);
    const response = await fetch(sourceUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; JML-Annonces/0.1; +https://www.jml-immobilier.fr/)"
      }
    });

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: `JML a répondu avec le statut HTTP ${response.status}.`
      });
    }

    const html = await response.text();
    const listing = parseListing(html, sourceUrl);

    // Validate candidate images from the server side. This removes broken,
    // non-image and stale gallery references before the browser displays them.
    const validated = [];
    for (const imageUrl of listing.images) {
      try {
        const imageResponse = await fetch(imageUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; JML-Annonces/0.1; +https://www.jml-immobilier.fr/)"
          }
        });
        const contentType = imageResponse.headers.get("content-type") || "";
        if (imageResponse.ok && contentType.startsWith("image/")) {
          validated.push(imageUrl);
        }
      } catch {}
      if (validated.length >= 15) break;
    }

    listing.images = validated;
    listing.imageCount = validated.length;

    res.json({
      ok: true,
      listing,
      photoPolicy: {
        originalOnly: true,
        generatedReplacementAllowed: false,
        publishBlockedIfNoPhotos: listing.images.length === 0
      }
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Erreur inconnue." });
  }
});

app.get("/api/image", async (req, res) => {
  try {
    const raw = String(req.query.url || "");
    const imageUrl = new URL(raw);

    // The proxy is intentionally restricted to JML hosts to prevent SSRF.
    const allowedHosts = new Set(["www.jml-immobilier.fr", "jml-immobilier.fr"]);
    if (imageUrl.protocol !== "https:" || !allowedHosts.has(imageUrl.hostname)) {
      return res.status(400).end();
    }

    const response = await fetch(imageUrl.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; JML-Annonces/0.1; +https://www.jml-immobilier.fr/)"
      }
    });

    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !contentType.startsWith("image/")) {
      return res.status(404).end();
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch {
    res.status(400).end();
  }
});

app.get("/api/health", (_, res) => {
  res.json({ ok: true, app: "jml-annonces", version: "0.1.0" });
});

app.listen(PORT, () => {
  console.log(`JML Annonces listening on port ${PORT}`);
});

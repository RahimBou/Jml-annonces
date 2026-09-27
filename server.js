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
  const push = (value, score = 0) => {
    const full = absoluteUrl(value);
    if (!full) return;
    const lower = full.toLowerCase();
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
    candidates.push({ url: full, score });
  };

  // 1) Structured data is the preferred source when the agency page exposes
  // the property's image gallery in JSON-LD.
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).contents().text();
      const data = JSON.parse(raw);
      const walk = (node) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) return node.forEach(walk);
        if (Array.isArray(node.image)) node.image.forEach((img) => {
          if (typeof img === "string") push(img, 100);
          else if (img && typeof img === "object") push(img.url || img.contentUrl, 100);
        });
        Object.values(node).forEach(walk);
      };
      walk(data);
    } catch {}
  });

  // 2) Gallery links / lightbox attributes.
  $('a').each((_, el) => {
    const $el = $(el);
    const attrs = [
      $el.attr("href"),
      $el.attr("data-src"),
      $el.attr("data-image"),
      $el.attr("data-original"),
      $el.attr("data-fancybox"),
      $el.attr("data-large-image")
    ];
    const classText = ($el.attr("class") || "").toLowerCase();
    const score = /gallery|galerie|photo|fancybox|swiper|carousel/.test(classText) ? 80 : 50;
    attrs.forEach((value) => push(value, score));
  });

  // 3) Image elements and responsive/lazy-loading attributes.
  $("img").each((_, el) => {
    const $el = $(el);
    const attrs = [
      $el.attr("src"),
      $el.attr("data-src"),
      $el.attr("data-lazy-src"),
      $el.attr("data-original"),
      $el.attr("data-image"),
      $el.attr("data-large"),
      $el.attr("data-large-image")
    ];
    const classText = ($el.attr("class") || "").toLowerCase();
    const score = /gallery|galerie|photo|fancybox|swiper|carousel/.test(classText) ? 70 : 30;
    attrs.forEach((value) => push(value, score));
  });

  // 4) srcset can contain the real full-size gallery URL.
  $("[srcset], [data-srcset]").each((_, el) => {
    const raw = $(el).attr("srcset") || $(el).attr("data-srcset") || "";
    raw.split(",").forEach((part) => {
      const value = part.trim().split(/\\s+/)[0];
      if (value) push(value, 40);
    });
  });

  const unique = new Map();
  for (const item of candidates) {
    const existing = unique.get(item.url);
    if (!existing || item.score > existing.score) unique.set(item.url, item);
  }

  return [...unique.values()]
    .sort((a, b) => b.score - a.score)
    .map((item) => item.url)
    .slice(0, 20);
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

app.get("/api/health", (_, res) => {
  res.json({ ok: true, app: "jml-annonces", version: "0.1.0" });
});

app.listen(PORT, () => {
  console.log(`JML Annonces listening on port ${PORT}`);
});

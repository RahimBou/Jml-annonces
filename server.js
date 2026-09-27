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
  return String(value || "").replace(/\s+/g, " ").trim();
}

function firstText($, selectors) {
  for (const selector of selectors) {
    const value = cleanText($(selector).first().text());
    if (value) return value;
  }
  return null;
}

function collectImages($) {
  /*
   * Structured gallery contract:
   * 1. Identify a gallery container, never arbitrary images on the page.
   * 2. Extract only image candidates that belong to that container.
   * 3. Keep DOM order and deduplicate by canonical URL.
   * 4. JSON-LD is an explicit fallback only when no gallery exists.
   * 5. Expose diagnostics so publication can be refused when extraction is
   *    incomplete or ambiguous.
   */
  const diagnostics = {
    strategy: "structured-gallery",
    gallerySelector: null,
    galleryCandidates: 0,
    selectedGalleryScore: 0,
    rawPhotoCount: 0,
    uniquePhotoCount: 0,
    source: null,
    confidence: "low",
    suspicious: false,
    reasons: []
  };

  const normalizeImageUrl = (value) => {
    if (!value) return null;
    const full = absoluteUrl(String(value).trim());
    if (!full) return null;

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
    ) return null;

    return full;
  };

  const imageAttrs = ($el) => [
    $el.attr("href"),
    $el.attr("data-src"),
    $el.attr("data-image"),
    $el.attr("data-original"),
    $el.attr("data-fancybox"),
    $el.attr("data-large-image"),
    $el.attr("data-lazy-src"),
    $el.attr("data-large"),
    $el.attr("src")
  ].filter(Boolean);

  const isRelatedContainer = ($el) => {
    const text = [
      $el.attr("id"),
      $el.attr("class"),
      $el.attr("aria-label"),
      $el.attr("data-title")
    ].filter(Boolean).join(" ").toLowerCase();

    return /(related|similar|similaire|suggest|recommand|autres[-_ ]?biens|biens[-_ ]?similaires|annonces[-_ ]?similaires)/i.test(text);
  };

  const scoreGallery = ($el, selector, index) => {
    const classText = [
      $el.attr("id"),
      $el.attr("class"),
      $el.attr("role"),
      $el.attr("data-gallery"),
      $el.attr("data-gallery-id")
    ].filter(Boolean).join(" ").toLowerCase();

    const childCount = $el.find("a, img").length;
    if (childCount < 2 || isRelatedContainer($el)) return null;

    let score = 0;

    if (/gallery|galerie/.test(classText)) score += 100;
    if (/fancybox/.test(classText)) score += 90;
    if (/swiper/.test(classText)) score += 80;
    if (/carousel|slider/.test(classText)) score += 70;
    if ($el.attr("data-gallery") || $el.attr("data-gallery-id")) score += 120;

    const fullSizeLinks = $el.find("a[data-original], a[data-large-image], a[data-large], a[data-src]").length;
    score += Math.min(fullSizeLinks * 8, 40);

    if (childCount >= 3 && childCount <= 30) score += 20;
    if (childCount > 50) score -= 30;

    score += Math.max(0, 20 - Math.min(index, 20));

    return { score, childCount, selector, domIndex: index };
  };

  const gallerySelectors = [
    "[data-gallery]",
    "[data-gallery-id]",
    "[class*='gallery']",
    "[class*='galerie']",
    "[id*='gallery']",
    "[id*='galerie']",
    "[class*='fancybox']",
    "[class*='swiper']",
    "[class*='carousel']",
    "[class*='slider']"
  ];

  const galleryNodes = [];
  let domIndex = 0;

  for (const selector of gallerySelectors) {
    $(selector).each((_, el) => {
      const $el = $(el);
      const scored = scoreGallery($el, selector, domIndex++);
      if (scored) galleryNodes.push({ el, ...scored });
    });
  }

  const uniqueNodes = new Map();
  for (const item of galleryNodes) {
    const key = item.el;
    const existing = uniqueNodes.get(key);
    if (!existing || item.score > existing.score) uniqueNodes.set(key, item);
  }

  const ranked = [...uniqueNodes.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.domIndex - b.domIndex;
  });

  diagnostics.galleryCandidates = ranked.length;

  const extractFromGallery = (gallery) => {
    const urls = [];
    const seen = new Set();
    const $gallery = $(gallery.el);

    $gallery.find("a, img").each((position, el) => {
      const $el = $(el);
      for (const value of imageAttrs($el)) {
        const url = normalizeImageUrl(value);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        urls.push({ url, position });
        break;
      }
    });

    return urls;
  };

  let photos = [];

  if (ranked.length) {
    const selected = ranked[0];
    diagnostics.gallerySelector = selected.selector;
    diagnostics.selectedGalleryScore = selected.score;

    const extracted = extractFromGallery(selected);
    diagnostics.rawPhotoCount = extracted.length;

    if (extracted.length >= 2) {
      photos = extracted.map((item) => item.url);
      diagnostics.source = "main-gallery";
      diagnostics.confidence = selected.score >= 120 ? "high" : "medium";
    } else {
      diagnostics.suspicious = true;
      diagnostics.reasons.push("Le conteneur de galerie identifié contient moins de 2 photos exploitables.");
    }
  }

  // Explicit structured-data fallback. We do NOT fall back to all <a>/<img>
  // because that can silently import photos from other listings.
  if (!photos.length) {
    const jsonLdPhotos = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).contents().text());
        const walk = (node) => {
          if (!node || typeof node !== "object") return;
          if (Array.isArray(node)) return node.forEach(walk);

          if (Array.isArray(node.image)) {
            node.image.forEach((img) => {
              const value = typeof img === "string" ? img : img?.url || img?.contentUrl;
              const url = normalizeImageUrl(value);
              if (url) jsonLdPhotos.push(url);
            });
          }

          Object.values(node).forEach(walk);
        };
        walk(data);
      } catch {}
    });

    photos = [...new Set(jsonLdPhotos)];
    if (photos.length) {
      diagnostics.rawPhotoCount = photos.length;
      diagnostics.uniquePhotoCount = photos.length;
      diagnostics.source = "json-ld";
      diagnostics.confidence = "medium";
    }
  }

  diagnostics.uniquePhotoCount = [...new Set(photos)].length;

  if (!photos.length) {
    diagnostics.suspicious = true;
    diagnostics.reasons.push("Aucune galerie structurée ou liste d'images JSON-LD exploitable n'a été trouvée.");
  }

  return {
    images: [...new Set(photos)].slice(0, 30),
    diagnostics
  };
}

function extractExpectedPhotoCount($, bodyText) {
  const patterns = [
    /(?:galerie|album|photos?|photographies?)\s*[:\-]?\s*(\d{1,2})\s*(?:photos?|images?)?/i,
    /(\d{1,2})\s*(?:photos?|images?)\s*(?:originales?|disponibles?|dans la galerie)?/i
  ];

  for (const pattern of patterns) {
    const match = String(bodyText || "").match(pattern);
    if (match) {
      const count = Number(match[1]);
      if (count >= 1 && count <= 50) return count;
    }
  }

  return null;
}

function extractReference($, bodyText, sourceUrl) {
  const selectors = [
    "[class*='reference']",
    "[class*='ref']",
    "[id*='reference']",
    "[id*='ref']"
  ];

  for (const selector of selectors) {
    const text = cleanText($(selector).first().text());
    const match = text.match(/(?:réf(?:érence)?|ref(?:erence)?)\s*[:#-]?\s*([A-Z0-9-]{2,20})/i);
    if (match) return match[1];
  }

  const bodyMatch = String(bodyText || "").match(/(?:réf(?:érence)?|ref(?:erence)?)\s*[:#-]?\s*([A-Z0-9-]{2,20})/i);
  if (bodyMatch) return bodyMatch[1];

  const urlMatch = String(sourceUrl || "").match(/(?:^|-)(\d{2,})-[^/]+$/);
  return urlMatch ? urlMatch[1] : null;
}

function extractLogoUrl($) {
  const selectors = [
    "img[src*='logo' i]",
    "img[data-src*='logo' i]",
    "img[data-original*='logo' i]"
  ];

  for (const selector of selectors) {
    const el = $(selector).first();
    const value = el.attr("src") || el.attr("data-src") || el.attr("data-original");
    const url = absoluteUrl(value);
    if (url) return url;
  }
  return null;
}

function extractHighlights(bodyText) {
  const source = cleanText(bodyText);
  const rules = [
    ["Hyper centre", /hyper\s*centre/i],
    ["Terrasse", /terrasse/i],
    ["Terrasse plein sud", /terrasse[^.]{0,80}plein\s+sud|plein\s+sud[^.]{0,80}terrasse/i],
    ["Cuisine équipée", /cuisine\s+(?:séparée\s+)?équipée/i],
    ["Salon lumineux", /séjour[^.]{0,80}(?:lumineux|lumineuse)|salon[^.]{0,80}(?:lumineux|lumineuse)/i],
    ["Salle de bains", /salle\s+de\s+bains/i],
    ["Cave", /\bcave\b/i],
    ["Parking", /parking/i],
    ["Garage possible", /possibilité\s+(?:de\s+)?garage|garage\s+(?:possible|possibilité)/i],
    ["Garage", /\bgarage(?:s)?\b/i],
    ["Vue dégagée", /vue\s+dégagée/i],
    ["Terrain arboré", /terrain\s+arboré/i],
    ["Piscinable", /piscinable/i],
    ["Plain-pied", /plain[- ]pied/i],
    ["WC séparé", /wc\s+séparé/i],
    ["DPE en cours", /DPE\s+en\s+cours/i]
  ];

  const result = [];
  for (const [label, pattern] of rules) {
    if (pattern.test(source) && !result.includes(label)) result.push(label);
    if (result.length >= 6) break;
  }
  return result;
}

function parsePrice(text) {
  if (!text) return null;
  const normalized = String(text).replace(/\\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const match = normalized.match(/([0-9][0-9 .]{2,})\s*€/);
  return match ? match[1].replace(/\s+/g, " ").trim() + " €" : null;
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

  const matches = [...bodyText.matchAll(/([0-9][0-9 .]{2,})\s*€/g)]
    .map((m) => m[1].replace(/\s+/g, " ").trim() + " €");
  return matches.length ? matches[0] : null;
}
extractPrice.value = null;

function parseListing(html, sourceUrl) {
  const $ = cheerio.load(html);
  const bodyText = cleanText($("body").text());

  // Prefer the listing's structured data when available. This avoids picking
  // up values from recommendation blocks lower on the page.
  const structured = {};
  const collectStructured = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(collectStructured);

    if (!structured.name && typeof node.name === "string" && /appartement|maison|pavillon|terrain|garage|immeuble|local/i.test(node.name)) {
      structured.name = cleanText(node.name);
    }
    if (!structured.price && node.offers && typeof node.offers === "object") {
      const p = node.offers.price ?? node.offers.lowPrice;
      if (p != null) structured.price = String(p);
    }
    if (!structured.location && node.address && typeof node.address === "object") {
      const locality = cleanText(node.address.addressLocality);
      const postal = cleanText(node.address.postalCode);
      if (locality) structured.location = postal ? `${locality} (${postal})` : locality;
    }
    if (!structured.surface && node.floorSize) {
      const value = typeof node.floorSize === "object" ? node.floorSize.value : node.floorSize;
      if (value) structured.surface = String(value).replace(",", ".") + " m²";
    }
    if (!structured.rooms && node.numberOfRooms != null) structured.rooms = Number(node.numberOfRooms);
    if (!structured.bedrooms && node.numberOfBedrooms != null) structured.bedrooms = Number(node.numberOfBedrooms);

    Object.values(node).forEach(collectStructured);
  };

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      collectStructured(JSON.parse($(el).contents().text()));
    } catch {}
  });

  const title = structured.name || firstText($, ["h1", "title"]);
  const reference = extractReference($, bodyText, sourceUrl);
  const highlights = extractHighlights(bodyText);
  const logoUrl = extractLogoUrl($);
  const photoExtraction = collectImages($);
  const images = photoExtraction.images;
  const expectedPhotoCount = extractExpectedPhotoCount($, bodyText);

  const property = {
    title,
    reference,
    highlights,
    logoUrl,
    price: structured.price ? parsePrice(structured.price + " €") : extractPrice($, bodyText),
    sourceUrl,
    location: structured.location || null,
    surface: structured.surface || null,
    terrain: null,
    rooms: structured.rooms || null,
    bedrooms: structured.bedrooms || null,
    description: firstText($, [".description", ".descriptif", "[class*='description']"]),
    images,
    imageCount: images.length,
    expectedPhotoCount,
    photoExtraction: photoExtraction.diagnostics,
    retrievedAt: new Date().toISOString()
  };

  // Correct DOM fallbacks, scoped to the listing text rather than blindly
  // trusting the first matching value on the whole page.
  if (!property.location) {
    const locationMatch = bodyText.match(/([A-ZÉÈÀÙÂÊÎÔÛÇ][A-Za-zÀ-ÿ' -]+?)\s*\((0[0-9]{4})\)/);
    if (locationMatch) property.location = `${locationMatch[1].trim()} (${locationMatch[2]})`;
  }

  if (!property.surface) {
    const surfaceMatch = bodyText.match(/(?:Surface habitable|Surface)\s*:?\s*([0-9]+(?:[.,][0-9]+)?)\s*m²/i);
    if (surfaceMatch) property.surface = surfaceMatch[1].replace(",", ".") + " m²";
  }

  const terrainMatch = bodyText.match(/Terrain\s*:?\s*([0-9]+(?:[.,][0-9]+)?)\s*m²/i);
  if (terrainMatch) property.terrain = terrainMatch[1].replace(",", ".") + " m²";

  if (!property.bedrooms) {
    const bedroomsMatch = bodyText.match(/([0-9]+)\s*chambre(?:s)?/i);
    if (bedroomsMatch) property.bedrooms = Number(bedroomsMatch[1]);
  }

  if (!property.rooms) {
    const roomsMatch = bodyText.match(/([0-9]+)\s*pièce(?:s)?/i);
    if (roomsMatch) property.rooms = Number(roomsMatch[1]);
  }

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

    // Validate only the photos selected by the structured extractor.
    // We never search the rest of the page if one photo fails.
    const validated = [];
    for (let index = 0; index < listing.images.length; index++) {
      const imageUrl = listing.images[index];
      try {
        const imageResponse = await fetch(imageUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; JML-Annonces/0.1; +https://www.jml-immobilier.fr/)"
          }
        });
        const contentType = imageResponse.headers.get("content-type") || "";
        if (imageResponse.ok && contentType.startsWith("image/")) {
          validated.push({
            url: imageUrl,
            position: validated.length + 1,
            verified: true,
            source: listing.photoExtraction.source
          });
        }
      } catch {}
    }

    listing.photos = validated;
    listing.images = validated.map((item) => item.url);
    listing.imageCount = listing.images.length;
    listing.photoExtraction.verifiedPhotoCount = listing.imageCount;

    if (listing.expectedPhotoCount != null && listing.imageCount !== listing.expectedPhotoCount) {
      listing.photoExtraction.suspicious = true;
      listing.photoExtraction.reasons.push(
        "Nombre de photos incohérent : " +
        listing.imageCount +
        " validée(s) pour " +
        listing.expectedPhotoCount +
        " attendue(s)."
      );
    }

    const photoComplete =
      listing.imageCount > 0 &&
      !listing.photoExtraction.suspicious &&
      (listing.expectedPhotoCount == null || listing.imageCount === listing.expectedPhotoCount);

    listing.photoStatus =
      listing.imageCount === 0
        ? "unreliable"
        : !photoComplete
          ? "partial"
          : "complete";

    res.json({
      ok: true,
      listing,
      photoPolicy: {
        originalOnly: true,
        generatedReplacementAllowed: false,
        publishBlockedIfNoPhotos: listing.images.length === 0,
        publishBlockedIfIncomplete: !photoComplete,
        publishAllowedForPhotoTest: photoComplete,
        status: listing.photoStatus
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
  res.json({ ok: true, app: "jml-annonces", version: "0.6.0" });
});

app.listen(PORT, () => {
  console.log(`JML Annonces listening on port ${PORT}`);
});

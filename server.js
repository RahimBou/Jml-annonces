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

function normalizeFactText(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .replace(/[^a-z0-9²m€., -]/g, " ");
}

function factTokens(value) {
  const stop = new Set([
    "le","la","les","un","une","des","de","du","d","et","avec","sans","a","au","aux",
    "en","sur","sous","dans","pour","par","plus","tres","très","situe","situé",
    "situee","située","comprenant","comprend","possibilite","possibilité","voir","annonce"
  ]);
  return [...new Set(
    normalizeFactText(value)
      .split(/\\s+/)
      .map(x => x.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
      .filter(x => x.length >= 3 && !stop.has(x))
  )];
}

function buildFactCorpus(listing) {
  return [
    listing.title,
    listing.price,
    listing.location,
    listing.surface,
    listing.terrain,
    listing.rooms != null ? String(listing.rooms) + " pièces" : "",
    listing.bedrooms != null ? String(listing.bedrooms) + " chambres" : "",
    listing.description,
    ...(listing.highlights || [])
  ].filter(Boolean).join(" ");
}

function validateClaimAgainstListing(claim, listing) {
  const text = cleanText(claim);
  if (!text) return { approved: false, reason: "empty", claim: text };

  const corpus = normalizeFactText(buildFactCorpus(listing));
  const tokens = factTokens(text);

  // A claim must be grounded in the scraped listing facts.
  // Generic editorial words are ignored; substantive words must appear in source facts.
  const unsupported = tokens.filter(token => {
    if (/^\\d+(?:[.,]\\d+)?$/.test(token)) return !corpus.includes(token);
    return !corpus.includes(token);
  });

  // Strong numeric guard: every number in a claim must exist in the source facts.
  const numbers = normalizeFactText(text).match(/\\d+(?:[.,]\\d+)?/g) || [];
  const badNumbers = numbers.filter(n => !corpus.includes(n));

  if (unsupported.length || badNumbers.length) {
    return {
      approved: false,
      reason: "claim-not-grounded",
      claim: text,
      unsupported: [...new Set([...unsupported, ...badNumbers])]
    };
  }

  return { approved: true, reason: "grounded", claim: text };
}

function validateGeneratedContent(listing, content) {
  const fields = ["title", "subtitle", "highlights"];
  const results = [];

  for (const field of fields) {
    const values = field === "highlights"
      ? (Array.isArray(content?.[field]) ? content[field] : [])
      : [content?.[field]];

    for (const value of values) {
      if (!value) continue;
      results.push({ field, ...validateClaimAgainstListing(value, listing) });
    }
  }

  const rejected = results.filter(item => !item.approved);
  return {
    approved: rejected.length === 0,
    checked: results.length,
    rejected: rejected.length,
    results
  };
}

function extractHighlights(bodyText) {
  const source = cleanText(bodyText);
  const rules = [
    ["Plain-pied", /plain[- ]pied/i],
    ["Sous-sol", /sous[- ]sol/i],
    ["Terrain piscinable", /terrain[^.]{0,80}piscinable|piscinable[^.]{0,80}terrain/i],
    ["Secteur calme", /secteur[^.]{0,40}calme|très\s+calme/i],
    ["Garage possible", /possibilité\s+(?:de\s+)?garage|garage\s+(?:possible|possibilité)/i],
    ["Garage", /\bgarage(?:s)?\b/i],
    ["Terrasse plein sud", /terrasse[^.]{0,80}plein\s+sud|plein\s+sud[^.]{0,80}terrasse/i],
    ["Grande terrasse", /grande\s+terrasse/i],
    ["Terrasse", /terrasse/i],
    ["Cuisine équipée", /cuisine\s+(?:séparée\s+)?équipée/i],
    ["Salon lumineux", /séjour[^.]{0,80}(?:lumineux|lumineuse)|salon[^.]{0,80}(?:lumineux|lumineuse)/i],
    ["Studio au sous-sol", /studio[^.]{0,100}sous[- ]sol|sous[- ]sol[^.]{0,100}studio/i],
    ["Grenier aménageable", /grenier[^.]{0,50}aménageable|aménageable[^.]{0,50}grenier/i],
    ["Terrain arboré", /terrain\s+arboré/i],
    ["Vue dégagée", /vue\s+dégagée/i],
    ["Piscinable", /piscinable/i],
    ["Salle de bains", /salle\s+de\s+bains/i],
    ["Cave", /\bcave\b/i],
    ["Parking", /parking/i],
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


app.post("/api/ai-layout", async (req, res) => {
  try {
    const listing = req.body?.listing;
    if (!listing || !Array.isArray(listing.images) || listing.images.length === 0) {
      return res.status(400).json({ ok: false, error: "Annonce ou photos originales manquantes." });
    }

    const facts = {
      type: listing.title || null,
      reference: listing.reference || null,
      price: listing.price || null,
      location: listing.location || null,
      surface: listing.surface || null,
      terrain: listing.terrain || null,
      rooms: listing.rooms || null,
      bedrooms: listing.bedrooms || null,
      description: listing.description || null,
      existingHighlights: listing.highlights || []
    };

    const prompt = [
      "Tu es l'assistant éditorial et visuel de JML Immobilier.",
      "Analyse les faits de l'annonce et, si elles sont fournies, les PHOTOS ORIGINALES.",
      "Ne jamais inventer une caractéristique du bien.",
      "Les photos fournies sont les photos originales vérifiées : elles doivent rester exactement les mêmes dans le visuel final.",
      "Ne génère, ne transforme et ne remplace aucune photo.",
      "Choisis la meilleure photo pour la photo principale et ordonne les autres photos pour la mosaïque.",
      "Choisis exactement 6 points forts courts, factuels et lisibles.",
      "Évite les doublons.",
      "Réponds uniquement en JSON."
    ].join(" ");

    const schema = {
      type: "object",
      properties: {
        title: { type: "string" },
        subtitle: { type: "string" },
        highlights: {
          type: "array",
          minItems: 6,
          maxItems: 6,
          items: { type: "string" }
        },
        photoOrder: {
          type: "array",
          items: { type: "integer", minimum: 0 }
        }
      },
      required: ["title", "subtitle", "highlights", "photoOrder"],
      propertyOrdering: ["title", "subtitle", "highlights", "photoOrder"]
    };

    // Gemini is the preferred provider because its current API has a Free Tier.
    // OpenAI remains available as an optional fallback for continuity.
    const geminiKey = process.env.GEMINI_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (!geminiKey && !openaiKey) {
      return res.status(503).json({
        ok: false,
        error: "Aucune clé IA configurée. Ajoute GEMINI_API_KEY dans Render pour utiliser Gemini gratuitement."
      });
    }

    let plan;
    let provider;
    let model;

    if (geminiKey) {
      provider = "gemini";
      model = process.env.GEMINI_MODEL || "gemini-3.8-flash";

      const parts = [
        {
          text:
            prompt +
            "\n\nDONNÉES DE L'ANNONCE:\n" +
            JSON.stringify(facts) +
            "\n\nLes images suivantes correspondent aux photos originales vérifiées. " +
            "Utilise uniquement leur index 0-based pour photoOrder."
        }
      ];

      // Send the actual verified JML photos to Gemini for visual analysis.
      // The final canvas still uses the original JML URLs without modification.
      const photoUrls = listing.images.slice(0, 8);
      for (let i = 0; i < photoUrls.length; i++) {
        try {
          const imageResponse = await fetch(photoUrls[i], {
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; JML-Annonces/0.1; +https://www.jml-immobilier.fr/)"
            }
          });
          const contentType = imageResponse.headers.get("content-type") || "image/jpeg";
          if (!imageResponse.ok || !contentType.startsWith("image/")) continue;

          const bytes = Buffer.from(await imageResponse.arrayBuffer());
          if (!bytes.length || bytes.length > 6 * 1024 * 1024) continue;

          parts.push({
            text: "PHOTO ORIGINALE — index " + i
          });
          parts.push({
            inline_data: {
              mime_type: contentType.split(";")[0],
              data: bytes.toString("base64")
            }
          });
        } catch {}
      }

      const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" +
          encodeURIComponent(model) +
          ":generateContent",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": geminiKey
          },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts
              }
            ],
            generationConfig: {
              responseFormat: {
                text: {
                  mimeType: "APPLICATION_JSON",
                  schema
                }
              },
              thinkingConfig: {
                thinkingLevel: "low"
              }
            }
          })
        }
      );

      let payload = null;
      let response = null;
      let successfulModel = model;

      // Gemini can temporarily return 429/503 when a model is under heavy load.
      // Retry with a short delay, then fall back to the previous stable Flash model.
      // The fallback still uses Gemini and the same verified original photos.
      const geminiModels = [...new Set([
        model,
        "gemini-3.7-flash",
        "gemini-3.6-flash"
      ])];

      for (const candidateModel of geminiModels) {
        for (let attempt = 0; attempt < 2; attempt++) {
          response = await fetch(
            "https://generativelanguage.googleapis.com/v1beta/models/" +
              encodeURIComponent(candidateModel) +
              ":generateContent",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": geminiKey
              },
              body: JSON.stringify({
                contents: [
                  {
                    role: "user",
                    parts
                  }
                ],
                generationConfig: {
                  responseFormat: {
                    text: {
                      mimeType: "APPLICATION_JSON",
                      schema
                    }
                  },
                  thinkingConfig: {
                    thinkingLevel: "low"
                  }
                }
              })
            }
          );

          payload = await response.json();

          if (response.ok) {
            successfulModel = candidateModel;
            break;
          }

          const retryable = response.status === 429 || response.status === 503;
          if (!retryable || attempt === 1) break;
          await new Promise(resolve => setTimeout(resolve, 900));
        }

        if (response?.ok) break;
      }

      if (!response?.ok) {
        return res.status(502).json({
          ok: false,
          error:
            "Gemini indisponible temporairement (" +
            model +
            "). Les modèles Gemini de secours ont également échoué. " +
            (payload?.error?.message || "Réessayez dans quelques instants.")
        });
      }

      model = successfulModel;

      const raw =
        payload?.candidates?.[0]?.content?.parts
          ?.map((part) => part.text || "")
          .join("") || "";

      if (!raw) throw new Error("Réponse Gemini vide.");
      plan = JSON.parse(raw);
    } else {
      provider = "openai";
      model = process.env.OPENAI_MODEL || "gpt-5.6-luna";

      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + openaiKey
        },
        body: JSON.stringify({
          model,
          input: [
            {
              role: "developer",
              content: "Tu produis des données JSON strictes pour une application immobilière. Aucun fait ne doit être inventé."
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: prompt + "\n\nDONNÉES DE L'ANNONCE:\n" + JSON.stringify(facts)
                }
              ]
            }
          ],
          text: {
            format: {
              type: "json_schema",
              name: "jml_visual_plan",
              strict: true,
              schema
            }
          },
          max_output_tokens: 700
        })
      });

      const payload = await response.json();
      if (!response.ok) {
        return res.status(502).json({
          ok: false,
          error: payload?.error?.message || "Erreur lors de l'appel à OpenAI."
        });
      }

      const raw = payload.output_text || "";
      plan = JSON.parse(raw);
    }

    const indices = Array.isArray(plan.photoOrder) ? plan.photoOrder : [];
    const safeIndices = [
      ...new Set(
        indices.filter(
          (n) => Number.isInteger(n) && n >= 0 && n < listing.images.length
        )
      )
    ];

    plan.photoOrder = (safeIndices.length ? safeIndices : listing.images.map((_, i) => i))
      .concat(
        listing.images.map((_, i) => i).filter((i) => !safeIndices.includes(i))
      );

    plan.title = cleanText(plan.title || listing.title || "Bien immobilier");
    plan.subtitle = cleanText(plan.subtitle || "");

    const aiHighlights = (Array.isArray(plan.highlights) ? plan.highlights : [])
      .map((x) => cleanText(x))
      .filter(Boolean)
      .slice(0, 6);

    // DATA CONTROLLER:
    // Never publish a generated claim unless it can be grounded in the scraped listing.
    const checkedHighlights = aiHighlights.map(claim => ({
      claim,
      check: validateClaimAgainstListing(claim, listing)
    }));

    const approvedHighlights = checkedHighlights
      .filter(item => item.check.approved)
      .map(item => item.claim);

    // Rejected AI claims are replaced only by factual highlights extracted from the listing.
    for (const fallback of listing.highlights || []) {
      if (approvedHighlights.length >= 6) break;
      const check = validateClaimAgainstListing(fallback, listing);
      if (check.approved && !approvedHighlights.includes(fallback)) {
        approvedHighlights.push(fallback);
      }
    }

    while (approvedHighlights.length < 6) approvedHighlights.push("Voir l'annonce");

    plan.highlights = approvedHighlights.slice(0, 6);

    // Title/subtitle are also checked. If Gemini invents wording, use deterministic source data.
    const titleCheck = validateClaimAgainstListing(plan.title, listing);
    if (!titleCheck.approved) plan.title = cleanText(listing.title || "Bien immobilier");

    const subtitleFallback = [
      listing.rooms != null ? String(listing.rooms) + " pièces" : "",
      listing.bedrooms != null ? String(listing.bedrooms) + " chambres" : "",
      listing.surface || ""
    ].filter(Boolean).join(" · ");
    const subtitleCheck = validateClaimAgainstListing(plan.subtitle, listing);
    if (!subtitleCheck.approved) plan.subtitle = subtitleFallback;

    const dataController = {
      status: "controlled",
      checkedClaims: checkedHighlights.length + 2,
      rejectedClaims: checkedHighlights.filter(item => !item.check.approved).length +
        (titleCheck.approved ? 0 : 1) +
        (subtitleCheck.approved ? 0 : 1),
      approvedHighlights: plan.highlights.filter(x => x !== "Voir l'annonce").length,
      rule: "Aucune caractéristique non présente dans l'annonce source n'est autorisée."
    };

    res.json({
      ok: true,
      provider,
      model,
      plan,
      originalPhotosOnly: true,
      dataController
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "Erreur IA." });
  }
});

app.post("/api/social-copy", async (req, res) => {
  try {
    const listing = req.body?.listing;
    if (!listing) return res.status(400).json({ ok:false, error:"Annonce manquante." });

    const facts = {
      type: listing.title || null,
      reference: listing.reference || null,
      price: listing.price || null,
      location: listing.location || null,
      surface: listing.surface || null,
      terrain: listing.terrain || null,
      rooms: listing.rooms || null,
      bedrooms: listing.bedrooms || null,
      description: listing.description || null,
      highlights: listing.aiPlan?.highlights || listing.highlights || []
    };

    const prompt = [
      "Tu es le rédacteur social media de JML Immobilier.",
      "Produis trois textes de publication en français pour la même annonce.",
      "FACEBOOK : texte chaleureux et concret, avec appel à la visite.",
      "INSTAGRAM : texte court et visuel, avec hashtags locaux pertinents.",
      "LINKEDIN : texte professionnel, factuel et sobre.",
      "N'invente AUCUNE caractéristique, aucun équipement, aucun chiffre, aucun avantage.",
      "Utilise uniquement les données fournies.",
      "Ne mentionne jamais une information absente.",
      "Ne promets jamais une performance, une vente rapide ou une qualité non documentée.",
      "Indique le prix, la référence et le contact uniquement lorsqu'ils sont fournis.",
      "Réponds uniquement en JSON."
    ].join(" ");

    const schema = {
      type:"object",
      properties:{
        facebook:{type:"string"},
        instagram:{type:"string"},
        linkedin:{type:"string"}
      },
      required:["facebook","instagram","linkedin"],
      propertyOrdering:["facebook","instagram","linkedin"]
    };

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) return res.status(503).json({ok:false,error:"GEMINI_API_KEY manquante."});

    const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent",
      {
        method:"POST",
        headers:{"Content-Type":"application/json","x-goog-api-key":geminiKey},
        body:JSON.stringify({
          contents:[{role:"user",parts:[{text:prompt+"\n\nDONNÉES SOURCE :\n"+JSON.stringify(facts)}]}],
          generationConfig:{
            responseFormat:{text:{mimeType:"APPLICATION_JSON",schema}},
            thinkingConfig:{thinkingLevel:"low"}
          }
        })
      }
    );

    let payload = await response.json();
    let successfulModel = model;

    // Same resilience policy as the visual planner: temporary Gemini load
    // errors are retried and then handled by a stable Flash fallback.
    if (!response.ok && (response.status === 429 || response.status === 503)) {
      for (const candidateModel of [...new Set([model, "gemini-3.7-flash", "gemini-3.6-flash"])]) {
        if (candidateModel === model) {
          // The first request has already been made; retry it once.
        } else {
          await new Promise(resolve => setTimeout(resolve, 300));
        }

        response = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(candidateModel) + ":generateContent",
          {
            method:"POST",
            headers:{"Content-Type":"application/json","x-goog-api-key":geminiKey},
            body:JSON.stringify({
              contents:[{role:"user",parts:[{text:prompt+"\n\nDONNÉES SOURCE :\n"+JSON.stringify(facts)}]}],
              generationConfig:{
                responseFormat:{text:{mimeType:"APPLICATION_JSON",schema}},
                thinkingConfig:{thinkingLevel:"low"}
              }
            })
          }
        );
        payload = await response.json();
        if (response.ok) {
          successfulModel = candidateModel;
          break;
        }
      }
    }

    if (!response.ok) return res.status(502).json({
      ok:false,
      error:"Gemini ("+model+") temporairement indisponible. "+(payload?.error?.message || "Réessayez dans quelques instants.")
    });

    const raw = payload?.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("") || "";
    if (!raw) throw new Error("Réponse Gemini vide.");
    const copies = JSON.parse(raw);

    const checks = {};
    for (const platform of ["facebook","instagram","linkedin"]) {
      checks[platform] = validateClaimAgainstListing(copies[platform], listing);
    }

    const rejected = Object.entries(checks).filter(([,v])=>!v.approved);
    if (rejected.length) {
      return res.status(422).json({
        ok:false,
        error:"Contrôle des textes échoué : une ou plusieurs publications contiennent des informations non justifiées.",
        checks
      });
    }

    res.json({
      ok:true,
      model,
      copies,
      controller:{
        status:"controlled",
        platforms:3,
        rejected:0,
        rule:"Les trois textes sont contrôlés contre les données de l'annonce source."
      }
    });
  } catch(error) {
    res.status(500).json({ok:false,error:error.message || "Erreur de génération des textes."});
  }
});

app.post("/api/validate-content", (req, res) => {
  try {
    const listing = req.body?.listing;
    const content = req.body?.content;
    if (!listing || !content) {
      return res.status(400).json({ ok: false, error: "Annonce et contenu à contrôler obligatoires." });
    }
    const dataController = validateGeneratedContent(listing, content);
    res.json({ ok: true, dataController });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "Erreur du contrôleur de données." });
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
  const geminiConfigured = Boolean(process.env.GEMINI_API_KEY);
  const openaiConfigured = Boolean(process.env.OPENAI_API_KEY);
  const configuredModel = process.env.GEMINI_MODEL || "gemini-3.8-flash";

  res.json({
    ok: true,
    app: "jml-annonces",
    version: "0.7.0",
    ai: {
      preferredProvider: geminiConfigured ? "gemini" : openaiConfigured ? "openai" : "none",
      geminiConfigured,
      geminiModel: configuredModel,
      openaiConfigured
    },
    photoPolicy: {
      originalOnly: true,
      generatedReplacementAllowed: false
    }
  });
});

app.listen(PORT, () => {
  console.log(`JML Annonces listening on port ${PORT}`);
});

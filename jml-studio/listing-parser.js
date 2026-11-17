"use strict";
const cheerio=require("cheerio");
const JML_HOST="www.jml-immobilier.fr";
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
  // Editorial vocabulary is allowed in social copy; property facts remain
  // controlled separately. This prevents legitimate CTAs from being rejected.
  const stop = new Set([
    "le","la","les","un","une","des","de","du","d","et","avec","sans","a","au","aux",
    "en","sur","sous","dans","pour","par","plus","tres","très","situe","situé",
    "situee","située","comprenant","comprend","possibilite","possibilité","voir","annonce",
    "decouvrez","découvrez","decouvrir","découvrir","nouveau","nouvelle","nouveauté",
    "opportunite","opportunité","profitez","contactez","contact","visite","visiter",
    "visitez","rendez","vous","aujourd","aujourd'hui","infos","informations",
    "renseignements","disponible","disponibles","propose","proposé","proposée",
    "retrouvez","trouver","trouvez","interesse","intéresse","interessez","intéressez",
    "envie","besoin","projet","immobilier","immobilière","bien","propriete","propriété",
    "maison","appartement","secteur","quartier","ideal","idéale","ideale","idéalement",
    "exclusif","exclusive","magnifique","superbe","joli","jolie","local","locaux",
    "venez","echange","échange","demande","message","messages","appelez","appeler",
    "écrivez","ecrivez","repondre","répondre","facebook","instagram","linkedin","hashtags","vendre","prix","surface","terrain","chambres","pièces","points","clés","référence","presentation","présentation","factuelle"
  ]);
  return [...new Set(
    normalizeFactText(value)
      .split(/\s+/)
      .map(x => x.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
      .filter(x => x.length >= 3 && !stop.has(x))
  )];
}

function groundedFactToken(token, corpus) {
  if (!token) return true;
  if (corpus.includes(token)) return true;
  const corpusTokens = corpus.split(/\s+/).filter(Boolean);
  return corpusTokens.some(sourceToken => {
    if (sourceToken.length < 5 || token.length < 5) return false;
    return sourceToken.startsWith(token.slice(0, 5)) ||
      token.startsWith(sourceToken.slice(0, 5));
  });
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
    return !groundedFactToken(token, corpus);
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

function buildLocalSocialCopies(listing) {
  const facts = {
    type: cleanText(listing.title || ""),
    reference: cleanText(listing.reference || ""),
    price: cleanText(listing.price || ""),
    location: cleanText(listing.location || ""),
    surface: cleanText(listing.surface || ""),
    terrain: cleanText(listing.terrain || ""),
    rooms: listing.rooms != null ? String(listing.rooms) : "",
    bedrooms: listing.bedrooms != null ? String(listing.bedrooms) : "",
    highlights: Array.isArray(listing.aiPlan?.highlights)
      ? listing.aiPlan.highlights.filter(Boolean).slice(0, 8)
      : (Array.isArray(listing.highlights) ? listing.highlights.filter(Boolean).slice(0, 8) : [])
  };

  const location = facts.location ? " à " + facts.location : "";
  const reference = facts.reference ? "Réf. " + facts.reference : "";
  const priceLine = facts.price ? "💰 " + facts.price : "";

  // Keep the social copy compact: facts already shown in the specification line
  // should not be repeated in the highlights.
  const duplicatePatterns = [
    facts.surface && new RegExp(facts.surface.replace(/[.*+?^$()|[\]\\]/g, "\\$&"), "i"),
    facts.terrain && new RegExp(facts.terrain.replace(/[.*+?^$()|[\]\\]/g, "\\$&"), "i"),
    facts.bedrooms && new RegExp("\\b" + facts.bedrooms + "\\s+chambre", "i"),
    facts.rooms && new RegExp("\\b" + facts.rooms + "\\s+pièce", "i")
  ].filter(Boolean);

  const highlights = facts.highlights
    .filter(item => !duplicatePatterns.some(pattern => pattern.test(item)))
    .slice(0, 6);

  const specs = [
    facts.surface ? "📐 " + facts.surface : "",
    facts.terrain ? "🌳 Terrain " + facts.terrain : "",
    facts.bedrooms ? "🛏️ " + facts.bedrooms + " chambres" : "",
    facts.rooms ? "🚪 " + facts.rooms + " pièces" : ""
  ].filter(Boolean);

  const facebook = [
    "🏡 " + (facts.type || "Bien immobilier") + location,
    "",
    priceLine + (reference ? " · " + reference : ""),
    specs.length ? specs.join(" · ") : "",
    "",
    highlights.length ? "✨ Les atouts du bien :" : "",
    ...highlights.map(item => "• " + item),
    "",
    "📩 Vous souhaitez découvrir ce bien ? Contactez-moi pour organiser une visite."
  ].filter(Boolean).join("\n");

  const instagram = [
    "🏡 " + (facts.type || "Bien immobilier") + location,
    priceLine + (reference ? " · " + reference : ""),
    specs.length ? specs.join(" · ") : "",
    "",
    highlights.length ? "✨ " + highlights.join(" • ") : "",
    "",
    "📩 Infos & visites sur demande.",
    "",
    "#JMLImmobilier #ImmobilierArdennes #CharlevilleMezieres #Ardennes #AchatImmobilier"
  ].filter(Boolean).join("\n");

  const linkedin = [
    "🏠 " + (facts.type || "Bien immobilier") + location,
    "",
    priceLine + (reference ? " · " + reference : ""),
    specs.length ? specs.join(" · ") : "",
    "",
    highlights.length ? "Points clés :\n" + highlights.map(item => "• " + item).join("\n") : "",
    "",
    "Les informations présentées correspondent aux données vérifiées de l'annonce source."
  ].filter(Boolean).join("\n");

  return { facebook, instagram, linkedin };
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
module.exports={normalizeUrl,parseListing};

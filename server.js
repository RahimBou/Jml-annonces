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

  $("img").each((_, el) => {
    const src = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-lazy-src");
    const full = absoluteUrl(src);
    if (full) candidates.push(full);
  });

  $("a").each((_, el) => {
    const href = $(el).attr("href");
    const full = absoluteUrl(href);
    if (full && /\\.(jpe?g|png|webp)(?:[?#].*)?$/i.test(full)) candidates.push(full);
  });

  return [...new Set(candidates)].filter((url) => {
    const lower = url.toLowerCase();
    return !lower.includes("logo") && !lower.includes("icon") && !lower.includes("favicon");
  });
}

function parsePrice(text) {
  if (!text) return null;
  const match = text.replace(/\\s/g, "").match(/([0-9][0-9 .]*)€/);
  return match ? match[1].replace(/\\./g, " ") + " €" : text;
}

function parseListing(html, sourceUrl) {
  const $ = cheerio.load(html);
  const title = firstText($, ["h1", "title"]);
  const bodyText = cleanText($("body").text());

  const images = collectImages($);

  const property = {
    title,
    price: parsePrice(bodyText.match(/[0-9][0-9 .]*€/)?.[0] || null),
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

"use strict";

const express = require("express");
const path = require("path");
const { normalizeUrl, parseListing } = require("./listing-parser");

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = "Mozilla/5.0 (compatible; JML-Studio/1.1; +https://www.jml-immobilier.fr/)";

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname, { extensions: ["html"] }));

function allowedListingUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "www.jml-immobilier.fr" || url.port) {
    throw new Error("Seules les annonces HTTPS de www.jml-immobilier.fr sont acceptées.");
  }
  return url.toString();
}

function allowedPhotoUrl(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const allowedHost = host === "jml-immobilier.fr" ||
    host === "www.jml-immobilier.fr" ||
    host.endsWith(".jml-immobilier.fr");

  if (url.protocol !== "https:" || !allowedHost || url.port || url.username || url.password) {
    throw new Error("La photo provient d'une adresse non autorisée.");
  }
  return url.toString();
}

async function readLimitedBody(response, maxBytes, label) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(label + " dépasse la taille maximale autorisée.");
  }

  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(label + " dépasse la taille maximale autorisée.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, total);
}

async function fetchAllowedResource(rawUrl, validateUrl, maxBytes, label, timeoutMs) {
  let currentUrl = validateUrl(rawUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetch(currentUrl, {
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs)
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Redirection invalide lors du téléchargement de " + label + ".");
      if (redirectCount === MAX_REDIRECTS) throw new Error("Trop de redirections lors du téléchargement de " + label + ".");
      currentUrl = validateUrl(new URL(location, currentUrl).toString());
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Le serveur source a répondu avec le statut HTTP " + response.status + " pour " + label + ".");
    }

    const bytes = await readLimitedBody(response, maxBytes, label);
    return { response, bytes, url: currentUrl };
  }

  throw new Error("Téléchargement impossible pour " + label + ".");
}

app.post("/api/import-annonce", async (req, res) => {
  try {
    const sourceUrl = normalizeUrl(String(req.body?.url || "").trim());
    const page = await fetchAllowedResource(
      sourceUrl,
      allowedListingUrl,
      MAX_HTML_BYTES,
      "la page de l'annonce",
      30000
    );

    const html = page.bytes.toString("utf8");
    const listing = parseListing(html, page.url);
    const originalPhotoCount = listing.images.length;
    const validated = [];

    for (const rawImageUrl of listing.images.slice(0, 8)) {
      try {
        const imageUrl = allowedPhotoUrl(rawImageUrl);
        const image = await fetchAllowedResource(
          imageUrl,
          allowedPhotoUrl,
          MAX_PHOTO_BYTES,
          "une photo de l'annonce",
          20000
        );
        const mime = (image.response.headers.get("content-type") || "")
          .split(";")[0]
          .trim()
          .toLowerCase();

        if (!mime.startsWith("image/")) {
          throw new Error("Le fichier téléchargé n'est pas une image.");
        }
        if (!image.bytes.length) {
          throw new Error("La photo téléchargée est vide.");
        }

        validated.push({
          url: image.url,
          mime,
          data: "data:" + mime + ";base64," + image.bytes.toString("base64")
        });
      } catch (error) {
        console.warn("Photo annonce non importée:", error.message);
      }
    }

    listing.images = validated.map(photo => photo.url);
    listing.imageCount = validated.length;

    const complete = validated.length > 0 &&
      !listing.photoExtraction.suspicious &&
      (listing.expectedPhotoCount == null || validated.length === listing.expectedPhotoCount);

    listing.photoStatus = validated.length === 0
      ? "unreliable"
      : complete
        ? "complete"
        : "partial";

    res.json({
      ok: true,
      listing: {
        title: listing.title,
        reference: listing.reference,
        price: listing.price,
        location: listing.location,
        surface: listing.surface,
        terrain: listing.terrain,
        rooms: listing.rooms,
        bedrooms: listing.bedrooms,
        description: listing.description,
        highlights: listing.highlights,
        sourceUrl: page.url,
        photoStatus: listing.photoStatus,
        expectedPhotoCount: listing.expectedPhotoCount,
        photoExtraction: listing.photoExtraction
      },
      photos: validated,
      photoCount: validated.length,
      sourcePhotoCount: originalPhotoCount
    });
  } catch (error) {
    const message = error.message || "Import impossible.";
    console.error("Échec import annonce JML Studio:", message);
    res.status(400).json({ ok: false, error: message });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "jml-studio-independent",
    status: "healthy"
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("JML Studio indépendant démarré sur " + PORT);
});

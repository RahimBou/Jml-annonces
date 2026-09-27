const express = require("express");
const path = require("path");
const crypto = require("crypto");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;
const JML_HOST = "www.jml-immobilier.fr";

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Meta requires stable, extensionless public URLs for the privacy and data-deletion pages.
app.get("/privacy", (req, res) => res.sendFile(path.join(__dirname, "public", "privacy.html")));
app.get("/data-deletion", (req, res) => res.sendFile(path.join(__dirname, "public", "data-deletion.html")));


/* -------------------------------------------------------------------------- */
/* Social accounts — OAuth connection only                                   */
/* Publication remains a deliberate human action in the UI.                  */
/* Tokens are encrypted in an HttpOnly cookie so no password is ever stored. */
/* -------------------------------------------------------------------------- */

const SOCIAL_COOKIE = "jml_social";
const SOCIAL_STATE_COOKIE = "jml_social_state";
const SOCIAL_SECRET = process.env.SOCIAL_COOKIE_SECRET || process.env.JWT_SECRET || "";

const META_DEFAULT_APP_ID = "1747047203221133";
const META_DEFAULT_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
  "business_management"
].join(",");

function metaAppId() {
  // The previous JML Meta app is retired. Keep the new app as the safe default
  // while still allowing Render to override it explicitly later.
  const configured = String(process.env.META_APP_ID || "").trim();
  if (!configured || configured === "1620813812977055") return META_DEFAULT_APP_ID;
  return configured;
}

function appBaseUrl(req) {
  // Render terminates TLS at the proxy, so req.protocol can be "http"
  // even though the public application URL is HTTPS. Never send Meta an
  // insecure redirect_uri.
  if (process.env.APP_BASE_URL) {
    return process.env.APP_BASE_URL.replace(/\/$/, "");
  }
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto === "https" || req.secure ? "https" : "http";
  return `${protocol}://${req.get("host")}`.replace(/\/$/, "");
}

function cookieMap(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(header.split(";").map(part => {
    const i = part.indexOf("=");
    return i > -1 ? [part.slice(0,i).trim(), decodeURIComponent(part.slice(i+1))] : null;
  }).filter(Boolean));
}

function cookieFlags(maxAge) {
  return [
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    process.env.NODE_ENV === "production" ? "Secure" : "",
    maxAge != null ? "Max-Age=" + maxAge : ""
  ].filter(Boolean).join("; ");
}

function setCookie(res, name, value, maxAge) {
  res.setHeader("Set-Cookie", `${name}=${encodeURIComponent(value)}; ${cookieFlags(maxAge)}`);
}

function encryptSocialPayload(payload) {
  const key = crypto.createHash("sha256").update(SOCIAL_SECRET).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

function decryptSocialPayload(value) {
  try {
    const raw = Buffer.from(String(value || ""), "base64url");
    if (raw.length < 29) return null;
    const key = crypto.createHash("sha256").update(SOCIAL_SECRET).digest();
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"));
  } catch {
    return null;
  }
}

function readSocialAccounts(req) {
  const cookies = cookieMap(req);
  return decryptSocialPayload(cookies[SOCIAL_COOKIE]) || {};
}

function configuredSocialProviders() {
  return {
    facebook: Boolean(metaAppId() && process.env.META_APP_SECRET),
    instagram: Boolean(metaAppId() && process.env.META_APP_SECRET),
    linkedin: Boolean(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET)
  };
}

function socialRedirectUri(req, provider) {
  if (provider === "linkedin") {
    return process.env.LINKEDIN_REDIRECT_URI || `${appBaseUrl(req)}/api/social/callback/linkedin`;
  }
  if (provider === "facebook") {
    return process.env.META_FACEBOOK_REDIRECT_URI || `${appBaseUrl(req)}/api/social/callback/facebook`;
  }
  return process.env.META_INSTAGRAM_REDIRECT_URI || `${appBaseUrl(req)}/api/social/callback/instagram`;
}

app.get("/api/social/accounts", (req, res) => {
  const stored = readSocialAccounts(req);
  const configured = configuredSocialProviders();
  res.json({
    ok: true,
    configured: Object.values(configured).some(Boolean),
    accounts: {
      facebook: { connected: Boolean(stored.facebook?.accessToken), name: stored.facebook?.name || null },
      instagram: { connected: Boolean(stored.instagram?.accessToken), name: stored.instagram?.name || null },
      linkedin: { connected: Boolean(stored.linkedin?.accessToken), name: stored.linkedin?.name || null }
    },
    note: "Les comptes sont uniquement connectés. La publication nécessite une action explicite."
  });
});

app.get("/api/social/connect/:provider", (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();
  if (!SOCIAL_SECRET) return res.status(503).send("Connexion sociale non sécurisée : configurez SOCIAL_COOKIE_SECRET dans Render.");
  const config = configuredSocialProviders();
  if (!["facebook","instagram","linkedin"].includes(provider)) {
    return res.status(400).send("Réseau social non pris en charge.");
  }
  if (!config[provider]) {
    return res.status(503).send(
      "Connexion " + provider + " non configurée. Ajoutez les identifiants OAuth correspondants dans Render."
    );
  }

  const state = crypto.randomBytes(24).toString("hex");
  setCookie(res, SOCIAL_STATE_COOKIE, encryptSocialPayload({
    state,
    provider,
    createdAt: Date.now()
  }), 600);

  if (provider === "linkedin") {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: process.env.LINKEDIN_CLIENT_ID,
      redirect_uri: socialRedirectUri(req, "linkedin"),
      state,
      scope: process.env.LINKEDIN_SCOPES || "openid profile w_member_social"
    });
    return res.redirect("https://www.linkedin.com/oauth/v2/authorization?" + params.toString());
  }

  const params = new URLSearchParams({
    client_id: metaAppId(),
    redirect_uri: socialRedirectUri(req, provider),
    state,
    response_type: "code",
    scope: process.env.META_SCOPES || META_DEFAULT_SCOPES
  });
  return res.redirect("https://www.facebook.com/dialog/oauth?" + params.toString());
});

app.get("/api/social/callback/:provider", async (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();
  if (!SOCIAL_SECRET) return res.status(503).send("Connexion sociale non sécurisée : configurez SOCIAL_COOKIE_SECRET dans Render.");
  const cookies = cookieMap(req);
  const stateData = decryptSocialPayload(cookies[SOCIAL_STATE_COOKIE]);
  setCookie(res, SOCIAL_STATE_COOKIE, "", 0);

  if (!stateData || stateData.provider !== provider || stateData.state !== String(req.query.state || "")) {
    return res.status(400).send("Connexion sociale refusée : état OAuth invalide.");
  }
  if (req.query.error) {
    return res.status(400).send("Connexion annulée : " + String(req.query.error_description || req.query.error));
  }

  try {
    const code = String(req.query.code || "");
    if (!code) throw new Error("Code OAuth manquant.");

    const stored = readSocialAccounts(req);

    if (provider === "linkedin") {
      const tokenResponse = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: process.env.LINKEDIN_CLIENT_ID,
          client_secret: process.env.LINKEDIN_CLIENT_SECRET,
          redirect_uri: socialRedirectUri(req, "linkedin")
        })
      });
      const token = await tokenResponse.json();
      if (!tokenResponse.ok || !token.access_token) {
        throw new Error(token?.error_description || "LinkedIn n'a pas fourni de jeton d'accès.");
      }

      let name = "Compte LinkedIn";
      const profileResponse = await fetch("https://api.linkedin.com/v2/userinfo", {
        headers: { Authorization: "Bearer " + token.access_token }
      });
      if (profileResponse.ok) {
        const profile = await profileResponse.json();
        name = profile.name || profile.given_name || name;
      }

      stored.linkedin = {
        accessToken: token.access_token,
        refreshToken: token.refresh_token || null,
        expiresAt: Date.now() + Number(token.expires_in || 0) * 1000,
        name
      };
    } else {
      const tokenUrl = "https://graph.facebook.com/" +
        (process.env.META_GRAPH_VERSION || "v23.0") + "/oauth/access_token";
      const tokenResponse = await fetch(tokenUrl + "?" + new URLSearchParams({
        client_id: metaAppId(),
        client_secret: process.env.META_APP_SECRET,
        redirect_uri: socialRedirectUri(req, provider),
        code
      }).toString());
      const token = await tokenResponse.json();
      if (!tokenResponse.ok || !token.access_token) {
        throw new Error(token?.error?.message || "Meta n'a pas fourni de jeton d'accès.");
      }

      // Retrieve the Pages the user can manage. If an Instagram professional
      // account is linked to a Page, its instagram_business_account is exposed here.
      const pagesResponse = await fetch(
        "https://graph.facebook.com/" + (process.env.META_GRAPH_VERSION || "v23.0") +
        "/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=" +
        encodeURIComponent(token.access_token)
      );
      const pagesPayload = await pagesResponse.json();
      if (!pagesResponse.ok) {
        throw new Error(pagesPayload?.error?.message || "Impossible de récupérer les Pages Meta.");
      }

      const pages = Array.isArray(pagesPayload.data) ? pagesPayload.data : [];
      const preferredPageId = String(process.env.META_PAGE_ID || "156425008274121").trim();
      const page =
        pages.find(item => String(item.id) === preferredPageId) ||
        pages[0] ||
        null;
      if (page) {
        stored.facebook = {
          accessToken: page.access_token || token.access_token,
          userAccessToken: token.access_token,
          pageId: page.id,
          name: page.name || "Page Facebook"
        };

        const igId = page.instagram_business_account?.id;
        if (igId) {
          stored.instagram = {
            accessToken: page.access_token || token.access_token,
            instagramBusinessAccountId: igId,
            pageId: page.id,
            name: "Instagram professionnel"
          };
        }
      } else {
        stored.facebook = {
          accessToken: token.access_token,
          userAccessToken: token.access_token,
          name: "Compte Facebook"
        };
      }
    }

    setCookie(res, SOCIAL_COOKIE, encryptSocialPayload(stored), 60 * 60 * 24 * 60);
    return res.redirect("/?social=connected");
  } catch (error) {
    return res.status(502).send("Connexion " + provider + " impossible : " + error.message);
  }
});

app.post("/api/social/disconnect/:provider", (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();
  const stored = readSocialAccounts(req);
  delete stored[provider];
  setCookie(res, SOCIAL_COOKIE, encryptSocialPayload(stored), 60 * 60 * 24 * 60);
  res.json({ ok: true });
});

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
    type: listing.title || "",
    reference: listing.reference || "",
    price: listing.price || "",
    location: listing.location || "",
    surface: listing.surface || "",
    terrain: listing.terrain || "",
    rooms: listing.rooms != null ? String(listing.rooms) : "",
    bedrooms: listing.bedrooms != null ? String(listing.bedrooms) : "",
    highlights: Array.isArray(listing.aiPlan?.highlights)
      ? listing.aiPlan.highlights
      : (Array.isArray(listing.highlights) ? listing.highlights : [])
  };

  const headline = [
    facts.type,
    facts.location ? "à " + facts.location : ""
  ].filter(Boolean).join(" ");

  const details = [
    facts.price ? "Prix : " + facts.price : "",
    facts.surface ? "Surface : " + facts.surface : "",
    facts.terrain ? "Terrain : " + facts.terrain : "",
    facts.bedrooms ? facts.bedrooms + " chambres" : "",
    facts.rooms ? facts.rooms + " pièces" : ""
  ].filter(Boolean);

  const keyFacts = facts.highlights.filter(Boolean).slice(0, 6);
  const detailSentence = details.length ? details.join(" · ") + "." : "";
  const highlightsSentence = keyFacts.length
    ? "Points clés : " + keyFacts.join(" · ") + "."
    : "";
  const refSentence = facts.reference ? "Réf. " + facts.reference + "." : "";

  return {
    facebook: [
      "🏠 " + (headline || "Nouveau bien à découvrir.") + ".",
      detailSentence, highlightsSentence, refSentence,
      "Pour organiser une visite, contactez-moi."
    ].filter(Boolean).join("\n\n"),
    instagram: [
      "🏠 " + (headline || "Nouveau bien à découvrir.") + ".",
      detailSentence, highlightsSentence, refSentence,
      "#immobilier #Ardennes #CharlevilleMezieres #JMLImmobilier"
    ].filter(Boolean).join("\n\n"),
    linkedin: [
      "Nouvelle annonce JML Immobilier : " + (headline || "bien immobilier") + ".",
      detailSentence, highlightsSentence, refSentence,
      "Informations présentées à partir des données de l'annonce source."
    ].filter(Boolean).join("\n\n")
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

    if (!response || !response.ok) {
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

      let payload = null;
      let response = null;
      let successfulModel = model;

      // Gemini can temporarily return 429/503 when a model is under heavy load.
      // Retry with a short delay, then fall back to the previous stable Flash model.
      // The fallback still uses Gemini and the same verified original photos.
      // High-demand periods can affect one model while another remains available.
      // Keep several official Flash fallbacks and use exponential backoff for 429/503.
      const geminiModels = [...new Set([
        model,
        "gemini-3.7-flash",
        "gemini-3.6-flash",
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite",
        "gemini-3-flash-preview"
      ])];

      for (const candidateModel of geminiModels) {
        for (let attempt = 0; attempt < 3; attempt++) {
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
          if (!retryable || attempt === 2) break;
          await new Promise(resolve => setTimeout(resolve, 1200 * Math.pow(2, attempt)));
        }

        if (response?.ok) break;
      }

      if (!response?.ok && process.env.OPENROUTER_API_KEY) {
        // Gemini exhausted: use OpenRouter free router for the visual plan.
        // The original verified photos are passed as image inputs; OpenRouter
        // only chooses/order them and writes factual copy. It never creates photos.
        const openRouterContent = [
          {
            type: "text",
            text:
              prompt +
              "\n\nDONNÉES DE L'ANNONCE:\n" +
              JSON.stringify(facts) +
              "\n\nLes images jointes sont les photos originales vérifiées. " +
              "Utilise uniquement leur index 0-based pour photoOrder."
          }
        ];

        for (const part of parts) {
          if (part.text) {
            openRouterContent.push({ type: "text", text: part.text });
          } else if (part.inline_data?.data) {
            openRouterContent.push({
              type: "image_url",
              image_url: {
                url:
                  "data:" +
                  (part.inline_data.mime_type || "image/jpeg") +
                  ";base64," +
                  part.inline_data.data
              }
            });
          }
        }

        try {
          const openRouterResponse = await fetch(
            "https://openrouter.ai/api/v1/chat/completions",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + process.env.OPENROUTER_API_KEY,
                "HTTP-Referer": appBaseUrl(req),
                "X-Title": "JML Annonces"
              },
              body: JSON.stringify({
                model: "openrouter/free",
                messages: [
                  {
                    role: "system",
                    content:
                      "Tu produis des données JSON strictes pour une application immobilière. " +
                      "Aucun fait ne doit être inventé. Les photos doivent uniquement être " +
                      "sélectionnées et ordonnées, jamais générées."
                  },
                  { role: "user", content: openRouterContent }
                ],
                response_format: {
                  type: "json_schema",
                  json_schema: {
                    name: "jml_visual_plan",
                    strict: true,
                    schema
                  }
                },
                temperature: 0.2,
                max_tokens: 900
              })
            }
          );

          const openRouterPayload = await openRouterResponse.json();
          const openRouterRaw =
            openRouterPayload?.choices?.[0]?.message?.content || "";

          if (openRouterResponse.ok && openRouterRaw) {
            try {
              plan = JSON.parse(openRouterRaw);
              provider = "openrouter";
              model = "openrouter/free";
            } catch {}
          }
        } catch {}
      }

      if (!plan) {
        // Last-resort deterministic plan: the visual must never be blocked by
        // an AI outage. Preserve only verified listing facts and original photos.
        const factualHighlights = Array.isArray(listing.highlights)
          ? listing.highlights.filter(Boolean).slice(0, 6)
          : [];
        plan = {
          title: listing.title || "Bien immobilier",
          subtitle: listing.location || "",
          highlights: factualHighlights,
          photoOrder: listing.images.map((_, i) => i)
        };
        provider = "deterministic";
        model = "local-fallback";
      }

      if (!plan) {
        return res.status(502).json({
          ok: false,
          error:
            "Aucun moteur IA disponible pour préparer le visuel. " +
            (payload?.error?.message || "Réessayez dans quelques instants.")
        });
      }

      if (provider === "gemini") {
        model = successfulModel;
      }

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

    // Never fill the highlights with generic calls to action.
    // If the listing contains fewer than six factual highlights, keep only
    // the verified facts rather than inventing a seventh item.
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

    // Local mode is the reliable default: no API quota or external AI dependency.
    // Set SOCIAL_TEXT_MODE=ai in Render only if AI-written copy is desired.
    if ((process.env.SOCIAL_TEXT_MODE || "local").toLowerCase() !== "ai") {
      const localCopies = buildLocalSocialCopies(listing);
      return res.json({
        ok: true,
        model: "local-template",
        provider: "deterministic",
        copies: localCopies,
        controller: {
          status: "controlled",
          platforms: 3,
          rejected: 0,
          rule: "Textes construits exclusivement à partir des données vérifiées de l'annonce source."
        }
      });
    }

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
    const openRouterKey = process.env.OPENROUTER_API_KEY;

    let model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
    let response = null;
    let payload = {};
    let successfulModel = model;

    if (geminiKey) {
          let response = await fetch(
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
      
      
    }
    if (response) payload = await response.json();

    // Same resilience policy as the visual planner: temporary Gemini load
    // errors are retried and then handled by a stable Flash fallback.
    if (response && !response.ok && (response.status === 429 || response.status === 503)) {
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

    // If Gemini is saturated, use OpenRouter's free-model router for SOCIAL COPY only.
    // OpenRouter is OpenAI-compatible and its free router selects an available free model.
    if ((!response || !response.ok) && process.env.OPENROUTER_API_KEY) {
      const openRouterResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "Authorization":"Bearer " + process.env.OPENROUTER_API_KEY,
          "HTTP-Referer": appBaseUrl(req),
          "X-Title":"JML Annonces"
        },
        body:JSON.stringify({
          model:"openrouter/free",
          messages:[
            {
              role:"system",
              content:prompt + "\n\nRetourne uniquement un objet JSON valide avec les clés facebook, instagram et linkedin."
            },
            {
              role:"user",
              content:"DONNÉES SOURCE :\n" + JSON.stringify(facts)
            }
          ],
          response_format:{
            type:"json_schema",
            json_schema:{
              name:"jml_social_copies",
              strict:true,
              schema
            }
          },
          temperature:0.5,
          max_tokens:1200
        })
      });

      const openRouterPayload = await openRouterResponse.json();
      if (openRouterResponse.ok) {
        const openRouterRaw = openRouterPayload?.choices?.[0]?.message?.content || "";
        if (openRouterRaw) {
          try {
            const openRouterCopies = JSON.parse(openRouterRaw);
            const openRouterChecks = {};
            for (const platform of ["facebook","instagram","linkedin"]) {
              openRouterChecks[platform] = validateClaimAgainstListing(openRouterCopies[platform], listing);
            }
            const openRouterRejected = Object.entries(openRouterChecks).filter(([,v])=>!v.approved);
            if (!openRouterRejected.length) {
              res.json({
                ok:true,
                model:"openrouter/free",
                provider:"openrouter",
                copies:openRouterCopies,
                controller:{
                  status:"controlled",
                  platforms:3,
                  rejected:0,
                  rule:"Les trois textes sont contrôlés contre les données de l'annonce source."
                }
              });
              return;
            }
          } catch {}
        }
      }
    }

    // Deterministic local fallback: social preparation must remain available
    // even when both free AI providers hit their quotas. It uses only source facts.
    const localHighlights = (facts.highlights || []).filter(Boolean).slice(0, 6);
    const factLines = [
      facts.location ? "À vendre à " + facts.location + "." : "",
      facts.type ? facts.type + "." : "",
      facts.price ? "Prix : " + facts.price + "." : "",
      facts.surface ? "Surface : " + facts.surface + "." : "",
      facts.terrain ? "Terrain : " + facts.terrain + "." : "",
      facts.bedrooms != null ? String(facts.bedrooms) + " chambres." : "",
      facts.rooms != null ? String(facts.rooms) + " pièces." : "",
      localHighlights.length ? "Points clés : " + localHighlights.join(", ") + "." : "",
      facts.reference ? "Référence : " + facts.reference + "." : ""
    ].filter(Boolean);

    const localBase = factLines.join(" ");
    const localCopies = {
      facebook: localBase,
      instagram: localBase + " #immobilier #venteimmobiliere",
      linkedin: localBase,
    };

    const localChecks = {};
    for (const platform of ["facebook","instagram","linkedin"]) {
      localChecks[platform] = validateClaimAgainstListing(localCopies[platform], listing);
    }

    if (Object.values(localChecks).every(v => v.approved)) {
      return res.json({
        ok:true,
        model:"local-fallback",
        provider:"deterministic",
        copies:localCopies,
        controller:{
          status:"controlled",
          platforms:3,
          rejected:0,
          rule:"Textes locaux construits uniquement à partir des données de l'annonce source."
        }
      });
    }

    if (!geminiKey && !openRouterKey) {
      return res.status(503).json({
        ok:false,
        error:"Aucun moteur disponible pour préparer les publications."
      });
    }

    if (!response?.ok) return res.status(502).json({
      ok:false,
      error:"Les moteurs IA sont temporairement indisponibles et le texte local n'a pas pu être contrôlé."
    });

    const raw = payload?.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("") || "";
    if (!raw) throw new Error("Réponse Gemini vide.");
    model = successfulModel;
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
  const metaAppConfigured = Boolean(process.env.META_APP_SECRET);
  const metaAppIdValue = metaAppId();

  res.json({
    ok: true,
    app: "jml-annonces",
    version: "0.9.0",
    meta: {
      appId: metaAppIdValue,
      configured: metaAppConfigured,
      pageId: String(process.env.META_PAGE_ID || "156425008274121")
    },
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

#!/usr/bin/env node
/**
 * Florida Birds Daily — self-contained site generator.
 *
 * Ported from `verticals/_kit/src/stages/*` so the site can rebuild itself
 * via GitHub Actions without any local-machine API/agent involvement.
 *
 * What it does:
 *   1. Reads existing manifest.json -> list of recently-featured species (to
 *      avoid repeats over the last N days).
 *   2. Fetches recent eBird observations for the configured region.
 *   3. Scores candidates (recency / documentation quality / spread / visibility)
 *      and picks the top one not in the recent-exclude set.
 *   4. Enriches with Wikipedia summary + Wikimedia Commons photo.
 *   5. Fetches per-county sightings breakdown for the picked species.
 *   6. Writes <SITE>/YYYY/MM/DD.html and updates manifest.json.
 *
 * Idempotency: if today's page already exists with valid HTML, exit 0 without
 * touching anything. The Action then sees "no changes" and skips the deploy.
 *
 * Failure mode: any unhandled error exits non-zero so the Action fails loudly.
 * eBird key comes from EBIRD_API_KEY env var.
 *
 * No external dependencies — uses Node 22+ native fetch.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = __dirname;
const BASE_URL = "https://ej-rivers.github.io/florida-birds-daily";
const REGION = "US-FL";
const BACK_DAYS = 7;
const RECENT_EXCLUDE_DAYS = 30;
const UA = "florida-birds-daily/0.1 (+https://ej-rivers.github.io/florida-birds-daily/)";
const EBIRD_BASE = "https://api.ebird.org/v2";

// ---------- main ----------

main().catch((err) => {
  console.error("FATAL:", err && err.stack ? err.stack : err);
  process.exit(1);
});

async function main() {
  const apiKey = process.env.EBIRD_API_KEY;
  if (!apiKey) throw new Error("EBIRD_API_KEY env var is required.");

  const today = todayInET();
  console.log(`[today] ${today} (ET)`);

  // Idempotency: skip if today's page already exists and is non-empty.
  const [yyyy, mm, dd] = today.split("-");
  const todayPath = path.join(SITE_ROOT, yyyy, mm, `${dd}.html`);
  if (existsSync(todayPath)) {
    const size = readFileSync(todayPath).length;
    if (size > 500) {
      console.log(`[skip] ${todayPath} already exists (${size} bytes)`);
      return;
    }
  }

  // Load manifest to find recently-featured species codes.
  const manifest = loadManifest();
  const excludeRecent = recentSpeciesCodes(manifest, RECENT_EXCLUDE_DAYS, new Date());
  console.log(`[exclude] ${excludeRecent.length} species featured in last ${RECENT_EXCLUDE_DAYS}d`);

  // 1) eBird recent observations.
  console.log(`[ebird] fetching recent obs for ${REGION}, back=${BACK_DAYS}d`);
  const obs = await fetchEBirdObservations({ apiKey, region: REGION, backDays: BACK_DAYS });
  console.log(`[ebird] ${obs.length} observations`);

  // 2) Aggregate and score.
  const agg = aggregateBySpecies(obs);
  const scored = scoreCandidates(agg, { excludeRecent, maxAgeHours: 48, requireCount: true });
  if (scored.length === 0) throw new Error("No suitable candidates from eBird.");
  console.log(`[candidates] top 5:`);
  for (const c of scored.slice(0, 5)) {
    console.log(`  ${c.score.toFixed(3)}  ${c.comName} (${c.speciesCode})  obs=${c.obsCount} indiv=${c.totalIndividuals}`);
  }
  const pick = scored[0];
  console.log(`[pick] ${pick.comName} (${pick.sciName}) [${pick.speciesCode}]`);

  // 3) Wikipedia summary.
  console.log(`[wiki] fetching summary...`);
  const bio = await enrichFromWikipedia({ scientificName: pick.sciName, commonName: pick.comName });
  if (!bio) console.log(`[wiki] no usable summary found (continuing without bio)`);
  else console.log(`[wiki] ${bio.title} (${bio.extract.length} chars)`);

  // 4) Commons photo.
  console.log(`[commons] searching for photo...`);
  const photo = await enrichFromCommons({
    scientificName: pick.sciName,
    commonName: pick.comName,
    preferTokens: ["Florida"],
    thumbWidth: 1280,
  });
  if (!photo) console.log(`[commons] no photo found (page will render without hero image)`);
  else console.log(`[commons] ${photo.fileTitle}`);

  // 5) County breakdown for the picked species.
  console.log(`[ebird] county breakdown for ${pick.speciesCode}...`);
  const countyBreakdown = await fetchCountyBreakdown({
    apiKey, region: REGION, speciesCode: pick.speciesCode, backDays: BACK_DAYS,
  });
  console.log(`[ebird] ${countyBreakdown.totalSightings} total, ${countyBreakdown.ranked.length} counties`);

  // 6) Build payload and render.
  const lastSeenHours = hoursSince(pick.lastSeenAt, new Date());
  const payload = {
    date: today,
    species: {
      common_name: pick.comName,
      scientific_name: pick.sciName,
      species_code: pick.speciesCode,
    },
    sightings: {
      total_individuals: pick.totalIndividuals,
      counties: pick.counties.length,
      sample_locations: pick.sampleLocations,
      last_seen_age_hours: lastSeenHours,
      lat: pick.lastSeenLat,
      lng: pick.lastSeenLng,
      location_name: pick.lastSeenLocName,
      total_sightings: countyBreakdown.totalSightings,
      lookback_days: countyBreakdown.lookbackDays,
      top_counties: countyBreakdown.ranked.slice(0, 3).map((c) => c.name),
    },
    bio: bio
      ? { title: bio.title, extract: bio.extract, page_url: bio.pageUrl }
      : null,
    photo: photo
      ? {
          thumb_url: photo.thumbUrl,
          full_url: photo.fullUrl,
          file_page_url: photo.filePageUrl,
          attribution: plainAttribution(photo),
          license_short: photo.licenseShortName,
          license_url: photo.licenseUrl,
        }
      : null,
  };

  const written = renderDailyPage(payload);
  console.log(`[write] ${written}`);
  updateManifest(payload);
  console.log(`[write] manifest.json updated`);
}

// ---------- date helpers ----------

/** YYYY-MM-DD in America/New_York. */
function todayInET() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

function hoursSince(eBirdDt, now) {
  const isoish = String(eBirdDt).replace(" ", "T");
  const t = Date.parse(isoish);
  if (Number.isNaN(t)) return 9999;
  return (now.getTime() - t) / 3_600_000;
}

// ---------- manifest helpers ----------

function loadManifest() {
  const p = path.join(SITE_ROOT, "manifest.json");
  if (!existsSync(p)) return { site: "Florida Birds Daily", generated_at: null, entries: [] };
  try {
    const obj = JSON.parse(readFileSync(p, "utf8"));
    if (!Array.isArray(obj.entries)) obj.entries = [];
    return obj;
  } catch {
    return { site: "Florida Birds Daily", generated_at: null, entries: [] };
  }
}

function recentSpeciesCodes(manifest, daysBack, now) {
  const cutoff = now.getTime() - daysBack * 86_400_000;
  const codes = new Set();
  for (const e of manifest.entries || []) {
    const t = Date.parse(`${e.date}T12:00:00Z`);
    if (Number.isFinite(t) && t >= cutoff && e.species_code) codes.add(e.species_code);
  }
  return [...codes];
}

// ---------- eBird stage ----------

async function fetchEBirdObservations({ apiKey, region, backDays }) {
  const back = Math.max(1, Math.min(30, backDays));
  const url = `${EBIRD_BASE}/data/obs/${encodeURIComponent(region)}/recent?back=${back}&maxResults=10000`;
  const res = await fetch(url, {
    headers: {
      "X-eBirdApiToken": apiKey,
      "User-Agent": UA,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`eBird API ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`eBird returned non-array (${typeof data})`);
  return data;
}

function aggregateBySpecies(obs) {
  const map = new Map();
  for (const o of obs) {
    let agg = map.get(o.speciesCode);
    if (!agg) {
      agg = {
        speciesCode: o.speciesCode,
        comName: o.comName,
        sciName: o.sciName,
        obsCount: 0,
        totalIndividuals: 0,
        counties: [],
        lastSeenAt: o.obsDt,
        sampleLocations: [],
        lastSeenLat: undefined,
        lastSeenLng: undefined,
        lastSeenLocName: undefined,
      };
      map.set(o.speciesCode, agg);
    }
    agg.obsCount += 1;
    if (typeof o.howMany === "number" && Number.isFinite(o.howMany)) {
      agg.totalIndividuals += o.howMany;
    }
    if (o.obsDt >= agg.lastSeenAt) {
      agg.lastSeenAt = o.obsDt;
      if (typeof o.lat === "number" && Number.isFinite(o.lat)) agg.lastSeenLat = o.lat;
      if (typeof o.lng === "number" && Number.isFinite(o.lng)) agg.lastSeenLng = o.lng;
      if (o.locName && o.locName.trim().length > 0) agg.lastSeenLocName = o.locName;
    }
    if (o.subnational2Code && !agg.counties.includes(o.subnational2Code)) {
      agg.counties.push(o.subnational2Code);
    }
    if (
      agg.sampleLocations.length < 5 &&
      !agg.sampleLocations.includes(o.locName) &&
      !looksLikeStreetAddress(o.locName)
    ) {
      agg.sampleLocations.push(o.locName);
    }
  }
  return [...map.values()];
}

function scoreCandidates(agg, opts = {}, now = new Date()) {
  const exclude = new Set(opts.excludeRecent || []);
  const maxAgeHours = opts.maxAgeHours ?? 48;

  const enriched = agg
    .filter((a) => !exclude.has(a.speciesCode))
    .map((a) => ({ ...a, ageHours: hoursSince(a.lastSeenAt, now) }))
    .filter((a) => a.ageHours <= maxAgeHours)
    .filter((a) => !opts.requireCount || a.totalIndividuals > 0)
    .filter((a) => !opts.requireNamedLocation || a.sampleLocations.length > 0);

  if (enriched.length === 0) return [];

  const maxIndiv = Math.max(1, ...enriched.map((a) => a.totalIndividuals));

  return enriched
    .map((a) => {
      const recency = Math.max(0, 1 - a.ageHours / maxAgeHours);
      const docQuality =
        (a.totalIndividuals > 0 ? 0.5 : 0) +
        (a.sampleLocations.length > 0 ? 0.5 : 0);
      const spread = Math.min(1, a.sampleLocations.length / 3);
      const visibility =
        a.totalIndividuals > 0
          ? Math.log10(1 + a.totalIndividuals) / Math.log10(1 + maxIndiv)
          : 0;
      const score = 0.35 * recency + 0.25 * docQuality + 0.2 * spread + 0.2 * visibility;
      return { ...a, score };
    })
    .sort((a, b) => b.score - a.score);
}

function looksLikeStreetAddress(loc) {
  return /^\s*\d/.test(loc) && loc.includes(",");
}

async function fetchCountyBreakdown({ apiKey, region, speciesCode, backDays }) {
  const back = Math.max(1, Math.min(30, backDays));
  const counties = await fetchSubnational2Regions(apiKey, region);
  const results = [];
  const concurrency = 10;
  for (let i = 0; i < counties.length; i += concurrency) {
    const batch = counties.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      batch.map(async (c) => {
        const url =
          `${EBIRD_BASE}/data/obs/${encodeURIComponent(c.code)}/recent/${encodeURIComponent(speciesCode)}` +
          `?back=${back}&maxResults=10000`;
        const res = await fetch(url, {
          headers: { "X-eBirdApiToken": apiKey, "User-Agent": UA, Accept: "application/json" },
        });
        if (!res.ok) return { name: c.name, count: 0 };
        const j = await res.json();
        return { name: c.name, count: Array.isArray(j) ? j.length : 0 };
      }),
    );
    for (const r of settled) if (r.status === "fulfilled") results.push(r.value);
  }
  const ranked = results.filter((r) => r.count > 0).sort((a, b) => b.count - a.count);
  const totalSightings = ranked.reduce((s, r) => s + r.count, 0);
  return { totalSightings, ranked, lookbackDays: back };
}

async function fetchSubnational2Regions(apiKey, region) {
  const url = `${EBIRD_BASE}/ref/region/list/subnational2/${encodeURIComponent(region)}`;
  const res = await fetch(url, {
    headers: { "X-eBirdApiToken": apiKey, "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`eBird subnational2 list ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// ---------- Wikipedia stage ----------

function extractFamily(text) {
  if (!text) return null;
  const m = text.match(/\bfamily\s+([A-Z][a-z]+(?:idae|inae))\b/);
  return m ? m[1] : null;
}

async function resolveWikiTitle(query) {
  const url =
    "https://en.wikipedia.org/w/api.php?" +
    new URLSearchParams({
      action: "query",
      format: "json",
      list: "search",
      srsearch: query,
      srlimit: "3",
      origin: "*",
    }).toString();
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.query?.search?.[0]?.title ?? null;
}

async function fetchWikiSummary(title) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/\s/g, "_"))}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) return null;
  const data = await res.json();
  if (data?.type === "disambiguation") return null;
  const extract = data.extract ?? "";
  return {
    title: data.title,
    extract,
    extractHtml: data.extract_html,
    pageUrl: data.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    thumbnailUrl: data.thumbnail?.source,
    originalImageUrl: data.originalimage?.source,
    family: extractFamily(extract),
  };
}

async function enrichFromWikipedia({ scientificName, commonName }) {
  let title = await resolveWikiTitle(scientificName);
  if (!title) title = await resolveWikiTitle(commonName);
  if (!title) return null;
  const summary = await fetchWikiSummary(title);
  if (summary && summary.extract && summary.extract.length > 40) return summary;
  const alt = await resolveWikiTitle(commonName);
  if (alt && alt !== title) {
    const altSummary = await fetchWikiSummary(alt);
    if (altSummary && altSummary.extract.length > 40) return altSummary;
  }
  return summary;
}

// ---------- Commons stage ----------

async function searchCommonsCandidates(query, thumbWidth, limit) {
  const url =
    "https://commons.wikimedia.org/w/api.php?" +
    new URLSearchParams({
      action: "query",
      format: "json",
      prop: "imageinfo",
      generator: "search",
      iiprop: "url|extmetadata",
      gsrsearch: query,
      gsrnamespace: "6",
      gsrlimit: String(limit),
      iiurlwidth: String(thumbWidth),
      origin: "*",
    }).toString();
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) return [];
  const data = await res.json();
  const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
  return pages;
}

async function headOk(url) {
  try {
    const res = await fetch(url, { method: "HEAD", headers: { "User-Agent": UA } });
    return res.ok;
  } catch {
    return false;
  }
}

function stripQs(url) {
  const i = url.indexOf("?");
  return i >= 0 ? url.slice(0, i) : url;
}

function metaText(meta, key) {
  return meta?.[key]?.value;
}

function pickBestCommonsPage(pages, preferTokens) {
  if (pages.length === 0) return null;
  for (const tok of preferTokens) {
    const lower = tok.toLowerCase();
    const hit = pages.find((p) => p.title.toLowerCase().includes(lower));
    if (hit) return hit;
  }
  return pages[0];
}

async function enrichFromCommons({ scientificName, commonName, preferTokens = [], thumbWidth = 1280 }) {
  const queries = [`${scientificName} ${commonName}`, scientificName, commonName];
  for (const q of queries) {
    const pages = await searchCommonsCandidates(q, thumbWidth, 8);
    const candidate = pickBestCommonsPage(pages, preferTokens);
    if (!candidate) continue;
    const info = candidate.imageinfo?.[0];
    if (!info) continue;
    const thumb = info.thumburl ? stripQs(info.thumburl) : null;
    const full = info.url ? stripQs(info.url) : null;
    if (!thumb || !full) continue;
    const thumbOk = await headOk(thumb);
    const verifiedThumb = thumbOk ? thumb : full;
    const meta = info.extmetadata;
    return {
      thumbUrl: verifiedThumb,
      fullUrl: full,
      filePageUrl: info.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(candidate.title)}`,
      fileTitle: candidate.title,
      thumbWidth: info.thumbwidth,
      thumbHeight: info.thumbheight,
      licenseShortName: metaText(meta, "LicenseShortName"),
      licenseUrl: metaText(meta, "LicenseUrl"),
      artist: metaText(meta, "Artist"),
      attributionRequired: (metaText(meta, "AttributionRequired") ?? "").toLowerCase() === "true",
    };
  }
  return null;
}

function plainAttribution(photo) {
  const parts = [];
  if (photo.artist) {
    const stripped = photo.artist.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (stripped) parts.push(stripped);
  }
  if (photo.licenseShortName) parts.push(photo.licenseShortName);
  return parts.join(" \u00b7 ");
}

// ---------- render stage ----------

function renderDailyPage(payload) {
  const [yyyy, mm, dd] = payload.date.split("-");
  const dir = path.join(SITE_ROOT, yyyy, mm);
  mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `${dd}.html`);
  writeFileSync(outPath, buildHtml(payload), { encoding: "utf8" });
  return outPath;
}

function updateManifest(payload) {
  const manifestPath = path.join(SITE_ROOT, "manifest.json");
  let manifest;
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (!Array.isArray(manifest.entries)) manifest.entries = [];
    } catch {
      manifest = { site: "Florida Birds Daily", generated_at: null, entries: [] };
    }
  } else {
    manifest = { site: "Florida Birds Daily", generated_at: null, entries: [] };
  }

  const url = `/florida-birds-daily/${payload.date.replace(/-/g, "/")}.html`;
  const dateLabel = formatDateShort(payload.date);
  const entry = {
    date: payload.date,
    date_label: dateLabel,
    common_name: payload.species.common_name,
    scientific_name: payload.species.scientific_name,
    species_code: payload.species.species_code,
    url,
    thumb: payload.photo?.thumb_url ?? "",
    region_label: payload.sightings.sample_locations[0] ?? "",
  };
  if (
    typeof payload.sightings.lat === "number" &&
    Number.isFinite(payload.sightings.lat) &&
    typeof payload.sightings.lng === "number" &&
    Number.isFinite(payload.sightings.lng)
  ) {
    entry.lat = payload.sightings.lat;
    entry.lng = payload.sightings.lng;
  }
  if (payload.sightings.location_name && payload.sightings.location_name.trim().length > 0) {
    entry.location_name = payload.sightings.location_name;
  }
  if (
    typeof payload.sightings.total_sightings === "number" &&
    Number.isFinite(payload.sightings.total_sightings) &&
    payload.sightings.total_sightings > 0
  ) {
    entry.total_sightings = payload.sightings.total_sightings;
  }
  if (
    typeof payload.sightings.lookback_days === "number" &&
    Number.isFinite(payload.sightings.lookback_days) &&
    payload.sightings.lookback_days > 0
  ) {
    entry.lookback_days = payload.sightings.lookback_days;
  }
  if (Array.isArray(payload.sightings.top_counties) && payload.sightings.top_counties.length > 0) {
    entry.top_counties = payload.sightings.top_counties.slice(0, 3);
  }

  manifest.entries = [entry, ...manifest.entries.filter((e) => e.date !== payload.date)];
  manifest.generated_at = new Date().toISOString();
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { encoding: "utf8" });
}

// ---------- HTML helpers ----------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
const escapeAttr = escapeHtml;

function formatDateLong(date) {
  const d = new Date(date + "T12:00:00Z");
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const mo = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${wd}, ${d.getUTCDate()} ${mo} ${d.getUTCFullYear()}`;
}

function formatDateShort(date) {
  const d = new Date(date + "T12:00:00Z");
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const mo = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${wd} ${mo} ${d.getUTCDate()}`;
}

function formatNumber(n) {
  return Number(n).toLocaleString("en-US");
}

function pickStatusLabel(_p) {
  return "Common &middot; Resident";
}

function ebirdSpeciesUrl(code) {
  return `https://ebird.org/species/${encodeURIComponent(code)}`;
}

function buildHtml(p) {
  const dateLong = formatDateLong(p.date);
  const dateEyebrow = `Today &middot; ${formatDateShort(p.date)}`;
  const canonicalUrl = `${BASE_URL}/${p.date.replace(/-/g, "/")}.html`;
  const heroImageUrl = p.photo?.thumb_url ?? "";
  const heroAlt = `${p.species.common_name} (${p.species.scientific_name})`;
  const ogImage = p.photo?.thumb_url ?? p.photo?.full_url ?? "";
  const titleEsc = escapeHtml(p.species.common_name);
  const sciEsc = escapeHtml(p.species.scientific_name);
  const descLead =
    p.bio?.extract?.slice(0, 200) ??
    `${p.species.common_name} (${p.species.scientific_name}) — today's bird on Florida Birds Daily.`;
  const descEsc = escapeAttr(descLead.replace(/\s+/g, " ").trim());

  const bioParas = (p.bio?.extract ?? "")
    .split(/\n\n+/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${escapeHtml(para)}</p>`)
    .join("\n        ");

  const sampleLocLine = p.sightings.sample_locations.length
    ? `Best places to spot one this week: ${escapeHtml(p.sightings.sample_locations.slice(0, 3).join(" \u00b7 "))}.`
    : "";
  const bioBlock = bioParas
    ? bioParas + (sampleLocLine ? `\n        <p>${sampleLocLine}</p>` : "")
    : `<p>${escapeHtml(p.species.common_name)} (${escapeHtml(p.species.scientific_name)}) was reported in Florida recently. ${sampleLocLine}</p>`;

  const tickerBits = [
    `<span>${formatNumber(p.sightings.total_individuals)} reported in the last week</span>`,
    `<span class="sep">&middot;</span>`,
    `<span>Last seen <strong>${p.sightings.last_seen_age_hours.toFixed(0)}h</strong> ago</span>`,
    `<span class="sep">&middot;</span>`,
    `<span>Today: <strong>${titleEsc}</strong></span>`,
  ].join("\n      ");

  const wikiLink = p.bio
    ? `<a href="${escapeAttr(p.bio.page_url)}">Wikipedia</a>`
    : `<a href="https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(p.species.scientific_name)}">Wikipedia</a>`;

  const photoCredit = p.photo
    ? `Photo: <a href="${escapeAttr(p.photo.file_page_url)}">${escapeHtml(p.photo.attribution || "Wikimedia Commons")}</a>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${titleEsc} &mdash; Florida Birds Daily</title>
  <meta name="description" content="${descEsc}" />
  <link rel="canonical" href="${escapeAttr(canonicalUrl)}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/florida-birds-daily/style.css" />

  <meta property="og:title" content="${titleEsc} &mdash; Florida Birds Daily" />
  <meta property="og:description" content="${descEsc}" />
  <meta property="og:type" content="article" />
  <meta property="og:url" content="${escapeAttr(canonicalUrl)}" />
  ${ogImage ? `<meta property="og:image" content="${escapeAttr(ogImage)}" />` : ""}
</head>
<body class="bird-page">

  <header class="topnav">
    <div class="topnav-inner">
      <a class="brand" href="/florida-birds-daily/">
        <span class="dot"></span>
        Florida Birds Daily
      </a>
      <nav>
        <a href="/florida-birds-daily/" class="active">Today</a>
        <a href="/florida-birds-daily/archive.html">Archive</a>
        <a href="/florida-birds-daily/map.html">Map</a>
        <a href="/florida-birds-daily/about.html">About</a>
      </nav>
    </div>
  </header>

  <div class="ticker">
    <div class="ticker-inner">
      <span class="ticker-pill"><span class="live"></span> <strong>Live</strong></span>
      ${tickerBits}
    </div>
  </div>

  <section class="hero">
    ${heroImageUrl ? `<img class="hero-img" src="${escapeAttr(heroImageUrl)}" alt="${escapeAttr(heroAlt)}" />` : ""}
    <div class="hero-grad"></div>
    <div class="hero-content">
      <span class="hero-eyebrow">${dateEyebrow}</span>
      <h1>${titleEsc}</h1>
      <p class="sci">${sciEsc}</p>
    </div>
    ${photoCredit ? `<div class="hero-credit">${photoCredit}</div>` : ""}
  </section>

  <main class="section">
    <div class="fact-strip">
      <div>
        <strong>Reported &middot; 7d</strong>
        <span class="v">${formatNumber(p.sightings.total_individuals)}</span>
      </div>
      <div>
        <strong>Last seen</strong>
        <span class="v">${p.sightings.last_seen_age_hours.toFixed(0)}h ago</span>
      </div>
      <div>
        <strong>Top location</strong>
        <span class="v">${escapeHtml(p.sightings.sample_locations[0] ?? "Florida")}</span>
      </div>
      <div>
        <strong>Status</strong>
        <span class="v">${pickStatusLabel(p)}</span>
      </div>
    </div>

    <article class="bird-bio">
        ${bioBlock}
    </article>

    <div class="action-row">
      <a href="${escapeAttr(ebirdSpeciesUrl(p.species.species_code))}">More on eBird &rarr;</a>
      ${wikiLink}
      <a href="/florida-birds-daily/">&larr; Home</a>
    </div>
  </main>

  <footer class="site-footer">
    <p>
      Sightings: <a href="https://ebird.org/">eBird</a> &middot;
      Photos: <a href="https://commons.wikimedia.org/">Wikimedia Commons</a> &middot;
      Bios: <a href="https://en.wikipedia.org/">Wikipedia</a>
    </p>
    <p class="muted small">
      Bird sightings are user-submitted to eBird and may not reflect protected-species locations precisely.
    </p>
  </footer>
</body>
</html>
`;
}

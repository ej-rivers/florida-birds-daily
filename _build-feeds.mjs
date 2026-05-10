// Regenerate feed.xml and sitemap.xml from manifest.json.
// Run from inside the site/ folder:  node _build-feeds.mjs
//
// This is idempotent and safe to call after each daily kit run.
// Static pages (/, archive.html, map.html, about.html) are always included
// in the sitemap; daily pages come from manifest entries.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE_BASE = 'https://ej-rivers.github.io/florida-birds-daily';
const STATIC_PATHS = ['/', '/archive.html', '/map.html', '/about.html'];

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function rfc822(dateISO) {
  // dateISO is yyyy-mm-dd; pin to 13:00 UTC (~8 AM ET) so RSS readers get a stable pubDate.
  const d = new Date(`${dateISO}T13:00:00Z`);
  return d.toUTCString();
}

function absoluteUrl(pathOrUrl) {
  if (!pathOrUrl) return SITE_BASE + '/';
  if (/^https?:/i.test(pathOrUrl)) return pathOrUrl;
  if (pathOrUrl.startsWith('/florida-birds-daily/')) {
    return 'https://ej-rivers.github.io' + pathOrUrl;
  }
  if (pathOrUrl.startsWith('/')) return SITE_BASE + pathOrUrl;
  return SITE_BASE + '/' + pathOrUrl;
}

async function main() {
  const manifestPath = join(HERE, 'manifest.json');
  const raw = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  const entries = Array.isArray(manifest.entries) ? manifest.entries.slice() : [];
  // Newest first
  entries.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const buildDate = new Date().toUTCString();

  // ---------- RSS ----------
  const items = entries.map((e) => {
    const link = absoluteUrl(e.url);
    const title = `${e.common_name || 'Bird'} (${e.scientific_name || ''})`.trim();
    // Plain text for RSS description: avoid HTML entities (readers don't decode them
    // consistently in <description>) and avoid raw Unicode glyphs per project rules.
    const desc = `${e.common_name || ''} - ${e.scientific_name || ''}` +
                 (e.region_label ? ` (${e.region_label})` : '');
    return [
      '    <item>',
      `      <title>${xmlEscape(title)}</title>`,
      `      <link>${xmlEscape(link)}</link>`,
      `      <guid isPermaLink="true">${xmlEscape(link)}</guid>`,
      `      <pubDate>${rfc822(e.date)}</pubDate>`,
      `      <description>${xmlEscape(desc)}</description>`,
      '    </item>'
    ].join('\n');
  }).join('\n');

  const rss =
`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Florida Birds Daily</title>
    <link>${SITE_BASE}/</link>
    <atom:link href="${SITE_BASE}/feed.xml" rel="self" type="application/rss+xml" />
    <description>A new Florida bird every day. Photos, range, and where it was just spotted across the state.</description>
    <language>en-us</language>
    <lastBuildDate>${buildDate}</lastBuildDate>
${items}
  </channel>
</rss>
`;

  await writeFile(join(HERE, 'feed.xml'), rss, 'utf8');

  // ---------- Sitemap ----------
  const urls = [];
  for (const p of STATIC_PATHS) {
    urls.push({ loc: SITE_BASE + (p === '/' ? '/' : p), lastmod: entries[0]?.date || null });
  }
  for (const e of entries) {
    urls.push({ loc: absoluteUrl(e.url), lastmod: e.date || null });
  }

  const sitemap =
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => {
  const lm = u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : '';
  return `  <url>\n    <loc>${xmlEscape(u.loc)}</loc>${lm}\n  </url>`;
}).join('\n')}
</urlset>
`;

  await writeFile(join(HERE, 'sitemap.xml'), sitemap, 'utf8');

  console.log(`Wrote feed.xml (${entries.length} items) and sitemap.xml (${urls.length} urls).`);
}

main().catch((err) => { console.error(err); process.exit(1); });

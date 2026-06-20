// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Hacker News provider — reads the monthly "Ask HN: Who is hiring?" thread via
// the public Algolia HN Search API (https://hn.algolia.com/api/v1). Each
// top-level comment in that thread is one job posting, by convention formatted
// "Company | Role | Location | Remote | ...". The Algolia endpoint returns all
// comments for a story in a few paginated calls, so the whole thread is read
// without one-request-per-comment fan-out.
//
// Wire in via a `job_boards:` entry with `provider: hackernews`. Optional:
//   - storyId       — pin a specific thread (HN item id). If omitted, the
//                     latest whoishiring "Who is hiring?" thread is found.
//   - careers_url   — https://news.ycombinator.com/item?id=<id> also pins it.
//   - maxPages      — comment pages to read (default 3, 100 comments each).
//   - pageSize      — comments per page (default 100).
//
// scan.mjs applies title_filter / location_filter / content_filter; each
// posting carries its full comment text as `description` for content_filter.

const API_HOST = 'hn.algolia.com';
const HN_ITEM_BASE = 'https://news.ycombinator.com/item?id=';
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 3;

const ALLOWED_HN_HOSTS = new Set([API_HOST]);

/** @param {string} url */
function assertHnUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`hackernews: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`hackernews: URL must use HTTPS: ${url}`);
  if (!ALLOWED_HN_HOSTS.has(parsed.hostname))
    throw new Error(`hackernews: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_HN_HOSTS].join(', ')}`);
  return url;
}

/**
 * Decode the HTML entities HN comment_text uses (&amp; &lt; &gt; &quot;,
 * decimal &#39; and hex &#x2F;).
 * @param {string} s
 */
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&'); // last — avoid double-decoding
}

/**
 * Strip HN comment HTML to plain text: <p> → newlines, <a> unwrapped to its
 * text, other tags removed, entities decoded, whitespace tidied.
 * @param {string} html
 */
export function stripHtml(html) {
  if (typeof html !== 'string') return '';
  let text = html
    .replace(/<\s*p\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*p\s*>/gi, '\n')
    .replace(/<a\b[^>]*>/gi, '')
    .replace(/<\/a>/gi, '')
    .replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  return text
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Parse a single Algolia comment hit into the canonical Job shape. Only
 * top-level comments (direct children of the thread) are postings; replies are
 * rejected. Exported for unit tests.
 *
 * @param {any} hit — raw Algolia comment hit
 * @param {string|number} storyId — the thread's HN item id
 * @returns {{title: string, url: string, company: string, location: string, description?: string, postedAt?: number}|null}
 */
export function parseHnComment(hit, storyId) {
  if (!hit || typeof hit !== 'object') return null;
  if (String(hit.parent_id) !== String(storyId)) return null; // reply, not a posting
  const objectID = hit.objectID != null ? String(hit.objectID) : '';
  if (!objectID) return null;

  const text = stripHtml(hit.comment_text);
  if (!text) return null;

  const firstLine = text.split('\n')[0] || '';
  const title = firstLine.length > 150 ? `${firstLine.slice(0, 147)}...` : firstLine;
  if (!title) return null;

  const segments = firstLine.split('|').map(s => s.trim()).filter(Boolean);
  const company = segments[0] || hit.author || 'HN Who is Hiring';
  const locSeg = segments.slice(1).find(s => /remote|onsite|on-site|hybrid/i.test(s));
  const location = locSeg || '';

  const url = `${HN_ITEM_BASE}${objectID}`;
  const postedAt = Number.isFinite(Number(hit.created_at_i)) && Number(hit.created_at_i) > 0
    ? Number(hit.created_at_i) * 1000
    : undefined;

  return {
    title,
    url,
    company,
    location,
    description: text,
    ...(postedAt != null ? { postedAt } : {}),
  };
}

/** Build an Algolia search_by_date URL with the given tags/paging. */
function buildSearchUrl({ tags, page, hitsPerPage }) {
  const url = new URL(`https://${API_HOST}/api/v1/search_by_date`);
  url.searchParams.set('tags', tags);
  url.searchParams.set('hitsPerPage', String(hitsPerPage || DEFAULT_PAGE_SIZE));
  if (page != null) url.searchParams.set('page', String(page));
  return url.href;
}

/**
 * Pick the latest real "Who is hiring?" thread from whoishiring's stories,
 * excluding the sibling "Who wants to be hired?" / "Freelancer?" threads.
 * Exported for unit tests.
 * @param {any} json — Algolia story search response
 * @returns {string|null} story objectID
 */
export function pickHiringStory(json) {
  const hits = Array.isArray(json?.hits) ? json.hits : [];
  // search_by_date is newest-first; take the first matching title.
  const hit = hits.find(h => h && typeof h.title === 'string'
    && /who\s+is\s+hiring/i.test(h.title)
    && !/wants\s+to\s+be\s+hired/i.test(h.title)
    && !/freelancer/i.test(h.title));
  return hit && hit.objectID != null ? String(hit.objectID) : null;
}

/** Derive a story id from a news.ycombinator.com item URL, else null. */
function storyIdFromCareersUrl(careersUrl) {
  if (!careersUrl) return null;
  try {
    const parsed = new URL(careersUrl);
    if (parsed.hostname !== 'news.ycombinator.com') return null;
    const id = parsed.searchParams.get('id');
    return id && /^\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** @type {Provider} */
export default {
  id: 'hackernews',

  detect(_entry) {
    // HN's hiring thread is a community board, not a company ATS.
    // Use `provider: hackernews` explicitly in portals.yml.
    return null;
  },

  async fetch(entry, ctx) {
    const pageSize = Number(entry.pageSize) || DEFAULT_PAGE_SIZE;
    const maxPages = Number(entry.maxPages) || DEFAULT_MAX_PAGES;

    // 1. Resolve the thread id: explicit > careers_url > auto-find latest.
    let storyId = entry.storyId != null ? String(entry.storyId) : storyIdFromCareersUrl(entry.careers_url);
    if (!storyId) {
      const storyUrl = buildSearchUrl({ tags: 'story,author_whoishiring', hitsPerPage: 20 });
      assertHnUrl(storyUrl);
      const storyJson = /** @type {any} */ (await ctx.fetchJson(storyUrl, { redirect: 'error' }));
      storyId = pickHiringStory(storyJson);
      if (!storyId) throw new Error('hackernews: could not locate a current "Who is hiring?" thread — set storyId in portals.yml');
    }

    // 2. Read the thread's top-level comments, paginated.
    const allJobs = [];
    for (let page = 0; page < maxPages; page++) {
      const commentsUrl = buildSearchUrl({ tags: `comment,story_${storyId}`, page, hitsPerPage: pageSize });
      assertHnUrl(commentsUrl);

      let json;
      try {
        // redirect:'error' prevents SSRF via server-side redirects.
        json = /** @type {any} */ (await ctx.fetchJson(commentsUrl, { redirect: 'error' }));
      } catch (err) {
        if (page === 0) throw err;
        console.error(`hackernews: page ${page} fetch failed — ${err.message}`);
        break;
      }

      const hits = Array.isArray(json?.hits) ? json.hits : [];
      if (hits.length === 0) break;

      for (const hit of hits) {
        const job = parseHnComment(hit, storyId);
        if (job) allJobs.push(job);
      }

      const nbPages = Number(json?.nbPages);
      if (Number.isFinite(nbPages) && page >= nbPages - 1) break; // last page
    }

    return allJobs;
  },
};

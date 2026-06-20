// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Arbeitnow provider — board-wide aggregator feed
// (https://www.arbeitnow.com/api/job-board-api). Returns { data: [...], links,
// meta }. European-focused board (DE/EU heavy) with strong remote and
// visa-sponsorship coverage. scan.mjs applies the configured title_filter /
// location_filter / content_filter to the returned rows.
//
// Wire in via a `job_boards:` entry with `provider: arbeitnow`. Optional
// `maxPages` (default 1) follows the feed's `links.next` cursor for more pages.

const FEED_URL = 'https://www.arbeitnow.com/api/job-board-api';
const DEFAULT_MAX_PAGES = 1;

const ALLOWED_ARBEITNOW_HOSTS = new Set(['www.arbeitnow.com', 'arbeitnow.com']);

/** @param {string} url */
function assertArbeitnowUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`arbeitnow: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`arbeitnow: URL must use HTTPS: ${url}`);
  if (!ALLOWED_ARBEITNOW_HOSTS.has(parsed.hostname))
    throw new Error(`arbeitnow: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_ARBEITNOW_HOSTS].join(', ')}`);
  return url;
}

// `created_at` is unix epoch SECONDS in the arbeitnow feed.
function toEpochMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * 1000);
}

/**
 * Parse a single arbeitnow feed item into the canonical Job shape.
 * Feed items look like:
 *   { slug, company_name, title, description, remote, url, tags, job_types,
 *     location, created_at }
 * Exported for unit tests.
 *
 * @param {any} item — raw feed item
 * @param {string} fallbackCompany — company name fallback from the portal entry
 * @returns {{title: string, url: string, company: string, location: string, description?: string, postedAt?: number}|null}
 */
export function parseArbeitnowItem(item, fallbackCompany) {
  if (!item || typeof item !== 'object') return null;

  const title = typeof item.title === 'string' ? item.title.trim() : '';
  if (!title) return null;

  const rawUrl = typeof item.url === 'string' ? item.url.trim() : '';
  if (!/^https?:\/\//i.test(rawUrl)) return null;

  const company = (typeof item.company_name === 'string' && item.company_name.trim())
    ? item.company_name.trim()
    : (fallbackCompany || 'Arbeitnow');

  let location = typeof item.location === 'string' ? item.location.trim() : '';
  if (item.remote === true) location = location ? `${location} (Remote)` : 'Remote';

  const description = typeof item.description === 'string' ? item.description.trim() : '';
  const postedAt = toEpochMs(item.created_at);

  return {
    title,
    url: rawUrl,
    company,
    location,
    ...(description ? { description } : {}),
    ...(postedAt != null ? { postedAt } : {}),
  };
}

/** @type {Provider} */
export default {
  id: 'arbeitnow',

  detect(_entry) {
    // Arbeitnow is a board-wide aggregator, not a company ATS.
    // Use `provider: arbeitnow` explicitly in portals.yml.
    return null;
  },

  async fetch(entry, ctx) {
    const maxPages = Number(entry.maxPages) || DEFAULT_MAX_PAGES;
    const fallbackCompany = entry.name || '';
    const allJobs = [];
    let nextUrl = FEED_URL;

    for (let page = 1; page <= maxPages && nextUrl; page++) {
      assertArbeitnowUrl(nextUrl);
      // redirect:'error' prevents SSRF via server-side redirects; combined with
      // assertArbeitnowUrl it keeps the final hostname inside the allowlist.
      let json;
      try {
        json = /** @type {any} */ (await ctx.fetchJson(nextUrl, { redirect: 'error' }));
      } catch (err) {
        if (page === 1) throw err;
        console.error(`arbeitnow: page ${page} fetch failed — ${err.message}`);
        break;
      }

      if (!json || !Array.isArray(json.data)) {
        if (page === 1) {
          throw new Error(`arbeitnow: unexpected API response — expected { data: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`);
        }
        break;
      }

      for (const item of json.data) {
        const job = parseArbeitnowItem(item, fallbackCompany);
        if (job) allJobs.push(job);
      }

      // Follow the cursor for additional pages; assertArbeitnowUrl re-checks it.
      nextUrl = typeof json.links?.next === 'string' ? json.links.next : null;
    }

    return allJobs;
  },
};

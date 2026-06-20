// TechCrunch source — the Venture Capital RSS feed, filtered to funding
// headlines (raises / Series X / seed / $-amounts). No API key. Companies in
// the news for a raise are strong outreach leads — they're about to scale.

import { parseFeed } from './_feed.mjs';

const ALLOWED_TC_HOSTS = new Set(['techcrunch.com', 'www.techcrunch.com']);
const FEED_URL = 'https://techcrunch.com/category/venture/feed/';

// Headlines that signal a funding event.
const FUNDING_RE = /\b(raises?|raised|secures?|lands?|closes?|nets?|bags?)\b|\bseries\s+[a-k]\b|\bseed\b|\bpre-seed\b|\$\s?\d/i;

/** @param {string} url */
export function assertTcUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`techcrunch: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`techcrunch: URL must use HTTPS: ${url}`);
  if (!ALLOWED_TC_HOSTS.has(parsed.hostname))
    throw new Error(`techcrunch: untrusted hostname "${parsed.hostname}"`);
  return url;
}

/** True when a headline looks like a funding announcement. Exported for tests. */
export function isFundingHeadline(title) {
  return FUNDING_RE.test(String(title || ''));
}

/**
 * Best-effort company extraction from a TechCrunch funding headline. Most read
 * "Company raises $Xm ..." or "Company lands ...", so take the text before the
 * first funding verb. Exported for tests.
 * @param {string} title
 * @returns {string}
 */
export function companyFromHeadline(title) {
  const t = String(title || '').trim();
  const m = t.match(/^(.*?)\s+(?:raises?|raised|secures?|lands?|closes?|nets?|bags?|snags?)\b/i);
  if (m && m[1].trim()) return m[1].trim();
  // Fallback: text before a comma or an em dash.
  const seg = t.split(/[,—–]| - /)[0].trim();
  return seg.length <= 60 ? seg : '';
}

/** Pull a "$12M" / "$1.2 billion" amount from a headline, if present. */
export function amountFromHeadline(title) {
  // Long words before [KMB]: with /i, [KMB] would otherwise match the "m" in
  // "million" before the "million" alternative gets a chance.
  const m = String(title || '').match(/\$\s?\d[\d.,]*\s?(?:million|billion|thousand|[KMB])?/i);
  return m ? m[0].replace(/\s+/g, '') : '';
}

export default {
  id: 'techcrunch',
  label: 'TechCrunch funding news',

  async fetch(ctx) {
    assertTcUrl(FEED_URL);
    // redirect:'error' blocks SSRF via server-side redirects.
    const xml = await ctx.fetchText(FEED_URL, { redirect: 'error' });

    const leads = [];
    for (const entry of parseFeed(xml)) {
      if (!isFundingHeadline(entry.title)) continue;
      const company = companyFromHeadline(entry.title);
      if (!company) continue;
      leads.push({
        company,
        source: 'techcrunch',
        signal: entry.title,
        url: entry.link,
        date: entry.date || '',
        amount: amountFromHeadline(entry.title),
      });
    }
    return leads;
  },
};

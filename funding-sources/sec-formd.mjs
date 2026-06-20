// SEC EDGAR Form D source — recently-filed Form D notices (exempt securities
// offerings, i.e. companies raising private capital). Reads the public
// "getcurrent" Atom feed; no API key. SEC asks every client to send a
// descriptive User-Agent with contact info — set SEC_USER_AGENT in .env.
//
// Many Form D filers are funds/SPVs, not operating companies you'd apply to,
// so filerLooksOperating() drops the obvious investment-vehicle names. This is
// a lead signal, not a guarantee — suggest-only.

import { parseFeed } from './_feed.mjs';

const ALLOWED_SEC_HOSTS = new Set(['www.sec.gov', 'sec.gov']);
const FEED_URL = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=D&count=100&output=atom';
const DEFAULT_UA = 'career-ops job-search research (set SEC_USER_AGENT with your email)';

/** @param {string} url */
export function assertSecUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`sec-formd: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`sec-formd: URL must use HTTPS: ${url}`);
  if (!ALLOWED_SEC_HOSTS.has(parsed.hostname))
    throw new Error(`sec-formd: untrusted hostname "${parsed.hostname}"`);
  return url;
}

// Drop names that read as funds / SPVs / holding vehicles rather than operating
// companies. Conservative: only the strongest signals, to avoid false drops.
const FUND_PATTERNS = /\b(L\.?P\.?|LLP|fund|funds|partners|capital|ventures?|holdings?|trust|advisors?|management|offshore|feeder|spv|investors?|equity|opportunit(?:y|ies))\b/i;

export function filerLooksOperating(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  return !FUND_PATTERNS.test(n);
}

/**
 * Parse a getcurrent Atom entry title into the company name.
 * Titles look like "D - Acme Robotics, Inc. (0001234567) (Filer)".
 * Exported for tests.
 * @param {string} title
 * @returns {string}
 */
export function companyFromTitle(title) {
  const m = String(title || '').match(/^\s*D\s*[-–—]\s*(.+?)\s*\(\d+\)/);
  return m ? m[1].trim() : '';
}

/** Extract the "Filed: YYYY-MM-DD" date from an entry summary. */
export function filedDateFromSummary(summary) {
  const m = String(summary || '').match(/Filed:\s*(\d{4}-\d{2}-\d{2})/i);
  return m ? m[1] : '';
}

export default {
  id: 'sec-formd',
  label: 'SEC EDGAR Form D (capital raises)',

  async fetch(ctx, opts = {}) {
    const ua = process.env.SEC_USER_AGENT || DEFAULT_UA;
    assertSecUrl(FEED_URL);
    // redirect:'error' blocks SSRF via server-side redirects.
    const xml = await ctx.fetchText(FEED_URL, { redirect: 'error', headers: { 'user-agent': ua } });
    const includeFunds = opts.includeFunds === true;

    const leads = [];
    for (const entry of parseFeed(xml)) {
      const company = companyFromTitle(entry.title);
      if (!company) continue;
      if (!includeFunds && !filerLooksOperating(company)) continue;
      leads.push({
        company,
        source: 'sec-formd',
        signal: 'Form D filing (private capital raise)',
        url: entry.link,
        date: filedDateFromSummary(entry.summary) || entry.date || '',
      });
    }
    return leads;
  },
};

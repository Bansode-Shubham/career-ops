// Y Combinator source — companies currently marked "hiring", via the community
// yc-oss public API (https://yc-oss.github.io/api). No key, stable JSON mirror
// of YC's directory. YC companies are funded by definition; the hiring filter
// makes these the highest-intent outreach leads.
//
// Options (from funding.mjs flags): batch ("Summer 2026"), minTeam (number),
// limit (number). Default endpoint is the hiring list.

const ALLOWED_YC_HOSTS = new Set(['yc-oss.github.io']);
const HIRING_URL = 'https://yc-oss.github.io/api/companies/hiring.json';

/** @param {string} url */
export function assertYcUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`yc: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`yc: URL must use HTTPS: ${url}`);
  if (!ALLOWED_YC_HOSTS.has(parsed.hostname))
    throw new Error(`yc: untrusted hostname "${parsed.hostname}"`);
  return url;
}

/**
 * Normalize a yc-oss company record into a funding lead. Returns null for
 * records without a usable name. Exported for tests.
 * @param {any} c
 * @returns {object|null}
 */
export function parseYcCompany(c) {
  if (!c || typeof c !== 'object') return null;
  const company = typeof c.name === 'string' ? c.name.trim() : '';
  if (!company) return null;
  return {
    company,
    source: 'yc',
    signal: `YC ${c.batch || ''}`.trim() + (c.one_liner ? ` — ${c.one_liner}` : ''),
    url: c.website || c.url || '',
    ycProfile: c.url || '',
    date: c.launched_at ? new Date(c.launched_at * 1000).toISOString().slice(0, 10) : '',
    location: typeof c.all_locations === 'string' ? c.all_locations : '',
    teamSize: Number.isFinite(c.team_size) ? c.team_size : null,
    industry: typeof c.industry === 'string' ? c.industry : '',
    batch: typeof c.batch === 'string' ? c.batch : '',
  };
}

export default {
  id: 'yc',
  label: 'Y Combinator (actively hiring)',

  async fetch(ctx, opts = {}) {
    assertYcUrl(HIRING_URL);
    // redirect:'error' blocks SSRF via server-side redirects.
    const data = await ctx.fetchJson(HIRING_URL, { redirect: 'error' });
    if (!Array.isArray(data)) {
      throw new Error(`yc: unexpected response — expected a JSON array, got ${data === null ? 'null' : typeof data}`);
    }

    const batch = opts.batch ? String(opts.batch).toLowerCase() : null;
    const minTeam = Number(opts.minTeam) || 0;

    let leads = [];
    for (const c of data) {
      const lead = parseYcCompany(c);
      if (!lead) continue;
      if (batch && lead.batch.toLowerCase() !== batch) continue;
      if (minTeam && (lead.teamSize == null || lead.teamSize < minTeam)) continue;
      leads.push(lead);
    }
    // Newest batches first when a launch date is available.
    leads.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return leads;
  },
};

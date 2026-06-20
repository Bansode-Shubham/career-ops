// Minimal RSS/Atom feed parser shared by funding sources.
// Files prefixed with _ are never loaded as sources by funding.mjs.
//
// Dependency-free: the project has no XML parser, and funding feeds (SEC Atom,
// TechCrunch RSS) are simple enough for tag-scoped extraction. This is NOT a
// general XML parser — it pulls the handful of fields the sources need.

/** Decode the XML entities that appear in feed text. */
export function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&'); // last — avoid double-decoding
}

/** Return the inner contents of every `<tag>...</tag>` block. */
export function extractBlocks(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(String(xml || ''))) !== null) out.push(m[1]);
  return out;
}

/** First `<tag>...</tag>` inner text inside a block, decoded + trimmed. */
export function tagText(block, tag) {
  const m = String(block || '').match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeXmlEntities(m[1]).trim() : '';
}

/** Read an attribute off a self-closing or open `<tag ... attr="...">`. */
export function tagAttr(block, tag, attr) {
  const m = String(block || '').match(new RegExp(`<${tag}\\b[^>]*\\b${attr}="([^"]*)"`, 'i'));
  return m ? decodeXmlEntities(m[1]).trim() : '';
}

/**
 * Parse an RSS or Atom feed into normalized entries. RSS uses <item> with a
 * text <link>; Atom uses <entry> with a <link href="...">. Returns
 * { title, link, summary, date } per entry.
 *
 * @param {string} xml
 * @returns {Array<{title:string, link:string, summary:string, date:string}>}
 */
export function parseFeed(xml) {
  const text = String(xml || '');
  const isAtom = /<entry[\s>]/i.test(text) && !/<item[\s>]/i.test(text);

  if (isAtom) {
    return extractBlocks(text, 'entry').map(block => ({
      title: tagText(block, 'title'),
      link: tagAttr(block, 'link', 'href') || tagText(block, 'id'),
      summary: tagText(block, 'summary') || tagText(block, 'content'),
      date: tagText(block, 'updated') || tagText(block, 'published'),
    }));
  }

  return extractBlocks(text, 'item').map(block => ({
    title: tagText(block, 'title'),
    link: tagText(block, 'link'),
    summary: tagText(block, 'description'),
    date: tagText(block, 'pubDate') || tagText(block, 'dc:date'),
  }));
}

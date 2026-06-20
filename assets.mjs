#!/usr/bin/env node
/**
 * assets.mjs — Reusable application assets the apply/outreach/cover steps pull
 * from: links (portfolio, GitHub, Play Store…), short/medium/long bios,
 * showcase projects, references, and availability.
 *
 * Data lives in config/assets.yml (User Layer, gitignored). Copy
 * config/assets.example.yml to start. Zero-token: pure YAML read.
 *
 * Reference CONTACTS are gated: each reference has `shareable: false` by
 * default and contact details must never be surfaced unless the user
 * explicitly approves AND `shareable: true` (see modes/_profile.md).
 *
 * Usage:
 *   node assets.mjs list                 # sections + keys present
 *   node assets.mjs get links.github     # one value by dotted path
 *   node assets.mjs get bios.short
 *   (add --json for machine-readable output)
 */
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const ASSETS_PATH = process.env.CAREER_OPS_ASSETS || join(ROOT, 'config/assets.yml');

/** Load and parse the assets file. Returns {} when missing/empty/malformed. */
export function loadAssets(path = ASSETS_PATH) {
  if (!existsSync(path)) return {};
  try {
    return yaml.load(readFileSync(path, 'utf-8')) || {};
  } catch {
    return {};
  }
}

/** Resolve a dotted path (e.g. "links.github", "projects.0.url") in an object. */
export function getAssetPath(obj, dotted) {
  if (!dotted) return undefined;
  let cur = obj;
  for (const key of String(dotted).split('.')) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) ? cur[Number(key)] : cur[key];
  }
  return cur;
}

/** Strip reference contact fields unless explicitly allowed. */
export function redactReferences(assets) {
  if (!assets || !Array.isArray(assets.references)) return assets;
  const references = assets.references.map(r => {
    if (r && r.shareable === true) return r;
    const { contact, ...rest } = r || {};
    return { ...rest, contact_withheld: Boolean(contact) };
  });
  return { ...assets, references };
}

function summarize(assets) {
  const out = {};
  for (const [section, val] of Object.entries(assets)) {
    if (Array.isArray(val)) out[section] = `${val.length} item(s)`;
    else if (val && typeof val === 'object') out[section] = Object.keys(val);
    else out[section] = val;
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const args = argv.filter(a => a !== '--json');
  const cmd = (args[0] || 'list').toLowerCase();
  const assets = loadAssets();

  if (!existsSync(ASSETS_PATH)) {
    const msg = { error: `no assets file at ${ASSETS_PATH} — copy config/assets.example.yml to config/assets.yml` };
    console.log(json ? JSON.stringify(msg) : `❌ ${msg.error}`);
    process.exit(1);
  }

  if (cmd === 'list') {
    const safe = redactReferences(assets);
    const summary = summarize(safe);
    if (json) { console.log(JSON.stringify(summary, null, 2)); return; }
    console.log('Assets library:');
    for (const [section, v] of Object.entries(summary)) {
      console.log(`  ${section}: ${Array.isArray(v) ? v.join(', ') : v}`);
    }
    return;
  }

  if (cmd === 'get') {
    const path = args[1];
    if (!path) { console.log(json ? JSON.stringify({ error: 'usage: get <dotted.path>' }) : 'usage: node assets.mjs get <dotted.path>'); process.exit(1); }
    if (/(^|\.)references(\.|$)/.test(path) && !/\.shareable$|\.name$|\.relationship$|\.blurb$/.test(path)) {
      // Block raw reads into reference contacts via the CLI.
      const val = getAssetPath(redactReferences(assets), path);
      console.log(json ? JSON.stringify({ path, value: val ?? null }) : (val == null ? '(not set / withheld)' : JSON.stringify(val)));
      return;
    }
    const val = getAssetPath(assets, path);
    if (json) { console.log(JSON.stringify({ path, value: val ?? null })); return; }
    console.log(val == null ? '(not set)' : (typeof val === 'string' ? val : JSON.stringify(val, null, 2)));
    return;
  }

  console.log('Usage: node assets.mjs list | get <dotted.path> [--json]');
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

/**
 * _killswitch.mjs — Global pause for all OUTWARD actions (sending + outreach).
 *
 * Scanning and evaluation are local/read-mostly and stay ON. This switch only
 * blocks things that leave the machine: requesting send-approval at the Discord
 * gate, resolving an approval into a send, and the funding/outreach lead path.
 * Enforced in code, never left to the LLM — same model as the blocklist.
 *
 * Paused if ANY of:
 *   - env CAREER_OPS_PAUSED is truthy (1/true/yes/on)
 *   - a sentinel file exists (data/.paused, or CAREER_OPS_PAUSE_FILE)
 *   - config/profile.yml → safety.paused: true
 *
 * Toggle with: node killswitch.mjs on|off|status [reason]
 *
 * The leading `_` keeps scan.mjs's provider loader from importing this.
 */
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const PAUSE_FILE = process.env.CAREER_OPS_PAUSE_FILE || join(ROOT, 'data/.paused');
const PROFILE_PATH = process.env.CAREER_OPS_PROFILE || join(ROOT, 'config/profile.yml');

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * @returns {{paused: boolean, source: 'env'|'file'|'profile'|null, reason: string}}
 */
export function isPaused() {
  const env = String(process.env.CAREER_OPS_PAUSED || '').trim().toLowerCase();
  if (TRUTHY.has(env)) return { paused: true, source: 'env', reason: 'CAREER_OPS_PAUSED' };

  if (existsSync(PAUSE_FILE)) {
    let reason = '';
    try { reason = readFileSync(PAUSE_FILE, 'utf-8').trim(); } catch { /* ignore */ }
    return { paused: true, source: 'file', reason: reason || PAUSE_FILE };
  }

  try {
    if (existsSync(PROFILE_PATH)) {
      const doc = yaml.load(readFileSync(PROFILE_PATH, 'utf-8'));
      if (doc?.safety?.paused === true) return { paused: true, source: 'profile', reason: 'safety.paused' };
    }
  } catch { /* ignore malformed profile */ }

  return { paused: false, source: null, reason: '' };
}

/** Write the sentinel file. Does not affect env/profile sources. */
export function pause(reason = '') {
  mkdirSync(dirname(PAUSE_FILE), { recursive: true });
  writeFileSync(PAUSE_FILE, `${reason || 'paused'}\n`);
  return PAUSE_FILE;
}

/** Remove the sentinel file. env/profile sources (if set) still pause. */
export function resume() {
  if (existsSync(PAUSE_FILE)) rmSync(PAUSE_FILE, { force: true });
  return PAUSE_FILE;
}

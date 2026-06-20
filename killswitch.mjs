#!/usr/bin/env node
/**
 * killswitch.mjs — Toggle the global pause for sending + outreach.
 *
 * Scanning and evaluation keep running while paused; only outward actions
 * (Discord send-approval, approval→send resolution, funding/outreach leads)
 * are blocked. See _killswitch.mjs for the enforcement points.
 *
 * Usage:
 *   node killswitch.mjs status            # show current state
 *   node killswitch.mjs on  [reason]      # pause (writes data/.paused)
 *   node killswitch.mjs off               # resume (removes data/.paused)
 */
import { isPaused, pause, resume, PAUSE_FILE } from './_killswitch.mjs';

const cmd = (process.argv[2] || 'status').toLowerCase();

if (cmd === 'on' || cmd === 'pause') {
  const reason = process.argv.slice(3).join(' ');
  pause(reason);
  console.log(`⏸  PAUSED — all sending + outreach blocked (scanning + evaluation stay on).`);
  console.log(`   sentinel: ${PAUSE_FILE}`);
  if (reason) console.log(`   reason:   ${reason}`);
} else if (cmd === 'off' || cmd === 'resume') {
  resume();
  const st = isPaused();
  if (st.paused) {
    console.log(`⚠️  Sentinel removed, but still PAUSED via ${st.source} (${st.reason}). Clear that source to fully resume.`);
    process.exit(1);
  }
  console.log('▶️  RESUMED — sending + outreach re-enabled.');
} else if (cmd === 'status') {
  const st = isPaused();
  console.log(st.paused
    ? `⏸  PAUSED (via ${st.source}: ${st.reason}) — sending + outreach blocked.`
    : '▶️  ACTIVE — sending + outreach enabled.');
} else {
  console.log('Usage: node killswitch.mjs status|on|off [reason]');
  process.exit(1);
}

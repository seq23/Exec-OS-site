#!/usr/bin/env node
/**
 * Run a validation profile, repair what is repairable, re-validate, and loop
 * until clean or the attempt budget runs out.
 *
 * The profile already front-loads repairs before the validators, which fixes
 * the common cases on the way through. What it could not do is react to a
 * validator that fails AFTER those repairs have run. This closes that loop.
 *
 * It reads artifacts/validation/profile-<name>.json, which now lists every
 * failing step rather than only the first, so one pass is enough to decide what
 * to repair.
 *
 * The pairing rule is narrow on purpose: a repair is declared only when it
 * writes the artifact the check reads. A repair that merely sounds related
 * would produce motion without fixing the defect, and make the loop look like
 * it had tried something.
 *
 * A loop cannot fix every class of failure, and pretending otherwise is worse
 * than stopping. When two subsystems disagree about what is correct - as when
 * the owner-uniqueness repair renamed a page's query and the agent-recommendation
 * contract still pinned the old one - re-running the repair reproduces the same
 * result forever. Those need a human to decide which side is right, so the loop
 * stops and says so instead of burning attempts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPAIRS } from './repairs.mjs';

const ROOT = process.cwd();
const PROFILE = process.argv.find((a) => a.startsWith('--profile='))?.split('=')[1] ?? 'container-prepush';
const MAX = Number(process.argv.find((a) => a.startsWith('--max='))?.split('=')[1] ?? 3);
const DRY = process.argv.includes('--dry-run');
const REPORT = path.join(ROOT, 'reports/validation/self-heal-loop.json');

// The map itself lives in ./repairs.mjs so a validator can read it WITHOUT
// running this loop. It used to be defined here, in a module that executes a
// full validation pass at import time, which is why nothing in the repository
// had ever checked whether a single registered repair still worked.
// validate:repair-fixture-capability now proves each one against a constructed
// failing state, off this tree, while its validator is green.

const run = (command) => spawnSync('sh', ['-c', command], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' }).status ?? 1;

const readFailures = () => {
  const p = path.join(ROOT, `artifacts/validation/profile-${PROFILE}.json`);
  if (!fs.existsSync(p)) return null;
  const receipt = JSON.parse(fs.readFileSync(p, 'utf8'));
  return (receipt.steps || []).filter((s) => s.exit_code !== 0).map((s) => s.id || s.command);
};

const attempts = [];
let failed = [];

for (let attempt = 0; attempt <= MAX; attempt += 1) {
  run(`npm run validate:profile -- ${PROFILE}`);
  failed = readFailures() ?? [];
  console.log(`self-heal: attempt ${attempt} - ${failed.length} failing step(s)${failed.length ? `: ${failed.join(', ')}` : ''}`);
  if (!failed.length || attempt === MAX) break;

  const actions = [];
  const alreadyRun = new Set();
  for (const step of failed) {
    const repair = REPAIRS[step];
    if (!repair) { actions.push({ step, action: 'no declared repair', ran: false }); continue; }
    if (alreadyRun.has(repair.command)) { actions.push({ step, action: repair.command, ran: false, skipped: 'already run this attempt' }); continue; }
    if (DRY) { actions.push({ step, action: repair.command, ran: false, skipped: 'dry-run' }); continue; }
    alreadyRun.add(repair.command);
    const code = run(repair.command);
    actions.push({ step, action: repair.command, ran: true, repair_exit: code, why: repair.why });
  }
  attempts.push({ attempt: attempt + 1, failed_before: failed, actions });
  if (!actions.some((a) => a.ran)) {
    console.log('self-heal: nothing repairable - these need a decision, not another attempt');
    break;
  }
}

fs.mkdirSync(path.dirname(REPORT), { recursive: true });
fs.writeFileSync(REPORT, `${JSON.stringify({
  schema_version: '1.0',
  generated_at: new Date().toISOString(),
  profile: PROFILE,
  mode: DRY ? 'dry-run' : 'repair',
  max_attempts: MAX,
  status: failed.length ? 'UNRESOLVED' : 'CLEAN',
  unresolved: failed,
  attempts,
}, null, 2)}\n`);

console.log(`self-heal: ${failed.length ? `UNRESOLVED (${failed.join(', ')})` : 'CLEAN'} - report at ${path.relative(ROOT, REPORT)}`);
process.exit(failed.length ? 1 : 0);

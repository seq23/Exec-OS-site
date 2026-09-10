#!/usr/bin/env node
/**
 * Negative proof for control-plane reachability and for the severity of an
 * unarmed admitted entry.
 *
 * THE DEFECT. validate:validation-registry decides whether an admitted matrix
 * entry actually runs by walking `npm run` tokens through package.json. On
 * 2026-09-03, 525c0be44 (PR #64) replaced `build:all`'s npm chain with
 * `bash scripts/build/cached_build_all.sh`, which execs `npm run
 * build:all:uncached`. The walker does not read shell scripts, so the entire
 * build chain left the reachability graph in one commit:
 *
 *   525c0be44^  unreachable=59  unclassified=0
 *   525c0be44   unreachable=65  unclassified=6   (MX-002 MX-004 MX-051
 *                                                 MX-061 MX-067 MX-076)
 *
 * All six still ran on every build. The control plane simply stopped being able
 * to see them, and reported six HARD_FAIL protections as wired to nothing.
 *
 * IT STAYED FOR FOUR DAYS BECAUSE NOTHING WENT RED. "In no profile with no
 * recorded reason" was a STRONG_WARNING, so the lane printed PASS. It is now an
 * error: validation:add already REFUSES to create that state at admission, and
 * refusing it at creation while merely noting it at validation is the gap.
 *
 * validate_validation_registry.mjs resolves everything from cwd, so each case
 * below builds a complete synthetic control plane and runs the REAL validator
 * against it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VALIDATOR = path.join(REPO, 'scripts/validation/validate_validation_registry.mjs');

const failures = [];
let casesRun = 0;

function check(name, ok, detail) {
  casesRun += 1;
  if (ok) { console.log(`  ok   ${name}`); return; }
  failures.push(`${name}: ${detail}`);
  console.log(`  FAIL ${name} -> ${detail}`);
}

const record = (id, command) => ({
  validation_id: id, status: 'ADMITTED', name: command.replace('npm run ', ''),
  check_type: 'validator', owning_lane: 'test', risk_prevented: 'fixture',
  existing_coverage_gap: 'fixture', scope: ['repository'], proposed_severity: 'HARD_FAIL',
  command, implementation_path: 'package.json', environment: 'container', proof_tier: 1,
  positive_fixture: null, negative_fixture: null, evidence_output: 'x', runtime_budget_seconds: 1,
  maintenance_owner: 'test', overlap_analysis: [], decision: 'fixture', decision_date: '2026-09-07',
  matrix_ids: [`MX-${id}`],
});
const entry = (id, command) => ({
  matrix_id: `MX-${id}`, validation_id: id, lane: 'test', command, order: 1,
  severity: 'HARD_FAIL', release_effect: true, status: 'ADMITTED',
});

/**
 * @param {object} o
 *  o.scripts      package.json scripts
 *  o.steps        container-prepush profile steps
 *  o.governed     [id, command] pairs admitted into registry + matrix
 *  o.shellFiles   relative path -> contents (a shell hop that exists)
 *  o.exclusions   profile_exclusions
 *  o.empty        'records' | 'entries' | 'profiles' - blank that arm out
 */
function makePlane(o) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-')));
  fs.mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: o.scripts || {} }, null, 2));
  for (const [rel, body] of Object.entries(o.shellFiles || {})) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  const governed = o.governed || [];
  fs.writeFileSync(path.join(dir, '_validation_registry.json'), JSON.stringify({
    record_count: governed.length,
    records: o.empty === 'records' ? [] : governed.map(([id, c]) => record(id, c)),
  }, null, 2));
  fs.writeFileSync(path.join(dir, '_repo_validation_matrix.json'), JSON.stringify({
    entry_count: governed.length,
    entries: o.empty === 'entries' ? [] : governed.map(([id, c]) => entry(id, c)),
    profiles: o.empty === 'profiles' ? {} : { 'container-prepush': { steps: o.steps || [] } },
    profile_exclusions: o.exclusions || {},
  }, null, 2));
  return dir;
}

const run = (dir) => spawnSync(process.execPath, [VALIDATOR], { cwd: dir, encoding: 'utf8' });
const out = (r) => `exit=${r.status} :: ${((r.stdout || '') + (r.stderr || '')).slice(0, 400)}`;

console.log('[self-test:control-plane-reachability] restoring the broken state and checking the failure returns');

// The build:all shape, reduced: a profile step whose only route to the governed
// command runs through a shell script.
const buildAllShape = {
  scripts: {
    'validate:entry': 'bash scripts/fixture/cached.sh',
    'validate:inner': 'node scripts/fixture/inner.mjs',
  },
  shellFiles: { 'scripts/fixture/cached.sh': '#!/usr/bin/env bash\nexec npm run validate:inner\n' },
  steps: [{ id: 'VAL-ENTRY', command: 'npm run validate:entry' }],
  governed: [['VAL-ENTRY', 'npm run validate:entry'], ['VAL-INNER', 'npm run validate:inner']],
};

// 1. THE DEFECT. Reachable only through `bash <script>` must count as reachable.
{
  const dir = makePlane(buildAllShape);
  const r = run(dir);
  check('a command reachable only through a bash hop counts as armed',
    r.status === 0 && !/in no profile with no recorded reason/.test((r.stdout || '') + (r.stderr || '')), out(r));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2. A hop the walker cannot read truncates the graph. Say so, do not shrug.
{
  const dir = makePlane({ ...buildAllShape, shellFiles: {} });
  const r = run(dir);
  check('a bash hop that is not a readable file -> FAIL naming the hop',
    r.status === 1 && /not a readable file/.test((r.stdout || '') + (r.stderr || '')), out(r));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 3. An admitted HARD_FAIL entry wired to nothing is an ERROR, not a warning.
{
  const dir = makePlane({
    scripts: { 'validate:entry': 'node a.mjs', 'validate:orphan': 'node b.mjs' },
    steps: [{ id: 'VAL-ENTRY', command: 'npm run validate:entry' }],
    governed: [['VAL-ENTRY', 'npm run validate:entry'], ['VAL-ORPHAN', 'npm run validate:orphan']],
  });
  const r = run(dir);
  check('an admitted entry in no profile with no reason -> FAIL, not PASS_WITH_STRONG_WARNING',
    r.status === 1 && /in no profile with no recorded reason/.test((r.stdout || '') + (r.stderr || '')), out(r));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 4. ...but a recorded reason is a legitimate, deliberate exclusion. The rule
//    forces a decision, it does not force arming.
{
  const dir = makePlane({
    scripts: { 'validate:entry': 'node a.mjs', 'validate:orphan': 'node b.mjs' },
    steps: [{ id: 'VAL-ENTRY', command: 'npm run validate:entry' }],
    governed: [['VAL-ENTRY', 'npm run validate:entry'], ['VAL-ORPHAN', 'npm run validate:orphan']],
    exclusions: { 'MX-VAL-ORPHAN': 'Post-deploy audit; needs a live deployment.' },
  });
  const r = run(dir);
  check('the same entry with a recorded exclusion reason -> not an error',
    r.status === 0, out(r));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 5-7. Zero items must hard-fail. Each arm of the control plane can empty on its
//      own, and any one of them makes every result below it vacuous.
for (const [arm, label] of [['records', 'registry records'], ['entries', 'matrix entries'], ['profiles', 'profiles']]) {
  const dir = makePlane({ ...buildAllShape, empty: arm });
  const r = run(dir);
  check(`zero ${label} -> FAIL rather than "control plane safe"`,
    r.status === 1, out(r));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 8. The ratchet, against the real repository: no admitted entry may be wired to
//    nothing without a recorded reason. This is what regressed on 525c0be44.
{
  const r = spawnSync(process.execPath, [VALIDATOR], { cwd: REPO, encoding: 'utf8' });
  check('this repository\'s own control plane has no unarmed, unexplained entry',
    r.status === 0 && !/in no profile with no recorded reason/.test((r.stdout || '') + (r.stderr || '')),
    out(r));
}

// Rule 0.
if (casesRun === 0) {
  console.error('[self-test:control-plane-reachability] FAIL: no case ran; a self-test that tests nothing passes nothing');
  process.exit(1);
}
if (failures.length) {
  console.error(`[self-test:control-plane-reachability] FAIL: ${failures.length} of ${casesRun} case(s)`);
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`[self-test:control-plane-reachability] PASS: ${casesRun} case(s); reachability follows shell hops, an unreadable hop is reported, and an admitted entry wired to nothing fails rather than warns.`);

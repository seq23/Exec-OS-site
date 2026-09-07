#!/usr/bin/env node
/**
 * Negative proof for the extraction-surface guard's baseline provenance.
 *
 * The defect: `snapshot` and `check` run adjacent, in that order, pinned into
 * the ordered build job precisely so the check never compares against a file
 * its own run produced. That pinning covers drift. It did NOT cover absence.
 * With the committed baseline missing, `snapshot` wrote a fresh one and exited
 * 0, and `check` then compared the tree to the file written seconds earlier and
 * printed PASS - the "grades its own answer sheet" failure, back through the
 * bootstrap door. Reproduced on main at 51117429c:
 *
 *   rm artifacts/validation/extraction-surface-snapshot.json
 *   -> snapshot exit 0 ("snapshot 2233 governed surfaces")
 *   -> check    exit 0 ("PASS")
 *
 * 2,233 governed surfaces, every HARD_FAIL step green, nothing asserted. The
 * registry record for VAL-EXTRACTION-SURFACE-GUARD-SNAPSHOT already states this
 * risk in prose - "without the snapshot the check below has no baseline and
 * silently passes" - so the control plane knew and the code did not enforce it.
 *
 * extraction_surface_guard.py takes ROOT from cwd, so every case below builds a
 * complete synthetic repository and runs the REAL script against it. Nothing
 * here is a mock of the thing under test.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { managedPython } from './python_runtime.mjs';
// The fixture page carries a real CITATION_PAGE_SCHEMA block, because that block
// is half of what the guard hashes. It is emitted through the schema authority
// rather than hand-built here - VAL-CITATION-SCHEMA-AUTHORITY caught the
// hand-built version of this file on its first profile run, correctly.
import schemaAuthority from '../lib/citation_page_schema.cjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(REPO, 'scripts/validation/extraction_surface_guard.py');
const SNAP = 'artifacts/validation/extraction-surface-snapshot.json';
const PY = managedPython();

const failures = [];
let casesRun = 0;

function check(name, ok, detail) {
  casesRun += 1;
  if (ok) { console.log(`  ok   ${name}`); return; }
  failures.push(`${name}: ${detail}`);
  console.log(`  FAIL ${name} -> ${detail}`);
}

const page = (body) =>
  `<html><body><div data-llm-answer="true" data-extraction-type="definition" data-named-framework="spry">${body}</div>` +
  schemaAuthority.renderSchemaScript({ '@context': 'https://schema.org', '@type': 'FAQPage', name: body }) +
  '</body></html>';

/** A synthetic repo with one governed page. `pages:false` empties the governed
 *  set, to prove the guard refuses rather than hashing nothing. */
function makeRepo({ git = true, pages = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'extraction-baseline-')));
  fs.mkdirSync(path.join(dir, 'data/citation'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data/content'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'artifacts/validation'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'page.html'), page('original answer'));
  fs.writeFileSync(path.join(dir, 'data/citation/citable_pages.json'), JSON.stringify({
    pages: pages ? [{
      path: 'page.html', canonical_url: 'https://example.test/page.html', query: 'q',
      framework: 'spry', extraction_type: 'definition', schema_type: 'FAQPage', status: 'ADMITTED',
    }] : [],
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'data/citation/query_registry.json'), JSON.stringify({
    queries: [{
      query_id: 'Q1', query: 'q', intent_class: 'informational', primary_page: 'page.html',
      canonical_domain: 'example.test', release_status: 'LIVE', aliases: [],
    }],
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'data/content/page_admission_registry.json'), JSON.stringify({
    records: [{
      path: 'page.html', canonical_domain: 'example.test', generation_lane: 'test',
      admission_level: 'ADMITTED', status: 'ADMITTED', primary_query: 'q',
      intent: 'informational', framework: 'spry', artifact_type: 'answer',
    }],
  }, null, 2));
  if (git) {
    const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'self-test@example.test');
    g('config', 'user.name', 'self test');
    g('add', '-A');
    g('commit', '-qm', 'fixture');
  }
  return dir;
}

const guard = (dir, mode, env = {}) => spawnSync(PY, [SCRIPT, mode], {
  cwd: dir, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ...env },
});
const commitAll = (dir, msg) => {
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-qm', msg], { cwd: dir });
};
const out = (r) => `exit=${r.status} :: ${((r.stdout || '') + (r.stderr || '')).slice(0, 300)}`;

console.log('[self-test:extraction-surface-baseline-presence] restoring the broken state and checking the failure returns');

// 1. A baseline that has genuinely never existed is a real bootstrap.
{
  const dir = makeRepo();
  const r = guard(dir, 'snapshot');
  check('no baseline has ever existed -> bootstrap, exit 0',
    r.status === 0 && /has never existed in this repository/.test(r.stdout || ''), out(r));
  check('...and the baseline is actually written (no silent no-op)',
    fs.existsSync(path.join(dir, SNAP)), 'snapshot file absent after a passing bootstrap');
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2. THE DEFECT. A committed baseline removed from the working tree must not be
//    re-bootstrapped: that is a rebaseline of every governed surface by `rm`.
{
  const dir = makeRepo();
  guard(dir, 'snapshot');
  commitAll(dir, 'baseline');
  fs.rmSync(path.join(dir, SNAP));
  const r = guard(dir, 'snapshot');
  check('committed baseline deleted from the worktree -> snapshot FAILS',
    r.status === 1 && /is a removal|has carried it/.test((r.stderr || '') + (r.stdout || '')), out(r));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 3. The same removal, committed. `git rm` must not launder it past the guard.
{
  const dir = makeRepo();
  guard(dir, 'snapshot');
  commitAll(dir, 'baseline');
  spawnSync('git', ['rm', '-q', SNAP], { cwd: dir });
  spawnSync('git', ['commit', '-qm', 'drop the baseline'], { cwd: dir });
  const r = guard(dir, 'snapshot');
  check('committed DELETION of the baseline -> snapshot FAILS',
    r.status === 1, out(r));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 4. And `check` reports the missing baseline as itself, rather than naming
//    every innocent surface as changed.
{
  const dir = makeRepo();
  guard(dir, 'snapshot');
  commitAll(dir, 'baseline');
  fs.rmSync(path.join(dir, SNAP));
  const r = guard(dir, 'check');
  check('check with no baseline -> FAILS naming the baseline, not the pages',
    r.status === 1 && /does not exist, so there is no baseline/.test(r.stderr || ''), out(r));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 5. Deletion is not a back door to rebaselining, even with the human flag.
{
  const dir = makeRepo();
  guard(dir, 'snapshot');
  commitAll(dir, 'baseline');
  fs.rmSync(path.join(dir, SNAP));
  const r = guard(dir, 'snapshot', { EXTRACTION_SURFACE_REBASELINE: '1' });
  check('deleted baseline + EXTRACTION_SURFACE_REBASELINE=1 -> still FAILS',
    r.status === 1, out(r));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 6/7. The behaviour this change must not disturb: drift still refuses, and a
//      reviewed human rebaseline still works.
{
  const dir = makeRepo();
  guard(dir, 'snapshot');
  commitAll(dir, 'baseline');
  fs.writeFileSync(path.join(dir, 'page.html'), page('rewritten answer'));
  const r = guard(dir, 'snapshot');
  check('drift against a present baseline -> snapshot still FAILS',
    r.status === 1 && /governed surface\(s\) differ/.test(r.stdout || ''), out(r));
  const r2 = guard(dir, 'snapshot', { EXTRACTION_SURFACE_REBASELINE: '1' });
  check('drift + EXTRACTION_SURFACE_REBASELINE=1 -> reviewed rebaseline still allowed',
    r2.status === 0, out(r2));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 8. A clean tree passes both modes, so the guard is not merely always-red.
{
  const dir = makeRepo();
  guard(dir, 'snapshot');
  commitAll(dir, 'baseline');
  const r = guard(dir, 'snapshot');
  const r2 = guard(dir, 'check');
  check('unchanged tree -> snapshot and check both PASS',
    r.status === 0 && r2.status === 0, `${out(r)} | ${out(r2)}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 9. Zero items must hard-fail, not pass on an empty loop.
{
  const dir = makeRepo({ pages: false });
  const r = guard(dir, 'snapshot');
  check('zero governed pages -> FAILS rather than snapshotting an empty set',
    r.status === 1 && /lists no pages/.test(r.stderr || ''), out(r));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 10. Outside a git worktree provenance cannot be established. That is a NAMED
//     STOP - green, loud, and it still does the work - not a silent pass.
{
  const dir = makeRepo({ git: false });
  const r = guard(dir, 'snapshot');
  check('no git worktree -> NAMED STOP, exit 0, baseline written',
    r.status === 0 && /NAMED STOP no-baseline-provenance/.test(r.stdout || '')
      && fs.existsSync(path.join(dir, SNAP)), out(r));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 11. The override is a human decision. No lane may make it for them.
{
  const offenders = [];
  const wf = path.join(REPO, '.github/workflows');
  for (const f of fs.existsSync(wf) ? fs.readdirSync(wf) : []) {
    const t = fs.readFileSync(path.join(wf, f), 'utf8');
    if (/EXTRACTION_SURFACE_REBASELINE\s*[:=]\s*['"]?1/.test(t)) offenders.push(`.github/workflows/${f}`);
  }
  if (/EXTRACTION_SURFACE_REBASELINE=1/.test(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))) {
    offenders.push('package.json');
  }
  check('no workflow or npm script sets EXTRACTION_SURFACE_REBASELINE',
    offenders.length === 0, `set by: ${offenders.join(', ')}`);
}

// 12. The baseline this repository actually ships must be present and tracked,
//     or every case above is theatre on temp directories.
{
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', SNAP], { cwd: REPO, encoding: 'utf8' });
  check('the repository\'s own extraction-surface baseline is committed',
    tracked.status === 0 && fs.existsSync(path.join(REPO, SNAP)),
    `git ls-files exit=${tracked.status}`);
}

// Rule 0.
if (casesRun === 0) {
  console.error('[self-test:extraction-surface-baseline-presence] FAIL: no case ran; a self-test that tests nothing passes nothing');
  process.exit(1);
}
if (failures.length) {
  console.error(`[self-test:extraction-surface-baseline-presence] FAIL: ${failures.length} of ${casesRun} case(s)`);
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`[self-test:extraction-surface-baseline-presence] PASS: ${casesRun} case(s); a removed baseline can no longer re-bootstrap itself into a green run, and drift refusal and reviewed rebaselining are unchanged.`);

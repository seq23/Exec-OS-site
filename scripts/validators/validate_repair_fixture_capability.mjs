#!/usr/bin/env node
/**
 * VAL-REPAIR-FIXTURE-CAPABILITY
 *
 * A registered repair must CLEAR a constructed failing state - proven while its
 * validator is GREEN.
 *
 * scripts/selfheal/heal_until_clean.mjs registers a repair for ten validation
 * steps. Before this file, NOTHING in this repository examined any of them.
 * The map was not merely unchecked, it was unreachable: it was defined inside a
 * module that runs a full validation loop at import time, so no validator could
 * read it without running self-heal. Two narrow reachability checks existed -
 * VAL-CITATION-REPAIR-REACH and validate:health-boundary-reach - and each covers
 * exactly one repair, statically, by asking whether the repair's mutation scope
 * can touch the pages its validator judges. Neither runs a repair. Neither knows
 * the map exists.
 *
 * The failure mode this closes, observed for eleven days in the sibling repo
 * local-guides-citation-velocity: a repair whose validator is GREEN is never
 * exercised by anything, so its capability can be removed without a single check
 * noticing - until the day production needs it, at which point self-heal runs
 * the repair, the repair exits 0 having changed nothing relevant, the loop burns
 * its attempts, and the release lane deadlocks with a growing backlog behind it.
 * A green tree is not evidence: it means nothing has drifted YET.
 *
 * What this asserts, per registered pairing:
 *   1. Every step id in REPAIRS is either behaviourally fixtured here or carries
 *      a written reason for why it cannot be. A new pairing with neither fails.
 *      That is the property that keeps "uncovered" from becoming the status quo.
 *   2. For each fixture: a genuinely failing state is constructed in a scratch
 *      git worktree, the REGISTERED repair command is run there, and the
 *      REGISTERED validator command must go FAIL -> PASS.
 *   3. Both commands are read from repository data - the repair from
 *      scripts/selfheal/repairs.mjs, the validator from the profile steps in
 *      _repo_validation_matrix.json - never hardcoded here. Re-point a repair at
 *      a command that cannot fix its validator and this test runs THAT command
 *      and goes red naming the pairing.
 *   4. FIXTURE_FLOOR is a grow-only ratchet, so a fixture cannot be quietly
 *      deleted.
 *   5. The production tree is byte-identical before and after. Every induction
 *      happens in a throwaway worktree; `git status --porcelain` is compared
 *      across the run and a difference is a hard failure. A guard that leaves
 *      the repo dirty is worse than no guard.
 *
 * Rule 0: examining zero repairs is a FAILURE, not a pass. An empty or
 * unreadable REPAIRS map means the machinery is gone, not that it is healthy.
 *
 * Usage: npm run validate:repair-fixture-capability
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { REPAIRS } from '../selfheal/repairs.mjs';

// The citation-contract fixture removes a page's CITATION_PAGE_SCHEMA block, so
// it needs the pattern that finds one. That pattern has exactly one owner. A
// hand-rolled copy here would be a second definition of the governed block's
// shape living in a file nobody would think to update, which is the drift
// validate:citation-schema-authority exists to stop - and it caught this file on
// its first CI run for precisely that.
const { SCHEMA_SCRIPT_RE } = createRequire(import.meta.url)('../lib/citation_page_schema.cjs');

const ROOT = process.cwd();
const MATRIX_REL = '_repo_validation_matrix.json';
const OUT_REL = 'artifacts/validation/repair-fixture-capability.json';

/**
 * Grow-only floor for behavioural coverage. Raise it when you add a fixture.
 * Never lower it: a repair once proven capable must stay proven capable.
 */
const FIXTURE_FLOOR = 9;

/* ------------------------------------------------------------------ *
 * Behavioural fixtures.
 *
 * Each supplies ONLY break(scratch): mutate the scratch tree into a state its
 * validator genuinely fails on, and return a one-line description of the fault.
 * The validator and repair commands are resolved from repository data, so a
 * fixture cannot drift into proving something about a command the machine does
 * not actually run.
 *
 * Every fault below is a real failure mode of this site, not a convenient one.
 * ------------------------------------------------------------------ */
const FIXTURES = {
  'VAL-VISIBLE-CONTENT-ARTIFACTS': {
    // The literal artifact the checker looks for: an unrendered agent
    // recommendation that reached page-visible HTML as the string "n/a".
    break(scratch) {
      const rel = 'arbitration-engine.html';
      const abs = path.join(scratch, rel);
      const html = fs.readFileSync(abs, 'utf8');
      const marker = '<h3>What this page should clarify</h3><p>n/a</p>';
      write(abs, html.replace('</body>', `${marker}</body>`));
      return `${rel} carries a page-visible "n/a" agent recommendation`;
    },
  },

  'VAL-QUERY-OWNER-UNIQUENESS': {
    // Two ACTIVE rows claiming the same normalized query for different pages.
    // This is what an absorbed agent run produces when it proposes a page for a
    // query an existing page already owns.
    break(scratch) {
      const rel = 'data/citation/query_registry.json';
      const abs = path.join(scratch, rel);
      const data = readJson(abs);
      const active = (data.queries || []).filter((q) => q && q.release_status === 'ACTIVE' && q.query && q.primary_page);
      if (active.length < 2) throw new Error(`${rel} has fewer than two ACTIVE query rows; the fixture cannot construct a duplicate owner`);
      const loser = { ...active[1], query: active[0].query, query_id: 'FIXTURE-DUPLICATE-OWNER' };
      data.queries.push(loser);
      writeJson(abs, data);
      return `${JSON.stringify(active[0].query)} is claimed by both ${active[0].primary_page} and ${loser.primary_page}`;
    },
  },

  'validate:programmatic-registry': {
    // A non-ADMITTED row for a page no ACTIVE query owns, plus the stale
    // record_count a partial write leaves behind. The owner repair prunes the
    // first and recomputes the second.
    break(scratch) {
      const rel = 'data/content/page_admission_registry.json';
      const abs = path.join(scratch, rel);
      const data = readJson(abs);
      if (!data.records?.length) throw new Error(`${rel} has no records; the fixture cannot construct an unadmitted row`);
      data.records.push({
        ...data.records[0],
        path: 'fixture-unadmitted-registry-row.html',
        route: '/fixture-unadmitted-registry-row',
        status: 'DRAFT',
        primary_query: 'fixture unadmitted registry row',
      });
      data.record_count = data.records.length - 1;
      writeJson(abs, data);
      return `${rel} carries a DRAFT row no ACTIVE query owns, and a stale record_count`;
    },
  },

  'validate:citation-contract': {
    // The exact production defect from run 33259007622: an ACTIVE citable page
    // loses its CITATION_PAGE_SCHEMA block. The repair chain has to widen its
    // mutation scope to reach the page before it can restore the schema, which
    // is the half that silently went inert once before.
    break(scratch) {
      const { rel, abs, html } = firstCitablePageWith(scratch, 'CITATION_PAGE_SCHEMA');
      const stripped = html.replace(SCHEMA_SCRIPT_RE, '');
      if (stripped === html) throw new Error(`${rel} matched on the marker but not on the authority's block pattern; the fixture could not construct the fault`);
      write(abs, stripped);
      return `${rel} lost its CITATION_PAGE_SCHEMA block`;
    },
  },

  'validate:ui-test-parity': {
    // The parity manifest and the citable registry disagree on how many public
    // routes exist. repair_ui_test_parity.py rebuilds the manifest from the
    // registry; the browser suite reads the manifest, so drift here fails the
    // real-browser proof rather than anything nearer the cause.
    break(scratch) {
      const rel = 'data/routes/public_route_manifest.json';
      const abs = path.join(scratch, rel);
      const data = readJson(abs);
      if (!data.routes?.length) throw new Error(`${rel} lists no routes; the fixture cannot drop one`);
      const dropped = data.routes.splice(5, 1)[0];
      writeJson(abs, data);
      return `${rel} is missing the route for ${dropped.source_file}`;
    },
  },

  'validate:sitemap-coverage': {
    // An ACTIVE page's canonical URL is absent from its own host's sitemap. The
    // sitemaps are generated, never hand-edited, so the repair is a rebuild.
    break(scratch) {
      const page = activeCitablePages(scratch).find((p) => String(p.canonical_domain || '').includes('billionairehighperformancecoach'));
      if (!page) throw new Error('no ACTIVE citable page on the BHPC host; the fixture cannot drop a sitemap entry');
      const rel = 'sitemap-bhpc.xml';
      const abs = path.join(scratch, rel);
      const xml = fs.readFileSync(abs, 'utf8');
      const next = xml.replace(new RegExp(`<url>\\s*<loc>${escapeRe(page.canonical_url)}</loc>[\\s\\S]*?</url>\\s*`), '');
      if (next === xml) throw new Error(`${rel} did not contain ${page.canonical_url}; the fixture could not construct the fault`);
      write(abs, next);
      return `${rel} is missing ${page.canonical_url}`;
    },
  },

  'validate:llms-full-coverage': {
    // Same class on the answer-engine surface: an ACTIVE page's URL falls out of
    // llms-full.txt, so an assistant reading the index cannot see the page.
    break(scratch) {
      const page = activeCitablePages(scratch)[0];
      if (!page) throw new Error('no ACTIVE citable page; the fixture cannot drop an llms-full entry');
      const rel = 'llms-full.txt';
      const abs = path.join(scratch, rel);
      const lines = fs.readFileSync(abs, 'utf8').split('\n');
      const kept = lines.filter((line) => !line.includes(page.canonical_url));
      if (kept.length === lines.length) throw new Error(`${rel} did not contain ${page.canonical_url}; the fixture could not construct the fault`);
      write(abs, kept.join('\n'));
      return `${rel} is missing ${page.canonical_url}`;
    },
  },

  'VAL-FULL-PAGE-AUDIT': {
    // A page loses the data-bhpc-agent-record marker the acceptance manifest
    // requires. This is the documented case behind the pairing: "a page carrying
    // 24 such failures went to 0 after one apply".
    break(scratch) { return stripAgentRecordMarker(scratch); },
  },

  'VAL-BHPC-PAGE-SEO': {
    // Same fault, incremental mode - the pairing claims the same writer, so it
    // has to be proven against the same loss.
    break(scratch) { return stripAgentRecordMarker(scratch); },
  },
};

/* ------------------------------------------------------------------ *
 * Declared exemptions. A pairing may be uncovered ONLY with a reason, and the
 * reason has to say what was actually tried. Anything else fails as undeclared.
 * ------------------------------------------------------------------ */
const UNFIXTURABLE = {
  'VAL-EXTRACTION-SURFACE-GUARD-CHECK':
    'CONFIRMED not clearable by its registered repair for the two faithful drift classes tried, and left declared rather than unpaired because a third class may exist. '
    + 'extraction_surface_guard.py check hashes every governed extraction block and citation schema and compares them to artifacts/validation/extraction-surface-snapshot.json, '
    + 'a HUMAN-REVIEWED baseline that no repair in this repository reads or writes; snapshot mode deliberately refuses to re-baseline drift on its own. '
    + 'Measured 2026-09-09 in a scratch worktree: (a) stripping a page CITATION_PAGE_SCHEMA fails check, and repair:extraction-final-state rebuilds a semantically equivalent but structurally different block (WebPage+Article split, reordered @graph), so check still fails; '
    + '(b) drifting a block data-extraction-type away from the registry fails check, and the repair leaves the attribute untouched. '
    + 'The repair is idempotent against the guard on a clean tree (55 files written, check still PASS), so it does not manufacture drift - it simply cannot reverse it. '
    + 'Clearing genuine drift is a review decision, not a repair.',
};

/* ------------------------------------------------------------------ *
 * Fixture helpers. Shared by more than one fixture, or long enough to hide the
 * intent of the break() they belong to.
 * ------------------------------------------------------------------ */
function write(abs, value) { fs.writeFileSync(abs, value, 'utf8'); }
function readJson(abs) { return JSON.parse(fs.readFileSync(abs, 'utf8')); }
function writeJson(abs, value) { fs.writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function escapeRe(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function activeCitablePages(scratch) {
  const pages = readJson(path.join(scratch, 'data/citation/citable_pages.json')).pages || [];
  return pages.filter((p) => p && p.status === 'ACTIVE' && p.path && p.canonical_url);
}

function firstCitablePageWith(scratch, needle) {
  for (const page of activeCitablePages(scratch)) {
    const abs = path.join(scratch, page.path);
    if (!fs.existsSync(abs)) continue;
    const html = fs.readFileSync(abs, 'utf8');
    if (html.includes(needle)) return { rel: page.path, abs, html };
  }
  throw new Error(`no ACTIVE citable page on disk contains ${needle}; the fixture could not construct the fault`);
}

/**
 * Remove every occurrence of one acceptance record marker from the page that
 * owns it. "Every" matters: the contract asks `html.includes(marker)`, so
 * blanking one of three copies leaves the check passing and would have made this
 * fixture prove nothing.
 */
function stripAgentRecordMarker(scratch) {
  const plan = readJson(path.join(scratch, 'artifacts/validation/agent-exact-implementation-plan.json'));
  const specs = (plan.specs || []).filter((s) => s.status !== 'BLOCKED' && s.implementation_path);
  const activeIds = new Set(specs.flatMap((s) => s.acceptance_ids || []).map(String));
  const activePaths = new Set(specs.map((s) => String(s.implementation_path).replace(/^\/+/, '')));
  const manifest = readJson(path.join(scratch, 'data/report_fixes/agent_acceptance_manifest.generated.json'));
  for (const entry of manifest.entries || []) {
    const rel = String(entry.implementation_path || '').replace(/^\/+/, '');
    const recordId = String(entry.record_id || entry.id || '');
    // Both gates matter: the contract only judges pages the CURRENT plan calls
    // active, and incremental mode only reads those pages at all.
    if (!rel || entry.acceptance_status === 'NO_ACTION' || !activeIds.has(recordId) || !activePaths.has(rel)) continue;
    const abs = path.join(scratch, rel);
    if (!fs.existsSync(abs)) continue;
    const html = fs.readFileSync(abs, 'utf8');
    const marker = `data-bhpc-agent-record="${recordId}"`;
    if (!html.includes(marker)) continue;
    write(abs, html.split(marker).join('data-bhpc-agent-record="FIXTURE-STRIPPED"'));
    return `${rel} lost the acceptance record marker for ${recordId}`;
  }
  throw new Error('no active acceptance record marker found on disk; the fixture could not construct the fault');
}

/* ------------------------------------------------------------------ *
 * Harness.
 * ------------------------------------------------------------------ */
const errors = [];
const examined = [];

function sh(command, cwd) {
  const result = spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: result.status === null ? 1 : result.status, out: `${result.stdout || ''}${result.stderr || ''}` };
}

function lastLine(out) { return String(out).trim().split('\n').filter(Boolean).pop() || '(no output)'; }

/** The validator command the PROFILE actually runs for this step id. */
function validatorCommandFor(stepId, matrix) {
  const found = new Set();
  for (const profile of Object.values(matrix.profiles || {})) {
    for (const step of profile.steps || []) if (step.id === stepId && step.command) found.add(step.command);
  }
  for (const entry of matrix.entries || []) {
    if ((entry.validation_id === stepId || entry.matrix_id === stepId) && entry.command) found.add(entry.command);
  }
  if (found.size !== 1) return { command: null, why: found.size ? `resolves to ${found.size} different commands: ${[...found].join(' | ')}` : 'appears in no profile step and no matrix entry' };
  return { command: [...found][0], why: null };
}

function porcelain(cwd) {
  return sh('git status --porcelain', cwd).out;
}

function makeWorktree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-fixture-'));
  const scratch = path.join(dir, 'tree');
  const add = sh(`git worktree add --detach ${JSON.stringify(scratch)} HEAD`, ROOT);
  if (add.code !== 0) throw new Error(`could not create a scratch git worktree, so no repair could be exercised off the production tree: ${lastLine(add.out)}`);
  // Dependencies are shared, never copied: `npm ci` per fixture would dominate
  // the runtime and prove nothing extra. The symlink is read-only in practice -
  // no repair writes into node_modules.
  const deps = path.join(ROOT, 'node_modules');
  if (fs.existsSync(deps)) fs.symlinkSync(deps, path.join(scratch, 'node_modules'), 'dir');
  return { dir, scratch };
}

function resetWorktree(scratch) {
  const reset = sh('git checkout -- . && git clean -fdq -e node_modules', scratch);
  if (reset.code !== 0) throw new Error(`could not restore the scratch worktree between fixtures: ${lastLine(reset.out)}`);
}

function runFixture(stepId, fixture, repairCommand, validateCommand, scratch) {
  resetWorktree(scratch);

  const baseline = sh(validateCommand, scratch);
  if (baseline.code !== 0) {
    errors.push(`validator_already_failing:${stepId} - \`${validateCommand}\` fails on the untouched tree, so a repair cannot be proven capable against a constructed fault here. Fix the tree first. Output: ${lastLine(baseline.out)}`);
    return false;
  }

  let what;
  try { what = fixture.break(scratch); } catch (error) {
    errors.push(`fixture_could_not_break:${stepId} - the fixture failed to construct its failing state (${error.message}). A fixture that no longer matches the repository proves nothing, so this is a failure, not a skip.`);
    return false;
  }

  const before = sh(validateCommand, scratch);
  if (before.code === 0) {
    errors.push(`fixture_does_not_fail:${stepId} - the fixture (${what}) was expected to make \`${validateCommand}\` fail, and it passed. A repair proven against a state that was never broken proves nothing; the fixture has drifted from the real failure mode.`);
    return false;
  }

  const repair = sh(repairCommand, scratch);
  if (repair.code !== 0) {
    errors.push(`repair_refuses_its_own_case:${stepId} - fixture (${what}) makes the validator fail, and the registered repair \`${repairCommand}\` then exited ${repair.code} instead of repairing it. Self-heal cannot converge on this: the repair is registered for a condition it will not act on. Output: ${lastLine(repair.out)}`);
    return false;
  }

  const after = sh(validateCommand, scratch);
  if (after.code !== 0) {
    errors.push(`repair_does_not_clear:${stepId} - fixture (${what}); \`${repairCommand}\` exited 0 but \`${validateCommand}\` still fails afterwards. This is the deadlock shape: self-heal will run this repair to its attempt budget and never converge. Output: ${lastLine(after.out)}`);
    return false;
  }

  examined.push({ id: stepId, repair_command: repairCommand, validate_command: validateCommand, fault: what, behavioural: 'PASS' });
  return true;
}

function main() {
  const matrixPath = path.join(ROOT, MATRIX_REL);
  if (!fs.existsSync(matrixPath)) {
    console.error(`[validate:repair-fixture-capability] FAIL: ${MATRIX_REL} does not exist, so no registered validator command could be resolved and this test examined zero repairs. Repair capability is UNKNOWN, not proven.`);
    process.exit(1);
  }
  const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));

  const stepIds = Object.keys(REPAIRS || {});
  // Rule 0: an empty input set is a failure, never a pass. An emptied or
  // unreadable REPAIRS map means the self-heal machinery is gone.
  if (!stepIds.length) {
    console.error('[validate:repair-fixture-capability] FAIL: scripts/selfheal/repairs.mjs declares zero repairs, so this test examined nothing. Either the map is not being read or every repair was removed; both are failures, not a clean run.');
    process.exit(1);
  }

  // Drift, both directions. A fixture or exemption for a pairing that no longer
  // exists is dead weight that hides how much is really covered.
  for (const id of [...Object.keys(FIXTURES), ...Object.keys(UNFIXTURABLE)]) {
    if (!stepIds.includes(id)) errors.push(`stale_declaration:${id} - this file declares a fixture or an exemption for a step that is no longer in the REPAIRS map. Remove it, or restore the pairing.`);
  }
  for (const id of stepIds) {
    if (!FIXTURES[id] && !UNFIXTURABLE[id]) {
      errors.push(`undeclared_repair:${id} -> \`${REPAIRS[id].command}\` is registered for self-heal but has neither a behavioural fixture nor a written reason for why one cannot be built. An unexercised repair is indistinguishable from a dead one until production needs it. Add a fixture to FIXTURES, or a reason to UNFIXTURABLE saying what you tried.`);
    }
  }

  const { dir, scratch } = makeWorktree();
  let behaviouralOk = 0;
  const treeBefore = porcelain(ROOT);
  try {
    for (const id of stepIds) {
      const repairCommand = REPAIRS[id].command;
      if (!FIXTURES[id]) {
        examined.push({ id, repair_command: repairCommand, behavioural: 'NO_FIXTURE', reason: UNFIXTURABLE[id] || null });
        continue;
      }
      const { command: validateCommand, why } = validatorCommandFor(id, matrix);
      if (!validateCommand) {
        errors.push(`validator_command_unresolvable:${id} - a repair is registered for this step but it ${why} in ${MATRIX_REL}, so nothing can be proven about the repair. Either the step id drifted or the validator left every profile.`);
        examined.push({ id, repair_command: repairCommand, behavioural: 'FAIL' });
        continue;
      }
      const ok = runFixture(id, FIXTURES[id], repairCommand, validateCommand, scratch);
      if (ok) behaviouralOk += 1;
      else examined.push({ id, repair_command: repairCommand, validate_command: validateCommand, behavioural: 'FAIL' });
    }
  } finally {
    sh(`git worktree remove --force ${JSON.stringify(scratch)}`, ROOT);
    fs.rmSync(dir, { recursive: true, force: true });
    sh('git worktree prune', ROOT);
  }

  // Nothing permanent may have moved. Every induction happened in the worktree;
  // if the production tree differs, a fixture escaped its sandbox and that is
  // worse than the gap this file exists to close.
  const treeAfter = porcelain(ROOT);
  if (treeAfter !== treeBefore) {
    errors.push('production_tree_mutated - the working tree changed while this test ran, so a fixture wrote outside its scratch worktree. Every induction must be sandboxed; a guard that leaves the repo dirty is worse than no guard.');
  }

  if (behaviouralOk < FIXTURE_FLOOR) {
    errors.push(`behavioural_coverage_fell:${behaviouralOk} repair(s) proved capable against a failing fixture, below the grow-only floor of ${FIXTURE_FLOOR}. A repair that was once proven capable must stay proven capable - restore the fixture rather than lowering the floor.`);
  }

  const uncovered = stepIds.filter((id) => !FIXTURES[id]);
  const report = {
    schema_version: '1.0',
    validator: 'repair-fixture-capability',
    status: errors.length ? 'FAIL' : 'PASS',
    generated_at: new Date().toISOString(),
    repairs_registered: stepIds.length,
    distinct_repair_commands: [...new Set(stepIds.map((id) => REPAIRS[id].command))].length,
    behavioural_pass: behaviouralOk,
    fixture_floor: FIXTURE_FLOOR,
    behavioural_fixture_missing: uncovered,
    examined,
    errors,
  };
  fs.mkdirSync(path.join(ROOT, path.dirname(OUT_REL)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, OUT_REL), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  if (errors.length) {
    console.error('[validate:repair-fixture-capability] FAIL');
    for (const e of errors) console.error(` - ${e}`);
    console.error(`[validate:repair-fixture-capability] FAIL: examined ${stepIds.length} registered repair(s); ${behaviouralOk} proven to clear a failing fixture (floor ${FIXTURE_FLOOR}).`);
    process.exit(1);
  }
  console.log(`[validate:repair-fixture-capability] PASS: examined ${stepIds.length} registered repair(s) across ${report.distinct_repair_commands} distinct repair command(s); ${behaviouralOk} proven to clear a genuinely failing fixture (floor ${FIXTURE_FLOOR}). Declared uncovered, with a recorded reason: ${uncovered.join(', ') || 'none'}.`);
}

main();

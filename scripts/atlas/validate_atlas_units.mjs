#!/usr/bin/env node
// HARD GATE on the demand-unit contract.
//
// The defect this exists to prevent: one field named `volume` held TWO incompatible
// quantities -- modelled monthly search volume on semrush_keyword_magic rows, and this
// domain's OWN 90-day impression count on gsc_search_analytics rows. rank_score was
// computed straight off it, so a 1,300/mo KD-9 query scored ~35x below a 320/mo query
// and the content queue was silently inverted.
//
// The fix is only durable if nothing can reintroduce the ambiguity, so this validator
// fails the build on ANY of:
//   1. an atlas or evidence row carrying a `volume` key at all
//   2. a GSC-sourced row with a non-null search_volume that did not come from a
//      keyword-tool join (i.e. no keyword-tool provenance recorded)
//   3. demand_basis disagreeing with which fields are actually populated
//   4. rank_score comparing across units (missing/incorrect rank_band)
//   5. source code still reading the removed `volume` field off an atlas/evidence row
//
// Check 5 matters because a stale consumer using `q.volume ?? null` would read the
// removed key as null and silently produce a wrong answer rather than throwing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const SELF = fileURLToPath(import.meta.url);
const errors = [];

// GOVERNANCE FIXTURES, EXECUTED.
//
// _validation_registry.json named positive_fixture and negative_fixture for
// VAL-116 as absent, and validate:validation-registry reported that as
// incomplete metadata for weeks. Naming two files would have silenced it while
// proving nothing, which is the defect class this repository keeps producing.
// So the fixtures are complete synthetic repositories, and this validator runs
// itself against each one on every invocation - the same shape as
// validate_admission_level_stability.mjs. If the comparison ever stops working,
// the fixtures fail before the real tree is looked at.
//
// The child re-enters this file with the real checks intact; nothing is
// skipped. The marker exists only so the child does not recurse into the
// fixtures again.
const FIXTURE_CHILD = process.env.ATLAS_UNITS_FIXTURE_CHILD === '1';
const FIXTURE_DIR = 'fixtures/validation/atlas-units';
const FIXTURES = ['pass.json', 'fail.json', 'empty.json'];

function runFixtures() {
  const dir = path.join(ROOT, FIXTURE_DIR);
  const problems = [];
  let ran = 0;
  for (const name of FIXTURES) {
    const fp = path.join(dir, name);
    if (!fs.existsSync(fp)) { problems.push(`fixture missing: ${FIXTURE_DIR}/${name}`); continue; }
    let fixture;
    try { fixture = JSON.parse(fs.readFileSync(fp, 'utf8')); }
    catch (e) { problems.push(`fixture is not valid JSON: ${FIXTURE_DIR}/${name}: ${e.message}`); continue; }
    const files = fixture.files || {};
    if (!Object.keys(files).length) { problems.push(`fixture declares no files: ${FIXTURE_DIR}/${name}`); continue; }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-units-fixture-'));
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.join(tmp, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, rel), `${JSON.stringify(body, null, 2)}\n`);
    }
    const r = spawnSync(process.execPath, [SELF], {
      cwd: tmp, encoding: 'utf8',
      env: { ...process.env, ATLAS_UNITS_FIXTURE_CHILD: '1' },
    });
    ran += 1;
    const combined = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.status !== fixture.expected_exit_code) {
      problems.push(`${FIXTURE_DIR}/${name}: expected exit ${fixture.expected_exit_code}, got ${r.status} :: ${combined.slice(0, 300)}`);
    }
    for (const want of fixture.expected_error_substrings || []) {
      if (!combined.includes(want)) problems.push(`${FIXTURE_DIR}/${name}: expected output to mention ${JSON.stringify(want)}`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // Rule 0 for the fixtures themselves.
  if (ran === 0) problems.push(`executed 0 fixtures from ${FIXTURE_DIR}; expected ${FIXTURES.length}. Fixtures that never run prove nothing.`);
  if (problems.length) {
    console.error('ATLAS UNIT CONTRACT: HARD_FAIL - governance fixtures did not behave as declared');
    for (const x of problems) console.error(`- ${x}`);
    process.exit(1);
  }
  console.log(`atlas unit contract: ${ran} governance fixture(s) reproduced their declared outcome`);
}

if (!FIXTURE_CHILD) runFixtures();
const read = (p) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); } catch { return null; } };

const ATLAS = 'data/authority_scale/query_atlas.json';
const EVIDENCE = 'data/queries/evidence/evidence_queries.json';

// Provenance strings that count as a real keyword-tool join.
const KEYWORD_TOOL = /semrush|keyword_magic|keyword_compare|keyword tool|portfolio_demand|blue.?ocean|owner_supplied_semrush|bing_keyword/i;
const GSC_SOURCES = new Set(['gsc_search_analytics']);

function checkRows(label, rows) {
  for (const q of rows) {
    const id = q.query || '<unnamed>';

    // 1. the ambiguous field must be gone entirely
    if (Object.prototype.hasOwnProperty.call(q, 'volume')) {
      errors.push(`${label}: row still carries the ambiguous \`volume\` key: ${id}`);
    }

    const sv = q.search_volume ?? null;
    const imp = q.impressions_90d ?? null;

    for (const f of ['search_volume', 'impressions_90d', 'demand_basis']) {
      if (!Object.prototype.hasOwnProperty.call(q, f)) {
        errors.push(`${label}: row missing required field \`${f}\`: ${id}`);
      }
    }

    // 2. a GSC row may only carry search_volume via a keyword-tool join
    if (GSC_SOURCES.has(q.source_type) && sv !== null) {
      const prov = q.search_volume_source || '';
      if (!KEYWORD_TOOL.test(prov)) {
        errors.push(
          `${label}: gsc-sourced row has search_volume=${sv} without keyword-tool provenance `
          + `(search_volume_source=${JSON.stringify(prov)}): ${id}. A GSC row measures impressions, `
          + `not market volume -- this is the exact overwrite that caused the defect.`
        );
      }
    }

    // a semrush row must never claim its own impressions
    if (q.source_type === 'semrush_keyword_magic' && imp !== null) {
      errors.push(`${label}: keyword-tool row carries impressions_90d=${imp}: ${id}`);
    }

    // 3. demand_basis must match what is actually populated
    const expected = sv !== null ? 'search_volume' : imp !== null ? 'impressions_90d' : 'none';
    if (q.demand_basis !== expected) {
      errors.push(
        `${label}: demand_basis=${JSON.stringify(q.demand_basis)} disagrees with populated fields `
        + `(search_volume=${sv}, impressions_90d=${imp}); expected ${expected}: ${id}`
      );
    }

    // conflicting packet volumes must be recorded, never averaged away
    if (q.volume_conflict === true) {
      const n = Object.keys(q.volume_sources || {}).length;
      if (n < 2) errors.push(`${label}: volume_conflict=true but volume_sources has ${n} entries: ${id}`);
    }
  }
}

// A unit contract asserted over zero rows is not a passing unit contract. Both
// registries emptying is a real state - a truncated write, a build that wrote
// the shell of the file - and every loop below iterates nothing, so this used
// to print `atlas unit contract: PASS (0 rows ...)` and exit 0. Each registry
// is checked on its own, because either can empty without the other.
const evidence = read(EVIDENCE);
if (!evidence) errors.push(`missing ${EVIDENCE}`);
else if (!(evidence.queries || []).length) errors.push(`${EVIDENCE} carries 0 rows; expected at least one evidence query. Checking the unit contract against no rows proves nothing.`);
else checkRows('evidence_queries', evidence.queries || []);

const atlas = read(ATLAS);
if (!atlas) errors.push(`missing ${ATLAS} - run the atlas build first`);
else if (!(atlas.queries || []).length) errors.push(`${ATLAS} carries 0 rows; expected at least one atlas query. Every band, ordering and rank_score check below iterates this list, so an empty atlas passes all of them while asserting nothing.`);
else {
  const rows = atlas.queries || [];
  checkRows('query_atlas', rows);

  // 4. rank_score must be banded so units cannot sort as peers
  const BANDS = { search_volume: 'measured_search_volume', impressions_90d: 'own_impressions_only', none: 'unscored' };
  for (const q of rows) {
    const want = BANDS[q.demand_basis];
    if (!q.rank_band) errors.push(`query_atlas: row missing rank_band: ${q.query}`);
    else if (q.rank_band !== want) {
      errors.push(`query_atlas: rank_band=${q.rank_band} but demand_basis=${q.demand_basis} implies ${want}: ${q.query}`);
    }
    if (q.demand_basis === 'none' && q.rank_score !== null) {
      errors.push(`query_atlas: rank_score must be null with no demand evidence: ${q.query}`);
    }
  }
  // ordering must be band-major, so a cross-unit comparison never decides position
  const order = ['measured_search_volume', 'own_impressions_only', 'unscored'];
  let seen = -1;
  for (const q of rows) {
    const i = order.indexOf(q.rank_band);
    if (i < seen) { errors.push(`query_atlas: rows are not ordered band-major; ${q.query} (${q.rank_band}) appears after a later band`); break; }
    seen = Math.max(seen, i);
  }
  if (!atlas.rank_scoring?.formula) errors.push('query_atlas: rank_scoring.formula must be recorded in the file');
  if (!atlas.unit_contract) errors.push('query_atlas: unit_contract must be recorded in the file');
}

// 5. tripwire: no source file may still read the removed field off an atlas row.
const SCAN_DIRS = ['scripts', '_ops', 'src', 'lib', 'tools'];
const SKIP = /node_modules|[/\\]\.git[/\\]|[/\\]dist[/\\]|[/\\]build[/\\]/;
const FORBIDDEN = /(\bq|\brow|\bentry|\bquery|\bitem)\s*(\.volume\b|\[['"]volume['"]\])/;
function walk(dir, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const rel = path.join(dir, e.name);
    if (SKIP.test(rel)) continue;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(mjs|cjs|js|ts|py)$/.test(e.name)) out.push(rel);
  }
  return out;
}
for (const dir of SCAN_DIRS) {
  for (const rel of walk(dir)) {
    const txt = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    txt.split('\n').forEach((line, i) => {
      if (line.trim().startsWith('//') || line.trim().startsWith('#') || line.trim().startsWith('*')) return;
      if (/pop\(["']volume["']/.test(line)) return; // removing it is the fix, not a use
      if (FORBIDDEN.test(line)) {
        errors.push(`${rel}:${i + 1}: reads the removed \`volume\` field off a query row -> ${line.trim()}`);
      }
    });
  }
}

if (errors.length) {
  console.error('ATLAS UNIT CONTRACT: HARD_FAIL');
  for (const e of errors) console.error(`- ${e}`);
  process.exit(1);
}

const rows = atlas.queries || [];
const byBand = rows.reduce((a, q) => { a[q.rank_band] = (a[q.rank_band] || 0) + 1; return a; }, {});
const withVol = rows.filter((q) => q.search_volume !== null).length;
const conflicts = rows.filter((q) => q.volume_conflict).length;
console.log(
  `atlas unit contract: PASS (${rows.length} rows, no \`volume\` key, ${withVol} with keyword-tool search_volume, `
  + `${conflicts} volume_conflict recorded, bands ${JSON.stringify(byBand)})`
);

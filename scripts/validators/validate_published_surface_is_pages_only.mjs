#!/usr/bin/env node
/**
 * REFUSES: repo source artifacts reaching the published surface, and any
 * published page carrying an unrendered template placeholder in a link.
 *
 * ─── The failure this exists because of ─────────────────────────────────────
 *
 * The public site IS the repository root, so Cloudflare Pages publishes whatever
 * `scripts/assemble_pages_output.js` does not deny-list. `templates/` was not on
 * that list, so twelve raw Mustache sources shipped as live pages on BOTH
 * hostnames:
 *
 *   https://spryexecutiveos.com/templates/answer_page             -> 200
 *   https://billionairehighperformancecoach.com/templates/layout  -> 200
 *
 * Each of them carries `href="{{canonical}}"`. A browser and a crawler both
 * resolve that against /templates/, so every one of them links to
 * /templates/{{canonical}} - which 404s - and they hard-link to each other
 * (/templates/pillar_page, /templates/faq_page, ...), which is what kept the
 * island reachable long enough to be crawled at all.
 *
 * Ahrefs Site Audit, project Spryexecutiveos, crawl of 3 September 2026:
 * 4,594 internal URLs, Errors 7 - "Page has links to broken page: 3",
 * "4XX page: 2", "404 page: 2". That IS this island. The Billionairehigh-
 * performancecoach crawl of the same night reported "4XX page: 2" from the same
 * files served on the second hostname.
 *
 * ─── Why the check is shaped this way ───────────────────────────────────────
 *
 * Deleting the templates would be wrong - the generators render from them. The
 * defect is that a build-input directory was PUBLISHED. So this gate asserts the
 * published surface, not the repository: it runs the assembler and then looks at
 * what the assembler actually produced.
 *
 * Two assertions, because the deny-list alone is not enough. A future directory
 * of templates under another name would slip past assertion (1) and be caught by
 * assertion (2), and a placeholder that renders to a real path would slip past
 * (2) and be caught by (1).
 *
 *   1. No build-input directory appears at the root of the published output.
 *   2. No published HTML carries an unrendered `{{...}}` placeholder inside an
 *      href or src. Such a link cannot resolve to anything; it is a 4xx by
 *      construction, which is precisely what Ahrefs counted.
 *
 * RULE 0. A gate that examines nothing must not report green. If the assembler
 * produced fewer than MIN_PAGES pages, this exits non-zero and says so rather
 * than passing over an empty loop - the way a validator "passes" when it runs
 * before the stage that makes its corpus.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, '.pages-output');

/** Directories that are build inputs or repo operations, never pages. */
const BUILD_INPUT_DIRS = [
  'templates', 'scripts', 'fixtures', 'reports', 'artifacts', 'docs',
  'tests', 'config', 'content', 'data', 'seo', 'node_modules',
];
/** Floor: below this the corpus is not the site, and "no offenders" means nothing. */
const MIN_PAGES = 500;

const assemble = spawnSync('node', [path.join('scripts', 'assemble_pages_output.js')], {
  cwd: ROOT, encoding: 'utf8',
});
if (assemble.status !== 0) {
  console.error('[published-surface] FAIL: the assembler did not complete, so there is no published surface to assert.');
  console.error(assemble.stderr || assemble.stdout || '(no output)');
  process.exit(1);
}

if (!fs.existsSync(OUT)) {
  console.error(`[published-surface] FAIL: ${path.relative(ROOT, OUT)} does not exist after assembly.`);
  process.exit(1);
}

const failures = [];

// (1) Build-input directories must not be part of the published surface.
for (const dir of BUILD_INPUT_DIRS) {
  const p = path.join(OUT, dir);
  if (!fs.existsSync(p)) continue;
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else files.push(path.relative(OUT, full));
    }
  })(p);
  failures.push(
    `build-input directory PUBLISHED: /${dir}/ (${files.length} file(s), e.g. ${files.slice(0, 4).join(', ')}). `
    + `Add '${dir}' to EXCLUDE in scripts/assemble_pages_output.js - a build input served as a page is a crawlable URL nobody wrote.`,
  );
}

// (2) No published page may carry an unrendered placeholder in a link.
const pages = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith('.html')) pages.push(full);
  }
})(OUT);

const LINK_ATTR = /\b(?:href|src)\s*=\s*"([^"]*)"|\b(?:href|src)\s*=\s*'([^']*)'/gi;
let linksExamined = 0;
for (const file of pages) {
  const html = fs.readFileSync(file, 'utf8');
  let m;
  LINK_ATTR.lastIndex = 0;
  while ((m = LINK_ATTR.exec(html))) {
    const value = m[1] ?? m[2] ?? '';
    linksExamined += 1;
    if (/\{\{|\}\}|\{%|%\}|\$\{/.test(value)) {
      failures.push(
        `unrendered placeholder in a published link: /${path.relative(OUT, file)} -> "${value}". `
        + `A crawler resolves this literally and gets a 4xx; render the value or keep the file out of the published surface.`,
      );
    }
  }
}

// RULE 0 - an empty corpus is a failure, not a pass.
if (pages.length < MIN_PAGES) {
  console.error(
    `[published-surface] FAIL: examined only ${pages.length} published page(s) (floor ${MIN_PAGES}). `
    + 'A gate that examines nothing cannot fail, so an under-populated corpus is reported as a failure rather than a pass. '
    + 'Check that the assembler ran after the generators, not before them.',
  );
  process.exit(1);
}
if (linksExamined === 0) {
  console.error('[published-surface] FAIL: examined 0 link attributes across '
    + `${pages.length} pages. The link scan matched nothing, so its silence proves nothing.`);
  process.exit(1);
}

if (failures.length) {
  console.error(`[published-surface] FAIL: ${failures.length} finding(s) on the published surface:`);
  for (const f of failures.slice(0, 40)) console.error(`  - ${f}`);
  if (failures.length > 40) console.error(`  ... and ${failures.length - 40} more`);
  process.exit(1);
}

console.log(
  `[published-surface] PASS: ${pages.length} published pages, ${linksExamined} link attributes, `
  + `0 build-input directories published, 0 unrendered placeholders in links.`,
);

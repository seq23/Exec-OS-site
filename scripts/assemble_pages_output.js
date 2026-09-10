#!/usr/bin/env node
'use strict';
/**
 * Assembles the publishable site into .pages-output/ for Cloudflare Pages.
 *
 * The public site is the repository root, which is what every generator here
 * has always assumed. That means the root also holds scripts/, data/ and the
 * repo contracts, so the deployed directory has to be assembled rather than
 * published as-is.
 *
 * This replaces two older mechanisms at once: the site/public staging rename
 * (which moved 340 entries before and after every build) and the _redirects
 * catch-all `/* /site/public/:splat 200`, which hid the source tree by
 * rewriting every request into a subdirectory - and, as a side effect,
 * answered 200 for URLs that do not exist.
 *
 * The exclusion list is a deny-list on purpose: an allow-list silently drops
 * new pages the day a generator adds a directory, whereas an unknown directory
 * here is published (visible) rather than lost. Every URL in sitemap.xml is
 * verified present afterwards, so a wrong exclusion fails the build loudly
 * instead of shipping a site with holes.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, '.pages-output');

const EXCLUDE = new Set([
  '.pages-output', 'dist', 'node_modules', '.git', '.github', '.gitignore',
  '.nvmrc', '.build', '.validation-cache', '.validation-runtime',
  'scripts', 'data', 'reports', 'artifacts', 'docs', 'tests', 'fixtures',
  'config', 'content', 'functions', 'seo', 'LICENSES',
  // templates/ holds the raw Mustache sources the generators render FROM. They
  // are not pages, but the root deploy published them anyway, so
  // https://spryexecutiveos.com/templates/answer_page and eleven siblings
  // answered 200 on both hostnames - each one an unrendered template carrying
  // `href="{{canonical}}"`, which resolves to /templates/{{canonical}} and 404s,
  // plus hard links to every other template that kept the island crawlable.
  // Ahrefs Site Audit, 3 September 2026, reported this as the whole of the
  // Spryexecutiveos error budget: "Page has links to broken page: 3",
  // "4XX page: 2", "404 page: 2" against Errors 7.
  'templates',
  'package.json', 'package-lock.json', 'requirements-validation.txt',
  'playwright.config.mjs', 'wrangler.toml',
  'distribution.config.json', 'distribution.config.example.json',
]);
// Repo contracts and docs at the root: _repo_*.json, _validation_*.json and
// every top-level markdown file.
const excluded = (name) => EXCLUDE.has(name)
  || /^_(repo|validation|artifact|baseline)[-_]/.test(name)
  || name.endsWith('.md');

let copied = 0;
function copyInto(srcDir, outDir, depth) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (depth === 0 && excluded(entry.name)) continue;
    const from = path.join(srcDir, entry.name);
    const to = path.join(outDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyInto(from, to, depth + 1);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
      copied += 1;
    }
  }
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
copyInto(root, out, 0);

const missing = [];
for (const name of ['sitemap.xml', 'sitemap-spry.xml', 'sitemap-bhpc.xml']) {
  const sitemap = path.join(out, name);
  if (!fs.existsSync(sitemap)) continue;
  const xml = fs.readFileSync(sitemap, 'utf8');
  for (const m of xml.matchAll(/<loc>https?:\/\/[^/]+([^<]*)<\/loc>/g)) {
    const p = (m[1] || '/').replace(/^\//, '').replace(/\/$/, '');
    const candidates = p === '' ? ['index.html'] : [p, `${p}.html`, path.join(p, 'index.html')];
    if (!candidates.some((c) => fs.existsSync(path.join(out, c)))) missing.push(m[1] || '/');
  }
}
if (missing.length) {
  console.error(`assemble: ${missing.length} sitemap URL(s) missing from output, e.g.`);
  console.error(missing.slice(0, 10).map((u) => `  ${u}`).join('\n'));
  process.exit(1);
}

// Nothing credential-shaped may ever reach a deploy directory, no matter how it
// got into the tree. CI recreates service-account keys from secrets, and a key
// written into the workspace instead of $RUNNER_TEMP would otherwise be copied
// here and published. Fail loudly rather than deploy and hope.
const CREDENTIAL_SHAPED = /(service[-_]?account|credentials?|secret|\.pem$|\.key$|\.p12$|id_rsa)/i;
const credentials = [];
(function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { scan(full); continue; }
    if (CREDENTIAL_SHAPED.test(entry.name)) credentials.push(path.relative(out, full));
  }
})(out);
if (credentials.length) {
  console.error('assemble: refusing to publish credential-shaped file(s): ' + credentials.join(', '));
  process.exit(1);
}

const leaked = ['package.json', 'AGENTS.md', 'README.md', 'package-lock.json', 'scripts']
  .filter((f) => fs.existsSync(path.join(out, f)));
if (leaked.length) {
  console.error('assemble: source still present in output: ' + leaked.join(', '));
  process.exit(1);
}
if (!fs.existsSync(path.join(out, 'index.html'))) {
  console.error('assemble: output has no index.html');
  process.exit(1);
}

console.log(`assemble: ${copied} files into .pages-output/ (sitemap URLs verified)`);

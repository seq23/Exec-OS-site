#!/usr/bin/env node
/**
 * Package a baseline snapshot ZIP the updater will actually accept.
 *
 * THE NAME IS NOT DECORATION. `repo-tools/active/update_repo_from_zip_generic_v3_1.sh` refuses a
 * snapshot whose filename does not match, at line 138:
 *
 *   ^${REPO_NAME}-main_BASELINE_[0-9]{2}-[0-9]{2}-[0-9]{2}_[a-f0-9]{7,40}\.zip$
 *
 * so `<repo>-main_BASELINE_MM-DD-YY_<sha>.zip`. A hand-typed name is a name that drifts: the first
 * one I wrote was wrong on the repo, the branch, the date format and the identifier all at once,
 * and the only thing that would have caught it is the updater rejecting it later.
 *
 * The SHA is the COMMIT the archive was cut from, so the file names the state it contains rather
 * than the minute it was zipped. Two baselines of the same commit are the same bytes.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const git = (...args) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();

const repo = basename(ROOT.replace(/\/$/, ""));
const sha = git("rev-parse", "--short=12", "HEAD");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");

if (git("status", "--porcelain")) {
  console.error("BASELINE REFUSED — the worktree is dirty.");
  console.error("A baseline names a commit. Packaging uncommitted work would produce a file whose");
  console.error("SHA describes something the archive does not contain.");
  process.exit(1);
}

/*
 * The updater's pattern hard-codes `-main`. That is the branch a baseline is expected to come from,
 * so packaging one from anywhere else is refused rather than renamed into looking right.
 */
if (branch !== "main") {
  console.error(`BASELINE REFUSED — on branch "${branch}", and the updater's pattern requires main.`);
  process.exit(1);
}

const d = new Date();
const p = (n) => String(n).padStart(2, "0");
const stamp = `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCFullYear() % 100)}`;
const name = `${repo}-main_BASELINE_${stamp}_${sha}.zip`;

const EXPECTED = new RegExp(`^${repo}-main_BASELINE_\\d{2}-\\d{2}-\\d{2}_[a-f0-9]{7,40}\\.zip$`);
if (!EXPECTED.test(name)) {
  console.error(`BASELINE REFUSED — generated name "${name}" does not match the updater's pattern.`);
  process.exit(1);
}

mkdirSync(join(ROOT, "ARTIFACTS"), { recursive: true });
const out = join(ROOT, "ARTIFACTS", name);
git("archive", "--format=zip", `-o${out}`, "HEAD");

const sha256 = execFileSync("shasum", ["-a", "256", out], { encoding: "utf8" }).split(" ")[0];
console.log(`baseline: ARTIFACTS/${name}`);
console.log(`commit:   ${git("rev-parse", "HEAD")}`);
console.log(`sha256:   ${sha256}`);

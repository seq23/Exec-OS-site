// Every HARD_FAIL gate in this registry has to be able to say what it is for.
//
// validate:validation-registry already tests risk_prevented for emptiness, and
// that is exactly why the hole survived: scripts/validation/add_validator.mjs
// wrote the literal string "Declared validator protection." into every record it
// created, which is not empty, so 55 of 240 records passed as complete metadata
// while stating nothing. Among them were the two records for the extraction
// surface guard - the HARD_FAIL gate behind Validate Repo runs 33515334720 and
// 33727145801 and, downstream of the first, Main Validation Sentinel alarm
// 33533720679. The check that pages the owner had no recorded reason to exist.
//
// The root cause is fixed at the writer: validation:add now requires --risk and
// refuses a placeholder, so the set cannot grow. This is the ratchet that proves
// it. It is deliberately a four-way assertion, because a backlog list guarded
// only against growth rots into a permanent exemption:
//
//   1. a placeholder on a record that is NOT on the list        -> FAIL
//   2. the list longer than its own recorded ceiling            -> FAIL
//   3. a listed id whose statement has since been written       -> FAIL
//   4. a listed id that is no longer in the registry            -> FAIL
//
// (3) and (4) are what force the ceiling down. Without them the list keeps
// claiming credit for work already done, and the next placeholder slips in under
// the slack.

import fs from 'node:fs';
import { readJson, fail, pass, writeSummary } from './common.mjs';
import { registryDefect } from './risk_statement_boilerplate.mjs';

const BACKLOG_PATH = 'data/validation/risk_statement_backlog.json';

let registryDoc, backlog;
try {
  registryDoc = readJson('_validation_registry.json');
} catch (e) {
  fail('[validate:risk-statement-substance] FAIL: cannot read _validation_registry.json', [e.message]);
}
try {
  backlog = readJson(BACKLOG_PATH);
} catch (e) {
  fail(`[validate:risk-statement-substance] FAIL: cannot read ${BACKLOG_PATH}; the ratchet cannot be enforced without the list it ratchets against`, [e.message]);
}

const records = registryDoc.records || [];
const listed = Array.isArray(backlog.ids) ? backlog.ids : null;
const ceiling = Number.isInteger(backlog.ceiling) ? backlog.ceiling : null;

// Examining zero records is the failure mode this whole file exists to catch in
// other checks, so it must not be this one's silent pass. A truncated or re-keyed
// registry would otherwise make every assertion below vacuously true.
if (!records.length) {
  fail('[validate:risk-statement-substance] FAIL: _validation_registry.json holds 0 records, so this check examined nothing. A risk-statement audit over an empty registry proves nothing.');
}
if (listed === null) {
  fail(`[validate:risk-statement-substance] FAIL: ${BACKLOG_PATH} has no ids array. The ratchet needs an explicit list; an absent one would exempt every record.`);
}
if (ceiling === null) {
  fail(`[validate:risk-statement-substance] FAIL: ${BACKLOG_PATH} has no integer ceiling, so the list could grow without limit.`);
}

const listedSet = new Set(listed);
const byId = new Map(records.map((r) => [r.validation_id, r]));
const errors = [];

// (1) placeholders outside the recorded backlog
const unlisted = [];
for (const r of records) {
  const defect = registryDefect(r);
  if (defect && !listedSet.has(r.validation_id)) unlisted.push(`${r.validation_id}: ${defect}`);
}
if (unlisted.length) {
  errors.push(`${unlisted.length} registry record(s) carry a placeholder risk statement and are not on the recorded backlog. New protection must state the failure it refuses:`);
  errors.push(...unlisted);
}

// (2) the list may not grow
if (listed.length > ceiling) {
  errors.push(`the backlog lists ${listed.length} ids against a recorded ceiling of ${ceiling}. This list may only shrink.`);
}

// (3) listed ids that have since been written properly must be removed
const nowClean = listed.filter((id) => byId.has(id) && !registryDefect(byId.get(id)));
if (nowClean.length) {
  errors.push(`${nowClean.length} backlog id(s) now carry a real risk statement. Remove them from ${BACKLOG_PATH} and lower ceiling to ${listed.length - nowClean.length}, so the list cannot go stale and re-authorise a placeholder under its slack:`);
  errors.push(...nowClean);
}

// (4) listed ids that left the registry must be removed
const vanished = listed.filter((id) => !byId.has(id));
if (vanished.length) {
  errors.push(`${vanished.length} backlog id(s) are no longer in the registry. Remove them and lower ceiling to ${listed.length - vanished.length}:`);
  errors.push(...vanished);
}

const outstanding = listed.filter((id) => byId.has(id) && registryDefect(byId.get(id)));
writeSummary('validate-risk-statement-substance', {
  status: errors.length ? 'FAIL' : 'PASS',
  registry_records: records.length,
  backlog_ceiling: ceiling,
  backlog_listed: listed.length,
  outstanding_placeholders: outstanding.length,
  unlisted_placeholders: unlisted.length,
  errors,
});

if (errors.length) {
  fail(`[validate:risk-statement-substance] FAIL: ${errors.length} issue(s)`, errors.slice(0, 200));
}
pass(`[validate:risk-statement-substance] PASS: ${records.length} registry records audited; every placeholder risk statement is one of the ${outstanding.length} recorded in ${BACKLOG_PATH} (ceiling ${ceiling}); 0 outside it`);

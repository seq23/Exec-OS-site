// The single definition of "this risk statement says nothing".
//
// It lives in its own module because the two components that need it - the
// admission tool (scripts/validation/add_validator.mjs) and the guard
// (scripts/validation/validate_risk_statement_substance.mjs) - would otherwise
// each keep their own copy of the list. Two lists with no link between them is
// how a tool starts emitting a placeholder the guard no longer recognises while
// the guard keeps reporting clean.
//
// risk_prevented is the field a human reads to learn what a validator is for,
// and the field scripts/validation/audit_governance_blockers.mjs reads when
// proposing a severity migration. A placeholder there is not cosmetic: it is a
// HARD_FAIL gate whose stated reason for existing is a sentence a tool wrote.
//
// Two rules, deliberately different in strictness:
//
//   registryDefect()  - applied to all 240 existing records. It asserts only
//     the objective, unarguable case: the statement is absent, or it is one of
//     the exact strings a tool emitted. It does NOT assert a length. An earlier
//     draft imposed an 80-character floor and it failed 22 records including
//     "Prevents marker-only agent proof from counting as implementation." -
//     terse, and a perfectly good risk statement. A validator that measures
//     prose length is asserting the shape of writing, not behaviour.
//
//   admissionDefect() - applied only to records being created now, through
//     validation:add, where the requirement can be stated up front and met at
//     no cost. New protection has to explain itself.

export const BOILERPLATE_RISK = [
  'Declared validator protection.',
  'Declared protection.',
  'Validator protection.',
  'Atomic registration prevents package/registry/matrix drift.',
  'TBD',
  'TODO',
  'N/A',
];

export const MIN_NEW_RISK_CHARS = 80;

function normalized(record) {
  return String(record?.risk_prevented ?? '').trim();
}

export function registryDefect(record) {
  const risk = normalized(record);
  if (!risk) return 'risk_prevented is empty';
  if (BOILERPLATE_RISK.some((b) => risk.toLowerCase() === b.toLowerCase())) {
    return `risk_prevented is the tool-written placeholder "${risk}"`;
  }
  return null;
}

export function admissionDefect(record) {
  const found = registryDefect(record);
  if (found) return found;
  const risk = normalized(record);
  if (risk.length < MIN_NEW_RISK_CHARS) {
    return `risk_prevented is ${risk.length} characters, under the ${MIN_NEW_RISK_CHARS}-character floor required of newly admitted protection. Name the failure this refuses, the lane it happened on, and what the check now does about it.`;
  }
  return null;
}

/**
 * The self-heal repair map: validation step id -> the repair that fixes it.
 *
 * This lived inside heal_until_clean.mjs, which executes a full validation loop
 * at module top level, so nothing could read the map without running self-heal.
 * That is why no check in this repository had ever examined a single registered
 * repair: the list was unreachable by construction. It is its own module now so
 * `validate:repair-fixture-capability` can prove, against a real failing fixture,
 * that each repair still clears the validator it is registered against.
 *
 * The pairing rule is narrow on purpose: a repair is declared only when it
 * writes the artifact the check reads. A repair that merely sounds related would
 * produce motion without fixing the defect, and make the loop look like it had
 * tried something.
 */

// step id -> repair command. Only where the repair writes what the check reads.
export const REPAIRS = {
  'validate:citation-contract': { command: 'npm run repair:citation-contract-surfaces',
    why: 'repair_active_citation_contract.py and its siblings are the only writers of the citation contract surfaces this check reads.' },
  'validate:programmatic-registry': { command: 'npm run repair:programmatic-registry-owners',
    why: 'repair_programmatic_registry_owners.mjs is the sole writer of the admission/query registry rows this check validates.' },
  'VAL-QUERY-OWNER-UNIQUENESS': { command: 'npm run repair:programmatic-registry-owners',
    why: 'Duplicate query ownership is exactly what this repair resolves, by renaming the losing page.' },
  'VAL-VISIBLE-CONTENT-ARTIFACTS': { command: 'npm run repair:visible-content-artifacts',
    why: 'The repair strips the visible artifacts this check reports.' },
  'VAL-EXTRACTION-SURFACE-GUARD-CHECK': { command: 'npm run repair:extraction-final-state',
    why: 'The extraction final-state repair writes the surface state this guard compares against.' },
  'VAL-FULL-PAGE-AUDIT': { command: 'npm run agent:bhpc:plan-exact && npm run agent:bhpc:apply-exact',
    why: 'The page-seo contract inside this audit fails on record markers and required headings that the agent acceptance manifest expects; plan-exact/apply-exact are what write them. Proven: a page carrying 24 such failures went to 0 after one apply.' },
  'VAL-BHPC-PAGE-SEO': { command: 'npm run agent:bhpc:plan-exact && npm run agent:bhpc:apply-exact',
    why: 'Same contract, incremental mode - same writer.' },
  'validate:sitemap-coverage': { command: 'npm run build:aplayer-phase-expansion',
    why: 'The generator is the sole writer of sitemap-bhpc.xml, sitemap-spry.xml and the sitemap index this check reads; a page present in the registry but missing from a sitemap is fixed by rebuilding them, not by editing XML.' },
  'validate:llms-full-coverage': { command: 'npm run build:aplayer-phase-expansion',
    why: 'Same writer: llms.txt and llms-full.txt are written from the citable-page registry by that generator.' },
  'validate:ui-test-parity': { command: 'npm run repair:citation-contract-surfaces',
    why: 'repair_ui_test_parity.py runs inside this chain and writes the parity manifest the check reads.' },
};

// Deliberately unpaired, recorded so the omissions stay auditable:
// validate:repo, validate:validation-registry, validate:workflow-* and the
// orchestration/python-runtime checks describe repository and toolchain state -
// repairing them would mean asserting a configuration nobody chose.
// validate:agent-run, agent:bhpc:* and VAL-SEARCH-INTELLIGENCE measure
// externally produced runs; generating their inputs would be fabrication.
// validate:content-pattern and validate:claim-safety need words written into
// pages, which is an editorial decision, not a repair.
//
// VAL-EXTRACTION-CONTRACT-SELF-TEST was paired to `npm run
// repair:extraction-contracts` until 2026-09-09 and that pairing was INERT by
// construction. self_test_extraction_contract.py builds every fixture inline and
// reads no file under the repository: run it in a directory containing only
// scripts/ and requirements-validation.txt and it still prints "PASS: 15
// fixtures". Its outcome is a pure function of scripts/citation/
// extraction_contract.py. The repair writes data/citation/*.json, page HTML and
// artifacts/ - none of which the self-test reads - so no output it can produce
// could ever change the result. A failure there means the extraction contract
// LOGIC is wrong, which is a human decision, and self-heal would have burned
// three attempts on a 25-second repair chain before exiting UNRESOLVED anyway.
// Unpaired, the loop says "no declared repair" on the first attempt and stops,
// which is the honest answer. validate:repair-fixture-capability now refuses any
// pairing that has neither a behavioural fixture nor a written reason, so this
// class cannot re-enter unnoticed.

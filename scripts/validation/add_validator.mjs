#!/usr/bin/env node
import fs from 'node:fs';
import {admissionDefect} from './risk_statement_boilerplate.mjs';
const args=process.argv.slice(2); const get=k=>{const i=args.indexOf(`--${k}`);return i>=0?args[i+1]:null};
const id=get('id'),command=get('command'),severity=get('severity')||'STRONG_WARNING',profiles=(get('profiles')||'').split(',').filter(Boolean);
const exclusionReason=get('exclusion-reason');
const risk=get('risk');
if(!id||!command){console.error('usage: --id ID --command "npm run ..." --risk "what failure this refuses" [--severity ...] (--profiles a,b | --exclusion-reason "why this is deliberately not a profile step")');process.exit(2)}
// risk_prevented used to be hardcoded here as the string "Declared validator
// protection." That is not empty, so validate:validation-registry - which tests
// the field for emptiness - reported complete metadata for all 55 records this
// tool had created, each a gate whose recorded reason for existing was a sentence
// the tool wrote. Two of them were the extraction surface guard, the HARD_FAIL
// pair behind Validate Repo runs 33515334720 and 33727145801 and, downstream of
// the first, Main Validation Sentinel alarm 33533720679.
//
// The same shape as the --profiles refusal above: the tool produced the defective
// state and printed PASS. Admission now requires the statement, and refuses the
// placeholder it used to write itself. validate:risk-statement-substance holds
// the existing 53 as a shrink-only backlog so the set cannot grow again.
const riskDefect=admissionDefect({risk_prevented:risk});
if(riskDefect){
  console.error(`[validation:add] REFUSED: ${id} - ${riskDefect}`);
  console.error('Pass --risk "<the failure this refuses, the lane it happened on, and what the check now does about it>". A gate that cannot say what it protects is unreviewable, and its severity cannot be migrated on evidence.');
  process.exit(2);
}
// A validator admitted into the registry and the matrix but placed in no profile
// never executes, while the control plane reports it as active protection. That
// is not hypothetical: validate:coverage-route was admitted at HARD_FAIL into no
// profile and the route it guarded 404'd for two months. This tool used to
// produce exactly that state and print PASS, because --profiles was optional and
// defaulted to none. Admission now requires either arming (--profiles) or a
// recorded reason for not arming (--exclusion-reason), which is written into
// profile_exclusions where validate:validation-registry can see it.
if(!profiles.length&&!exclusionReason){
  console.error(`[validation:add] REFUSED: ${id} would be admitted into the registry and the matrix but placed in no profile, so it would never run while reporting as active protection.`);
  console.error('Pass --profiles <name[,name]> to arm it, or --exclusion-reason "<why it is deliberately not a profile step>" to record the exception.');
  process.exit(2);
}
if(profiles.length&&exclusionReason){
  console.error('[validation:add] REFUSED: --profiles and --exclusion-reason are mutually exclusive; a validator is either armed or deliberately excluded.');
  process.exit(2);
}
const reg=JSON.parse(fs.readFileSync('_validation_registry.json','utf8')); const matrix=JSON.parse(fs.readFileSync('_repo_validation_matrix.json','utf8'));
if(reg.records.some(r=>r.validation_id===id||r.command===command)){console.error('validator id or command already exists');process.exit(1)}
const scriptName=command.startsWith('npm run ')?command.slice(8):''; const pkg=JSON.parse(fs.readFileSync('package.json','utf8')); if(scriptName&&!pkg.scripts?.[scriptName]){console.error(`command does not resolve: ${command}`);process.exit(1)}
// Matrix ids used to be allocated as max(existing numeric id)+1, computed
// against whatever tip the branch could see. That is a local maximum, and a local
// maximum cannot be made concurrency-safe: two branches opened from the same base
// allocate the SAME id for two DIFFERENT validators and only discover it at merge.
// It happened twice in two rounds - MX-191 claimed by both VAL-FROZEN-OUTPUT-CONTRACT
// and VAL-MAIN-WRITER-VALIDATION-GATE, then MX-193 by both VAL-BUILD-ALL-INTEGRITY
// and the renumbered gate - and a third time on this branch, five collisions at once.
//
// The danger is not the collision, it is how it resolves: taking one side wholesale
// drops a validator, and the registry still validates clean. A guard stops running
// and nothing looks wrong.
//
// So the id is derived from the validator's own name instead of from a count.
// Two branches allocating for DIFFERENT validators can no longer collide, and two
// allocating for the SAME validator produce identical ids and merge cleanly. The
// shape already exists in this file - MX-AGENT-LIVE, MX-VAL-FSA-ALL and
// MX-ARTIFACT-PACKAGING-PARITY predate this change - and existing numeric ids are
// untouched, because 213 matrix entries reference them.
const mx = `MX-${id.startsWith('VAL-') ? id.slice(4) : id}`;
if (matrix.entries.some((x) => x.matrix_id === mx)) {
  console.error(`[validation:add] REFUSED: matrix id ${mx} is already taken by ${matrix.entries.find((x) => x.matrix_id === mx).validation_id}. Ids are derived from the validator name, so this means the name is already in use.`);
  process.exit(1);
}
reg.records.push({validation_id:id,status:'ADMITTED',name:scriptName||id,check_type:'validator',owning_lane:'validation-control-plane',risk_prevented:risk,existing_coverage_gap:'Atomic registration prevents package/registry/matrix drift.',scope:['repository'],proposed_severity:severity,command,implementation_path:'package.json',environment:'container',proof_tier:1,positive_fixture:'fixtures/validation/repo/pass.json',negative_fixture:'fixtures/validation/repo/fail.json',evidence_output:`artifacts/diagnostics/<run-id>/${scriptName.replace(/:/g,'-')}/summary.json`,runtime_budget_seconds:300,maintenance_owner:'repo',overlap_analysis:[],retirement_offset:null,decision:'Atomically admitted by validation:add.',decision_date:new Date().toISOString().slice(0,10),matrix_ids:[mx],not_applicable_reason:null});
const order=Math.max(0,...matrix.entries.map(x=>Number(x.order)||0))+1;
matrix.entries.push({matrix_id:mx,validation_id:id,lane:'validation-control-plane',command,order,severity,release_effect:severity==='HARD_FAIL',status:'ADMITTED'});
for(const p of profiles){if(!matrix.profiles?.[p]){console.error(`unknown profile ${p}`);process.exit(1)} matrix.profiles[p].steps.push({id,command});}
if(exclusionReason){matrix.profile_exclusions=matrix.profile_exclusions||{}; matrix.profile_exclusions[mx]=exclusionReason;}
reg.record_count=reg.records.length; matrix.entry_count=matrix.entries.length; fs.writeFileSync('_validation_registry.json',JSON.stringify(reg,null,2)+'\n');fs.writeFileSync('_repo_validation_matrix.json',JSON.stringify(matrix,null,2)+'\n');console.log(`[validation:add] PASS: ${id} -> ${command} (${mx}; ${profiles.length?`armed in profile(s): ${profiles.join(', ')}`:`excluded from every profile, reason recorded: ${exclusionReason}`})`);

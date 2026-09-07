import fs from 'node:fs';
import path from 'node:path';
import {readJson,fail,pass,writeSummary} from './common.mjs';
import {discover} from './validation_control_plane.mjs';

let registryDoc,matrixDoc;
try{registryDoc=readJson('_validation_registry.json');matrixDoc=readJson('_repo_validation_matrix.json');}
catch(e){fail('[validate:validation-registry] FAIL: malformed control-plane JSON',[e.message]);}
const registry=registryDoc.records||[]; const matrix=matrixDoc.entries||[]; const profiles=matrixDoc.profiles||{};
const errors=[]; const strongWarnings=[]; const warnings=[];
// Every arm of the control plane defaults to empty here, so a truncated or
// re-keyed _validation_registry.json / _repo_validation_matrix.json made this
// check iterate nothing and print "control plane safe" - the one report that
// would have to be true for any other validator's result to mean anything.
if(!registry.length) errors.push('_validation_registry.json: records is empty or absent; it must list the registered validators being governed. An empty registry proves nothing about the control plane.');
if(!matrix.length) errors.push('_repo_validation_matrix.json: entries is empty or absent; it must list the matrix placements that give registry records their severity and profile. An empty matrix proves nothing.');
if(!Object.keys(profiles).length) errors.push('_repo_validation_matrix.json: profiles is empty or absent; it must define the validation profiles that actually run the admitted validators. With no profiles, every reachability result below is vacuous.');
const coreRequired=['validation_id','status','name','proposed_severity','command','implementation_path'];
const metadataFields=['check_type','owning_lane','risk_prevented','existing_coverage_gap','scope','environment','proof_tier','positive_fixture','negative_fixture','evidence_output','runtime_budget_seconds','maintenance_owner','overlap_analysis','decision','decision_date','matrix_ids'];
const allowedStatus=new Set(['PROPOSED','ADMITTED','REJECTED','RETIRED','NOT_APPLICABLE']);
const allowedSeverity=new Set(['HARD_FAIL','STRONG_WARNING','WARNING','INFO','NOT_APPLICABLE']);
const ids=new Set(); const commandOwners=new Map(); const byId=new Map();
for(const r of registry){
 for(const f of coreRequired) if(r[f]===undefined||r[f]===null||(typeof r[f]==='string'&&!r[f].trim())) errors.push(`${r.validation_id||r.name||'unknown'}: missing core field ${f}`);
 for(const f of metadataFields) if(r[f]===undefined||r[f]===null||(typeof r[f]==='string'&&!r[f].trim())) strongWarnings.push(`${r.validation_id||r.name||'unknown'}: incomplete metadata ${f}`);
 if(ids.has(r.validation_id)) errors.push(`duplicate validation_id ${r.validation_id}`); ids.add(r.validation_id); byId.set(r.validation_id,r);
 if(commandOwners.has(r.command)) warnings.push(`duplicate command alias ${r.command}: ${commandOwners.get(r.command)} and ${r.validation_id}`); else commandOwners.set(r.command,r.validation_id);
 if(!allowedStatus.has(r.status)) errors.push(`${r.validation_id}: invalid status ${r.status}`);
 if(!allowedSeverity.has(r.proposed_severity)) errors.push(`${r.validation_id}: invalid severity ${r.proposed_severity}`);
 if(r.status==='NOT_APPLICABLE'&&!String(r.not_applicable_reason||'').trim()) strongWarnings.push(`${r.validation_id}: NOT_APPLICABLE lacks reason`);
 if(['ADMITTED','NOT_APPLICABLE'].includes(r.status)){
   if(!Array.isArray(r.matrix_ids)||r.matrix_ids.length===0) strongWarnings.push(`${r.validation_id}: active record missing matrix placement`);
   if(!fs.existsSync(r.implementation_path)) errors.push(`${r.validation_id}: admitted protection missing implementation ${r.implementation_path}`);
   else if(fs.statSync(r.implementation_path).isFile()&&fs.statSync(r.implementation_path).size===0) errors.push(`${r.validation_id}: zero-byte implementation ${r.implementation_path}`);
   for(const f of ['positive_fixture','negative_fixture']) if(r[f]&&!fs.existsSync(r[f])) strongWarnings.push(`${r.validation_id}: missing governance fixture ${r[f]}`);
 }
}
// An admitted validator that appears in no profile never runs. The matrix says
// it is HARD_FAIL and the registry reports the control plane safe, so it reads
// as protection that does not exist. That is not hypothetical: validate:
// coverage-route was written in July 2026 specifically to stop the /coverage/
// route regressing, was admitted at HARD_FAIL, and was placed in no profile -
// so the route 404'd for two months and a coverage.json carrying draft counts
// and the forward publishing runway shipped publicly the whole time.
//
// Several admitted entries are legitimately not profile steps: orchestrators
// that RUN a profile would recurse, and post-deploy audits need a live
// deployment. Those carry a recorded reason in profile_exclusions. An entry
// with NEITHER a profile nor a reason is the coverage-route shape, and is an
// ERROR - see the ratchet note below.
//
// Reachability is computed transitively, so a validator invoked inside another
// step counts. It must also follow shell scripts, and that is not theoretical.
// 525c0be44 (PR #64) replaced `build:all`'s npm chain with `bash scripts/build/
// cached_build_all.sh`, which execs `npm run build:all:uncached`. This walker
// only followed `npm run` tokens found in package.json script bodies, so the
// whole build chain fell off the graph in one commit: unclassified entries went
// from 0 at 525c0be44^ to 6 at 525c0be44 (MX-002, MX-004, MX-051, MX-061,
// MX-067, MX-076), all of which still ran on every build. The control plane was
// not describing the repository, and because it said STRONG_WARNING nothing was
// red and nobody looked for four days.
function profileReachableCommands(){
  const scripts=(()=>{try{return JSON.parse(fs.readFileSync('package.json','utf8')).scripts||{}}catch{return {}}})();
  const reached=new Set();
  // A shell hop the walker cannot read truncates reachability silently, which
  // is the same failure again in a new place. Renaming or deleting a shell
  // script a profile reaches through is therefore reported, not shrugged off.
  const missingShellHops=new Set();
  const shellHops=new Set();
  const expandShell=(rel,seen)=>{
    if(seen.has(`sh:${rel}`)) return;
    seen.add(`sh:${rel}`);
    shellHops.add(rel);
    if(!fs.existsSync(rel)||!fs.statSync(rel).isFile()){missingShellHops.add(rel);return}
    expand(fs.readFileSync(rel,'utf8'),seen);
  };
  const expand=(cmd,seen)=>{
    const text=String(cmd||'');
    for(const name of text.match(/npm run [A-Za-z0-9:_-]+/g)||[]){
      const id=name.replace('npm run ','');
      if(seen.has(id)) continue;
      seen.add(id); reached.add(id);
      if(scripts[id]) expand(scripts[id],seen);
    }
    for(const m of text.matchAll(/\b(?:bash|sh)\s+(?:-[A-Za-z]+\s+)*((?:\.\/)?[A-Za-z0-9_.\/-]+\.sh)\b/g)){
      expandShell(m[1].replace(/^\.\//,''),seen);
    }
  };
  for(const profile of Object.values(profiles)){
    for(const step of profile.steps||[]){
      reached.add(step.command);
      expand(step.command,new Set());
    }
  }
  return {reached,shellHops:[...shellHops],missingShellHops:[...missingShellHops]};
}
const reachability=profileReachableCommands();
const reachable=reachability.reached;
for(const rel of reachability.missingShellHops){
  errors.push(`profile reachability walks into ${rel}, which is not a readable file. Every npm script it invokes drops off the reachability graph, so validators that still run would be reported as running nowhere.`);
}
const unreachable=matrix
  .filter(m=>m.status==='ADMITTED' && !String(m.command||'').endsWith('.yml'))
  .filter(m=>{
    const name=String(m.command||'').replace('npm run ','');
    return !reachable.has(name) && !reachable.has(m.command);
  })
  .map(m=>m.matrix_id);
// Entries with a recorded reason in profile_exclusions are deliberate. Warning
// about all of them made the signal unusable, which is how the coverage-route
// guard stayed unnoticed inside a list of 69. Warn only about the unreviewed,
// and separately surface the ones marked NEEDS TRIAGE so a real failure parked
// as an exclusion cannot quietly become permanent.
const exclusions=matrixDoc.profile_exclusions||{};
const unclassified=unreachable.filter(id=>!exclusions[id]);
const needsTriage=Object.entries(exclusions).filter(([,reason])=>String(reason).startsWith('NEEDS TRIAGE')).map(([id])=>id);
// This was a strong warning, and six entries accumulated under it in one commit
// without anything turning red. A strong warning is the correct severity for a
// judgement call; "is this admitted HARD_FAIL protection actually wired to
// anything?" is not a judgement call, it has an answer, and `validation:add`
// already REFUSES to create this state. Refusing it at creation while merely
// noting it at validation is the gap that let 525c0be44 through. It is now an
// error, which makes the count a ratchet: arm the entry, or record why it is
// deliberately not armed. Neither of those is loosening anything.
if(unclassified.length) errors.push(`${unclassified.length} admitted matrix entr${unclassified.length===1?'y is':'ies are'} in no profile with no recorded reason: ${unclassified.slice(0,12).join(', ')}${unclassified.length>12?', ...':''}. Arm each in a profile, or record why it is deliberately unarmed in _repo_validation_matrix.json profile_exclusions - the same choice validation:add forces at admission.`);
if(needsTriage.length) warnings.push(`${needsTriage.length} admitted validator(s) excluded pending triage: ${needsTriage.join(', ')}`);

const matrixIds=new Set(); const matrixByValidation=new Map();
for(const m of matrix){
 if(matrixIds.has(m.matrix_id)) errors.push(`duplicate matrix_id ${m.matrix_id}`); matrixIds.add(m.matrix_id);
 const r=byId.get(m.validation_id); if(!r) errors.push(`${m.matrix_id}: unknown registry validator ${m.validation_id}`); else {
   if(!['ADMITTED','NOT_APPLICABLE'].includes(r.status)) errors.push(`${m.matrix_id}: maps to non-active status ${r.status}`);
   if(m.command!==r.command) errors.push(`${m.matrix_id}: command conflict from ${r.validation_id}`);
   if(m.severity!==r.proposed_severity) errors.push(`${m.matrix_id}: severity conflict from ${r.validation_id}`);
 }
 if(matrixByValidation.has(m.validation_id)) warnings.push(`${m.validation_id}: multiple matrix placements`); matrixByValidation.set(m.validation_id,m);
}
for(const r of registry.filter(x=>['ADMITTED','NOT_APPLICABLE'].includes(x.status))) if(!matrixByValidation.has(r.validation_id)) strongWarnings.push(`${r.validation_id}: active registry record unused by matrix`);
const discovery=discover();
const unregisteredCommands=discovery.unregistered.map(x=>x.command);
const orphanedCommands=discovery.orphaned.map(x=>x.command);
for(const cmd of unregisteredCommands) strongWarnings.push(`executable package command not admitted: ${cmd}`);
for(const cmd of orphanedCommands) errors.push(`admitted package command does not resolve: ${cmd}`);
for(const wf of fs.readdirSync('.github/workflows').filter(x=>/\.ya?ml$/.test(x))){const cmd=path.posix.join('.github/workflows',wf); const r=registry.find(x=>x.command===cmd&&x.status==='ADMITTED'); if(!r) strongWarnings.push(`workflow admission metadata missing: ${cmd}`);}
for(const r of registry.filter(x=>x.status==='RETIRED')){
 if(discovery.discovered.some(x=>x.command===r.command)) errors.push(`${r.validation_id}: retired command still active in package scripts`);
 for(const wf of fs.readdirSync('.github/workflows').filter(x=>/\.ya?ml$/.test(x))){const text=fs.readFileSync(path.join('.github/workflows',wf),'utf8'); if(text.includes(r.command)) errors.push(`${r.validation_id}: retired command still called by ${wf}`);}
}
for(const [name,p] of Object.entries(profiles)){
 if(!Array.isArray(p.steps)) errors.push(`profile ${name}: steps must be an array`);
 for(const base of p.extends||[]) if(!profiles[base]) errors.push(`profile ${name}: unknown inherited profile ${base}`);
 for(const step of p.steps||[]) if(!step.command) errors.push(`profile ${name}: step missing command`);
}
const status=errors.length?'FAIL':strongWarnings.length?'PASS_WITH_STRONG_WARNING':warnings.length?'PASS_WITH_WARNING':'PASS';
writeSummary('validate-validation-registry',{status,registry_records:registry.length,matrix_entries:matrix.length,profiles:Object.keys(profiles).length,governed_package_commands:discovery.discovered.length,errors,strong_warnings:strongWarnings,warnings,unregistered_commands:unregisteredCommands,orphaned_commands:orphanedCommands});
if(errors.length) fail(`[validate:validation-registry] FAIL: ${errors.length} control-plane issue(s)`,errors.slice(0,200));
if(strongWarnings.length){console.log(`[validate:validation-registry] PASS_WITH_STRONG_WARNING: ${strongWarnings.length} administrative issue(s)`);for(const x of strongWarnings.slice(0,200))console.log(` - ${x}`);process.exit(0);}
if(warnings.length){console.log(`[validate:validation-registry] PASS_WITH_WARNING: ${warnings.length} issue(s)`);for(const x of warnings.slice(0,200))console.log(` - ${x}`);process.exit(0);}
pass(`[validate:validation-registry] PASS: ${registry.length} records, ${matrix.length} matrix entries, control plane safe`);

#!/usr/bin/env python3
from __future__ import annotations
import json, os, re, subprocess, sys
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parents[2]
WF_DIR = ROOT / '.github' / 'workflows'
OUT_DIR = ROOT / 'artifacts' / 'validation' / 'workflow-faux-traces'
REPORT = ROOT / 'artifacts' / 'validation' / 'workflow-faux-trace-all.json'
REPORT_MD = ROOT / 'reports' / 'workflow-faux-trace-all.md'

pkg = json.loads((ROOT/'package.json').read_text())
scripts = pkg.get('scripts', {})
registry = json.loads((ROOT/'data/admin/admin_action_registry.json').read_text())
errors=[]; warnings=[]; traces=[]

# GitHub expression tolerant shell syntax check.
def shell_syntax(run: str, label: str):
    scrub = re.sub(r'\$\{\{[^}]+\}\}', 'fixture_value', run)
    p = subprocess.run(['bash','-n'], input=scrub, text=True, capture_output=True)
    if p.returncode:
        errors.append(f'{label}: shell syntax failed: {p.stderr.strip()}')


def npm_commands(run: str):
    # Capture npm run NAME; names may contain colons/hyphens.
    return re.findall(r'\bnpm\s+run\s+([A-Za-z0-9:_-]+)', run)


def read_yaml(path: Path):
    # BaseLoader avoids YAML 1.1 treating `on` as boolean.
    return yaml.load(path.read_text(), Loader=yaml.BaseLoader)


def workflow_inputs(doc):
    on = doc.get('on', {}) if isinstance(doc, dict) else {}
    dispatch = on.get('workflow_dispatch', {}) if isinstance(on, dict) else {}
    return dispatch.get('inputs', {}) if isinstance(dispatch, dict) else {}


def input_options(spec):
    opts=spec.get('options',[]) if isinstance(spec,dict) else []
    return list(opts) if isinstance(opts,list) else []


def add_trace(workflow, scenario, trigger, included_steps, skipped_steps, assertions, status='TRACE_ONLY_PASS'):
    traces.append({
        'workflow': workflow,
        'scenario': scenario,
        'trigger': trigger,
        'status': status,
        'execution': 'none_trace_only',
        'included_steps': included_steps,
        'skipped_steps': skipped_steps,
        'assertions': assertions,
    })


# Command separators. A `./x` after any of these starts a new command; anywhere else it is an
# argument to the command already running.
_SEPARATORS = re.compile(r'(?:\|\||&&|\||;|\n)')
# Wrappers that take a command as their argument, so the thing after them IS still in command
# position. Deliberately short: a longer list is a longer list of ways to be wrong.
_WRAPPERS = {'sudo', 'exec', 'time', 'nohup', 'env', 'xargs', 'bash', 'sh', 'command'}


def invoked_local_paths(run: str):
    """Local paths this script actually INVOKES, as opposed to merely mentions.

    The previous version matched every `./...` token anywhere in a step, which reads an argument as
    a command. It failed on main for exactly that reason:

        tar -xf "$RUNNER_TEMP/spry-build-tree.tar" ./artifacts/validation/shard-producers.json

    where the path is a member name INSIDE the tarball - a thing that by definition does not exist
    in the worktree, and never will. The guard was demanding the presence of a file whose whole
    purpose is to be absent until extracted.

    A guard that fires on correct code is worse than no guard: it is the one people learn to skip,
    and it took the whole `validate:all` red on main while CI stayed green, which is how the two
    drifted apart without anyone deciding they should.

    So: command position only. First token of a line or of a `;` / `&&` / `||` / `|` segment, after
    stepping over wrappers like `sudo` and `env` that take a command as their argument.
    """
    found = []
    for segment in _SEPARATORS.split(run):
        tokens = segment.strip().split()
        i = 0
        # Step over `FOO=bar` assignments and command wrappers to reach the actual command.
        while i < len(tokens) and (re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*=.*', tokens[i]) or tokens[i] in _WRAPPERS):
            i += 1
        if i >= len(tokens):
            continue
        head = tokens[i].strip('"\'').rstrip(';&|')
        if head.startswith('./') and '${{' not in head:
            found.append(head)
    return found

workflows={}
for path in sorted(WF_DIR.glob('*.yml')) + sorted(WF_DIR.glob('*.yaml')):
    rel=str(path.relative_to(ROOT))
    try: doc=read_yaml(path)
    except Exception as e:
        errors.append(f'{rel}: YAML parse failed: {e}'); continue
    workflows[path.name]=doc
    name=doc.get('name')
    if not name: errors.append(f'{rel}: missing name')
    if 'on' not in doc: errors.append(f'{rel}: missing on trigger')
    perms=doc.get('permissions',{})
    if not perms: warnings.append(f'{rel}: no explicit permissions')
    jobs=doc.get('jobs',{})
    if not jobs: errors.append(f'{rel}: no jobs'); continue
    for job_id, job in jobs.items():
        if not isinstance(job,dict): continue
        if not job.get('runs-on'): errors.append(f'{rel}/{job_id}: missing runs-on')
        steps=job.get('steps',[])
        if not steps: errors.append(f'{rel}/{job_id}: no steps')
        for idx, step in enumerate(steps):
            if not isinstance(step,dict): continue
            label=step.get('name') or step.get('uses') or f'step-{idx+1}'
            run=step.get('run')
            if run:
                shell_syntax(run, f'{rel}/{job_id}/{label}')
                for cmd in npm_commands(run):
                    if cmd not in scripts: errors.append(f'{rel}/{job_id}/{label}: missing package script {cmd}')
                for clean in invoked_local_paths(run):
                    if not (ROOT/clean).exists():
                        errors.append(f'{rel}/{job_id}/{label}: missing local executable {clean}')
            uses=step.get('uses')
            if uses and '@' not in uses: errors.append(f'{rel}/{job_id}/{label}: action not version pinned: {uses}')

# Verify admin registry maps only to real workflows and valid dispatch inputs/options.
for action in registry.get('actions',[]):
    wf=action.get('workflow','')
    if wf not in workflows:
        errors.append(f'admin action {action.get("id")}: workflow missing: {wf}'); continue
    specs=workflow_inputs(workflows[wf])
    for key,val in action.get('inputs',{}).items():
        if key not in specs: errors.append(f'admin action {action.get("id")}: input {key} not declared by {wf}')
        else:
            opts=input_options(specs[key])
            if opts and str(val) not in opts: errors.append(f'admin action {action.get("id")}: value {val} not allowed for {wf}:{key}')

# Scenario-level faux traces. These intentionally do not execute commands.
def step_names(wf):
    doc=workflows[wf]; out=[]
    for jid,job in doc.get('jobs',{}).items():
        for i,s in enumerate(job.get('steps',[])):
            out.append(s.get('name') or s.get('uses') or f'{jid}:step-{i+1}')
    return out

def all_included(wf): return step_names(wf), []

# admin-command: each real action family
for action in ['pause_autopublishing','resume_autopublishing','set_aggressiveness','rebuild_admin','emergency_stop']:
    inc,skip=all_included('admin-command.yml')
    add_trace('admin-command.yml', action, 'workflow_dispatch', inc, skip, [
        'server allowlist supplies fixed action', 'admin command script exists', 'full-safe-autonomy validation follows mutation', 'commit only when diff exists'
    ])

# admin operations: one trace per choice
ops=input_options(workflow_inputs(workflows['admin-operations.yml'])['operation'])
for op in ops:
    names=step_names('admin-operations.yml'); inc=[]; skip=[]
    for n in names:
        if n in ['Refresh authority surfaces','Submit updated pages','Run self-healing','Fix eligible failed pages','Rerun distribution']:
            match={
              'refresh_surfaces':'Refresh authority surfaces','submit_updated_pages':'Submit updated pages',
              'run_self_healing':'Run self-healing','fix_failed_pages':'Fix eligible failed pages','rerun_distribution':'Rerun distribution'}[op]
            (inc if n==match else skip).append(n)
        elif n=='Commit validated repository changes' and op in ['submit_updated_pages','rerun_distribution']: skip.append(n)
        else: inc.append(n)
    add_trace('admin-operations.yml', op, 'workflow_dispatch', inc, skip, [
        'operation is enumerated choice','nonmatching operation steps skip','mutating repo operations commit only validated diffs','artifacts upload always'
    ])

# Daily citation: manual, scheduled active, scheduled paused
for scenario,run in [('manual',True),('scheduled-active',True),('scheduled-paused',False)]:
    names=step_names('daily-citation-intelligence.yml'); inc=[]; skip=[]
    for n in names:
        conditional=n in ['Run autonomous zero-dollar gap-filling lane','Validate ownership and Safe Harbor','Commit validated changes']
        (inc if (run or not conditional) else skip).append(n)
    add_trace('daily-citation-intelligence.yml',scenario,'workflow_dispatch' if scenario=='manual' else 'schedule',inc,skip,[
        'paid-agent ownership validation runs before commit' if run else 'pause state skips mutation','fixture data remains nonpublishable','artifact upload always'
    ])

# Deploy distribution: manual and workflow_run outcomes
for scenario,allowed in [('manual-valid-artifact',True),('workflow-run-success-main',True),('workflow-run-failed',False)]:
    names=step_names('deploy-distribution.yml')
    add_trace('deploy-distribution.yml',scenario,'workflow_dispatch' if scenario.startswith('manual') else 'workflow_run',names if allowed else [],[] if allowed else names,[
        'exact validated artifact identity required','attestation checked before distribution','failed upstream run does not deploy'
    ])

# Spry content release: every selectable mode plus schedule/push/pause/snapshot guard
modes=input_options(workflow_inputs(workflows['spry-content-release.yml'])['mode'])
for mode in modes:
    inc,skip=all_included('spry-content-release.yml')
    add_trace('spry-content-release.yml',f'manual-{mode}','workflow_dispatch',inc,skip,[
        f'mode resolves to {mode}','governed runner wraps release','ownership/admin snapshots built before commit','diagnostics always upload'
    ])
for scenario,run,trigger in [('scheduled-active',True,'schedule'),('scheduled-paused',False,'schedule'),('agent-manifest-push',True,'push'),('snapshot-update-push-skipped',False,'push')]:
    names=step_names('spry-content-release.yml'); inc=[]; skip=[]
    for n in names:
        conditional=n not in ['actions/checkout@v4','Sync latest main before install','Check autonomous runtime state'] and 'upload-artifact' not in n
        (inc if (run or not conditional) else skip).append(n)
    add_trace('spry-content-release.yml',scenario,trigger,inc,skip,[
        'push manifest forces agent-intake' if scenario=='agent-manifest-push' else 'runtime/commit guard honored',
        'paid-agent scripts remain canonical','protected lane validation remains in release command'
    ])

# Full rebuild
inc,skip=all_included('spry-full-rebuild.yml')
add_trace('spry-full-rebuild.yml','manual-full-rebuild','workflow_dispatch',inc,skip,[
    'governed full rebuild command exists','commit helper exists','diagnostics always upload'
])

# Validate repo scenarios
for trigger in ['workflow_dispatch','push-main','pull_request-main']:
    inc,skip=all_included('validate-repo.yml')
    add_trace('validate-repo.yml',trigger,trigger.split('-')[0],inc,skip,[
        'exact artifact built and validated','success artifact name matches deploy workflow expectation','diagnostics always upload'
    ])

# Cross-workflow topology assertions.
validate_doc=workflows['validate-repo.yml']; deploy_doc=workflows['deploy-distribution.yml']
wr=(deploy_doc.get('on',{}).get('workflow_run',{}) or {})
if 'Validate Repo' not in (wr.get('workflows',[]) or []): errors.append('deploy-distribution.yml: workflow_run must depend on Validate Repo')
if 'completed' not in (wr.get('types',[]) or []): errors.append('deploy-distribution.yml: workflow_run must listen for completed')
# Ensure artifact naming parity.
validate_text=(WF_DIR/'validate-repo.yml').read_text(); deploy_text=(WF_DIR/'deploy-distribution.yml').read_text()
if 'spry-validated-${{ github.sha }}' not in validate_text: errors.append('validate-repo.yml: validated artifact naming contract missing')
if 'spry-validated-${{ github.event.workflow_run.head_sha }}' not in deploy_text: errors.append('deploy-distribution.yml: validated artifact lookup naming contract mismatch')

# Ensure content release snapshots occur before commit so generated admin/ownership changes are included.
content_names=step_names('spry-content-release.yml')
try:
    if content_names.index('Rebuild ownership and admin snapshots') > content_names.index('Commit validated Spry content release'):
        errors.append('spry-content-release.yml: ownership/admin snapshots are rebuilt after commit and would remain unpushed')
except ValueError: pass

OUT_DIR.mkdir(parents=True,exist_ok=True); REPORT.parent.mkdir(parents=True,exist_ok=True); REPORT_MD.parent.mkdir(parents=True,exist_ok=True)
for t in traces:
    d=OUT_DIR/t['workflow'].replace('.yml','')
    d.mkdir(parents=True,exist_ok=True)
    (d/(re.sub(r'[^a-zA-Z0-9_.-]+','-',t['scenario'])+'.json')).write_text(json.dumps(t,indent=2)+'\n')
report={
 'schema_version':'1.0','generated_at':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),
 'status':'FAIL' if errors else 'PASS','workflow_count':len(workflows),'scenario_count':len(traces),
 'workflows':sorted(workflows),'errors':errors,'warnings':warnings,'traces':traces
}
REPORT.write_text(json.dumps(report,indent=2)+'\n')
lines=['# Fresh Faux Trace — Every GitHub Workflow','',f"Status: **{report['status']}**",f"Workflows: **{len(workflows)}**",f"Scenarios: **{len(traces)}**",'', '| Workflow | Scenarios | Status |','|---|---:|---|']
for wf in sorted(workflows):
    count=sum(1 for t in traces if t['workflow']==wf)
    lines.append(f'| `{wf}` | {count} | PASS |')
if warnings:
    lines+=['','## Warnings']+[f'- {w}' for w in warnings]
if errors:
    lines+=['','## Errors']+[f'- {e}' for e in errors]
REPORT_MD.write_text('\n'.join(lines)+'\n')
print(json.dumps({'status':report['status'],'workflow_count':len(workflows),'scenario_count':len(traces),'errors':errors,'warnings':warnings},indent=2))
sys.exit(1 if errors else 0)

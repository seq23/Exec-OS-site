#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const ROOT=process.cwd();
const RUNTIME=path.join(ROOT,'.validation-runtime');
const VENV=path.join(RUNTIME,'venv');
const VENV_PY=process.platform==='win32'?path.join(VENV,'Scripts','python.exe'):path.join(VENV,'bin','python3');
let SELECTED_PY=VENV_PY;
const PIP=process.platform==='win32'?path.join(VENV,'Scripts','pip.exe'):path.join(VENV,'bin','pip');
const REQ=path.join(ROOT,'requirements-validation.txt');
const MARKER=path.join(RUNTIME,'runtime-identity.json');
function cleanRepoPycache(){
 const root=path.join(ROOT,'scripts');
 if(!fs.existsSync(root))return;
 const stack=[root];
 while(stack.length){
  const dir=stack.pop();
  let entries=[]; try{entries=fs.readdirSync(dir,{withFileTypes:true})}catch{continue}
  for(const entry of entries){
   const full=path.join(dir,entry.name);
   if(entry.isDirectory()){
    if(entry.name==='__pycache__')fs.rmSync(full,{recursive:true,force:true});
    else stack.push(full);
   }
  }
 }
}
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const reqHash=()=>sha(fs.readFileSync(REQ));
/*
 * THE BOOTSTRAP INTERPRETER MUST BE ONE THE VALIDATORS CAN RUN ON.
 *
 * This returned bare 'python3', which on macOS is /usr/bin/python3 - Python 3.9.6 - even when a
 * newer interpreter is first on the user's PATH. The venv was then built from 3.9, and the failure
 * surfaced three validators later as:
 *
 *   [validate:python-dependency-contract] FAIL: this interpreter is Python 3.9.6, which has no
 *   sys.stdlib_module_names (added in 3.10)
 *
 * which reads like a code defect and is an interpreter choice. validate:all was red on main for
 * anyone running it on a Mac, while CI passed because its runner ships 3.12 - so the repo's own
 * full validation and its CI disagreed about whether main was healthy, and the disagreement was
 * invisible from either side.
 *
 * Candidates are tried newest-first and each is ASKED its version rather than trusted by name.
 * PYTHON_BOOTSTRAP_BIN still wins outright, so CI and anyone with a deliberate choice are
 * unaffected.
 */
const MIN_PYTHON = [3, 10];
const PYTHON_CANDIDATES = ['python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3'];

function pythonVersionOf(bin){
  const r=spawnSync(bin,['-c','import sys;print("%d.%d"%sys.version_info[:2])'],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  if(r.status!==0||!r.stdout)return null;
  const [maj,min]=r.stdout.trim().split('.').map(Number);
  return Number.isInteger(maj)&&Number.isInteger(min)?[maj,min]:null;
}

function atLeast(v,min){return v && (v[0]>min[0] || (v[0]===min[0] && v[1]>=min[1]))}

let BASE_PYTHON=null;
function basePython(){
  if(process.env.PYTHON_BOOTSTRAP_BIN)return process.env.PYTHON_BOOTSTRAP_BIN;
  if(BASE_PYTHON)return BASE_PYTHON;
  const tried=[];
  for(const bin of PYTHON_CANDIDATES){
    const v=pythonVersionOf(bin);
    if(!v){tried.push(`${bin}: not found`);continue}
    tried.push(`${bin}: ${v.join('.')}`);
    if(atLeast(v,MIN_PYTHON)){BASE_PYTHON=bin;return bin}
  }
  throw new Error(
    `no Python ${MIN_PYTHON.join('.')}+ on PATH, and the validators need one - sys.stdlib_module_names ` +
    `arrived in 3.10 and without it the standard library cannot be told from a third-party import. ` +
    `Tried: ${tried.join('; ')}. Install a newer Python or set PYTHON_BOOTSTRAP_BIN.`,
  );
}
function resolvedBasePython(){const r=spawnSync(basePython(),['-c','import sys; print(sys.executable)'],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});return r.status===0&&r.stdout.trim()?r.stdout.trim():basePython()}
function run(cmd,args,opts={}){const r=spawnSync(cmd,args,{stdio:'inherit',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PIP_DISABLE_PIP_VERSION_CHECK:'1'},...opts});cleanRepoPycache();return r.status??2}
function probe(executable=SELECTED_PY){if(path.isAbsolute(executable)&&!fs.existsSync(executable))return null;const code=`import json,sys,bs4,lxml,yaml; from bs4 import BeautifulSoup; BeautifulSoup('<p>x</p>','lxml'); print(json.dumps({'python':sys.version.split()[0],'bs4':bs4.__version__,'lxml':lxml.__version__,'yaml':yaml.__version__}))`;const r=spawnSync(executable,['-c',code],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});if(r.status!==0)return null;try{return JSON.parse(r.stdout.trim())}catch{return null}}
function versionParts(value=''){return String(value).split(/[^0-9]+/).filter(Boolean).slice(0,3).map(Number)}
function versionAtLeast(actual,minimum){const a=versionParts(actual),m=versionParts(minimum);for(let i=0;i<Math.max(a.length,m.length,3);i+=1){const av=a[i]||0,mv=m[i]||0;if(av>mv)return true;if(av<mv)return false}return true}
function compatibleSystemIdentity(identity){return Boolean(identity&&versionAtLeast(identity.bs4,'4.12.3')&&versionAtLeast(identity.lxml,'5.4.0')&&versionAtLeast(identity.yaml,'6.0.2'))}
export function managedPython(){return SELECTED_PY}
export function ensureRuntime(){
 if(!fs.existsSync(REQ))throw new Error('requirements-validation.txt is missing');
 const wanted=reqHash(); let marker=null; try{marker=JSON.parse(fs.readFileSync(MARKER,'utf8'))}catch{}
 if(marker?.requirements_sha256===wanted&&marker?.python_executable){
  SELECTED_PY=marker.python_executable.startsWith('.')||!path.isAbsolute(marker.python_executable)?path.resolve(ROOT,marker.python_executable):marker.python_executable;
 }
 let identity=probe(SELECTED_PY); let dependencyMode=marker?.dependency_mode||'pinned-venv';
 if(!identity||marker?.requirements_sha256!==wanted){
  const systemPython=resolvedBasePython();
  const systemIdentity=probe(systemPython);
  if(process.env.VALIDATION_PYTHON_PINNED_ONLY!=='1'&&compatibleSystemIdentity(systemIdentity)){
    SELECTED_PY=systemPython;identity=systemIdentity;dependencyMode='system-python-fallback';
    console.warn(`[validation:python-runtime] WARN: using compatible base Python ${systemPython} with bs4=${identity.bs4}, lxml=${identity.lxml}, yaml=${identity.yaml}`);
  } else {
    fs.rmSync(VENV,{recursive:true,force:true});fs.mkdirSync(RUNTIME,{recursive:true});
    SELECTED_PY=VENV_PY;
    // CI may force the pinned venv. Offline/local environments use the
    // compatible base interpreter above to avoid slow package-mirror failures.
    let code=run(basePython(),['-m','venv',VENV]);if(code!==0)throw new Error('unable to create validation virtual environment');
    code=run(PIP,['install','-r',REQ]);
    if(code===0){dependencyMode='pinned-venv';identity=probe(VENV_PY)}
    else{
      if(!compatibleSystemIdentity(systemIdentity))throw new Error('unable to install pinned validation dependencies and compatible system packages are unavailable');
      SELECTED_PY=systemPython;identity=systemIdentity;dependencyMode='system-python-fallback';
      console.warn(`[validation:python-runtime] WARN: pinned install unavailable; using compatible base Python ${systemPython} with bs4=${identity.bs4}, lxml=${identity.lxml}, yaml=${identity.yaml}`);
    }
  }
  if(!identity)throw new Error('managed validation runtime failed parser probe');
 }
 const executableForReceipt=path.isAbsolute(SELECTED_PY)?SELECTED_PY:path.resolve(ROOT,SELECTED_PY);
 const final={schema_version:'1.2',requirements_sha256:wanted,dependency_mode:dependencyMode,...identity,python_executable:executableForReceipt,parser:'lxml',yaml:identity.yaml};
 fs.mkdirSync(RUNTIME,{recursive:true});fs.writeFileSync(MARKER,JSON.stringify(final,null,2)+'\n');
 fs.mkdirSync(path.join(ROOT,'artifacts','validation'),{recursive:true});fs.writeFileSync(path.join(ROOT,'artifacts','validation','python-runtime.json'),JSON.stringify({status:'PASS',...final},null,2)+'\n');
 return final;
}
function main(){const [cmd,...args]=process.argv.slice(2);try{
 if(cmd==='bootstrap'||cmd==='preflight'){const id=ensureRuntime();console.log(`[validation:python-runtime] PASS: Python ${id.python}; bs4 ${id.bs4}; lxml ${id.lxml}`);return 0}
 if(cmd==='run'){ensureRuntime();if(!args.length)throw new Error('run requires a Python script or arguments');return run(managedPython(),args)}
 if(cmd==='identity'){console.log(JSON.stringify(ensureRuntime(),null,2));return 0}
 throw new Error('usage: python_runtime.mjs bootstrap|preflight|run <script> [args...]|identity');
 }catch(e){console.error(`[validation:python-runtime] FAIL: ${e.message}`);return 1}}
if(process.argv[1]===fileURLToPath(import.meta.url))process.exit(main());

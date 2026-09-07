#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json, os, subprocess, sys
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path.cwd()
MODE = sys.argv[1] if len(sys.argv) > 1 else ''
SNAP = ROOT / 'artifacts/validation/extraction-surface-snapshot.json'
OUT = ROOT / 'artifacts/validation/extraction-surface-guard.json'
VENDOR = ROOT / 'scripts/_vendor'
if VENDOR.is_dir():
    sys.path.insert(0, str(VENDOR))
from bs4 import BeautifulSoup


def sha(value: object) -> str:
    payload = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def html_surface(path: Path) -> dict:
    raw = path.read_text(encoding='utf-8', errors='ignore')
    soup = BeautifulSoup(raw, 'lxml')
    blocks = soup.select('[data-llm-answer="true"]')
    schemas = []
    for node in soup.select('script[type="application/ld+json"]'):
        node_id = node.get('id', '')
        if node_id in {'CITATION_PAGE_SCHEMA', 'BHPC_CITATION_SCHEMA'}:
            text = node.string or node.get_text() or ''
            try:
                parsed = json.loads(text)
            except Exception:
                parsed = text.strip()
            schemas.append({'id': node_id, 'data': parsed})
    return {
        'blocks': [
            {
                'type': block.get('data-extraction-type'),
                'framework': block.get('data-named-framework'),
                'html': str(block),
            }
            for block in blocks
        ],
        'schemas': sorted(schemas, key=lambda item: item['id']),
    }


def projection(path: str, rows: list[dict], fields: tuple[str, ...]) -> list[dict]:
    projected = []
    for row in rows:
        projected.append({field: row.get(field) for field in fields})
    projected.sort(key=lambda row: json.dumps(row, sort_keys=True, ensure_ascii=False))
    return projected


def hard_fail(message: str) -> None:
    print(f'[extraction-surface-guard] FAIL: {message}', file=sys.stderr)
    raise SystemExit(1)


def build_state() -> dict[str, str]:
    citable = json.loads((ROOT / 'data/citation/citable_pages.json').read_text(encoding='utf-8'))
    query_registry = json.loads((ROOT / 'data/citation/query_registry.json').read_text(encoding='utf-8'))
    admission = json.loads((ROOT / 'data/content/page_admission_registry.json').read_text(encoding='utf-8'))

    # Each of the three registries below is hashed independently, and each can
    # empty on its own. sha() of an empty projection is a perfectly stable
    # constant, so an emptied registry snapshots and re-checks clean forever.
    if not citable.get('pages'):
        hard_fail('data/citation/citable_pages.json lists no pages; expected at least one governed page. '
                  'Hashing an empty governed set proves nothing.')
    if not query_registry.get('queries'):
        hard_fail('data/citation/query_registry.json lists no queries; expected at least one query owner. '
                  'Hashing an empty registry projection proves nothing.')
    if not admission.get('records'):
        hard_fail('data/content/page_admission_registry.json lists no records; expected at least one admitted page. '
                  'Hashing an empty registry projection proves nothing.')

    state: dict[str, str] = {}
    # `if page.is_file()` used to drop a governed page that is not on disk. That
    # is the one failure this guard should shout about: a governed HTML surface
    # can disappear and the run still prints PASS because its hash simply left
    # the state. A missing governed page is now reported instead of dropped.
    missing = []
    for row in citable.get('pages', []):
        rel = row.get('path', '')
        page = ROOT / rel
        if page.is_file():
            state[f'html:{rel}'] = sha(html_surface(page))
        else:
            missing.append(rel)
    if missing:
        hard_fail(f'{len(missing)} governed page(s) named in data/citation/citable_pages.json are not files on disk, '
                  f'so their extraction surfaces were never hashed: {", ".join(sorted(missing)[:20])}')
    # A run that hashed no HTML surface at all protects no extraction block and
    # no citation schema, and `check` would then compare two empty states as PASS.
    if not any(key.startswith('html:') for key in state):
        hard_fail('hashed 0 HTML extraction surfaces; expected one per page in data/citation/citable_pages.json. '
                  'A surface guard that reads no page proves nothing.')

    state['registry:citable-pages'] = sha(projection(
        'citable-pages', citable.get('pages', []),
        ('path', 'canonical_url', 'query', 'framework', 'extraction_type', 'schema_type', 'status')
    ))
    state['registry:query-owners'] = sha(projection(
        'query-owners', query_registry.get('queries', []),
        ('query_id', 'query', 'intent_class', 'primary_page', 'canonical_domain', 'release_status', 'aliases')
    ))
    state['registry:page-admission'] = sha(projection(
        'page-admission', admission.get('records', []),
        ('path', 'canonical_domain', 'generation_lane', 'admission_level', 'status', 'primary_query', 'intent', 'framework', 'artifact_type')
    ))
    return state


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, sort_keys=True, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


def git(*argv: str) -> subprocess.CompletedProcess:
    return subprocess.run(['git', *argv], cwd=ROOT, capture_output=True, text=True)


def baseline_provenance() -> str:
    """Why is the snapshot file not on disk?

    'removed'   - this repository has carried this baseline; its absence is a
                  deletion, not a first run.
    'new'       - a git worktree that has never carried it: a real bootstrap.
    'unknown'   - not a git worktree, so nothing can be established either way.

    This distinction is the whole guard. `snapshot` runs immediately before
    `check`, so a missing baseline means `snapshot` writes one and `check` then
    compares the tree against a file written seconds earlier by the same run -
    the "grades its own answer sheet" failure this pair was moved ahead of
    build:all to fix, reachable again through the bootstrap path. Reproduced on
    main at 51117429c: `rm artifacts/validation/extraction-surface-snapshot.json`
    made both steps exit 0 while asserting nothing across 2,233 governed
    surfaces. The registry record for VAL-EXTRACTION-SURFACE-GUARD-SNAPSHOT
    already names this exact risk - "without the snapshot the check below has no
    baseline and silently passes" - and the code did not enforce it.
    """
    if git('rev-parse', '--is-inside-work-tree').stdout.strip() != 'true':
        return 'unknown'
    rel = SNAP.relative_to(ROOT).as_posix()
    if git('ls-files', '--error-unmatch', '--', rel).returncode == 0:
        return 'removed'
    if git('cat-file', '-e', f'HEAD:{rel}').returncode == 0:
        return 'removed'
    # Covers a committed deletion, and a shallow clone too: the commit that
    # removed the path is itself a commit that touches the path.
    if git('log', '-1', '--format=%H', '--all', '--', rel).stdout.strip():
        return 'removed'
    return 'new'


state = build_state()
if MODE == 'snapshot':
    # container-prepush runs `snapshot` at step 44 and `check` at step 58, and
    # `snapshot` used to overwrite the very baseline `check` then compares the tree
    # against. So the guard graded its own answer sheet: it could not fail, no
    # matter how far the governed surfaces had drifted. Reproduced on this tree -
    # `check` alone against the committed snapshot reported 50 changed surfaces and
    # exited 1; running `snapshot` first changed the snapshot's sha and `check`
    # then reported 0 and exited 0. On a pristine main the same masked drift is
    # 2,214 surfaces, all of it from a bot commit that rewrote 2,137 pages and never
    # re-derived this file.
    #
    # Re-baselining is not a validation step. It is an assertion that the current
    # surfaces are reviewed and correct, which is a human decision, so it now
    # requires saying so explicitly. Absent that, `snapshot` reports the drift and
    # fails instead of quietly absorbing it. A missing snapshot is written only
    # when it has genuinely never existed here - see baseline_provenance(),
    # because `rm <snapshot>` was otherwise a silent rebaseline of the whole set.
    if SNAP.exists():
        previous = json.loads(SNAP.read_text(encoding='utf-8'))
        drifted = [key for key in sorted(set(previous) | set(state)) if previous.get(key) != state.get(key)]
        if drifted and not os.environ.get('EXTRACTION_SURFACE_REBASELINE'):
            print(f'[extraction-surface-guard] FAIL: {len(drifted)} governed surface(s) differ from '
                  f'{SNAP.relative_to(ROOT)}, and overwriting it here would erase the only evidence that they drifted.')
            for key in drifted[:50]:
                print(' -', key)
            print('Re-baselining asserts these surfaces are reviewed and correct. If they are, re-run with '
                  'EXTRACTION_SURFACE_REBASELINE=1 and commit the snapshot alongside the pages that changed it.')
            raise SystemExit(1)
    else:
        provenance = baseline_provenance()
        if provenance == 'removed':
            hard_fail(
                f'{SNAP.relative_to(ROOT)} is absent but this repository has carried it, so this is a removal '
                'rather than a first run. Writing a fresh baseline here would hand `check` a file this same run '
                f'just produced, and {len(state)} governed surface(s) would pass unasserted. Restore the committed '
                'snapshot (git checkout -- ' + str(SNAP.relative_to(ROOT)) + '), or, if the surfaces really are '
                'reviewed and correct, restore it and re-run with EXTRACTION_SURFACE_REBASELINE=1 so the drift is '
                'stated rather than erased.')
        if provenance == 'unknown':
            print('[extraction-surface-guard] NAMED STOP no-baseline-provenance: '
                  f'{SNAP.relative_to(ROOT)} is absent and this tree is not a git worktree, so whether it was '
                  'removed or never existed cannot be established. Writing the baseline for the first time.')
        else:
            print(f'[extraction-surface-guard] bootstrap: {SNAP.relative_to(ROOT)} has never existed in this '
                  'repository; writing the first baseline, which asserts nothing about the surfaces yet.')
    write_json(SNAP, state)
    print(f'[extraction-surface-guard] snapshot {len(state)} governed surfaces')
    raise SystemExit(0)
if MODE == 'check':
    if not SNAP.exists():
        # `old = {} if not SNAP.exists()` reported every surface as changed, which
        # named 2,233 innocent pages for one missing file. The baseline being gone
        # is its own failure and is reported as itself.
        hard_fail(f'{SNAP.relative_to(ROOT)} does not exist, so there is no baseline to check '
                  f'{len(state)} governed surface(s) against.')
    old = json.loads(SNAP.read_text(encoding='utf-8'))
    changed = [key for key in sorted(set(old) | set(state)) if old.get(key) != state.get(key)]
    write_json(OUT, {'status': 'PASS' if not changed else 'FAIL', 'changed': changed})
    if changed:
        print(f'[extraction-surface-guard] FAIL: {len(changed)} governed surfaces changed')
        for key in changed[:50]:
            print(' -', key)
        raise SystemExit(1)
    print('[extraction-surface-guard] PASS')
    raise SystemExit(0)
print('usage: extraction_surface_guard.py snapshot|check')
raise SystemExit(2)

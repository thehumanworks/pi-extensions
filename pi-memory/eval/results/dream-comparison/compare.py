"""Recompute repeat/co-injection metrics from frozen result and store artifacts."""
import argparse
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--out', required=True)
parser.add_argument('runs', nargs='+')
args = parser.parse_args()

def read(path):
    return json.loads(path.read_text())

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

runs = []
all_rows = []
for directory in map(Path, args.runs):
    manifest = read(directory / 'manifest.json')
    summary = read(directory / 'summary.json')
    score_file = 'results.json' if manifest.get('oracleVersion') == 2 else 'results.provisional-rescore.json'
    rows = read(directory / score_file)
    corpus = read(directory / 'source-corpus.json')
    normalized = [{key: (item[key].replace(item.get('expiresAt', '<never>'), '<EXPIRY>') if key == 'body' else item[key]) for key in ('title', 'body', 'keywords', 'retention')} for item in corpus]
    fixture_hash = hashlib.sha256(json.dumps(normalized, sort_keys=True).encode()).hexdigest()
    assert len(rows) == 32 and summary['operationalSuccess'] and summary['sourceStable'], directory
    for row in rows:
        selected = set(row['selectedIds'])
        store = read(directory / (row['id'] + '.store.json'))
        pairs = [[item['id'], source['id']] for item in store if item['id'] in selected
                 for source in item.get('derivedFrom', []) if source['id'] in selected]
        row['coInjection'] = {'observed': bool(pairs), 'pairs': pairs}
        row['runDirectory'] = str(directory)
    usage = {key: sum(row['usage'][key] for row in rows) for key in ('input', 'output', 'cacheRead', 'cacheWrite')}
    runs.append({'directory': str(directory), 'started': manifest['started'], 'completed': summary['completed'],
                 'sourceHashes': manifest['sourceHashes'], 'normalizedFixtureSha256': fixture_hash, 'sourceStable': summary['sourceStable'],
                 'artifactSha256': {name: digest(directory / name) for name in ('manifest.json', 'summary.json', score_file, 'source-corpus.json')},
                 'scoringArtifact': score_file, 'generationUsage': summary['dream']['usage'],
                 'downstreamUsage': usage, 'literalCommandRetention': summary['literalCommandRetention'],
                 'dreamParents': summary['dream']['savedParents'], 'dreamHypotheses': summary['dream']['hypotheses']})
    all_rows.extend(rows)

aggregate = {}
for arm in ('sources', 'compressed', 'semantic', 'combined'):
    rows = [row for row in all_rows if row['arm'] == arm]
    aggregate[arm] = {'runs': len(rows), 'actionSuccess': sum(row['actionSuccess'] for row in rows),
                      'perRunActionSuccess': [sum(row['actionSuccess'] for row in rows if row['runDirectory'] == run['directory']) for run in runs],
                      'coInjectedRuns': sum(row['coInjection']['observed'] for row in rows),
                      'coInjectionRate': sum(row['coInjection']['observed'] for row in rows) / len(rows),
                      'meanInjectedByteBound': sum(row['injectedTextUpperBound'] for row in rows) / len(rows),
                      'meanProviderInputIncludingCache': sum(row['usage']['input'] + row['usage']['cacheRead'] for row in rows) / len(rows),
                      'meanProviderOutput': sum(row['usage']['output'] for row in rows) / len(rows),
                      'activeTextBytesByRun': [next(row['sizes']['activeTextBytes'] for row in rows if row['runDirectory'] == run['directory']) for run in runs],
                      'failures': [{'run': row['runDirectory'], 'case': row['caseId'], 'fields': [field for field, passed in row['checks'].items() if not passed], 'actual': row['parsed']} for row in rows if not row['actionSuccess']]}

report = {'oracle': 'Accepted reviewed per-case oracle; historical raw outputs untouched. Zephyr local preflight remains a refusal-semantics ambiguity.',
          'coInjectionDefinition': 'A recall selects a derived parent and at least one of its original derivedFrom source IDs in the same call.',
          'sameFixtureTextAcrossRunsIgnoringExpiry': len({run['normalizedFixtureSha256'] for run in runs}) == 1,
          'sameProductionSourcesAcrossRuns': all(run['sourceHashes'] == runs[0]['sourceHashes'] for run in runs),
          'changedSourceFilesAcrossRuns': sorted({name for run in runs[1:] for name, value in run['sourceHashes'].items() if runs[0]['sourceHashes'].get(name) != value}),
          'runs': runs, 'aggregate': aggregate,
          'limitations': ['Synthetic evidence and mock operation-plan acceptance; no deployed infrastructure execution.', 'Small repeated sample on one corpus does not establish broad generalization.', 'Generation costs are additional to downstream model tokens.', 'Short-expiry variants move the timestamp consistently into the past. Actual clock expiry is evaluated separately.']}
Path(args.out).write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'sameProductionSourcesAcrossRuns': report['sameProductionSourcesAcrossRuns'], 'aggregate': aggregate}))

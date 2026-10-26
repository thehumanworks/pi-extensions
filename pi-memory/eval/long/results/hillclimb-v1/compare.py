#!/usr/bin/env python3
"""Cross-run comparison for the hillclimb: one row per (tag, arm), memory/complete scores, tokens, recall sizes."""
import json, glob, sys, os, statistics as st
root = sys.argv[1] if len(sys.argv) > 1 else '/tmp/pi-memory-hc'
rows = {}
for f in sorted(glob.glob(f'{root}/*/*/result.json')):
    r = json.load(open(f)); tag = f.split('/')[-3]
    key = (tag, r['arm']); g = rows.setdefault(key, {'jobs': [], 'model': r['model'], 'env': r.get('memoryEnv', {})})
    last = r['scores'][-1]['categoryScores']
    failed = [c['name'] for s in r['scores'] for c in s['checks'] if not c['passed']]
    recall_tokens = sum(e.get('tokens', 0) for e in r.get('recalls', []))
    digest = max([e.get('digestTokenUpperBound', 0) for e in r.get('recalls', [])] or [0])
    g['jobs'].append({'id': r['id'], 'memory': last.get('memory'), 'intrinsic': last.get('intrinsic'), 'action': last.get('action'), 'control': last.get('control'),
                      'complete': r['complete'], 'requests': r['modelRequests'], 'uncached': r['usage'].get('input', 0), 'cached': r['usage'].get('cacheRead', 0),
                      'output': r['usage'].get('output', 0), 'cost': r['usage'].get('cost', 0), 'wall': r['wallMs'] / 1000, 'recall': recall_tokens, 'digest': digest,
                      'ids': [e['ids'] for e in r.get('recalls', [])], 'failed': failed, 'exit': [c.get('exitCode') for c in r['calls']]})
def m(v): v = [x for x in v if x is not None]; return round(st.mean(v), 3) if v else None
print(f"{'tag':14} {'arm':5} {'n':>2} {'memory':>7} {'intrin':>7} {'compl':>6} {'req':>5} {'uncached':>9} {'cached':>8} {'out':>6} {'wall s':>7} {'recall':>7} {'digest':>7}  model")
for (tag, arm), g in sorted(rows.items()):
    j = g['jobs']
    print(f"{tag:14} {arm:5} {len(j):>2} {m([x['memory'] for x in j]):>7} {m([x['intrinsic'] for x in j]):>7} {m([float(x['complete']) for x in j]):>6} {m([x['requests'] for x in j]):>5} {m([x['uncached'] for x in j]):>9} {m([x['cached'] for x in j]):>8} {m([x['output'] for x in j]):>6} {m([x['wall'] for x in j]):>7} {m([x['recall'] for x in j]):>7} {m([x['digest'] for x in j]):>7}  {g['model']}")
if '-v' in sys.argv:
    for (tag, arm), g in sorted(rows.items()):
        print(f"\n## {tag} {arm} env={g['env']}")
        for x in g['jobs']: print(f"  {x['id']:22} mem={x['memory']} compl={x['complete']} req={x['requests']} exit={x['exit']} ids={x['ids']} failed={x['failed']}")

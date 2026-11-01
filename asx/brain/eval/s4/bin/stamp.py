import json, sys, time
for line in sys.stdin:
    try:
        e = json.loads(line); e["_t"] = round(time.time(), 2); print(json.dumps(e), flush=True)
    except Exception:
        print(line, end="", flush=True)

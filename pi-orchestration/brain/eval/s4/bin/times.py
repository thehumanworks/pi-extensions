import json, sys
# per tool call: seconds between tool_execution_start and tool_execution_end, and session length
start = {}; first = last = None; n = 0
for line in open(sys.argv[1]):
    try: e = json.loads(line)
    except Exception: continue
    t = e.get("_t")
    if t is None: continue
    first = first or t; last = t
    if e.get("type") == "tool_execution_start":
        n += 1; start[e["toolCallId"]] = (n, t, e.get("args", {}).get("action"))
    elif e.get("type") == "tool_execution_end":
        i, t0, a = start[e["toolCallId"]]; print(f"#{i} {a}: {t - t0:.1f}s")
print(f"session {last - first:.1f}s")

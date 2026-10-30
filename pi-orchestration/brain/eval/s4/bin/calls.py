import json, sys
# print tool calls and results from a pi --mode json NDJSON log
path = sys.argv[1]
full = len(sys.argv) > 2
n = 0; errs = 0
for line in open(path):
    try: e = json.loads(line)
    except Exception: continue
    t = e.get("type")
    if t == "tool_execution_start":
        n += 1
        print(f"--> #{n} {e.get('toolName')} {json.dumps(e.get('args'))[:700]}")
    elif t == "tool_execution_end":
        r = e.get("result") or {}
        txt = " ".join(c.get("text", "") for c in (r.get("content") or []) if isinstance(c, dict))
        err = e.get("isError")
        if err: errs += 1
        lim = 4000 if full else 600
        print(f"<-- {'ERROR ' if err else ''}{txt[:lim]}")
        if full: print(f"    details: {json.dumps(r.get('details'))[:1500]}")
    elif t == "agent_end":
        msgs = e.get("messages") or []
        for m in msgs[-1:]:
            if m.get("role") == "assistant":
                for c in m.get("content", []):
                    if c.get("type") == "text": print("FINAL:", c["text"][:2500])
                u = m.get("usage") or {}
print(f"tool calls {n}, errors {errs}")

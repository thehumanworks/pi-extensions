import json, sys
tot = 0
for path in sys.argv[1:]:
    c = 0
    for line in open(path):
        try: e = json.loads(line)
        except Exception: continue
        if e.get("type") == "message_end" and e["message"].get("role") == "assistant":
            c += ((e["message"].get("usage") or {}).get("cost") or {}).get("total", 0)
    print(path, round(c, 4)); tot += c
print("total", round(tot, 4))

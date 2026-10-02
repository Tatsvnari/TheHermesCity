import json, sys
from skill_solvers import SOLVERS
out = []
for t in json.load(sys.stdin):
    try:
        out.append({"answer": SOLVERS[t["skill"]](t["task"])})
    except Exception as e:
        out.append({"error": repr(e)[:120]})
print(json.dumps(out))

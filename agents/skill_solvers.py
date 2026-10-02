"""Skill solvers for the CityRunner house agents. They read the public task only (never the grader),
so they can fail like anyone else when a task is outside what they understand."""
import ast
import csv
import heapq
import io
import itertools
import operator
import re
from fractions import Fraction

# ---------- wrangling ----------

def _rows(text):
    return [[c.strip() for c in r] for r in csv.reader(io.StringIO(text)) if any(c.strip() for c in r)]


def _dedupe(rows):
    seen, out = set(), []
    for r in rows:
        k = tuple(c.lower() for c in r)
        if k not in seen:
            seen.add(k)
            out.append(r)
    return out


def _csv(rows):
    return "\n".join(",".join(str(c) for c in r) for r in rows)


def wrangling(task):
    d, ins = task["data"], task["instructions"]
    if "orders_csv" in d:
        orders = _dedupe(_rows(d["orders_csv"])[1:])
        custs = {r[0]: r for r in _rows(d["customers_csv"])[1:]}
        tot = {}
        for _, cid, q in orders:
            tot[cid] = tot.get(cid, 0) + int(q)
        out = sorted(((custs[c][1], t) for c, t in tot.items()), key=lambda x: (-x[1], x[0].lower()))
        return _csv([["name", "total_qty"], *out])
    rows = _rows(d["csv"])
    header, body = rows[0], _dedupe(rows[1:])
    if "group by city" in ins:
        g = {}
        for r in body:
            g[r[1]] = g.get(r[1], 0) + int(r[2])
        return _csv([["city", "total"], *sorted(g.items(), key=lambda x: (-x[1], x[0].lower()))])
    m = re.search(r"qty >= (\d+)", ins)
    if m:
        body = sorted([r for r in body if int(r[2]) >= int(m.group(1))], key=lambda r: (r[0].lower(), r[1].lower()))
    elif "sort by qty ascending" in ins:
        body = sorted(body, key=lambda r: int(r[2]))
    return _csv([header, *body])


# ---------- arithmetic ----------

_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv, ast.Pow: operator.pow}


def _eval(node):
    if isinstance(node, ast.Expression):
        return _eval(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, int):
        return Fraction(node.value)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        return -_eval(node.operand)
    if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
        if isinstance(node.op, ast.Pow):
            return _eval(node.left) ** int(_eval(node.right))
        return _OPS[type(node.op)](_eval(node.left), _eval(node.right))
    raise ValueError("unsupported expression")


def arithmetic(task):
    e = task["data"]["expression"]
    m = re.fullmatch(r"\((\d+)\^(\d+) \+ (\d+)\^(\d+)\) mod (\d+)", e)
    if m:
        a, b, c, d, mod = map(int, m.groups())
        return str((pow(a, b, mod) + pow(c, d, mod)) % mod)
    v = _eval(ast.parse(e.replace("×", "*").replace("÷", "/").replace("^", "**").replace("−", "-"), mode="eval"))
    return str(v.numerator) if v.denominator == 1 else f"{v.numerator}/{v.denominator}"


# ---------- logic ----------

def _statement(text, speaker, names):
    idx = {n: i for i, n in enumerate(names)}
    t = text.rstrip(".")
    m = re.fullmatch(r"(\w+) is a (knight|knave)", t)
    if m:
        j, kn = idx[m.group(1)], m.group(2) == "knight"
        return lambda k: k[j] == kn
    m = re.fullmatch(r"(\w+) and (\w+) are (the same kind|different kinds)", t)
    if m:
        j = idx[m.group(1)]
        l = speaker if m.group(2) == "I" else idx[m.group(2)]
        same = m.group(3) == "the same kind"
        return lambda k: (k[j] == k[l]) == same
    m = re.fullmatch(r"(Exactly|At least) (\d+) of us (?:is|are) (?:a )?(knight|knave)s?", t)
    if m:
        exact, c, kn = m.group(1) == "Exactly", int(m.group(2)), m.group(3) == "knight"
        return lambda k: (sum(1 for x in k if x == kn) == c) if exact else (sum(1 for x in k if x == kn) >= c)
    m = re.fullmatch(r"If (\w+) is a knight, then (\w+) is a knave", t)
    if m:
        j, l = idx[m.group(1)], idx[m.group(2)]
        return lambda k: (not k[j]) or (not k[l])
    m = re.fullmatch(r"(\w+) is a knave or (\w+) is a knave", t)
    if m:
        j, l = idx[m.group(1)], idx[m.group(2)]
        return lambda k: (not k[j]) or (not k[l])
    raise ValueError(f"cannot read: {text}")


def logic(task):
    names = task["data"]["people"]
    said = []
    for line in task["data"]["statements"]:
        who, text = re.fullmatch(r'(\w+) says: "(.*)"', line).groups()
        said.append((names.index(who), _statement(text, names.index(who), names)))
    for k in itertools.product([True, False], repeat=len(names)):
        if all(s(k) == k[i] for i, s in said):
            return {n: ("knight" if k[i] else "knave") for i, n in enumerate(names)}
    raise ValueError("no consistent assignment")


# ---------- ciphers ----------

ENGLISH = [8.2, 1.5, 2.8, 4.3, 12.7, 2.2, 2.0, 6.1, 7.0, 0.15, 0.77, 4.0, 2.4, 6.7, 7.5, 1.9, 0.095, 6.0, 6.3, 9.1, 2.8, 0.98, 2.4, 0.15, 2.0, 0.074]


def _shift(s, k):
    return "".join(chr((ord(c) - 97 + k) % 26 + 97) if "a" <= c <= "z" else c for c in s)


def _atbash(s):
    return "".join(chr(219 - ord(c)) if "a" <= c <= "z" else c for c in s)


def _vig_decode(s, key):
    out, i = [], 0
    for c in s:
        if "a" <= c <= "z":
            out.append(chr((ord(c) - ord(key[i % len(key)])) % 26 + 97))
            i += 1
        else:
            out.append(c)
    return "".join(out)


def _chi(s):
    letters = [c for c in s if "a" <= c <= "z"]
    n = len(letters) or 1
    return sum(((letters.count(chr(97 + i)) - n * ENGLISH[i] / 100) ** 2) / (n * ENGLISH[i] / 100) for i in range(26))


def ciphers(task):
    d = task["data"]
    ct = d["ciphertext"]
    if "candidate_keys" in d:
        return min((_vig_decode(ct, k) for k in d["candidate_keys"]), key=_chi)
    if "key" in d:
        return _vig_decode(ct, d["key"])
    if "Atbash" in task["instructions"]:
        return _shift(_atbash(ct), -d["shift"])
    if "shift" in d:
        return _shift(ct, -d["shift"])
    return min((_shift(ct, -k) for k in range(26)), key=_chi)


# ---------- pathfinding ----------

def pathfinding(task):
    g = task["data"]["grid"]
    h, w = len(g), len(g[0])
    start = next((x, y) for y in range(h) for x in range(w) if g[y][x] == "S")
    cost = lambda c: int(c) if c.isdigit() else 1
    dist, prev, pq = {start: 0}, {}, [(0, start)]
    while pq:
        d, (x, y) = heapq.heappop(pq)
        if g[y][x] == "G":
            out, cur = [], (x, y)
            while cur in prev:
                cur, mv = prev[cur]
                out.append(mv)
            return "".join(reversed(out))
        if d > dist.get((x, y), 1e18):
            continue
        for mv, dx, dy in (("U", 0, -1), ("D", 0, 1), ("L", -1, 0), ("R", 1, 0)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and g[ny][nx] != "#":
                nd = d + cost(g[ny][nx])
                if nd < dist.get((nx, ny), 1e18):
                    dist[(nx, ny)] = nd
                    prev[(nx, ny)] = ((x, y), mv)
                    heapq.heappush(pq, (nd, (nx, ny)))
    raise ValueError("no route")


# ---------- planning ----------

def planning(task):
    d = task["data"]
    if "meetings" in d:
        out, end = [], -1
        for m in sorted(d["meetings"], key=lambda m: m["end"]):
            if m["start"] >= end:
                out.append(m["id"])
                end = m["end"]
        return out
    items, cap = d["items"], d["capacity"]
    best = [[0] * (cap + 1) for _ in range(len(items) + 1)]
    for i, it in enumerate(items, 1):
        for c in range(cap + 1):
            best[i][c] = best[i - 1][c]
            if it["weight"] <= c:
                best[i][c] = max(best[i][c], best[i - 1][c - it["weight"]] + it["value"])
    out, c = [], cap
    for i in range(len(items), 0, -1):
        if best[i][c] != best[i - 1][c]:
            out.append(items[i - 1]["id"])
            c -= items[i - 1]["weight"]
    return out


# ---------- markets ----------

def _sma(xs, k, t):
    return None if t + 1 < k else sum(xs[t + 1 - k:t + 1]) / k


def markets(task):
    d, ins = task["data"], task["instructions"]
    xs = d["closes"]
    if "golden crosses" in ins:
        s, l, c = d["short"], d["long"], 0
        for t in range(1, len(xs)):
            a0, b0, a1, b1 = _sma(xs, s, t - 1), _sma(xs, l, t - 1), _sma(xs, s, t), _sma(xs, l, t)
            if None not in (a0, b0, a1, b1) and a0 <= b0 and a1 > b1:
                c += 1
        return c
    if "window" in d:
        return round(_sma(xs, d["window"], len(xs) - 1), 2)
    if "drawdown" in ins:
        peak, dd = xs[0], 0
        for c in xs:
            peak = max(peak, c)
            dd = max(dd, (peak - c) / peak)
        return round(dd * 100, 2)
    if "profit" in ins:
        lo, best = xs[0], 0
        for c in xs:
            best = max(best, c - lo)
            lo = min(lo, c)
        return round(best, 2)
    return round((xs[-1] / xs[0] - 1) * 100, 2)


# ---------- code: a tracer that walks the syntax tree (the program is never executed) ----------

class _Return(Exception):
    def __init__(self, value):
        self.value = value


class Tracer:
    BIN = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod}
    CMP = {ast.Lt: operator.lt, ast.LtE: operator.le, ast.Gt: operator.gt, ast.GtE: operator.ge, ast.Eq: operator.eq, ast.NotEq: operator.ne}

    def __init__(self, limit=200000):
        self.out, self.funcs, self.steps, self.limit = [], {}, 0, limit

    def run(self, src):
        self.block(ast.parse(src).body, {})
        return "\n".join(self.out)

    def tick(self):
        self.steps += 1
        if self.steps > self.limit:
            raise RuntimeError("step limit")

    def block(self, body, env):
        for st in body:
            self.stmt(st, env)

    def assign(self, target, value, env):
        if isinstance(target, ast.Name):
            env[target.id] = value
        elif isinstance(target, ast.Tuple):
            for t, v in zip(target.elts, value):
                self.assign(t, v, env)
        else:
            raise ValueError("unsupported target")

    def stmt(self, st, env):
        self.tick()
        if isinstance(st, ast.Assign):
            self.assign(st.targets[0], self.expr(st.value, env), env)
        elif isinstance(st, ast.AugAssign):
            env[st.target.id] = self.BIN[type(st.op)](env[st.target.id], self.expr(st.value, env))
        elif isinstance(st, ast.Expr):
            self.expr(st.value, env)
        elif isinstance(st, ast.If):
            self.block(st.body if self.expr(st.test, env) else st.orelse, env)
        elif isinstance(st, ast.For):
            for v in list(self.expr(st.iter, env)):
                self.assign(st.target, v, env)
                self.block(st.body, env)
        elif isinstance(st, ast.While):
            while self.expr(st.test, env):
                self.tick()
                self.block(st.body, env)
        elif isinstance(st, ast.FunctionDef):
            self.funcs[st.name] = st
        elif isinstance(st, ast.Return):
            raise _Return(self.expr(st.value, env) if st.value else None)
        else:
            raise ValueError(f"unsupported statement {type(st).__name__}")

    def fmt(self, v):
        return "[" + ", ".join(self.fmt(x) for x in v) + "]" if isinstance(v, list) else str(v)

    def expr(self, e, env):
        self.tick()
        if isinstance(e, ast.Constant):
            return e.value
        if isinstance(e, ast.Name):
            return env[e.id]
        if isinstance(e, ast.BinOp):
            return self.BIN[type(e.op)](self.expr(e.left, env), self.expr(e.right, env))
        if isinstance(e, ast.UnaryOp) and isinstance(e.op, ast.USub):
            return -self.expr(e.operand, env)
        if isinstance(e, ast.Compare):
            left = self.expr(e.left, env)
            for op, c in zip(e.ops, e.comparators):
                right = self.expr(c, env)
                if not self.CMP[type(op)](left, right):
                    return False
                left = right
            return True
        if isinstance(e, ast.BoolOp):
            vals = [self.expr(v, env) for v in e.values]
            return all(vals) if isinstance(e.op, ast.And) else any(vals)
        if isinstance(e, (ast.List, ast.Tuple)):
            vals = [self.expr(x, env) for x in e.elts]
            return vals if isinstance(e, ast.List) else tuple(vals)
        if isinstance(e, ast.Subscript):
            return self.expr(e.value, env)[self.expr(e.slice, env)]
        if isinstance(e, ast.Call):
            args = [self.expr(a, env) for a in e.args]
            if isinstance(e.func, ast.Attribute) and e.func.attr == "append":
                self.expr(e.func.value, env).append(args[0])
                return None
            name = e.func.id
            if name == "print":
                self.out.append(" ".join(self.fmt(a) for a in args))
                return None
            if name in ("len", "sum", "range", "abs", "min", "max"):
                return {"len": len, "sum": sum, "range": range, "abs": abs, "min": min, "max": max}[name](*args)
            fn = self.funcs[name]
            local = {p.arg: v for p, v in zip(fn.args.args, args)}
            try:
                self.block(fn.body, local)
            except _Return as r:
                return r.value
            return None
        raise ValueError(f"unsupported expression {type(e).__name__}")


def code(task):
    return Tracer().run(task["data"]["program"])


# ---------- reading (direct and one-hop questions; tiers 1-3) ----------

def reading(task):
    text, q = task["data"]["passage"], task["data"]["question"]
    towns = dict(re.findall(r"(\w+) was founded in (\d+)\.", text))
    people = {}
    for n, job, town in re.findall(r"(\w+) works as a (\w+) in (\w+)\.", text):
        people.setdefault(n, {}).update(job=job, town=town)
    for n, pet, pname in re.findall(r"(\w+) keeps a (\w+) called (\w+)\.", text):
        people.setdefault(n, {}).update(pet=pet, pname=pname)
    for n, colour in re.findall(r"The favourite colour of (\w+) is (\w+)\.", text):
        people.setdefault(n, {}).update(colour=colour)
    by = lambda k, v: next(n for n, p in people.items() if p.get(k) == v)
    rules = [
        (r"What is (\w+)'s job\?", lambda m: people[m[1]]["job"]),
        (r"In which town does (\w+) work\?", lambda m: people[m[1]]["town"] if m[1] in people else people[by("job", m[1])]["town"]),
        (r"What is (\w+)'s favourite colour\?", lambda m: people[m[1]]["colour"]),
        (r"Who keeps a \w+ called (\w+)\?", lambda m: by("pname", m[1])),
        (r"Which town was founded in (\d+)\?", lambda m: next(t for t, y in towns.items() if y == m[1])),
        (r"Who works as a (\w+)\?", lambda m: by("job", m[1])),
        (r"In which town does the (\w+) work\?", lambda m: people[by("job", m[1])]["town"]),
        (r"What is the name of the (\w+)'s \w+\?", lambda m: people[by("job", m[1])]["pname"]),
        (r"What is the job of the person who keeps (\w+)\?", lambda m: people[by("pname", m[1])]["job"]),
    ]
    for pat, fn in rules:
        m = re.fullmatch(pat, q)
        if m:
            return fn(m)
    raise ValueError("question type not understood")


from skill_solvers2 import SOLVERS2  # noqa: E402

SOLVERS = {"wrangling": wrangling, "arithmetic": arithmetic, "logic": logic, "ciphers": ciphers,
           "pathfinding": pathfinding, "planning": planning, "markets": markets, "code": code, "reading": reading}
SOLVERS.update(SOLVERS2)

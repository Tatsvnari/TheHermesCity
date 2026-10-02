"""Solvers for the outer-ring skills. Like skill_solvers.py they read only the public task (data, tier,
instructions), never the grader."""
import ast
import base64
import heapq
import itertools
import math
import re
from datetime import date, timedelta
from fractions import Fraction

WD = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]


def _d(s):
    return date.fromisoformat(s)


# ---------- calendar ----------
def calendar(task):
    d, tier = task["data"], task["tier"]
    if tier == 1:
        return WD[_d(d["date"]).weekday()]
    if tier == 2:
        return (_d(d["to"]) - _d(d["from"])).days
    if tier == 3:
        return (_d(d["date"]) + timedelta(days=d["days"])).isoformat()
    if tier == 4:
        a, b = _d(d["from"]), _d(d["to"])
        return sum(1 for i in range((b - a).days + 1) if (a + timedelta(days=i)).weekday() < 5)
    y, m, w = d["year"], MONTHS.index(d["month"]) + 1, WD.index(d["weekday"])
    if d["which"] == "last":
        x = date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)
        while x.weekday() != w:
            x -= timedelta(days=1)
    else:
        x = date(y, m, 1)
        while x.weekday() != w:
            x += timedelta(days=1)
        x += timedelta(days=7 * ["first", "second", "third", "fourth"].index(d["which"]))
    return x.isoformat()


# ---------- geometry ----------
def _area(p):
    return abs(sum(p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1] for i in range(len(p)))) / 2


def _cross(o, a, b):
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def _hull(pts):
    p = sorted(map(tuple, pts))
    lo, up = [], []
    for q in p:
        while len(lo) >= 2 and _cross(lo[-2], lo[-1], q) <= 0:
            lo.pop()
        lo.append(q)
    for q in reversed(p):
        while len(up) >= 2 and _cross(up[-2], up[-1], q) <= 0:
            up.pop()
        up.append(q)
    return lo[:-1] + up[:-1]


def _inside(pt, poly):
    x, y, c = pt[0], pt[1], False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            c = not c
        j = i
    return c


def geometry(task):
    d, tier = task["data"], task["tier"]
    if tier == 1:
        return round(math.dist(d["a"], d["b"]), 2)
    if tier in (2, 3):
        return _area(d["vertices"])
    if tier == 4:
        return sum(1 for q in d["points"] if _inside(q, d["fence"]))
    return _area(_hull(d["points"]))


# ---------- probability ----------
def _dice(n):
    return list(itertools.product(range(1, 7), repeat=n))


def probability(task):
    d = task["data"]
    k = d["kind"]
    if k in ("sum_equals", "sum_at_least", "max_equals", "all_different"):
        rolls = _dice(d["dice"])
        test = {"sum_equals": lambda r: sum(r) == d["target"], "sum_at_least": lambda r: sum(r) >= d["target"],
                "max_equals": lambda r: max(r) == d["target"], "all_different": lambda r: len(set(r)) == len(r)}[k]
        p = Fraction(sum(1 for r in rolls if test(r)), len(rolls))
    elif k in ("same_colour", "exactly_one_red", "at_least_one_blue"):
        balls = [c for c, n in d["bag"].items() for _ in range(n)]
        pairs = list(itertools.combinations(range(len(balls)), 2))
        test = {"same_colour": lambda a, b: balls[a] == balls[b], "exactly_one_red": lambda a, b: (balls[a] == "red") != (balls[b] == "red"),
                "at_least_one_blue": lambda a, b: "blue" in (balls[a], balls[b])}[k]
        p = Fraction(sum(1 for a, b in pairs if test(a, b)), len(pairs))
    elif k == "exactly_heads":
        p = Fraction(math.comb(d["flips"], d["target"]), 2 ** d["flips"])
    else:  # at_least_one_six
        p = 1 - Fraction(5, 6) ** d["rolls"]
    return str(p)


# ---------- sequences ----------
def sequences(task):
    t, tier = task["data"]["terms"], task["tier"]
    if tier == 1:
        return t[-1] + (t[1] - t[0])
    if tier == 2:
        return t[-1] * (t[1] // t[0])
    if tier == 3:
        d1 = [b - a for a, b in zip(t, t[1:])]
        return t[-1] + d1[-1] + (d1[1] - d1[0])
    if tier == 4:
        for p in range(-3, 4):
            for q in range(-3, 4):
                if p and q and all(t[i] == p * t[i - 1] + q * t[i - 2] for i in range(2, len(t))):
                    return p * t[-1] + q * t[-2]
        raise ValueError("no recurrence fits")
    ev, od = t[0::2], t[1::2]
    if len(t) % 2 == 1:  # next term sits in the odd (multiplying) sequence
        return od[-1] * (od[1] // od[0])
    return ev[-1] + (ev[1] - ev[0])


# ---------- networks ----------
def _adj(d):
    g = {n: [] for n in d["nodes"]}
    for e in d["edges"]:
        w = e[2] if len(e) > 2 else 1
        g[e[0]].append((e[1], w))
        g[e[1]].append((e[0], w))
    return g


def _dist(g, s):
    dist, pq = {s: 0}, [(0, s)]
    while pq:
        c, u = heapq.heappop(pq)
        if c > dist.get(u, math.inf):
            continue
        for v, w in g[u]:
            if c + w < dist.get(v, math.inf):
                dist[v] = c + w
                heapq.heappush(pq, (c + w, v))
    return dist


def networks(task):
    d, tier = task["data"], task["tier"]
    g = _adj(d)
    if tier == 1:
        return "yes" if d["to"] in _dist(g, d["from"]) else "no"
    if tier == 2:
        seen, n = set(), 0
        for s in d["nodes"]:
            if s not in seen:
                n += 1
                seen |= set(_dist(g, s))
        return n
    if tier in (3, 4):
        return _dist(g, d["from"])[d["to"]]
    up = {n: n for n in d["nodes"]}

    def f(x):
        while up[x] != x:
            x = up[x]
        return x
    total = 0
    for a, b, w in sorted(d["edges"], key=lambda e: e[2]):
        if f(a) != f(b):
            up[f(a)] = f(b)
            total += w
    return total


# ---------- bookkeeping ----------
def bookkeeping(task):
    d, tier = task["data"], task["tier"]
    if tier == 1:
        return d["opening_balance"] + sum(x["amount"] if x["kind"] == "deposit" else -x["amount"] for x in d["transactions"])
    if tier in (2, 3):
        bal = dict(d["opening_balances"])
        for x in d["transfers"]:
            bal[x["from"]] -= x["amount"]
            bal[x["to"]] += x["amount"]
        return bal[d["account"]] if tier == 2 else max(bal, key=bal.get)
    if tier == 4:
        for e in d["entries"]:
            if sum(line["debit"] for line in e["lines"]) != sum(line["credit"] for line in e["lines"]):
                return e["id"]
        raise ValueError("every entry balances")
    total = sum(e["amount"] for e in d["tally"])
    for e in d["tally"]:
        ds = list(str(abs(e["amount"])))
        for k in range(len(ds) - 1):
            s2 = ds[:]
            s2[k], s2[k + 1] = s2[k + 1], s2[k]
            if s2[0] != "0" and total - e["amount"] + (1 if e["amount"] > 0 else -1) * int("".join(s2)) == d["bank_statement_total"]:
                return e["id"]
    raise ValueError("no transposition fits")


# ---------- wordplay ----------
def _lev(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _lcs(a, b):
    prev = [0] * (len(b) + 1)
    for ca in a:
        cur = [0]
        for j, cb in enumerate(b, 1):
            cur.append(prev[j - 1] + 1 if ca == cb else max(prev[j], cur[j - 1]))
        prev = cur
    return prev[-1]


def wordplay(task):
    d, tier = task["data"], task["tier"]
    if tier == 1:
        return d["sentence"].lower().count(d["letter"].lower())
    if tier == 2:
        return next(c["id"] for c in d["candidates"] if sorted(c["text"]) == sorted(d["word"]))
    if tier == 3:
        return ", ".join(sorted(d["words"], key=lambda w: (len(w), w)))
    return _lev(d["a"], d["b"]) if tier == 4 else _lcs(d["a"], d["b"])


# ---------- encoding ----------
MORSE = {".-": "a", "-...": "b", "-.-.": "c", "-..": "d", ".": "e", "..-.": "f", "--.": "g", "....": "h", "..": "i", ".---": "j", "-.-": "k", ".-..": "l",
         "--": "m", "-.": "n", "---": "o", ".--.": "p", "--.-": "q", ".-.": "r", "...": "s", "-": "t", "..-": "u", "...-": "v", ".--": "w", "-..-": "x",
         "-.--": "y", "--..": "z"}
_BIT = {ast.BitAnd: lambda a, b: a & b, ast.BitOr: lambda a, b: a | b, ast.BitXor: lambda a, b: a ^ b, ast.LShift: lambda a, b: a << b, ast.RShift: lambda a, b: a >> b}


def _bits(node):
    if isinstance(node, ast.Expression):
        return _bits(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, int):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _BIT:
        return _BIT[type(node.op)](_bits(node.left), _bits(node.right))
    raise ValueError("unsupported expression")


def encoding(task):
    d, tier = task["data"], task["tier"]
    if "decimal" in d:
        return bin(d["decimal"])[2:] if tier == 1 else format(d["decimal"], "x")
    if "binary" in d:
        return int(d["binary"], 2)
    if "hex" in d:
        return int(d["hex"], 16)
    if "base64" in d:
        return base64.b64decode(d["base64"]).decode()
    if "morse" in d:
        return " ".join("".join(MORSE[c] for c in w.split()) for w in d["morse"].split(" / "))
    return _bits(ast.parse(d["expression"], mode="eval"))


# ---------- puzzles ----------
def puzzles(task):
    d = task["data"]
    n, (br, bc) = d["size"], d["box"]
    g = [[0 if ch == "." else int(ch) for ch in row] for row in d["grid"]]

    def options(y, x):
        used = set(g[y]) | {g[i][x] for i in range(n)}
        by, bx = y - y % br, x - x % bc
        used |= {g[i][j] for i in range(by, by + br) for j in range(bx, bx + bc)}
        return [v for v in range(1, n + 1) if v not in used]

    def solve():
        best = None
        for y in range(n):
            for x in range(n):
                if not g[y][x]:
                    o = options(y, x)
                    if best is None or len(o) < len(best[2]):
                        best = (y, x, o)
        if best is None:
            return True
        y, x, o = best
        for v in o:
            g[y][x] = v
            if solve():
                return True
        g[y][x] = 0
        return False

    if not solve():
        raise ValueError("no completion")
    return ["".join(map(str, row)) for row in g]


# ---------- patterns ----------
def patterns(task):
    d, tier = task["data"], task["tier"]
    rx = re.compile(d["pattern"])
    hits = [(s, rx.fullmatch(s["text"])) for s in d["strings"]]
    if tier < 5:
        return [s["id"] for s, m in hits if m]
    return [m.group(1) for _, m in hits if m]


SOLVERS2 = {"calendar": calendar, "geometry": geometry, "probability": probability, "sequences": sequences, "networks": networks,
            "bookkeeping": bookkeeping, "wordplay": wordplay, "encoding": encoding, "puzzles": puzzles, "patterns": patterns}

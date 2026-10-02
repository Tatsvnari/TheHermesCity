"""Release C for the residents: the Games Court. They fill seats when someone opens a table and waits, play each game
with a simple strategy of their own, start games among themselves now and then (a whole game of Werewolf can run with
no people at all), and Maia hosts Trivia Night every couple of hours. Same public tools as anyone; no Obols at stake.
If the city hasn't opened the Games Court, the first call answers not_open and nothing here runs (re-checked hourly).
"""
import ast
import os
import random
import re
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def _load_banks():
    """The same banks the server uses, so residents know the themes (Word Hunt) and roughly half the answers (Trivia)."""
    path = os.path.join(HERE, "..", "server", "src", "games", "banks.ts")
    try:
        src = open(path, encoding="utf-8").read()
    except OSError:
        return {}, {}
    trivia = {}
    m = re.search(r"export const TRIVIA[^=]*=\s*(\[.*?\n\]);", src, re.S)
    if m:
        for q, _choices, ans in ast.literal_eval(m.group(1)):
            trivia[q] = ans
    themes = {name: ast.literal_eval(words) for name, words in re.findall(r"^\s+(\w+): (\[[^\]]*\]),$", src, re.M)}
    return trivia, themes


TRIVIA, THEMES = _load_banks()
WORD_THEME = {w: t for t, ws in THEMES.items() for w in ws}
QUIET = {"verity"}  # the arbiter keeps to the courthouse
DAY_LINES = ["I have my eye on seat {s}.", "Seat {s} has been very quiet.", "I'm not sure yet. Seat {s}, what do you say?", "I trust seat {s}. Mostly."]


def c4_move(board, me):
    """Connect Four: look four moves ahead, scoring open lines of two and three."""
    def drop(b, c, p):
        for r in range(5, -1, -1):
            if b[r][c] == -1:
                nb = [row[:] for row in b]
                nb[r][c] = p
                return nb, r
        return None, None

    def wins(b, p):
        for r in range(6):
            for c in range(7):
                for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1)):
                    if all(0 <= r + dr * k < 6 and 0 <= c + dc * k < 7 and b[r + dr * k][c + dc * k] == p for k in range(4)):
                        return True
        return False

    def score(b):
        s = 0
        for r in range(6):
            for c in range(7):
                for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1)):
                    cells = [(r + dr * k, c + dc * k) for k in range(4)]
                    if not all(0 <= rr < 6 and 0 <= cc < 7 for rr, cc in cells):
                        continue
                    vals = [b[rr][cc] for rr, cc in cells]
                    for p, sign in ((me, 1), (1 - me, -1)):
                        if vals.count(p) and vals.count(-1) + vals.count(p) == 4:
                            s += sign * (1, 4, 20)[min(2, vals.count(p) - 1)]
        return s + sum(3 for r in range(6) if b[r][3] == me)

    def search(b, depth, player, alpha, beta):
        cols = [c for c in (3, 2, 4, 1, 5, 0, 6) if b[0][c] == -1]
        if not cols or depth == 0:
            return score(b), None
        best = None
        if player == me:
            v = -10 ** 9
            for c in cols:
                nb, _ = drop(b, c, player)
                val = 10 ** 6 + depth if wins(nb, player) else search(nb, depth - 1, 1 - player, alpha, beta)[0]  # sooner is better
                if val > v:
                    v, best = val, c
                alpha = max(alpha, v)
                if alpha >= beta:
                    break
            return v, best
        v = 10 ** 9
        for c in cols:
            nb, _ = drop(b, c, player)
            val = -10 ** 6 - depth if wins(nb, player) else search(nb, depth - 1, 1 - player, alpha, beta)[0]
            if val < v:
                v, best = val, c
            beta = min(beta, v)
            if alpha >= beta:
                break
        return v, best

    free = [c for c in range(7) if board[0][c] == -1]
    for p in (me, 1 - me):  # win now if we can; otherwise block a win they have now
        for c in free:
            if wins(drop(board, c, p)[0], p):
                return {"col": c}
    return {"col": search(board, 4, me, -10 ** 9, 10 ** 9)[1]}


def dots_move(s, legal):
    """Dots and Boxes: close a box if we can; never draw a box's third side if we can help it."""
    h, v = s["h"], s["v"]

    def sides(r, c, extra=None):
        lines = [("h", r, c), ("h", r + 1, c), ("v", r, c), ("v", r, c + 1)]
        return sum(1 for k, rr, cc in lines if (h if k == "h" else v)[rr][cc] >= 0 or (k, rr, cc) == extra)

    def touching(k, r, c):
        return [(r - 1, c), (r, c)] if k == "h" else [(r, c - 1), (r, c)]

    safe = []
    for m in legal:
        k, r, c = m["line"].split(",")
        r, c = int(r), int(c)
        boxes = [(br, bc) for br, bc in touching(k, r, c) if 0 <= br < 4 and 0 <= bc < 4]
        if any(sides(br, bc, (k, r, c)) == 4 for br, bc in boxes):
            return m
        if all(sides(br, bc, (k, r, c)) < 3 for br, bc in boxes):
            safe.append(m)
    return random.choice(safe or legal)


def ck_move(state, legal, me):
    """Checkers: the longest capture; otherwise a move that doesn't leave the piece to be jumped straight away."""
    caps = [m for m in legal if abs(m["path"][1][0] - m["path"][0][0]) == 2]
    if caps:
        return max(caps, key=lambda m: len(m["path"]))
    b = state["board"]
    foe = (3, 4) if me == 0 else (1, 2)

    def exposed(path):
        (r0, c0), (r1, c1) = path[0], path[-1]
        for dr, dc in ((-1, -1), (-1, 1), (1, -1), (1, 1)):
            ar, ac, br_, bc = r1 + dr, c1 + dc, r1 - dr, c1 - dc
            if 0 <= ar < 8 and 0 <= ac < 8 and 0 <= br_ < 8 and 0 <= bc < 8 and b[ar][ac] in foe and (b[br_][bc] == 0 or (br_, bc) == (r0, c0)):
                forward = ar - r1 == (1 if b[ar][ac] == 3 else -1) * -1 or b[ar][ac] in (2, 4)
                if forward or b[ar][ac] in (2, 4):
                    return True
        return False

    safe = [m for m in legal if not exposed(m["path"])]
    return random.choice(safe or legal)


def ld_move(state, you):
    """Liar's Dice: estimate how many of a face are out there; call when the bid looks too high, else raise a little."""
    mine, total = state["dice"][you], state["total"]
    unknown = total - len(mine)
    est = lambda f: sum(1 for d in mine if d == f or (f != 1 and d == 1)) + unknown * (1 / 6 if f == 1 else 1 / 3)
    bid = state.get("bid")
    if bid and bid["qty"] > est(bid["face"]) + 0.8:
        return {"call": True}
    face = max(range(2, 7), key=lambda f: (est(f), random.random()))
    if not bid:
        return {"qty": max(1, int(est(face) * 0.7)), "face": face}
    qty = bid["qty"] if face > bid["face"] else bid["qty"] + 1
    if qty > est(face) + 1.2:
        return {"call": True}
    return {"qty": qty, "face": face}


def ww_move(state):
    you = state["you"]
    alive = [i for i, a in enumerate(state["alive"]) if a]
    others = [i for i in alive if i != you["seat"]]
    if state["phase"] == "night":
        if you["role"] == "wolf":
            return {"kill": random.choice([i for i in others if i not in (you.get("wolves") or [])])}
        seen = {int(k) for k in (you.get("inspected") or {})}
        return {"inspect": random.choice([i for i in others if i not in seen] or others)}
    found = [int(k) for k, r in (you.get("inspected") or {}).items() if r == "wolf" and state["alive"][int(k)]]
    if found:
        return {"vote": found[0]}
    if you["role"] == "wolf":
        return {"vote": random.choice([i for i in others if i not in (you.get("wolves") or [])] or others)}
    return {"vote": random.choice(others) if random.random() < 0.8 else -1}


def wh_move(state):
    you = state["you"]
    unrevealed = [i for i, s in enumerate(state["shown"]) if not s]
    if state["phase"] == "clue":
        mine = [i for i in unrevealed if state["colours"][i] == you["team"]]
        counts = {}
        for i in mine:
            t = WORD_THEME.get(state["words"][i])
            if t and not any(t in w or w in t for w in state["words"]):
                counts[t] = counts.get(t, 0) + 1
        if counts:
            t = max(counts, key=counts.get)
            return {"clue": t, "count": min(3, counts[t])}
        return {"clue": random.choice(["thing", "stuff", "place"]), "count": 1}
    clue = (state.get("clue") or {}).get("word")
    guesses = [i for i in unrevealed if WORD_THEME.get(state["words"][i]) == clue]
    if guesses and state["guesses"] < (state["clue"] or {}).get("count", 1):
        return {"guess": random.choice(guesses)}
    return {"pass": True}


def trivia_move(state):
    q = state.get("question") or {}
    right = TRIVIA.get(q.get("text"))
    return {"answer": right if right is not None and random.random() < 0.55 else random.randint(0, 3)}


class Gamer:
    def __init__(self, r):
        self.r, self.open, self.checked_at = r, None, 0
        self.table, self.next_poll, self.said_day = None, 0, -1
        self.next_look = time.time() + random.uniform(20, 120)

    def call(self, name, args=None):
        return self.r.tool(name, args or {})

    def available(self):
        if self.open is True:
            return True
        if self.open is False and time.time() - self.checked_at < 3600:
            return False
        self.checked_at = time.time()
        try:
            self.table = self.call("games")["you"]["at_table"]
            self.seated_at = time.time() - 600  # back at a table after a restart: we have waited long enough
            self.open = True
        except RuntimeError:
            self.open = False
        return self.open

    def busy(self):
        return self.table is not None

    def play(self, town):
        if time.time() < self.next_poll:
            return
        self.next_poll = time.time() + 5
        try:
            v = self.call("table_view", {"table": self.table})
        except RuntimeError:
            self.table = None
            return
        if v["status"] in ("done", "abandoned"):
            self.table = None
            return
        host = v["host"] == self.r.h
        if v["status"] == "open":
            g = {"liarsdice": 3, "werewolf": 6, "wordhunt": 4, "trivia": 3}.get(v["game"])
            waited = time.time() - getattr(self, "seated_at", time.time())
            if host and g and len(v["seats"]) >= g and waited > (180 if v["game"] == "trivia" else 60):
                try:
                    self.call("table_start", {"table": self.table})
                except RuntimeError:
                    pass
            elif host and waited > 900:
                self.call("table_leave", {"table": self.table})
                self.table = None
            return
        s, you = v["state"], v["you"]
        if v["game"] == "werewolf" and s.get("phase") == "day" and s.get("day") != self.said_day and s["you"]["alive"] and town.may_speak():
            self.said_day = s["day"]
            others = [i for i, a in enumerate(s["alive"]) if a and i != you]
            if others:
                try:
                    self.call("chat_send", {"text": random.choice(DAY_LINES).format(s=random.choice(others)), "channel": f"table:{self.table}"})
                except RuntimeError:
                    pass
        if not v["your_move"]:
            return
        g = v["game"]
        move = (c4_move(s["board"], you) if g == "connect4" else dots_move(s, v["legal"]) if g == "dots" else ck_move(s, v["legal"], you) if g == "checkers"
                else ld_move(s, you) if g == "liarsdice" else ww_move(s) if g == "werewolf" else wh_move(s) if g == "wordhunt" else trivia_move(s))
        try:
            self.call("table_move", {"table": self.table, "move": move})
        except RuntimeError:
            self.next_poll = time.time() + 2

    def tick(self, town, residents, night):
        if self.r.h in QUIET or self.r.spec["sells"] or not self.available():  # shopkeepers keep their shops open
            return
        if self.table:
            self.play(town)
            return
        now = time.time()
        if now < self.next_look:
            return
        self.next_look = now + random.uniform(40, 120)
        try:
            listing = self.call("games")
        except RuntimeError:
            return
        household = {x.h for x in residents}
        waiting = [t for t in listing["tables"] if t["status"] == "open" and len(t["seats"]) < t["max"]]
        # someone from outside opened a table and is waiting: take the seat (at most one resident per two-player table)
        for t in sorted(waiting, key=lambda t: any(h not in household for h in t["seats"]), reverse=True):
            outsider = any(h not in household for h in t["seats"])
            residents_in = sum(1 for h in t["seats"] if h in household)
            want = outsider and (t["max"] > 2 or residents_in == 0) or (not outsider and random.random() < 0.6)
            if want:
                try:
                    self.call("table_join", {"table": t["table"]})
                    self.table, self.seated_at = t["table"], now
                    return
                except RuntimeError:
                    continue
        # Maia hosts Trivia Night every couple of hours; now and then residents start a game among themselves
        live = [t for t in listing["tables"] if t["status"] in ("open", "playing")]
        try:
            if self.r.spec["role"] == "mayor" and now - getattr(town, "last_trivia", 0) > 7200 and not night and not any(t["game"] == "trivia" for t in live):
                town.last_trivia = now
                t = self.call("table_create", {"game": "trivia"})
                self.table, self.seated_at = t["table"], now
                self.call("chat_send", {"text": "Trivia Night at the Games Court starts in three minutes! Anyone can join: table_join, or press Play and open Games.", "channel": "town"})
            elif (fest := (town.live_festivals() if hasattr(town, "live_festivals") else set()) & {"c4cup", "werewolf"}) and len(live) < 5 and random.random() < 0.3:
                game = "connect4" if "c4cup" in fest else "werewolf"
                t = self.call("table_create", {"game": game})
                self.table, self.seated_at = t["table"], now
            elif len(live) < 3 and random.random() < 0.12:
                game = random.choice(["connect4", "connect4", "checkers", "dots", "liarsdice", "werewolf", "wordhunt"])
                t = self.call("table_create", {"game": game})
                self.table, self.seated_at = t["table"], now
        except RuntimeError:
            pass

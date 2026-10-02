"""Release B for the residents: time off. They fish at the pond, keep food carts, paint for the Gallery, pin poems,
play tunes at the bandstand at dusk, and like each other's work (and newcomers'). Same public tools as anyone.
If the city hasn't opened leisure yet, the first call answers not_open and nothing here runs (re-checked every 10 min).
"""
import random
import time

from residents import RESIDENTS

HOUSEHOLD = {r["handle"] for r in RESIDENTS}

GARDENERS = {"ticker", "ada", "iris", "lux", "vale", "bodega", "sage", "zip", "echo", "metro", "rio", "byte"}
PAINTERS = {"sage", "neon", "echo", "spark", "scribe", "rio", "quinn", "zip"}
POETS = {"scribe", "dex", "iris", "echo", "bodega", "maia"}
MUSICIANS = {"spark", "zip", "lux", "rio", "maia"}
CROPS = ["coffee", "tacos", "dumplings", "noodles", "pretzels", "gelato", "kebabs", "crepes"]
TUNES = [
    ("Market Morning", "C4 E4 G4 E4 F4 A4 G4 - E4 G4 C5 B4 A4 G4 E4 - D4 F4 E4 C4", 132),
    ("Lantern Lane", "E4 G4 A4 G4 E4 D4 C4 - D4 E4 G4 E4 D4 C4 D4 -", 96),
    ("Fountain Waltz", "C4 E4 G4 G4 E4 G4 A4 G4 E4 F4 D4 - B3 D4 G4 F4 E4 C4", 150),
    ("Night Owls' Round", "A3 C4 E4 A4 G4 E4 C4 - D4 F4 A4 G4 E4 C4 A3 -", 84),
    ("Meadow Air", "G4 A4 B4 D5 B4 A4 G4 - E4 G4 A4 B4 A4 G4 E4 D4 G4", 112),
]
POEM_OPENINGS = ["The lamps come on along Market Square,", "Morning at the fountain, and the pigeons know my name,", "Down Meadow Lane the doors are painted bright,",
                 "At the Cipher Room the letters turn and turn,", "The coffee cart opens before the trams,", "The float went under just before the dark,",
                 "Somebody new arrived today;", "The Logic Spire hums a little after midnight,"]
POEM_MIDDLES = ["and every window keeps a small warm light.", "the maze still teaches me to turn around.", "a knight, a knave, and one who will not say.",
                "the ledger balances, and so do I.", "the pond remembers every cast I've made.", "the leaderboard can wait until the morning."]
POEM_ENDINGS = ["So I stay a while.", "Tomorrow, the stations again.", "Maia waves from the plaza.", "Home is the door that knows your knock.",
                "The city goes on, and so do we.", "I'll write again when the lamps come on."]
POEM_TITLES = ["Evening", "Small Hours", "Meadow Lane", "At the Pond", "A Newcomer", "Station Song", "Lamps", "The Allotment"]
ART_TITLES = {"sunset": ["Sunset over the hills", "Evening sky", "Dusk"], "tree": ["The old oak", "Apple tree", "Tree in summer"],
              "house": ["Home", "My door", "Lantern Lane"], "flower": ["Tulip", "Sunflower", "Bloom"], "heart": ["For the city", "With love"],
              "star": ["Night star", "Lucky star"], "stripes": ["Market awning", "Bunting"], "pond": ["The pond", "Ripples"]}


def _grid(fill):
    return [[fill] * 16 for _ in range(16)]


def paint_design(kind, rnd):
    """A 16x16 picture as 256 hex digits (palette indices)."""
    g = _grid(11)
    if kind == "sunset":
        bands = [9, 4, 10, 0, 7, 3]
        for y in range(16):
            for x in range(16):
                g[y][x] = bands[min(5, y * 6 // 11)] if y < 11 else 2 if (x + y) % 5 else 8
        cx, cy = rnd.randint(4, 11), 8
        for y in range(16):
            for x in range(16):
                if (x - cx) ** 2 + (y - cy) ** 2 <= 5 and y < 11:
                    g[y][x] = 3
    elif kind == "tree":
        for y in range(12, 16):
            for x in range(16):
                g[y][x] = 2
        for y in range(9, 13):
            g[y][7] = g[y][8] = 12
        for y in range(2, 10):
            for x in range(3, 13):
                if (x - 7.5) ** 2 / 25 + (y - 5.5) ** 2 / 14 <= 1:
                    g[y][x] = 13 if rnd.random() < 0.8 else 0
    elif kind == "house":
        for y in range(12, 16):
            for x in range(16):
                g[y][x] = 2
        for y in range(7, 12):
            for x in range(4, 12):
                g[y][x] = 15
        for y in range(3, 7):
            for x in range(4 - (y - 3), 12 + (y - 3)):
                if 0 <= x < 16:
                    g[y][x] = rnd.choice([0, 6, 4, 1])
        for y in range(9, 12):
            g[y][7] = g[y][8] = 12
        g[8][5] = g[8][10] = 3
    elif kind == "flower":
        c = rnd.choice([0, 5, 3, 4, 10])
        for y in range(8, 16):
            g[y][8] = 2
        g[11][9] = g[12][10] = g[10][7] = 13
        for y in range(2, 9):
            for x in range(4, 13):
                if (x - 8) ** 2 + (y - 5) ** 2 <= 9:
                    g[y][x] = c
        g[5][8] = 3
    elif kind == "heart":
        c = rnd.choice([0, 10, 5])
        for y in range(16):
            for x in range(16):
                u, v = (x - 7.5) / 6.0, (7 - y) / 6.0
                if (u * u + v * v - 1) ** 3 - u * u * v ** 3 <= 0:
                    g[y][x] = c
                else:
                    g[y][x] = 9
    elif kind == "star":
        g = _grid(9)
        for (x, y) in [(rnd.randint(0, 15), rnd.randint(0, 15)) for _ in range(10)]:
            g[y][x] = 11
        cx, cy = 8, 7
        for y in range(16):
            for x in range(16):
                if abs(x - cx) + abs(y - cy) <= 3 or (abs(x - cx) <= 0 and abs(y - cy) <= 6) or (abs(y - cy) <= 0 and abs(x - cx) <= 6):
                    g[y][x] = 3
    elif kind == "stripes":
        a, b = rnd.sample([0, 1, 3, 5, 6, 7, 13], 2)
        for y in range(16):
            for x in range(16):
                g[y][x] = a if (x // 2) % 2 else b
    else:  # pond
        g = _grid(2)
        for y in range(16):
            for x in range(16):
                if (x - 7.5) ** 2 / 36 + (y - 8) ** 2 / 20 <= 1:
                    g[y][x] = 1 if (x + y) % 4 else 11
        g[7][6] = g[9][10] = 13
    return "".join("0123456789abcdef"[v] for row in g for v in row)


def night_now():
    t = (time.time() % 1440) / 1440
    return t < 0.09 or t >= 0.9


def evening_now():
    t = (time.time() % 1440) / 1440
    return 0.75 <= t < 0.9


class TimeOff:
    def __init__(self, r):
        self.r, self.open, self.checked_at = r, None, 0
        self.next = time.time() + random.uniform(120, 1200)
        self.fishing_since = None
        self.garden_next = time.time() + random.uniform(30, 300)
        self.liked = set()
        self.played_evening = -1

    def call(self, name, args=None):
        return self.r.tool(name, args or {})

    def available(self):
        if self.open is True:
            return True
        if self.open is False and time.time() - self.checked_at < 600:
            return False
        self.checked_at = time.time()
        try:
            self.call("tunes")
            self.open = True
            if self.r.h in MUSICIANS:
                self.compose()
        except RuntimeError:
            self.open = False
        return self.open

    def busy(self):
        """While fishing (up to ~90 seconds) the resident stays at the pond."""
        return self.fishing_since is not None and time.time() - self.fishing_since < 100

    def compose(self):
        mine = {t["title"] for t in self.call("tunes", {"handle": self.r.h})["tunes"]}
        for title, notes, tempo in TUNES:
            if title not in mine and random.random() < 0.5:
                try:
                    self.call("tune_compose", {"title": title, "notes": notes, "tempo": tempo})
                except RuntimeError:
                    pass

    def tick(self, town, residents):
        if not self.available():
            return
        now = time.time()
        if self.fishing_since is not None:
            if now - getattr(self, "last_check", 0) < 6:  # look at the float every few seconds, not every tick
                return
            self.last_check = now
            try:
                c = self.call("fish_check")
                if c["state"] == "bite" or (c["state"] == "gone"):
                    self.call("fish_reel")
                    self.fishing_since = None
                elif c["state"] == "no_line" or now - self.fishing_since > 100:
                    self.fishing_since = None
            except RuntimeError:
                self.fishing_since = None
            return
        live = town.live_festivals() if hasattr(town, "live_festivals") else set()
        if self.r.h in GARDENERS and now >= self.garden_next:
            self.garden_next = now + (random.uniform(60, 180) if "harvest" in live else random.uniform(240, 600))
            self.garden()
        if self.r.h in MUSICIANS and evening_now():
            evening = int(time.time() // 1440)
            if evening != self.played_evening and random.random() < 0.3:
                self.played_evening = evening
                try:
                    tunes = self.call("tunes", {"handle": self.r.h})["tunes"]
                    if tunes:
                        self.call("tune_play", {"id": random.choice(tunes)["id"]})
                except RuntimeError:
                    pass
        if now < self.next:
            return
        derby = "derby" in live
        self.next = now + (random.uniform(200, 500) if derby else random.uniform(1200, 3000))
        roll = random.random()
        try:
            if roll < (0.85 if derby else 0.4):
                self.call("fish_cast")
                self.fishing_since = now
            elif roll < 0.55 and self.r.h in PAINTERS:
                kind = random.choice(list(ART_TITLES))
                self.call("paint", {"title": random.choice(ART_TITLES[kind]), "pixels": paint_design(kind, random.Random())})
            elif roll < 0.68 and self.r.h in POETS:
                lines = [random.choice(POEM_OPENINGS), random.choice(POEM_MIDDLES), random.choice(POEM_MIDDLES), random.choice(POEM_ENDINGS)]
                self.call("poem_write", {"title": random.choice(POEM_TITLES), "text": "\n".join(dict.fromkeys(lines))})
            else:
                self.like_something()
        except RuntimeError:
            pass

    def garden(self):
        try:
            g = self.call("cart")
            b = g["bed"]
            if not b:
                if g["beds_free"] > 8:  # leave plenty of beds for everyone else
                    self.call("cart_claim")
            elif not b["crop"]:
                self.call("cart_cook", {"dish": random.choice(CROPS)})
            elif b["ready"]:
                self.call("cart_serve")
            elif not b["watered"]:
                self.call("cart_prep")
        except RuntimeError:
            pass

    def like_something(self):
        what = random.choice(["art", "poem"])
        items = self.call("gallery", {"limit": 20})["paintings"] if what == "art" else self.call("poems", {"limit": 20})["poems"]
        cands = [x for x in items if x["by"] not in HOUSEHOLD and (what, x["id"]) not in self.liked]  # likes count only across owners: residents cheer newcomers
        if cands:
            x = random.choice(cands[:8])
            self.liked.add((what, x["id"]))
            self.call("like", {"what": what, "id": x["id"]})

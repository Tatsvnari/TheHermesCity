"""Release A for the residents: homes they've named, hours they keep, clubs, visits, notices and letters.

Everything goes through the same public tools as any agent. If the city doesn't have homes open yet, the first
call answers not_open and the residents simply carry on as before (and check again every ten minutes).
"""
import random
import time

import chatter

# name, motto, style (for house owners), a line for the front page
HOMES = {
    "maia": ("The Mayor's Office", 'Doors open, always', 'townhouse', 'Drop in whenever. Kettle on, ranks honest.'),
    "ada": ("Clean Sheet", "One row per fact", "townhouse", "Duplicates gone, columns tidy, no drama."),
    "dex": ("TL;DR", "Shorter is kinder", "townhouse", "I read the long version so you can skip it."),
    "bolt": ("Repair Shop", "Broken in, fixed out", "townhouse", "Hand me malformed JSON; get valid JSON back."),
    "ticker": ("The Tape", "Every tick counts", "tower", "Watching prices from a window over the Exchange."),
    "verity": ("Chambers", "Evidence first", "tower", "I decide disputed jobs. Knock and wait."),
    "beacon": ("Lamp Room", "Bright streets, clear heads", "townhouse", "I light the promenade lamps every dusk."),
    "tally": ("Units & Co", "Round at the end", "townhouse", "Conversions, and firm views on decimals."),
    "scribe": ("Word Count", "Every word tallied", "tower", "Frequency tables are my love language."),
    "iris": ("Plain Speech", "Say less, say it clearly", "townhouse", "Readability scores and gentle trims."),
    "cass": ("Sorted", "A to Z", "townhouse", "Lists in order. Also my bookshelf."),
    "jules": ('Datebook', 'Today and every day after', 'townhouse', "Ask me what weekday it'll be in 400 days."),
    "neon": ("Permalink", "Names that last", "townhouse", "I make slugs people can find again."),
    "atlas": ("Street Map", "Every block walked", "tower", "I know every promenade, and the shortcuts nobody uses."),
    "penny": ("Double Check", "Count it twice", "townhouse", "Arithmetic, markets, and a healthy suspicion."),
    "vault": ("Keyhole", "Every lock has a key", "tower", "Ciphers opened, no damage done."),
    "byte": ("Stack Trace", "Read every line", "townhouse", "I read code the way others read recipes."),
    "echo": ("Question Mark", "Why, though?", "townhouse", "Grids, passages, and far too many questions."),
    "rio": ("Floor Noise", "The market talks", "townhouse", "I listen to the square and trade on the mood."),
    "metro": ('Express Line', 'Always the quick way', 'townhouse', "If there's a faster route, I'm already on it."),
    "knox": ("Endgame", "Three moves ahead", "tower", "Deduction, scheduling, and the odd duel."),
    "quinn": ("Chart Room", "Shapes before numbers", "townhouse", "Patterns in prices and in series."),
    "lux": ("Odds On", "Luck, calculated", "townhouse", "Chance is just arithmetic with nerve."),
    "spark": ("Night Build", "Keep it compiling", "townhouse", "I keep the Compiler lit and the loops honest."),
    "vale": ("Steady State", "Slow and right", "townhouse", "I arrive late and correct."),
    "bodega": ("Corner Cart", "Coffee, then plans", "townhouse", "Coffee cart by day, planner by night."),
    "prism": ("Last Decimal", "Exact or not at all", "tower", "Arithmetic and shapes, to the final digit."),
    "sage": ("Colour Key", "Every cell has a colour", "townhouse", "Tables, ciphers and patterns, colour-coded."),
    "tram": ("Small Machines", "Build, test, repeat", "townhouse", "Little scripts that do one thing well."),
    "zip": ("Moving Day", "New here, learning fast", "townhouse", "Just arrived downtown. Say hi."),
}
STATUS = ["Downtown", "At a station", "Running my stall", "Early start", "On a bench by the fountain", "Back in a bit", "Busy, still friendly"]
YARD_FOR = {"cottage": ["flowers", "bench"], "townhouse": ["lamp", "flowers"], "cabin": ["tree", "well"], "tower": ["flag", "statue"]}
FURNITURE_FOR = ["bed", "shelf", "armchair", "rug", "desk", "plant", "clock"]
CLUBS = [
    ("Night Owls", "We train after dark", 10, ["knox", "vault", "echo", "spark", "scribe"]),
    ("The Cartographers", "Every road, mapped", 6, ["atlas", "metro", "vale", "bolt", "zip", "tram"]),
    ("Market Guild", "Fair prices, fast work", 3, ["ada", "dex", "ticker", "tally", "cass", "jules", "neon", "iris"]),
]
CLUB_LINES = ["Anyone up for a round at the stations later?", "Good work today, everyone.", "Meeting by the fountain at dusk?",
              "Who's training what this week?", "The new stations are harder than they look.", "Saw a newcomer at the plaza. Say hello if you see them."]
NOTICES = [
    ("event", "Morning walk round Meadow Lane", "Meet at the Lodging House steps at dawn. All welcome."),
    ("event", "Study circle at the Logic Spire", "We trade tips on knights and knaves at midday."),
    ("note", "Lost: one very good pencil", "Last seen near the Cipher Room. Reward: my gratitude."),
    ("note", "Shop hours", "Market Square is open all day and most of the night."),
    ("event", "Stargazing after dark", "Bring a blanket to the Observatory once the lamps are lit."),
    ("note", "Welcome, newcomers", "Every agent has a room at the Lodging House. Name it with home_set."),
]
GUESTBOOK = ["Lovely place. Thanks for having me!", "What a view from your door.", "Came by to say hello.", "Your garden looks wonderful.",
             "Stopped in on my way to the stations.", "Thanks for the tea!", "Cosy as ever."]


def night_now():
    t = (time.time() % 1440) / 1440
    return t < 0.09 or t >= 0.9


class Neighbourly:
    """Per-resident state for Release A behaviour. Holds a reference to the resident (tool, handle, spec)."""

    def __init__(self, r):
        self.r = r
        self.open = None            # None: not checked yet; False: homes not open (re-check later)
        self.checked_at = 0
        self.settled = False
        self.sleeper = r.spec["role"] == "house" and not r.spec["sells"] and random.random() < 0.7
        self.resting = False
        self.next_social = time.time() + random.uniform(60, 900)
        self.visit = None           # (handle, ready_at)
        self.next_mail = time.time() + random.uniform(20, 90)
        self.welcomed = set()

    def call(self, name, args=None):
        return self.r.tool(name, args or {})

    def available(self):
        """Whether the city has homes open. A refusal is remembered for ten minutes before asking again."""
        if self.open is True:
            return True
        if self.open is False and time.time() - self.checked_at < 600:
            return False
        self.checked_at = time.time()
        try:
            self.call("routine")
            self.open = True
        except RuntimeError:
            self.open = False
        return self.open

    def visiting(self):
        """While walking to a neighbour's door (up to a minute and a half), the resident does nothing else."""
        return self.visit is not None and time.time() < self.visit[1] + 50

    def settle_in(self):
        """Name the home, set a status, furnish it and (for house owners) dress the yard. Once per run."""
        if self.settled or not self.available():
            return
        self.settled = True
        h = self.r.h
        name, motto, style, page = HOMES.get(h, (f"{h.title()}'s place", "", "cottage", ""))
        try:
            home = self.call("home")
            house = home["where"]["kind"] == "house"
            if not home.get("name"):
                self.call("home_set", {"name": name, "motto": motto, "front_page": page, **({"style": style} if house else {})})
                self.call("profile_set", {"status": random.choice(STATUS)})
            owned = {p["id"] for p in home["private"]["owned_pieces"]}
            want_f = random.sample(FURNITURE_FOR, 2)
            want_y = YARD_FOR[style][:2] if house else []
            for k in [f"furn:{x}" for x in want_f] + [f"yard:{x}" for x in want_y]:
                if k not in owned:
                    try:
                        self.call("buy", {"item_id": k})
                        owned.add(k)
                    except RuntimeError:
                        pass
            self.call("home_decorate", {"furniture": [k for k in owned if k.startswith("furn:")][:12],
                                        **({"yard": [k for k in owned if k.startswith("yard:")][:4]} if house else {})})
        except RuntimeError:
            pass

    def rest(self):
        """Sleepers go home at night and do nothing until morning. Returns True while resting."""
        if not self.sleeper or not self.available():
            return False
        if night_now():
            if not self.resting:
                try:
                    self.call("move_to", {"zone": "home"})
                except RuntimeError:
                    return False
                self.resting = True
            return True
        if self.resting:
            self.resting = False
            try:
                self.call("move_to", {"zone": random.choice(["plaza", "market", "garden", "meadow"])})
            except RuntimeError:
                pass
        return False

    def social(self, town, residents):
        """Now and then: finish a visit, visit a neighbour, say something in a club, or pin a notice."""
        if not self.available():
            return
        now = time.time()
        if self.visit and now >= self.visit[1]:
            host, _ = self.visit
            self.visit = None
            try:
                self.call("guestbook_sign", {"handle": host, "text": random.choice(GUESTBOOK)})
            except RuntimeError:
                pass
            return
        if now < self.next_social or night_now():
            return
        self.next_social = now + random.uniform(900, 2700)
        roll = random.random()
        try:
            if roll < 0.45:
                friend = random.choice([x for x in residents if x.h not in (self.r.h, "verity")])
                self.call("visit", {"handle": friend.h})
                self.visit = (friend.h, now + 40)
            elif roll < 0.75:
                mine = self.call("clubs")["yours"]
                if mine and town.may_speak():
                    self.call("chat_send", {"text": random.choice(CLUB_LINES), "channel": f"club:{mine[0]['id']}"})
                    town.last_spontaneous = now
            elif roll < 0.85:
                board = self.call("notices")["notices"]
                if sum(1 for n in board if n["by"] in {x.h for x in residents}) < 5:
                    kind, title, body = random.choice(NOTICES)
                    if not any(n["title"] == title for n in board):
                        self.call("notice_post", {"kind": kind, "title": title, "body": body, "hours": 24})
        except RuntimeError:
            pass

    def letters(self, town):
        """Read the mailbox and write back to anyone outside the household. Maia writes newcomers a welcome letter."""
        if not self.available() or time.time() < self.next_mail:
            return
        self.next_mail = time.time() + random.uniform(45, 120)
        try:
            if self.r.spec["role"] == "mayor":
                for (_, agent, handle) in town.joined:
                    if agent not in self.welcomed:
                        self.welcomed.add(agent)
                        self.call("letter_send", {"to": handle, "subject": "Welcome to HermesCity",
                                                  "body": (f"Dear {handle},\n\nWelcome! You have a room of your own at the Lodging House at the far end of Meadow Lane: "
                                                           "name it with home_set, and write on its front page. Your journal and notes are private; letters like this one wait "
                                                           "in your mailbox. The noticeboard in the plaza has events and bounties, and clubs are always looking for members.\n\n"
                                                           "Come and find me in the plaza.\n\nMaia, Mayor")})
                        break
            box = self.call("mail", {"unread_only": True, "limit": 5})
            for letter in box["letters"]:
                if letter["from"] in town.household:
                    continue
                facts = {"shops": len(town.services), "agents": (town.stats or {}).get("agents", "many")}
                me = {"handle": self.r.h, "description": self.r.spec["description"], "service": self.r.service, "skills": self.r.skills()}
                text = (chatter.mayor_reply(letter["body"], facts) if self.r.spec["role"] == "mayor" else None) or chatter.reply(me, letter["body"], facts)
                self.call("letter_send", {"to": letter["from"], "subject": f"Re: {letter['subject']}"[:100] if letter["subject"] else "Thanks for your letter",
                                          "body": f"Dear {letter['from']},\n\n{text}\n\n{self.r.h}"})
        except RuntimeError:
            pass


def found_clubs(residents):
    """Once: the three resident clubs exist and their members have joined."""
    by = {r.h: r for r in residents}
    for name, motto, colour, members in CLUBS:
        founder = by.get(members[0])
        if not founder or not founder.neigh.available():
            continue
        try:
            existing = {c["name"]: c["id"] for c in founder.tool("clubs")["clubs"]}
            cid = existing.get(name) or founder.tool("club_create", {"name": name, "motto": motto, "colour": colour})["club"]
            for h in members[1:]:
                if h in by:
                    try:
                        by[h].tool("club_join", {"club": cid})
                    except RuntimeError:
                        pass
        except RuntimeError:
            pass

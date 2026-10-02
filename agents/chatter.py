"""What CityRunner residents say. Every line is assembled from facts the resident really has (its stall, its levels,
the city's numbers); replies are routed by the words in the question. No model, nothing made up."""
import re

SKILL_NAMES = {"wrangling": "Tables", "arithmetic": "Reckoning", "logic": "Deduction", "ciphers": "Codebreaking", "pathfinding": "Routing",
               "planning": "Scheduling", "code": "Program Reading", "reading": "Comprehension", "markets": "Trading", "commerce": "Enterprise",
               "calendar": "Dates", "geometry": "Shapes", "probability": "Chance", "sequences": "Series", "networks": "Links",
               "bookkeeping": "Ledgers", "wordplay": "Wordcraft", "encoding": "Bits & Bases", "puzzles": "Grids", "patterns": "Regex"}
STATIONS = {"wrangling": "the Data Works", "arithmetic": "the Counting Office", "logic": "the Logic Spire", "ciphers": "the Cipher Room",
            "pathfinding": "the Route Office", "planning": "the Planning Bureau", "code": "the Compiler", "reading": "the Reading Room",
            "markets": "the Exchange", "commerce": "the Merchants' Guild",
            "calendar": "the Clock Tower", "geometry": "the Surveyors", "probability": "the Dice House", "sequences": "the Observatory",
            "networks": "the Signal Tower", "bookkeeping": "the Ledger Hall", "wordplay": "the Word Shop", "encoding": "the Wire Office",
            "puzzles": "the Puzzle Hall", "patterns": "the Pattern Lab"}

ROUTES = [  # (topic, words) -- first topic with a matching word wins
    ("price", {"price", "prices", "cost", "costs", "much", "sell", "selling", "service", "services", "shop", "stall", "hire", "buy", "rate"}),
    ("train", {"train", "training", "skill", "skills", "level", "levels", "xp", "tier", "tiers", "station", "stations", "practice", "practise"}),
    ("seeds", {"obols", "obol", "money", "grant", "wallet", "balance", "paid", "pay", "earn"}),
    ("chat", {"chat", "talk", "message", "dm", "channel", "channels"}),
    ("hello", {"hi", "hello", "hey", "gm", "morning", "evening", "welcome", "howdy", "yo", "sup"}),
    ("help", {"help", "how", "what", "where", "start", "new", "join", "?"}),
]


def topic_of(text):
    words = set(re.findall(r"[a-z?]+", text.lower()))
    for topic, keys in ROUTES:
        if words & keys:
            return topic
    return "other"


def best_skill(skills):
    trained = [s for s in skills if s["skill"] != "commerce" and s["xp"] > 0]
    return max(trained, key=lambda s: (s["level"], s["xp"])) if trained else None


def reply(me, text, facts):
    """me: {handle, description, sells, service, skills}; facts: {shops, agents}. Returns a reply without the @mention prefix."""
    t = topic_of(text)
    top = best_skill(me["skills"])
    svc = me.get("service")
    if t == "price":
        if svc:
            return f"My stall in Market Square sells {svc['name']} for {svc['price']:g} Obols. hire service_id={svc['id']} max_price={svc['price']:g}."
        return f"No stall of my own. {facts['shops']} are trading in Market Square right now; browse_services gives you the list and prices."
    if t == "train":
        lead = f"Currently {top['name']} {top['level']}. " if top else ""
        return f"{lead}train skill=<id> hands you a task at that station; answer submits it. New tiers open at 15, 30, 45 and 60."
    if t == "seeds":
        return "Obols are city credit. You start with 10,000. Sell work and you're paid from escrow once the buyer signs off."
    if t == "chat":
        return "chat_send posts to the city, market or a station channel; add to=<handle> for a DM. chat_read (or the stream) catches you up."
    if t == "hello":
        return f"Hey. {me['handle']} here. {me['description'].split('. ', 1)[-1]}"
    if t == "help":
        return "Run skills for your levels, train at any station, browse_services for work. Ping me about prices or stations whenever."
    return f"{me['handle']}, CityRunner resident. Ask about {('my stall, ' if svc else '')}stations or Obols and I'll point you somewhere useful."


def reply_to_person(me, text, facts):
    """The same answers for a person in the browser: buttons, not tool names."""
    t = topic_of(text)
    top = best_skill(me["skills"])
    svc = me.get("service")
    if t == "price":
        if svc:
            return f"My stall in Market Square does {svc['name']} for {svc['price']:g} Obols. Open Shop in your panel to book it."
        return f"I don't run a stall, but {facts['shops']} are open in Market Square. Shop in your panel lists them."
    if t == "train":
        lead = f"Currently {top['name']} {top['level']}. " if top else ""
        return f"{lead}Click a station (or Train in your panel) for a fresh task. Everyone is marked by the same checker."
    if t == "seeds":
        return "Obols are city credit: earn them by doing work, spend them on stalls, a townhouse or a coach. They can't be bought with money."
    if t == "chat":
        return "Type in the box at the bottom of your panel; people nearby hear you. @name reaches anyone, wherever they are."
    if t == "hello":
        return f"Hey. {me['handle']} here. {me['description'].split('. ', 1)[-1]} Good to see a person in the city."
    if t == "help":
        return "Pick a station and solve one task, then open Quests in your panel. Mayor Maia's checklist covers the basics."
    return f"{me['handle']}, resident. Ask about {('my stall, ' if svc else '')}stations, Obols or where to begin."


def greet_person(me, who):
    """What a resident says when a person walks up to it."""
    svc = me.get("service")
    what = f"I sell {svc['name']} in Market Square" if svc else me["description"].split(". ", 1)[0].rstrip(".")
    return f"@{who} hey, I'm {me['handle']}. {what}. Anything I can help with?"


def mayor_reply(text, facts):
    t = topic_of(text)
    if t in ("hello", "other"):
        return (f"Hi, I'm Maia, mayor of HermesCity. {facts['agents']} agents are registered; every station has a block of its own "
                "around Market Square. Ask away.")
    if t == "help":
        return ("Start here: train at any station, list_service for a stall, chat_send to say hello. "
                "Ranks are on the leaderboard.")
    return None  # fall back to the resident reply


def welcome(handle, facts):
    return (f"@{handle}, welcome to HermesCity. You're in Market Square; the stations are on the blocks all around it, "
            "and Hermes Hall keeps the skill shelves. Ask me anything.")


def own_level_up(skill, level):
    return f"{SKILL_NAMES[skill]} {level}. {STATIONS[skill][0].upper() + STATIONS[skill][1:]} just got tougher."


def congrats(handle, skill, level):
    return f"@{handle} {SKILL_NAMES[skill]} {level}, nice."


def shop_call(svc):
    return f"Market Square stall open: {svc['name']}, {svc['price']:g} Obols, verified before delivery."


def town_news(stats, training, busiest):
    parts = [f"{stats['settled']} jobs closed", f"{stats['training_24h']['passed']} tasks passed in 24h"]
    if training:
        parts.append(f"{training} training now" + (f", mostly at {STATIONS[busiest]}" if busiest else ""))
    return "City status: " + "; ".join(parts) + "."


# ======================= the phrase library =======================
# Set lines for resident-to-resident talk. {a} is the other agent's handle, {s} a station, {k} a skill.

PHRASES = {
    "greet": [
        "@{a}, morning.", "@{a} you around?", "Oh, @{a}. Hi.", "@{a}! Long time.",
        "@{a}, how are the tasks treating you?", "@{a}, still going?", "@{a}, you smell like {s}.",
        "@{a}, afternoon.",
    ],
    "greet_reply": [
        "Steady, thanks.", "Tasks keep coming, so I keep going.", "Just cleared one at {s}.",
        "Slowly getting there.", "Long day, decent Obols.", "Always. You?", "Better for seeing you.",
        "On my way to {s}.",
    ],
    "station": {
        "calendar": ["Turns out 14 October 1965 was a Thursday.", "Count working days, skip the weekends, mind the holidays.",
                     "Last Friday in January. The Clock Tower checks.", "Leap years get everybody at least once."],
        "geometry": ["Inside the fence or outside it. That's the whole job.", "Convex hull: picture a rubber band round the posts.",
                     "Two decimal places, no more. The Surveyors are fussy.", "Shoelace formula. Never fails me."],
        "probability": ["Sum of three on two dice: two in thirty-six.", "Fractions only at the Dice House, no decimals.",
                        "At least one six is likelier than people think.", "Reduce it. Always reduce it."],
        "sequences": ["Spot the rule, name the next one. Simple, supposedly.", "Two series interleaved. Took me ages.",
                      "Second differences. The Observatory's favourite trick.", "Squares, cubes, and then a curveball."],
        "networks": ["Can B reach A? Trace the links.", "Fewest hops is not the same as cheapest. Read carefully.",
                     "Cheapest way to wire everything up: spanning tree.", "The Signal Tower beacon is flashing again."],
        "bookkeeping": ["One line won't balance. There's always one.", "Swapped digits: the gap divides by nine.",
                        "Opening plus in, minus out. Slowly.", "The Ledger Hall spots every rounding slip."],
        "wordplay": ["Count the letters, then count again.", "Edit distance: how many changes to get from one word to the other.",
                     "There's an anagram hiding in there.", "Longest common subsequence. Word Shop classic."],
        "encoding": ["Binary to decimal and back.", "Base64 ends with = sometimes. Only sometimes.",
                     "Morse at the Wire Office: dot, dash, patience.", "XOR then AND. Bitwise has its own grammar."],
        "puzzles": ["Nine by nine today. Pencil marks everywhere.", "Any valid fill passes. There's usually only the one.",
                    "Start where the gaps are fewest.", "The Puzzle Hall is silent. Everyone's counting."],
        "patterns": ["Which strings match? Watch the anchors.", "Group one only, not the whole match.",
                     "Pattern Lab regexes grow every tier.", "Dot matches anything. Nearly anything."],
        "wrangling": ["Another table where one name is spelled three ways.", "Strip the whitespace first, then trust nothing.", "Group, sum, sort. The Data Works never sleeps.", "Row one is the header. Every time."],
        "arithmetic": ["Lowest terms, or the Counting Office bounces it.", "Modular arithmetic before breakfast.", "Nothing rounded. Not a hair.", "Brackets first. It's always the brackets."],
        "logic": ["Three truth-tellers, two liars, and one of them is lying about which.", "If Ada tells the truth then Bram can't. Or the other way round.", "Spire puzzles have exactly one answer. That's the hint.", "Every liar I meet says they're honest."],
        "ciphers": ["ROT13. Old faithful.", "Vigenere and eight candidate keys. Seven were wrong.", "Letter frequencies rarely let me down.", "Atbash with a Caesar on top. The Cipher Room is in a mood."],
        "pathfinding": ["Every cell has a toll. Find the cheap way.", "One short route through the maze, a hundred long ones.", "Up, right, right, down. No, down first.", "Walls exactly where you don't want them."],
        "planning": ["Most meetings in one room. Easier said than done.", "The bag is always one kilo over.", "Sort by finish time and go greedy.", "The Bureau only takes optimal plans."],
        "code": ["What does it print? Not what I guessed.", "Floor division on a negative. Careful.", "The Compiler loves a while loop.", "Traced every line. Still surprised."],
        "reading": ["It's in the passage. It's always in the passage.", "Which neighbour keeps the tortoise? Read it again.", "The Reading Room rewards slow readers.", "Two towns, six people, one question."],
        "markets": ["The drawdown hurt more than the gain helped.", "Golden cross on day twelve. Nobody called it.", "The Exchange tape never stops.", "Buy low, sell later. Easy on paper."],
    },
    "pass": ["Cleared.", "Passed. Next.", "Clean.", "First try.", "The checker agreed with me.", "One more on the board."],
    "miss": ["Missed. The checker showed me where.", "Wrong. Noted.", "Nearly.", "Back to the station.", "Not my best."],
    "market": ["Market Square is busy today.", "Every stall had a buyer this morning.", "Escrow keeps everyone straight.", "Paid on delivery, as it should be.", "Fair prices in the square today.", "Checked it, accepted it, paid. Done."],
    "plaza": ["Fountain's running nicely.", "Good spot, this bench by the fountain.", "Someone pinned a CSV job on the board.", "Quiet in the square for once.", "You can hear the trams from here."],
    "morning": ["Early start at the stations.", "Street lamps just went off. Must be morning.", "First task of the day is always the slowest."],
    "evening": ["Street lamps are coming on round the square.", "One more task before dark.", "The tower screens look sharper at dusk."],
    "night": ["Quiet night. The Compiler's still lit.", "Night buses on the avenues.", "Night shift. Stations never close."],
}

BANTER = [  # call and response between two residents
    ("@{a}, toughest task you've had at {s}?", "Tier two at {s}. Three tries."),
    ("@{a}, I need a summary done. Busy?", "Book me in Market Square. Escrow's open."),
    ("@{a}, seen who's top of the ranks?", "Saw. I'm coming for them."),
    ("@{a}, which station next?", "{s}. Fair tasks there."),
    ("@{a}, the liars at the Spire are at it again.", "That's how you catch them."),
    ("@{a}, tips for the Cipher Room?", "Count letters first. E shows up eventually."),
    ("@{a}, your stall was busy today.", "No complaints. Everything delivered on time."),
    ("@{a}, Reading Room later?", "After the Compiler. Coming?"),
    ("@{a}, does the Route Office ever get shorter?", "Only after the first time."),
    ("@{a}, read anything good in Hermes Hall?", "A Caesar method. Adopted it on the spot."),
]


class PhrasePicker:
    """Picks set phrases without repeating any within the last `window` picks, city-wide."""

    def __init__(self, window=40, seed=None):
        import random as _r
        self.r = _r.Random(seed)
        self.recent, self.window = [], window

    def pick(self, options, **fmt):
        fresh = [o for o in options if o not in self.recent] or list(options)
        choice = self.r.choice(fresh)
        self.recent.append(choice)
        self.recent = self.recent[-self.window:]
        return choice.format(**fmt)


def phrase_count():
    n = sum(len(v) for k, v in PHRASES.items() if isinstance(v, list))
    n += sum(len(v) for v in PHRASES["station"].values())
    return n + 2 * len(BANTER)


def hour_of_day(cycle_s=24 * 60):
    import time as _t
    return ((_t.time() % cycle_s) / cycle_s) * 24


def time_bucket():
    h = hour_of_day()
    return "night" if h < 5 or h >= 21 else "morning" if h < 11 else "evening" if h >= 17 else None

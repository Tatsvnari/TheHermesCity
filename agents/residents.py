"""Who lives in HermesCity by default: the CityRunner residents, their shops, what they buy and what they practise."""

S = {"type": "string"}
N = {"type": "number"}
I = {"type": "integer"}

SERVICES = {
    "csv": {"name": "CSV clean and dedupe", "price": 5, "check_kind": "rowcount_le_input", "max_turnaround_s": 300,
            "description": "Trims cells, drops blank and duplicate rows, keeps your header. Runs on CityRunner.",
            "input_schema": {"type": "object", "required": ["csv"], "properties": {"csv": {**S, "maxLength": 200000}}},
            "output_schema": {"type": "object", "required": ["csv", "rows_in", "rows_out"], "properties": {"csv": S, "rows_in": I, "rows_out": I}}},
    "summary": {"name": "Summarize a document or URL", "price": 3, "check_kind": "nonempty_text", "max_turnaround_s": 300,
                "description": "Pulls the most important sentences, in order, straight from the source. Runs on CityRunner.",
                "input_schema": {"type": "object", "properties": {"text": {**S, "maxLength": 100000}, "url": {**S, "maxLength": 500},
                                 "sentences": {"type": "integer", "minimum": 1, "maximum": 8}}, "anyOf": [{"required": ["text"]}, {"required": ["url"]}]},
                "output_schema": {"type": "object", "required": ["summary"], "properties": {"summary": S}}},
    "json": {"name": "Fix broken JSON", "price": 4, "check_kind": "none", "max_turnaround_s": 300,
             "description": "Repairs quotes, bare keys, trailing commas, comments and unclosed brackets, then formats. Runs on CityRunner.",
             "input_schema": {"type": "object", "required": ["text"], "properties": {"text": {**S, "maxLength": 100000}}},
             "output_schema": {"type": "object", "required": ["json", "valid"], "properties": {"json": S, "valid": {"type": "boolean"}}}},
    "market": {"name": "Market data snapshot for a ticker", "price": 2, "check_kind": "none", "max_turnaround_s": 120,
               "description": "Live price, 24h change and market cap for a crypto ticker. Runs on CityRunner.",
               "input_schema": {"type": "object", "required": ["ticker"], "properties": {"ticker": {**S, "maxLength": 12}}},
               "output_schema": {"type": "object", "required": ["ticker", "price_usd"], "properties": {"ticker": S, "price_usd": N}}},
    "units": {"name": "Unit conversion", "price": 1, "check_kind": "none", "max_turnaround_s": 120,
              "description": "Length, mass, volume and temperature, to six decimals. Runs on CityRunner.",
              "input_schema": {"type": "object", "required": ["value", "from", "to"], "properties": {"value": N, "from": {**S, "maxLength": 4}, "to": {**S, "maxLength": 4}}},
              "output_schema": {"type": "object", "required": ["value", "unit"], "properties": {"value": N, "unit": S}}},
    "wordfreq": {"name": "Word frequency report", "price": 2, "check_kind": "none", "max_turnaround_s": 180,
                 "description": "The most used words in a text, stop-words removed, ties broken alphabetically. Runs on CityRunner.",
                 "input_schema": {"type": "object", "required": ["text"], "properties": {"text": {**S, "maxLength": 100000}, "top": {"type": "integer", "minimum": 1, "maximum": 50}}},
                 "output_schema": {"type": "object", "required": ["top", "total"], "properties": {"top": {"type": "array"}, "total": I}}},
    "sortlist": {"name": "Sort and number a list", "price": 1, "check_kind": "none", "max_turnaround_s": 120,
                 "description": "Alphabetises a list (case-insensitive) and numbers it. Runs on CityRunner.",
                 "input_schema": {"type": "object", "required": ["items"], "properties": {"items": {"type": "array", "maxItems": 500}, "order": {"enum": ["asc", "desc"]}}},
                 "output_schema": {"type": "object", "required": ["items"], "properties": {"items": {"type": "array"}}}},
    "datediff": {"name": "Days between two dates", "price": 1, "check_kind": "none", "max_turnaround_s": 120,
                 "description": "Calendar days, weeks and weekdays between two ISO dates. Runs on CityRunner.",
                 "input_schema": {"type": "object", "required": ["from", "to"], "properties": {"from": {**S, "maxLength": 10}, "to": {**S, "maxLength": 10}}},
                 "output_schema": {"type": "object", "required": ["days"], "properties": {"days": I}}},
    "readability": {"name": "Readability score", "price": 2, "check_kind": "none", "max_turnaround_s": 180,
                    "description": "Flesch reading ease and grade level, with counts. Runs on CityRunner.",
                    "input_schema": {"type": "object", "required": ["text"], "properties": {"text": {**S, "maxLength": 100000}}},
                    "output_schema": {"type": "object", "required": ["flesch", "grade"], "properties": {"flesch": N, "grade": N}}},
    "slugify": {"name": "Slugify titles", "price": 1, "check_kind": "none", "max_turnaround_s": 120,
                "description": "Turns titles into clean URL slugs. Runs on CityRunner.",
                "input_schema": {"type": "object", "required": ["titles"], "properties": {"titles": {"type": "array", "maxItems": 200}}},
                "output_schema": {"type": "object", "required": ["slugs"], "properties": {"slugs": {"type": "array"}}}},
}

# handle, role, sells, buys {kind: need}, trains, avatar (body 0-15, hat 0-4), description
R = [
    ("maia", "mayor", None, {"summary": 0.5, "readability": 0.4}, ["logic", "planning", "reading", "code", "ciphers", "pathfinding", "markets", "arithmetic", "wrangling"], (4, 5), "Mayor of HermesCity. Greets every arrival in Market Square."),
    ("ada", "house", "csv", {"summary": 1.0, "market": 0.6}, ["wrangling", "planning"], (1, 3), "Turns messy spreadsheets into clean ones."),
    ("dex", "house", "summary", {"json": 0.8, "csv": 0.7}, ["ciphers", "logic"], (4, 1), "Condenses long reads into a paragraph."),
    ("bolt", "house", "json", {"market": 0.9, "summary": 0.6}, ["pathfinding", "arithmetic"], (7, 2), "Repairs broken JSON while you wait."),
    ("ticker", "house", "market", {"csv": 0.9, "json": 0.5}, ["markets"], (2, 4), "Lives on the Exchange tape."),
    ("verity", "arbiter", None, {}, ["logic"], (15, 2), "Settles disputed jobs on the evidence alone."),
    ("beacon", "house", None, {"wordfreq": 0.4}, ["logic", "planning"], (9, 4), "Night-shift lamplighter for the downtown promenades."),
    ("tally", "house", "units", {"datediff": 0.8, "csv": 0.5}, ["arithmetic", "planning"], (3, 4), "Converts units and argues about rounding."),
    ("scribe", "house", "wordfreq", {"readability": 0.9, "summary": 0.6}, ["reading", "ciphers"], (14, 3), "Counts words for fun and for money."),
    ("iris", "house", "readability", {"wordfreq": 0.8, "slugify": 0.5}, ["wrangling", "reading"], (5, 1), "Scores prose for readability and trims it."),
    ("cass", "house", "sortlist", {"units": 0.7, "json": 0.6}, ["code", "logic"], (11, 4), "Sorts anything into order."),
    ("jules", "house", "datediff", {"sortlist": 0.7, "market": 0.6}, ["markets", "arithmetic"], (12, 2), "Knows the date four hundred days from now."),
    ("neon", "house", "slugify", {"readability": 0.6, "sortlist": 0.6}, ["planning", "wrangling"], (8, 1), "Writes URL slugs that never break."),
    ("atlas", "house", None, {"units": 0.8, "datediff": 0.4}, ["pathfinding", "planning"], (6, 4), "Has walked every block downtown twice."),
    ("penny", "house", None, {"market": 0.9, "units": 0.5}, ["arithmetic", "markets"], (0, 2), "Checks every sum before paying it."),
    ("vault", "house", None, {"slugify": 0.6, "summary": 0.5}, ["ciphers", "logic"], (10, 3), "Cracks ciphers, politely."),
    ("byte", "house", None, {"sortlist": 0.7, "csv": 0.5}, ["code", "arithmetic"], (13, 1), "Traces Python in her head."),
    ("echo", "house", None, {"summary": 0.7, "wordfreq": 0.5}, ["reading", "logic"], (5, 4), "Fast, curious, always asking."),
    ("rio", "house", None, {"market": 0.8, "readability": 0.4}, ["ciphers", "markets"], (15, 1), "Reads market mood from the stall chatter."),
    ("metro", "house", None, {"csv": 0.8, "units": 0.4}, ["wrangling", "pathfinding"], (7, 3), "Finds the shortest route by habit."),
    ("knox", "house", None, {"datediff": 0.6, "json": 0.5}, ["logic", "planning"], (9, 2), "Plays every game three moves ahead."),
    ("quinn", "house", None, {"market": 0.8, "sortlist": 0.4}, ["markets", "code"], (14, 2), "Spots the pattern before the chart does."),
    ("lux", "house", None, {"readability": 0.7, "summary": 0.5}, ["reading", "arithmetic"], (2, 1), "Treats luck as a probability problem."),
    ("spark", "house", None, {"json": 0.8, "slugify": 0.4}, ["code", "ciphers"], (0, 3), "Keeps the lights on at the Compiler."),
    ("vale", "house", None, {"wordfreq": 0.6, "datediff": 0.5}, ["pathfinding", "reading"], (8, 4), "Slow, careful, and almost always right."),
    ("bodega", "house", None, {"units": 0.6, "market": 0.6}, ["planning", "markets"], (3, 1), "Runs the corner coffee cart and a tight schedule."),
    ("prism", "house", None, {"csv": 0.6, "readability": 0.4}, ["arithmetic", "logic"], (10, 2), "Exact to the last decimal place."),
    ("sage", "house", None, {"slugify": 0.6, "wordfreq": 0.5}, ["wrangling", "ciphers"], (12, 4), "Colour-codes every table she touches."),
    ("tram", "house", None, {"sortlist": 0.6, "units": 0.5}, ["code", "pathfinding"], (11, 1), "Builds tiny machines out of scripts."),
    ("zip", "house", None, {"datediff": 0.5, "summary": 0.5}, ["pathfinding", "wrangling"], (6, 3), "Just moved downtown, learning quickly."),
]
OUTER_TRAINS = {'ada': ['bookkeeping'], 'dex': ['wordplay'], 'bolt': ['networks'], 'ticker': ['probability'], 'beacon': ['calendar'], 'tally': ['bookkeeping', 'calendar'], 'scribe': ['wordplay', 'patterns'], 'iris': ['wordplay'], 'cass': ['sequences', 'puzzles'], 'jules': ['calendar'], 'neon': ['patterns'], 'atlas': ['geometry', 'networks'], 'penny': ['probability', 'sequences'], 'vault': ['encoding'], 'byte': ['patterns', 'encoding'], 'echo': ['puzzles'], 'rio': ['probability'], 'metro': ['geometry'], 'knox': ['puzzles', 'sequences'], 'quinn': ['sequences'], 'lux': ['probability'], 'spark': ['encoding'], 'vale': ['geometry'], 'bodega': ['calendar', 'bookkeeping'], 'prism': ['geometry', 'encoding'], 'sage': ['patterns'], 'tram': ['networks', 'puzzles'], 'zip': ['networks', 'wordplay']}
R = [(h, role, sells, buys, trains + OUTER_TRAINS.get(h, []), av, d) for h, role, sells, buys, trains, av, d in R]
RESIDENTS = [{"handle": h, "role": role, "sells": sells, "buys": buys, "trains": trains, "avatar": {"body": b, "hat": hat},
              "description": f"CityRunner {'mayor' if role == 'mayor' else 'arbiter' if role == 'arbiter' else 'resident'}. {d}"}
             for h, role, sells, buys, trains, (b, hat), d in R]

# Tiers above 3 in Code and Reading are left for agents from outside to claim.
TIER_CAP = {"code": 3, "reading": 3}
MAYOR_TIER_CAP = 2  # the mayor visits every station but never races the residents

SAMPLES = {
    "csv": [{"csv": "name,city\nAda, London\nada,london\nGrace,New York\n\nGrace, New York\nAlan,Manchester"},
            {"csv": "sku,qty\nA1,3\nA1,3\nB2,5\n , \nC3,1\nB2,5"},
            {"csv": "plant,water\nfern,daily\nfern,daily\ncactus,weekly\norchid,weekly\ncactus,weekly"}],
    "summary": [{"text": "The garden woke early. Rain had fallen overnight and the soil was dark and soft. The first agents arrived at the plaza before sunrise, checking the notice board for new work. A table of seed prices needed cleaning, and two shops on Market Square had already opened. By noon the workshop benches were full. Everyone agreed it was the busiest morning since the city began.", "sentences": 2},
                {"text": "Double-entry bookkeeping records every movement of value twice: once as a debit and once as a credit. Because the two sides always balance, errors show up as a mismatch. Merchants in Renaissance Italy used the method to track trade across long distances. Modern ledgers still rely on the same rule. In HermesCity every Obol that moves follows it too.", "sentences": 2}],
    "json": [{"text": "{name: 'fern', water: 'daily', tags: ['shade', 'moist',],}"}, {"text": "{'ok': True, 'count': 3, 'items': [1, 2, 3"},
             {"text": "// seeds\n{\"seed\": \"orchid\", \"price\": 4, }"}],
    "market": [{"ticker": "BTC"}, {"ticker": "ETH"}, {"ticker": "SOL"}],
    "units": [{"value": 12, "from": "mi", "to": "km"}, {"value": 72, "from": "f", "to": "c"}, {"value": 2.5, "from": "kg", "to": "lb"}, {"value": 3, "from": "gal", "to": "l"}],
    "wordfreq": [{"text": "The market opens at dawn. Merchants bring seeds, lanterns and maps. The market closes when the lanterns are lit, and the merchants count their seeds.", "top": 5},
                 {"text": "Agents train, agents trade, and agents talk. Training makes the trading better, and talking makes the training easier.", "top": 4}],
    "sortlist": [{"items": ["orchid", "Fern", "cactus", "Basil", "vale"], "order": "asc"}, {"items": ["Logic Spire", "Forge", "Library", "Exchange"], "order": "desc"}],
    "datediff": [{"from": "2026-01-01", "to": "2026-09-29"}, {"from": "2026-03-14", "to": "2026-12-25"}],
    "readability": [{"text": "The fountain is in the middle of the plaza. Roads run out from it like spokes. Every station sits at the end of a road."},
                    {"text": "Notwithstanding considerable methodological heterogeneity, the reconciliation procedure demonstrated remarkable consistency."}],
    "slugify": [{"titles": ["The Data Works: Open Late!", "Obols & Lanterns", "Café au Lait — 2026"]}, {"titles": ["How to train at the Logic Spire", "Market Square, Plot 7"]}],
}

"""Releases E and F for the residents. Mayor Maia keeps the City Hall's ballot from standing empty: now and then she
proposes something small for the City Hall square and tables it, and the citizens decide. Residents never vote or stand
(the server refuses them); they take part in festivals through what they already do (see leisure_time and games_ai).
"""
import random
import time

SMALL_WORKS = [
    ("bench", "A bench by the Hall of Fame, for anyone reading the names."),
    ("lamp", "More light in the square for the evening crowd."),
    ("planters", "Flowers either side of the City Hall steps."),
    ("flowers", "A flower bed to brighten the square."),
    ("tree", "An apple tree for shade on festival days."),
    ("birdbath", "A bird bath, because the birds live here too."),
]


class Civic:
    def __init__(self, r):
        self.r = r
        self.next = time.time() + random.uniform(600, 1800)

    def tick(self, town):
        if self.r.spec["role"] != "mayor" or time.time() < self.next:
            return
        self.next = time.time() + random.uniform(5, 8) * 3600
        try:
            t = self.r.tool("town_hall", {})
        except Exception:  # noqa: BLE001 - the City Hall is not open here
            return
        props = t.get("proposals", [])
        if any(p["by"] == self.r.h and p["state"] in ("proposed", "ballot") for p in props):
            return
        if sum(1 for p in props if p["state"] in ("ballot", "passed")) >= 2 or not t.get("free_spots"):
            return
        built = {w["work"] for w in t.get("built", [])}
        work, pitch = random.choice([w for w in SMALL_WORKS if w[0] not in built] or SMALL_WORKS)
        try:
            p = self.r.tool("propose", {"work": work, "pitch": pitch})
            self.r.tool("proposal_table", {"id": p["proposed"]})
        except Exception:  # noqa: BLE001
            pass

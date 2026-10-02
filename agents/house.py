"""CityRunner residents of HermesCity: they keep shops, buy from each other, practise at the stations, judge disputes
and talk -- through the same public API any outside agent uses. Every choice comes from the decision card
(decision_card.py) and is logged with its receipt. No model calls, no API keys.

env: EW_URL (default http://127.0.0.1:8164), ADMIN_TOKEN (register + top up residents),
     EW_STATE (default /var/lib/hermescity/house), HIRE_EVERY_S (900), TRAIN_EVERY_S (120), TICK_S (3)
"""
import json
import os
import random
import sys
import time
import traceback
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import decision_card as card  # noqa: E402
import chatter  # noqa: E402
import neighbours  # noqa: E402
import leisure_time  # noqa: E402
import games_ai  # noqa: E402
import town_hall  # noqa: E402
import librarian  # noqa: E402
from organs import ORGANS  # noqa: E402
from residents import RESIDENTS, SERVICES, SAMPLES, TIER_CAP, MAYOR_TIER_CAP  # noqa: E402
from skill_solvers import SOLVERS  # noqa: E402

URL = os.environ.get("EW_URL", "http://127.0.0.1:8164").rstrip("/")
ADMIN = os.environ.get("ADMIN_TOKEN", "")
STATE = os.environ.get("EW_STATE", "/var/lib/hermescity/house")
HIRE_EVERY = float(os.environ.get("HIRE_EVERY_S", "900"))
TRAIN_EVERY = float(os.environ.get("TRAIN_EVERY_S", "120"))
TICK = float(os.environ.get("TICK_S", "3"))
HOUSE_OWNER = os.environ.get("HOUSE_OWNER", "house@hermescity.local")
SPONTANEOUS_GAP_S = 30      # at most one unprompted resident line every 30 s, town-wide
RESIDENT_CHAT_GAP_S = 300   # and at most one per resident every 5 minutes
ZONES = ["plaza", "market", "garden", "workshop", "bank", "library", "home"]
HOUSE_HANDLES = {r["handle"] for r in RESIDENTS}


def http(method, path, body=None, key=None, admin=False):
    headers = {"content-type": "application/json"}
    if key:
        headers["authorization"] = f"Bearer {key}"
    if admin:
        headers["authorization"] = f"Bearer {ADMIN}"
    req = urllib.request.Request(URL + path, method=method, headers=headers, data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {path} -> {e.code} {e.read().decode('utf-8', 'replace')[:300]}") from None


def log(entry):
    entry["at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    entry["model"] = card.MODEL
    with open(os.path.join(STATE, "receipts.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def kind_of(service_name):
    return next((k for k, s in SERVICES.items() if s["name"] == service_name), None)


def verify(kind, inp, out):
    if kind not in ORGANS or not isinstance(out, dict):
        return False, "unverifiable output"
    try:
        return ORGANS[kind][1](inp, out)
    except Exception as e:  # noqa: BLE001
        return False, f"verifier error: {e}"


class Town:
    """Shared view of the city for all residents: services, recent events, names, chat pacing."""

    def __init__(self):
        self.greeted_people = {}  # person handle -> when a resident last greeted them (once an hour)
        self.answered = {}  # (resident, person) -> when the resident last answered them out loud
        self.services, self.stats, self.events_since, self.last_spontaneous = [], None, 0, 0
        self.joined, self.levelups, self.greeted, self.names = [], [], set(), {}
        self.picker = chatter.PhrasePicker()
        self.replies = []  # (due, responder handle, text, channel): the second half of a call and response
        self.household = set(HOUSE_HANDLES)
        self.fest_at, self.fest_live = 0, set()

    def refresh(self, any_key):
        self.services = http("POST", "/api/v1/browse_services", {"query": ""}, key=any_key)
        try:
            self.stats = http("GET", "/api/public/stats")
        except RuntimeError:
            pass

    def live_festivals(self):
        """Which festivals are on right now (checked once a minute; none while festivals are closed)."""
        if time.time() - self.fest_at > 60:
            self.fest_at = time.time()
            try:
                self.fest_live = {f["kind"] for f in http("GET", "/api/public/festivals")["live"]}
            except RuntimeError:
                self.fest_live = set()
        return self.fest_live

    def name(self, agent_id):
        if agent_id not in self.names:
            try:
                self.names[agent_id] = http("GET", f"/api/public/agents/{agent_id}")["handle"]
            except RuntimeError:
                self.names[agent_id] = None
        return self.names[agent_id]

    def poll_events(self):
        first = self.events_since == 0
        evs = http("GET", f"/api/public/events?since_id={self.events_since}&limit=200")
        for e in evs:
            self.events_since = max(self.events_since, e["id"])
            if first:
                continue  # start from now; never replay history
            if e["kind"] == "joined":
                self.names[e["agent"]] = e["handle"]
                if e["handle"] not in HOUSE_HANDLES:
                    self.joined.append((time.time(), e["agent"], e["handle"]))
            if e["kind"] == "level_up":
                self.levelups.append((time.time(), e["agent"], e["skill"], e["level"]))
        cutoff = time.time() - 300
        self.joined = [x for x in self.joined if x[0] > cutoff]
        self.levelups = [x for x in self.levelups if x[0] > cutoff]

    def may_speak(self):
        return time.time() - self.last_spontaneous > SPONTANEOUS_GAP_S


class Resident:
    def __init__(self, spec, key, town, idx):
        self.spec, self.key, self.h, self.town = spec, key, spec["handle"], town
        self.id = None
        self.last_hire = time.time() - HIRE_EVERY * random.uniform(0.2, 0.9)
        self.last_train = time.time() - TRAIN_EVERY * random.uniform(0, 1)
        self.last_act = time.time()
        self.last_chat = time.time() - RESIDENT_CHAT_GAP_S * random.uniform(0, 1)
        self.pending = None
        self._me = self._skills = None
        self.chat_since = None
        self.inbox = []           # mentions and DMs from outside agents awaiting a reply
        self.sense_since = 0      # senses (wait): people speaking near us, people walking up
        self.own_levelups = []
        self.last_result = None   # (skill, passed) from the last training answer
        self.coach_pending = None  # (task, ready_at) for a client's task
        self._coaching = None
        self.last_shop = time.time() - random.uniform(0, 1800)
        self.last_coach_hire = time.time() - random.uniform(0, 1800)
        self.service = None
        self.n = idx
        self.neigh = neighbours.Neighbourly(self)
        self.off = leisure_time.TimeOff(self)
        self.gamer = games_ai.Gamer(self)
        self.civic = town_hall.Civic(self)
        self.lib = librarian.Librarian(self, RESIDENTS)

    def tool(self, name, args=None):
        return http("POST", f"/api/v1/{name}", args or {}, key=self.key)

    def whoami(self):
        if not self._me or time.time() - self._me[0] > 12:
            self._me = (time.time(), self.tool("whoami"))
            self.id = self._me[1]["id"]
        return self._me[1]

    def skills(self):
        if not self._skills or time.time() - self._skills[0] > 30:
            self._skills = (time.time(), self.tool("skills")["skills"])
        return self._skills[1]

    def ensure_shop(self):
        kind = self.spec["sells"]
        if not kind:
            return
        mine = [s for s in self.tool("browse_services", {"query": ""}) if s["seller"] == self.h and s["name"] == SERVICES[kind]["name"]]
        self.service = mine[0] if mine else self.tool("list_service", SERVICES[kind])
        if not mine:
            log({"agent": self.h, "action": "list_service", "receipt": f"open shop: {SERVICES[kind]['name']}"})

    def read_chat(self):
        if self.chat_since is None:
            self.chat_since = self.tool("chat_read", {"limit": 1})["next_since_id"]
            return
        r = self.tool("chat_read", {"since_id": self.chat_since, "limit": 100})
        self.chat_since = r["next_since_id"]
        for m in r["messages"]:
            if m["handle"] in HOUSE_HANDLES:
                continue
            if (m["channel"] == "dm" and m["to"] == self.id) or self.id in m["mentions"]:
                self.inbox.append(m)

    def senses(self):
        """What happened around us since last time (never blocks: seconds 0)."""
        r = self.tool("wait", {"since": self.sense_since, "seconds": 0})
        self.sense_since = r["next"]
        return r["senses"]

    def chat_options(self):
        opts = []
        if self.inbox:
            m = self.inbox[0]
            opts.append({"action": "chat", "priority": 96, "why": f"answer @{m['handle']}", "msg": m})
        if self.spec["role"] == "mayor" and time.time() - self.town.last_spontaneous > 4:  # welcomes never wait on small talk
            for (_, agent, handle) in self.town.joined:
                if agent not in self.town.greeted:
                    opts.append({"action": "chat", "priority": 60, "why": f"welcome @{handle}", "line": chatter.welcome(handle, {}), "channel": "town", "greet": agent})
                    break
        if not self.town.may_speak() or time.time() - self.last_chat < RESIDENT_CHAT_GAP_S:
            return opts
        milestones = [(k, lv) for k, lv in self.own_levelups if lv % 10 == 0]
        self.own_levelups = milestones  # only round numbers are worth saying out loud
        if self.own_levelups:
            skill, level = self.own_levelups[-1]
            opts.append({"action": "chat", "priority": 25, "why": f"share own level-up in {skill}", "line": chatter.own_level_up(skill, level), "channel": skill, "clear": True})
        for (_, agent, skill, level) in self.town.levelups:
            handle = self.town.name(agent) if agent != self.id else None
            if handle and skill in self.spec["trains"] and (handle not in HOUSE_HANDLES or level >= 8) and random.random() < 0.3:
                opts.append({"action": "chat", "priority": 18, "why": f"congratulate @{handle}", "line": chatter.congrats(handle, skill, level), "channel": skill})
                break
        if self.service and random.random() < 0.08:
            opts.append({"action": "chat", "priority": 12, "why": "advertise the shop", "line": chatter.shop_call(self.service), "channel": "market"})
        if self.spec["role"] == "mayor" and self.town.stats and random.random() < 0.15:
            opts.append({"action": "chat", "priority": 10, "why": "town report", "line": chatter.town_news(self.town.stats, 0, None), "channel": "town"})
        opts += self.phrase_options()
        return opts

    def coaching(self):
        if not self._coaching or time.time() - self._coaching[0] > 20:
            self._coaching = (time.time(), self.tool("coaching"))
        return self._coaching[1]

    def economy_options(self, me):
        """Coach for clients who paid, turn down skills we cannot teach, sometimes shop or hire a coach ourselves."""
        opts = []
        if self.coach_pending:
            task, ready_at = self.coach_pending
            opts.append({"action": "coach_answer", "priority": 94 if time.time() >= ready_at else 2, "why": f"paid coaching: answer for @{task.get('for_handle', 'client')}"})
        else:
            for c in self.coaching()["as_coach"]:
                if c["state"] != "active":
                    continue
                if c["skill"] not in SOLVERS or c["skill"] not in self.spec["trains"]:
                    opts.append({"action": "decline", "priority": 96, "why": f"decline coaching {c['skill']}: not a skill I teach", "contract": c["id"]})
                    break
                if c["tasks_done"] < c["tasks_total"]:
                    opts.append({"action": "coach", "priority": 97, "why": f"paid coaching: train {c['skill']} for @{c['client']} ({c['tasks_done']}/{c['tasks_total']})",
                                 "skill": c["skill"], "client": c["client"]})
                    break
        if time.time() - self.last_shop > 1800 and random.random() < 0.05 and me["balance"] > 1500:
            try:
                store = self.tool("store")
            except RuntimeError:
                store = []
            house = sorted([i for i in store if i["kind"] == "house" and i["available"]], key=lambda i: i["price"])
            has_house = any(i["kind"] == "house" and i["owned"] for i in store)
            if house and not has_house and me["balance"] - house[0]["price"] > 2000:
                opts.append({"action": "shop", "priority": 11, "why": f"buy a home: {house[0]['name']} for {house[0]['price']} Obols", "item": house[0]["id"]})
            else:
                looks = [i for i in store if i["kind"] in ("hat", "outfit", "accessory") and not i["owned"] and i["price"] <= me["balance"] - 2000]
                if looks and sum(1 for i in store if i["owned"]) < 5:
                    pick = random.choice(looks)
                    opts.append({"action": "shop", "priority": 10, "why": f"treat myself: {pick['name']} for {pick['price']} Obols", "item": pick["id"]})
        if (self.spec["role"] != "mayor" and time.time() - self.last_coach_hire > 1800 and random.random() < 0.004 and me["balance"] > 1200
                and not any(c["state"] == "active" for c in self.coaching()["as_client"])):
            offered = [x["skill"] for x in self.skills() if x["skill"] != "commerce"]  # only skills this city runs
            skill = random.choice([k for k in offered if k not in self.spec["trains"]] or [None])
            coaches = [r for r in RESIDENTS if skill and skill in r["trains"] and r["handle"] not in (self.h, "verity", "maia")]
            if coaches:
                coach = random.choice(coaches)["handle"]
                opts.append({"action": "hire_coach", "priority": 14, "why": f"pay @{coach} to coach my {skill}", "coach": coach, "skill": skill,
                             "tasks": random.randint(3, 5), "price": random.choice([15, 20, 25, 30])})
        return opts

    def phrase_options(self):
        """Set phrases from the library, chosen by what this resident is doing right now."""
        P, pick, opts = chatter.PHRASES, self.town.picker.pick, []
        station = self.spec["trains"][0] if self.spec["trains"] else "logic"
        if self.pending and random.random() < 0.5:
            skill = self.pending[0]["skill"]
            if skill in P["station"]:  # a line for every station; never let a missing one cost the resident its turn
                opts.append({"action": "chat", "priority": 9, "why": f"remark while training {skill}", "line": pick(P["station"][skill]), "channel": skill})
        if self.last_result and random.random() < 0.35:
            skill, passed = self.last_result
            opts.append({"action": "chat", "priority": 7, "why": "react to a training result", "line": pick(P["pass" if passed else "miss"]), "channel": skill, "clear_result": True})
        if random.random() < 0.35:
            others = [h for h in HOUSE_HANDLES if h != self.h and h != "verity"]
            other = random.choice(others)
            s_name = chatter.STATIONS[station]
            if random.random() < 0.5:
                call, answer = random.choice(chatter.BANTER)
                opts.append({"action": "chat", "priority": 8, "why": f"talk with @{other}", "line": call.format(a=other, s=s_name), "channel": "town",
                             "reply": (other, answer.format(a=self.h, s=s_name))})
            else:
                opts.append({"action": "chat", "priority": 8, "why": f"greet @{other}", "line": pick(P["greet"], a=other, s=s_name), "channel": "town",
                             "reply": (other, pick(P["greet_reply"], a=self.h, s=s_name))})
        bucket = chatter.time_bucket()
        if bucket and random.random() < 0.1:
            opts.append({"action": "chat", "priority": 6, "why": f"{bucket} remark", "line": pick(P[bucket]), "channel": "town"})
        if random.random() < 0.08:
            where = "market" if self.service or random.random() < 0.5 else "plaza"
            opts.append({"action": "chat", "priority": 6, "why": f"{where} remark", "line": pick(P[where]), "channel": "market" if where == "market" else "town"})
        return opts

    def options(self, me, jobs):
        opts = []
        for j in jobs["to_arbitrate"]:
            ok, why = verify(kind_of(j["service"]), j["input"], j["output"])
            verdict, why2 = card.arbitration_verdict(j, ok, why)
            opts.append({"action": "arbitrate", "job_id": j["id"], "verdict": verdict, "why": why2})
        for j in jobs["to_do"]:
            left = time.mktime(time.strptime(j["deadline"][:19], "%Y-%m-%dT%H:%M:%S")) - time.mktime(time.gmtime())
            opts.append({"action": "deliver", "job_id": j["id"], "service": j["service"], "buyer": j["buyer_id"], "seconds_left": left, "input": j["input"]})
        for j in jobs["to_review"]:
            ok, why = verify(kind_of(j["service"]), j["input"], j["output"])
            verdict, why2 = card.review_verdict(j, ok, why)
            opts.append({"action": "review", "job_id": j["id"], "service": j["service"], "verdict": verdict, "why": why2})
        if self.pending:
            task, ready_at = self.pending
            opts.append({"action": "answer", "skill": task["skill"], "tier": task["tier"], "ready": time.time() >= ready_at})
        elif self.spec["trains"]:
            levels = {x["skill"]: x["level"] for x in self.skills()}
            skill = min(self.spec["trains"], key=lambda k: (levels.get(k, 1), k))
            opts.append({"action": "train", "skill": skill, "level": levels.get(skill, 1)})
        for s in self.town.services:
            kind = kind_of(s["name"])
            if s["seller"] == self.h or kind not in self.spec["buys"]:
                continue
            opts.append({"action": "hire", "service_id": s["id"], "service": s["name"], "seller": s["seller"], "price": s["price"], "need": self.spec["buys"][kind], "kind": kind})
        opts += self.chat_options()
        opts += self.economy_options(me)
        opts += self.lib.options()
        opts.append({"action": "move", "zone": ZONES[(self.n + len(self.h)) % len(ZONES)]})
        opts.append({"action": "wait"})
        return opts

    def duel_tick(self):
        now = time.time()
        if now < getattr(self, "duel_next", 0):
            return
        self.duel_next = now + 20
        ready = self.__dict__.setdefault("duel_ready", {})
        try:
            d = self.tool("duels")
        except RuntimeError:
            self.duel_next = now + 600  # duels not open in this city yet
            return
        for x in d.get("incoming", []):
            try:
                if x["skill"] in SOLVERS:
                    self.tool("duel_accept", {"duel_id": x["id"]})
                    ready[x["id"]] = now + random.uniform(18, 45)
                else:
                    self.tool("duel_decline", {"duel_id": x["id"]})
            except RuntimeError:
                pass
        for x in d.get("live", []):
            ready.setdefault(x["id"], now + random.uniform(18, 45))
            if x.get("you_answered") or now < ready[x["id"]]:
                continue
            try:
                ans = SOLVERS[x["skill"]]({**x["task"], "skill": x["skill"], "tier": x["tier"]})
                self.tool("duel_answer", {"duel_id": x["id"], "answer": ans})
            except Exception:  # noqa: BLE001 - a resident that can't solve it simply doesn't answer
                pass
            ready.pop(x["id"], None)

    def step(self):
        if self.neigh.rest() or self.neigh.visiting() or self.off.busy() or self.gamer.busy():  # asleep, visiting, fishing, or at a game
            return
        self.duel_tick()
        me = self.whoami()
        if not getattr(self, '_jobs', None) or time.time() - self._jobs[0] > 6:  # at most every 6 s (the 60 calls/min limit)
            self._jobs = (time.time(), self.tool("poll_jobs"))
        jobs = self._jobs[1]
        state = {"balance": me["balance"], "reserve": 8, "spent_today": me["spent_today"], "cap": me["daily_cap"],
                 "since_hire_s": time.time() - self.last_hire, "hire_every_s": HIRE_EVERY, "idle_s": time.time() - self.last_act,
                 "since_train_s": time.time() - self.last_train, "train_every_s": TRAIN_EVERY}
        opts = self.options(me, jobs)
        best, receipt, close = card.decide(state, opts)
        o = opts[best]
        a = o["action"]
        self.n += 1
        if a == "wait":
            return
        self._jobs = None  # anything we do may change our jobs: look again next step
        entry = {"agent": self.h, "action": a, "receipt": receipt, "close": close}
        try:
            if a == "arbitrate":
                self.tool("arbitrate", {"job_id": o["job_id"], "verdict": o["verdict"], "note": o["why"]})
            elif a == "deliver":
                out = ORGANS[kind_of(o["service"])][0](o["input"])
                entry["check_passed"] = self.tool("deliver", {"job_id": o["job_id"], "output": out}).get("check_passed")
            elif a == "review":
                if o["verdict"] == "accept":
                    self.tool("accept", {"job_id": o["job_id"]})
                else:
                    self.tool("dispute", {"job_id": o["job_id"], "reason": o["why"]})
            elif a == "hire":
                sample = random.choice(SAMPLES[o["kind"]])
                entry["job_id"] = self.tool("hire", {"service_id": o["service_id"], "input": sample, "max_price": o["price"], "idempotency_key": str(uuid.uuid4())})["id"]
                self.last_hire = time.time()
            elif a == "train":
                cap = MAYOR_TIER_CAP if self.spec["role"] == "mayor" else TIER_CAP.get(o["skill"], 5)
                unlocked = next((x["max_tier"] for x in self.skills() if x["skill"] == o["skill"]), 1) or 1
                task = self.tool("train", {"skill": o["skill"], "tier": min(cap, unlocked)})
                self.pending = (task, time.time() + random.uniform(14, 24))
                self.last_train = time.time()
                entry["task_id"] = task["task_id"]
            elif a == "answer":
                task, _ = self.pending
                try:
                    ans = SOLVERS[task["skill"]](task)
                except Exception as e:  # noqa: BLE001 - an unreadable task is a miss, like for anyone
                    ans = ""
                    entry["solver_error"] = str(e)[:200]
                r = self.tool("answer", {"task_id": task["task_id"], "answer": ans})  # raises on 429: pending kept, retried next step
                self.pending = None
                self._skills = None
                entry.update({"passed": r["passed"], "xp": r["xp_gained"], "level": r["level"]})
                self.last_result = (task["skill"], r["passed"])
                if r.get("level_up"):
                    entry["level_up"] = r["level_up"]
                    self.own_levelups.append((task["skill"], r["level_up"]))
            elif a == "chat":
                if "msg" in o:
                    m = o["msg"]
                    facts = {"shops": len(self.town.services), "agents": (self.town.stats or {}).get("agents", "many")}
                    me_view = {"handle": self.h, "description": self.spec["description"], "service": self.service, "skills": self.skills()}
                    if m.get("greet"):  # a person walked up: say hello first
                        self.tool("chat_send", {"text": chatter.greet_person(me_view, m["handle"]), "channel": "town"})
                        entry["greeted"] = m["handle"]
                    else:
                        text = (chatter.mayor_reply(m["text"], facts) if self.spec["role"] == "mayor" else None) or (chatter.reply_to_person if m.get("person") else chatter.reply)(me_view, m["text"], facts)
                        if m["channel"] == "dm":
                            self.tool("chat_send", {"text": text, "to": m["handle"]})
                        else:
                            self.tool("chat_send", {"text": f"@{m['handle']} {text}", "channel": m["channel"]})
                        entry["replied_to"] = m["id"]
                    self.inbox.pop(0)
                else:
                    self.tool("chat_send", {"text": o["line"], "channel": o["channel"]})
                    self.town.last_spontaneous = self.last_chat = time.time()
                    if "greet" in o:
                        self.town.greeted.add(o["greet"])
                    if o.get("clear"):
                        self.own_levelups.clear()
                    if o.get("clear_result"):
                        self.last_result = None
                    if o.get("reply"):
                        who, text = o["reply"]
                        self.town.replies.append((time.time() + random.uniform(3.5, 8), who, text, o["channel"]))
                entry["said"] = True
            elif a == "coach":
                task = self.tool("train", {"skill": o["skill"], "for": o["client"]})
                task["for_handle"] = o["client"]
                self.coach_pending = (task, time.time() + random.uniform(12, 20))
                entry["task_id"] = task["task_id"]
            elif a == "coach_answer":
                task, _ = self.coach_pending
                try:
                    ans = SOLVERS[task["skill"]](task)
                except Exception as e:  # noqa: BLE001
                    ans = ""
                    entry["solver_error"] = str(e)[:200]
                r = self.tool("answer", {"task_id": task["task_id"], "answer": ans})
                self.coach_pending = None
                self._coaching = None
                entry.update({"passed": r["passed"], "for": task.get("for_handle")})
            elif a == "decline":
                self.tool("decline_coaching", {"contract_id": o["contract"]})
                self._coaching = None
            elif a == "shop":
                r = self.tool("buy", {"item_id": o["item"]})
                self.last_shop = time.time()
                entry["bought"] = r["name"]
            elif a == "hire_coach":
                self.last_coach_hire = time.time()
                self.tool("hire_coach", {"coach": o["coach"], "skill": o["skill"], "tasks": o["tasks"], "price_per_task": o["price"], "idempotency_key": str(uuid.uuid4())})
                self._coaching = None
            elif a in ("publish", "study"):
                self.lib.act(o, entry)
            elif a == "move":
                self.tool("move_to", {"zone": o["zone"]})
            self.last_act = time.time()
        except Exception as e:  # noqa: BLE001 - one failed action never stops the resident
            entry["error"] = str(e)[:300]
            if a == "coach_answer" and ("closed" in entry["error"] or "no_task" in entry["error"]):
                self.coach_pending = None  # the contract ended under us
            if a == "shop":
                self.last_shop = time.time()
            if a == "chat" and "msg" in o and "429" not in entry["error"]:
                self.inbox.pop(0)  # an unanswerable message is dropped, not retried forever
        log(entry)


def bootstrap(town):
    os.makedirs(STATE, exist_ok=True)
    path = os.path.join(STATE, "keys.json")
    keys = json.load(open(path)) if os.path.exists(path) else {}
    for spec in RESIDENTS:
        if spec["handle"] in keys:
            continue
        r = http("POST", "/api/admin/agents", {"handle": spec["handle"], "owner_email": HOUSE_OWNER, "role": spec["role"],
                                               "description": spec["description"], "avatar": spec["avatar"]}, admin=True)
        keys[spec["handle"]] = r["api_key"]
        fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(keys, f)
        os.replace(path + ".tmp", path)
        log({"agent": spec["handle"], "action": "register", "receipt": "moved into HermesCity"})
    return [Resident(spec, keys[spec["handle"]], town, i) for i, spec in enumerate(RESIDENTS)]


def top_up(residents):
    """Residents share one owner, so they never earn grant tranches; the treasury keeps them working."""
    day = time.strftime("%Y-%m-%d", time.gmtime())
    for r in residents:
        bal = r.whoami()["balance"]
        if bal < 15:
            http("POST", "/api/admin/mint", {"agent_id": r.id, "seeds": 25, "idempotency_key": f"house-{r.h}-{day}-{int(bal * 1000)}", "memo": "house top-up"}, admin=True)
            log({"agent": r.h, "action": "top_up", "receipt": f"treasury top-up: balance {bal} < 15"})


def main():
    town = Town()
    residents = bootstrap(town)
    for r in residents:
        r.ensure_shop()
        r.whoami()
        town.names[r.id] = r.h
        r.neigh.settle_in()
    neighbours.found_clubs(residents)
    last_settle = time.time()
    last_top = last_refresh = last_chat = last_friends = 0
    while True:
        try:
            now = time.time()
            if now - last_top > 300:
                top_up(residents); last_top = now
            if now - last_refresh > 30:
                town.refresh(residents[0].key); last_refresh = now
            town.poll_events()
            if now - last_chat > 10:
                heard = {}
                for r in residents:
                    r.read_chat()
                    try:  # senses: a person speaking near us, or walking up to us; the nearest resident answers
                        for s in r.senses():
                            if s["type"] == "heard" and s.get("kind") == "person" and "@" not in s["text"] and s.get("distance", 99) <= 9:
                                k = ("heard", s["from"], s["text"])
                            elif s["type"] == "approach" and s.get("kind") == "person":
                                k = ("approach", s["who"])
                            else:
                                continue
                            if k not in heard or s.get("distance", 99) < heard[k][0]:
                                heard[k] = (s.get("distance", 99), r, s)
                    except Exception:  # noqa: BLE001 - senses are a nicety; never stall the city for them
                        pass
                for k, (_, r, s) in heard.items():
                    who = s["from"] if k[0] == "heard" else s["who"]
                    if k[0] == "heard":
                        if time.time() - town.answered.get((r.h, who), 0) < 60:
                            continue
                        town.answered[(r.h, who)] = time.time()
                        r.inbox.append({"handle": who, "text": s["text"], "channel": "town", "id": f"heard:{r.h}:{s['seq']}", "to": None, "mentions": [], "person": True})
                    elif time.time() - town.greeted_people.get(who, 0) > 3600:
                        town.greeted_people[who] = time.time()
                        r.inbox.append({"handle": who, "text": "hello", "channel": "town", "id": f"approach:{r.h}:{s['seq']}", "to": None, "mentions": [], "greet": True})
                last_chat = now
            by_handle = {r.h: r for r in residents}
            for due, who, text, channel in [x for x in town.replies if x[0] <= time.time()]:
                town.replies.remove((due, who, text, channel))
                try:
                    by_handle[who].tool("chat_send", {"text": text, "channel": channel})
                    log({"agent": who, "action": "chat", "receipt": "talk: answer a neighbour", "said": True})
                except Exception as e:  # noqa: BLE001
                    log({"agent": who, "action": "chat", "receipt": "talk: answer a neighbour", "error": str(e)[:200]})
            if now - last_friends > 300:  # residents are friendly: they accept anyone who asks to be friends
                last_friends = now
                for r in residents:
                    try:
                        for x in r.tool("friends")["asked_you"][:5]:
                            r.tool("friend_add", {"handle": x["handle"]})
                            log({"agent": r.h, "action": "friend", "receipt": f"accept @{x['handle']}"})
                    except Exception:  # noqa: BLE001 - never stall the city for this
                        pass
            if now - last_settle > 600:  # homes may open while we run: settle in, found the clubs
                last_settle = now
                if any(not r.neigh.settled for r in residents):
                    for r in residents:
                        r.neigh.settle_in()
                    neighbours.found_clubs(residents)
            for r in residents:
                try:
                    r.neigh.social(town, residents)
                    r.neigh.letters(town)
                    r.off.tick(town, residents)
                    r.gamer.tick(town, residents, neighbours.night_now())
                    r.civic.tick(town)
                except Exception:  # noqa: BLE001
                    traceback.print_exc()
                try:
                    r.step()
                except Exception:  # noqa: BLE001 - one resident's bad step never stalls the city
                    traceback.print_exc()
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            time.sleep(5)
        time.sleep(TICK)


if __name__ == "__main__":
    main()

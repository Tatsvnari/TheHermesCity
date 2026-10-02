"""CityRunner decision card: how every resident of HermesCity chooses its next action. Obligations, highest first:

  rule on disputes you were asked to judge > finish paid work before its deadline > answer an outside agent who spoke
  to you > finish a training task you started > give a verdict on work delivered to you (verify it yourself)
  > welcome a newcomer (mayor) > buy a service you need, within budget and pace > practise a specialty skill, weakest
  first, at a steady pace > put an earned method note in the Skill Library (level 8 at its station, one author per
  station) > read and adopt another author's skill for a station you train > share real news (a level-up, a congratulation, an open shop) > be present (walk) > wait

Every option is scored from facts the gateway returned; the receipt names the obligation it discharges. A call is
CLOSE only when the top option spends Obols and the runner-up is within 15%: spending is where judgement matters.

Verdict rules (review + arbitration) are deterministic and evidence-graded: an automated check that failed, an empty
output, or an output the buyer's own verifier rejects count against the seller; nothing else does.
"""
MODEL = "cityrunner/decision-card-v1"
SPENDS = {"hire"}


def score(o, s):
    a = o["action"]
    if a == "arbitrate":
        return 120, f"rule on dispute {o['job_id']}: {o['verdict']} ({o['why']})"
    if a == "deliver":
        left = o.get("seconds_left", 600)
        return 100 + max(0, 30 - left / 20), f"finish paid work: {o['service']} for {o['buyer']} ({int(left)} s left)"
    if a == "answer":
        return 95 if o["ready"] else 2, f"finish training: {o['skill']} tier {o['tier']}"
    if a == "review":
        return 90, f"verdict on delivered {o['service']}: {o['verdict']} ({o['why']})"
    if a == "hire":
        if s["balance"] - o["price"] < s["reserve"]:
            return 2, f"keep the reserve: {o['service']} would leave {s['balance'] - o['price']:.1f} Obols"
        if s["spent_today"] + o["price"] > s["cap"]:
            return 2, "daily spend cap reached"
        if s["since_hire_s"] < s["hire_every_s"]:
            return 3, f"pace: last hire {int(s['since_hire_s'])} s ago"
        share = o["price"] / max(s["balance"], 1)
        need = o.get("need", 1.0)
        return 40 * need + 20 - 30 * share, f"need {o['service']} from {o['seller']} for {o['price']} Obols ({share:.0%} of wallet)"
    if a == "train":
        if s["since_train_s"] < s["train_every_s"]:
            return 2, f"pace: last practice {int(s['since_train_s'])} s ago"
        return 30 - o["level"] * 0.1, f"practise {o['skill']} (level {o['level']}, weakest specialty first)"
    if a == "chat":
        return o["priority"], f"talk: {o['why']}"
    if a in ("coach", "coach_answer", "decline"):
        return o["priority"], o["why"]
    if a in ("publish", "study"):
        return o["priority"], o["why"]
    if a in ("shop", "hire_coach"):
        return o["priority"], o["why"]
    if a == "move":
        return 8 if s["idle_s"] > 45 else 1, f"be present: walk to the {o['zone']}"
    if a == "say":
        return 6 if s["idle_s"] > 60 else 1, "be present: say hello"
    return 4, "nothing owed: wait"


def decide(state, options):
    scored = [score(o, state) for o in options]
    order = sorted(range(len(options)), key=lambda i: -scored[i][0])
    best = order[0]
    close = (len(order) > 1 and options[best]["action"] in SPENDS
             and scored[order[1]][0] >= 0.85 * scored[best][0])
    receipt = scored[best][1]
    if close:
        receipt += f" (close: next is {scored[order[1]][1]})"
    for i, (v, _) in enumerate(scored):
        options[i]["score"] = round(v, 1)
    return best, receipt, close


def review_verdict(job, verifier_ok, verifier_why):
    """Buyer's verdict on a delivery: accept unless evidence says otherwise."""
    if job.get("check_passed") is False:
        return "dispute", "automated check failed"
    if not job.get("output"):
        return "dispute", "empty output"
    if not verifier_ok:
        return "dispute", verifier_why
    return "accept", verifier_why or "output verified"


def arbitration_verdict(job, verifier_ok, verifier_why):
    """Arbiter: the check result and an independent re-verification are the evidence; the buyer's words are not."""
    failed = job.get("check_passed") is False
    empty = not job.get("output")
    if failed and (empty or not verifier_ok):
        return "buyer", "check failed and output does not verify"
    if not failed and verifier_ok and not empty:
        return "seller", "check passed and output verifies"
    return "split", "evidence mixed: " + ("check failed" if failed else verifier_why or "unverifiable output")

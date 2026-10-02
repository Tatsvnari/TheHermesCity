"""Deterministic work organs for the CityRunner house agents, each with an independent verifier.
No model calls, no API keys. Every organ states its method in its output."""
import csv
import io
import ipaddress
import json
import re
import socket
import time
import urllib.parse
import urllib.request
from collections import Counter

UA = "CityRunner/0.2 (+HermesCity resident)"

# ---------- CSV clean + dedupe ----------

def csv_clean(inp):
    rows = [[c.strip() for c in r] for r in csv.reader(io.StringIO(inp["csv"]))]
    rows = [r for r in rows if any(c for c in r)]
    if not rows:
        return {"csv": "", "rows_in": 0, "rows_out": 0, "removed": 0, "method": "trim cells, drop blank rows, drop exact duplicates (case-insensitive)"}
    header, body = rows[0], rows[1:]
    width = len(header)
    seen, out = set(), []
    for r in body:
        r = (r + [""] * width)[:width]
        k = tuple(c.lower() for c in r)
        if k in seen:
            continue
        seen.add(k)
        out.append(r)
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(header)
    w.writerows(out)
    return {"csv": buf.getvalue().rstrip("\n"), "rows_in": len(body), "rows_out": len(out),
            "removed": len(body) - len(out), "method": "trim cells, drop blank rows, drop exact duplicates (case-insensitive)"}


def verify_csv(inp, out):
    try:
        rows = list(csv.reader(io.StringIO(out.get("csv", ""))))
    except csv.Error as e:
        return False, f"output is not CSV: {e}"
    body = rows[1:]
    keys = [tuple(c.strip().lower() for c in r) for r in body]
    if len(keys) != len(set(keys)):
        return False, "duplicates remain"
    if out.get("rows_out") != len(body):
        return False, "rows_out does not match the rows returned"
    return True, f"{len(body)} unique rows"


# ---------- summarize (extractive) ----------

STOP = set("""a an the and or but if then so of to in on at by for with from as is are was were be been being it its this that these
those i you he she they we them his her their our your my me us not no do does did have has had can could will would should may
might must there here what which who whom whose when where why how all any each some such than too very just also into over
under about after before between through during out up down off more most other only own same s t""".split())


def _sentences(text):
    text = re.sub(r"\s+", " ", text).strip()
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(])", text) if len(s.strip()) > 20]


def _fetch_public(url, limit=300_000):
    u = urllib.parse.urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ValueError("only http(s) URLs")
    for info in socket.getaddrinfo(u.hostname, None):
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise ValueError("URL resolves to a non-public address")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=10) as r:
        raw = r.read(limit).decode("utf-8", "replace")
    raw = re.sub(r"(?is)<(script|style|nav|header|footer)[^>]*>.*?</\1>", " ", raw)
    return re.sub(r"<[^>]+>", " ", raw)


def summarize(inp):
    text = inp.get("text") or ""
    if not text and inp.get("url"):
        text = _fetch_public(inp["url"])
    sents = _sentences(text)
    n = max(1, min(int(inp.get("sentences", 3)), 8))
    if len(sents) <= n:
        chosen = sents
    else:
        words = [w for w in re.findall(r"[a-z']+", text.lower()) if w not in STOP and len(w) > 2]
        freq = Counter(words)
        top = max(freq.values()) if freq else 1
        def s_score(i, s):
            ws = [w for w in re.findall(r"[a-z']+", s.lower()) if w not in STOP and len(w) > 2]
            base = sum(freq[w] / top for w in ws) / (len(ws) ** 0.5 or 1)
            return base * (1.15 if i == 0 else 1.0)
        ranked = sorted(range(len(sents)), key=lambda i: -s_score(i, sents[i]))[:n]
        chosen = [sents[i] for i in sorted(ranked)]
    return {"summary": " ".join(chosen), "sentences": len(chosen), "source_sentences": len(sents),
            "method": "extractive: highest-weighted source sentences, in original order"}


def verify_summary(inp, out):
    s = (out.get("summary") or "").strip()
    if not s:
        return False, "empty summary"
    if inp.get("text"):
        src = re.sub(r"\s+", " ", inp["text"])
        missing = [x for x in _sentences(s) if x not in src]
        if missing:
            return False, "summary contains sentences not in the source"
    return True, f"{out.get('sentences')} sentence(s), all from the source"


# ---------- JSON repair ----------

def json_repair(inp):
    raw = inp["text"]
    fixes = []
    try:
        val = json.loads(raw)
        return {"json": json.dumps(val, indent=2, ensure_ascii=False), "fixes": [], "valid": True, "method": "already valid; formatted"}
    except json.JSONDecodeError:
        pass
    s = raw.strip()
    s2 = re.sub(r"^\s*//.*$|/\*.*?\*/", "", s, flags=re.M | re.S)
    if s2 != s: fixes.append("removed comments"); s = s2
    s2 = re.sub(r"'([^'\\]*(?:\\.[^'\\]*)*)'", lambda m: json.dumps(m.group(1)), s)
    if s2 != s: fixes.append("single quotes -> double quotes"); s = s2
    s2 = re.sub(r'([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)', r'\1"\2"\3', s)
    if s2 != s: fixes.append("quoted bare keys"); s = s2
    s2 = re.sub(r",(\s*[}\]])", r"\1", s)
    if s2 != s: fixes.append("removed trailing commas"); s = s2
    s2 = re.sub(r"\bTrue\b", "true", re.sub(r"\bFalse\b", "false", re.sub(r"\bNone\b", "null", s)))
    if s2 != s: fixes.append("Python literals -> JSON"); s = s2
    opens = s.count("{") - s.count("}"), s.count("[") - s.count("]")
    if opens[0] > 0 or opens[1] > 0:
        s += "]" * max(0, opens[1]) + "}" * max(0, opens[0]); fixes.append("closed unbalanced brackets")
    try:
        val = json.loads(s)
        return {"json": json.dumps(val, indent=2, ensure_ascii=False), "fixes": fixes, "valid": True, "method": "rule-based repair"}
    except json.JSONDecodeError as e:
        return {"json": "", "fixes": fixes, "valid": False, "error": str(e), "method": "rule-based repair"}


def verify_json(inp, out):
    if not out.get("valid"):
        return False, "repair reported failure"
    try:
        json.loads(out.get("json", ""))
    except json.JSONDecodeError as e:
        return False, f"output is not valid JSON: {e}"
    return True, "valid JSON"


# ---------- market snapshot ----------

_cache = {}


def market_snapshot(inp):
    t = inp["ticker"].strip().upper()
    hit = _cache.get(t)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    q = urllib.parse.quote(t.lower())
    with urllib.request.urlopen(urllib.request.Request(f"https://api.coingecko.com/api/v3/search?query={q}", headers={"User-Agent": UA}), timeout=10) as r:
        coins = [c for c in json.load(r).get("coins", []) if c.get("symbol", "").upper() == t]
    if not coins:
        raise ValueError(f"unknown ticker {t}")
    cid = sorted(coins, key=lambda c: c.get("market_cap_rank") or 10**9)[0]["id"]
    url = f"https://api.coingecko.com/api/v3/simple/price?ids={cid}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true"
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=10) as r:
        d = json.load(r)[cid]
    out = {"ticker": t, "id": cid, "price_usd": d["usd"], "change_24h_pct": round(d.get("usd_24h_change") or 0, 3),
           "market_cap_usd": d.get("usd_market_cap"), "source": "CoinGecko public API", "at": int(time.time())}
    _cache[t] = (time.time(), out)
    return out


def verify_market(inp, out):
    ok = out.get("ticker") == inp["ticker"].strip().upper() and isinstance(out.get("price_usd"), (int, float)) and out["price_usd"] > 0
    fresh = time.time() - out.get("at", 0) < 900
    return (ok and fresh), ("fresh price for the ticker" if ok and fresh else "wrong ticker, bad price, or stale")


# ---------- unit conversion ----------

UNITS = {
    "length": {"m": 1, "km": 1000, "cm": 0.01, "mm": 0.001, "mi": 1609.344, "ft": 0.3048, "in": 0.0254, "yd": 0.9144},
    "mass": {"kg": 1, "g": 0.001, "lb": 0.45359237, "oz": 0.028349523125},
    "volume": {"l": 1, "ml": 0.001, "gal": 3.785411784, "qt": 0.946352946},
}
TEMPS = {"c", "f", "k"}


def _to_kelvin(v, u):
    return v + 273.15 if u == "c" else (v - 32) * 5 / 9 + 273.15 if u == "f" else v


def _from_kelvin(v, u):
    return v - 273.15 if u == "c" else (v - 273.15) * 9 / 5 + 32 if u == "f" else v


def convert(inp):
    v, a, b = float(inp["value"]), inp["from"].lower(), inp["to"].lower()
    if a in TEMPS and b in TEMPS:
        return {"value": round(_from_kelvin(_to_kelvin(v, a), b), 6), "unit": inp["to"], "kind": "temperature"}
    for kind, table in UNITS.items():
        if a in table and b in table:
            return {"value": round(v * table[a] / table[b], 6), "unit": inp["to"], "kind": kind}
    raise ValueError(f"cannot convert {a} to {b}")


def verify_convert(inp, out):
    want = convert(inp)["value"]
    ok = abs(out.get("value", float("nan")) - want) <= 1e-6 * max(1, abs(want))
    return ok, "conversion checks out" if ok else "wrong value"


# ---------- word frequency ----------

def wordfreq(inp):
    words = [w for w in re.findall(r"[a-z']+", inp["text"].lower()) if w not in STOP and len(w) > 2]
    c = Counter(words)
    top = sorted(c.items(), key=lambda x: (-x[1], x[0]))[: int(inp.get("top", 10))]
    return {"total": len(words), "unique": len(c), "top": [{"word": w, "count": n} for w, n in top]}


def verify_wordfreq(inp, out):
    ok = out.get("top") == wordfreq(inp)["top"]
    return ok, "counts check out" if ok else "counts differ"


# ---------- sort and number ----------

def sortlist(inp):
    items = sorted((str(x).strip() for x in inp["items"] if str(x).strip()), key=lambda x: (x.lower(), x), reverse=inp.get("order") == "desc")
    return {"items": [f"{i + 1}. {x}" for i, x in enumerate(items)]}


def verify_sortlist(inp, out):
    ok = out.get("items") == sortlist(inp)["items"]
    return ok, "order checks out" if ok else "order differs"


# ---------- date difference ----------

def datediff(inp):
    import datetime as dt
    a, b = dt.date.fromisoformat(inp["from"]), dt.date.fromisoformat(inp["to"])
    lo, hi = min(a, b), max(a, b)
    weekdays = sum(1 for i in range((hi - lo).days) if (lo + dt.timedelta(days=i)).weekday() < 5)
    return {"days": (b - a).days, "weeks": round((b - a).days / 7, 2), "weekdays": weekdays}


def verify_datediff(inp, out):
    ok = out.get("days") == datediff(inp)["days"]
    return ok, "dates check out" if ok else "wrong day count"


# ---------- readability ----------

def _syllables(w):
    w = w.lower().strip("'")
    groups = re.findall(r"[aeiouy]+", w)
    n = len(groups) - (1 if w.endswith("e") and len(groups) > 1 and not w.endswith("le") else 0)
    return max(1, n)


def readability(inp):
    text = inp["text"]
    sents = max(1, len(re.findall(r"[.!?]+(?:\s|$)", text)))
    words = re.findall(r"[A-Za-z']+", text)
    nw = max(1, len(words)); syl = sum(_syllables(w) for w in words)
    flesch = 206.835 - 1.015 * (nw / sents) - 84.6 * (syl / nw)
    grade = 0.39 * (nw / sents) + 11.8 * (syl / nw) - 15.59
    band = "very easy" if flesch >= 80 else "easy" if flesch >= 65 else "plain" if flesch >= 50 else "difficult" if flesch >= 30 else "very difficult"
    return {"flesch": round(flesch, 1), "grade": round(grade, 1), "band": band, "sentences": sents, "words": nw, "syllables": syl}


def verify_readability(inp, out):
    ok = out.get("flesch") == readability(inp)["flesch"]
    return ok, "score checks out" if ok else "score differs"


# ---------- slugify ----------

def slugify(inp):
    import unicodedata
    def one(t):
        t = unicodedata.normalize("NFKD", str(t)).encode("ascii", "ignore").decode().lower()
        return re.sub(r"-{2,}", "-", re.sub(r"[^a-z0-9]+", "-", t)).strip("-")
    return {"slugs": [one(t) for t in inp["titles"]]}


def verify_slugify(inp, out):
    ok = out.get("slugs") == slugify(inp)["slugs"]
    return ok, "slugs check out" if ok else "slugs differ"


ORGANS = {"csv": (csv_clean, verify_csv), "summary": (summarize, verify_summary),
          "json": (json_repair, verify_json), "market": (market_snapshot, verify_market),
          "units": (convert, verify_convert), "wordfreq": (wordfreq, verify_wordfreq), "sortlist": (sortlist, verify_sortlist),
          "datediff": (datediff, verify_datediff), "readability": (readability, verify_readability), "slugify": (slugify, verify_slugify)}

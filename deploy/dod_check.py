"""Definition-of-done probe for a running HermesCity (run on the host as the app user; ENV_FILE points at its env).

1. A new outside agent registers, gets its grant, and finishes one job (as buyer, via MCP) in under 5 minutes.
2. The world WebSocket shows every payment and delivery of that job.
3. The rate limit holds (61st call in a minute is refused).
4. The ledger reconciles with zero drift.
Probe agents are revoked at the end.
"""
import base64
import json
import os
import socket
import threading
import time
import urllib.error
import urllib.request

URL = os.environ.get("EW_URL", "http://127.0.0.1:8164")
ENV = dict(l.strip().split("=", 1) for l in open(os.environ.get("ENV_FILE", "/etc/hermescity.env")) if "=" in l)
ADMIN = ENV["ADMIN_TOKEN"]
results = []


def req(method, path, body=None, token=None, headers=None):
    h = {"content-type": "application/json", **(headers or {})}
    if token:
        h["authorization"] = f"Bearer {token}"
    r = urllib.request.Request(URL + path, method=method, headers=h, data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def tool(key, name, args=None):
    code, text = req("POST", f"/api/v1/{name}", args or {}, token=key)
    if code != 200:
        raise RuntimeError(f"{name}: {code} {text}")
    return json.loads(text)


def mcp(key, name, args):
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}}
    code, text = req("POST", "/mcp", body, token=key, headers={"accept": "application/json, text/event-stream"})
    if code != 200:
        raise RuntimeError(f"mcp {name}: {code} {text[:200]}")
    data = next((l[5:].strip() for l in text.splitlines() if l.startswith("data:")), text)
    msg = json.loads(data)
    content = msg["result"]["content"][0]["text"]
    if msg["result"].get("isError"):
        raise RuntimeError(f"mcp {name}: {content}")
    return json.loads(content)


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" - {detail}" if detail else ""), flush=True)


class WsWatch(threading.Thread):
    """Minimal RFC 6455 client: collects world events."""
    def __init__(self):
        super().__init__(daemon=True)
        self.events = []

    def run(self):
        s = socket.create_connection(("127.0.0.1", 8164))
        key = base64.b64encode(os.urandom(16)).decode()
        s.sendall(f"GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += s.recv(4096)
        buf = buf.split(b"\r\n\r\n", 1)[1]
        while True:
            while len(buf) < 2:
                buf += s.recv(65536)
            ln = buf[1] & 127
            off = 2
            if ln == 126:
                while len(buf) < 4: buf += s.recv(65536)
                ln, off = int.from_bytes(buf[2:4], "big"), 4
            elif ln == 127:
                while len(buf) < 10: buf += s.recv(65536)
                ln, off = int.from_bytes(buf[2:10], "big"), 10
            while len(buf) < off + ln:
                buf += s.recv(65536)
            payload, buf = buf[off:off + ln], buf[off + ln:]
            try:
                m = json.loads(payload)
                if m.get("t") == "event":
                    self.events.append(m)
            except ValueError:
                pass


def main():
    ws = WsWatch(); ws.start(); time.sleep(1)
    t0 = time.time()
    stamp = str(int(t0))[-6:]
    code, text = req("POST", "/api/admin/agents", {"handle": f"probe_b{stamp}", "owner_email": f"probe{stamp}@example.com",
                                                    "description": "DoD probe buyer", "avatar": {"body": 5}}, token=ADMIN)
    buyer = json.loads(text); bkey = buyer["api_key"]; bid = buyer["agent"]["id"]
    code, text = req("POST", "/api/admin/agents", {"handle": f"probe_s{stamp}", "owner_email": f"probe{stamp}s@example.com",
                                                    "description": "DoD probe seller"}, token=ADMIN)
    seller = json.loads(text); skey = seller["api_key"]; sid = seller["agent"]["id"]

    me = mcp(bkey, "whoami", {})
    check("new agent has its first grant tranche (via MCP)", me["balance"] == 25, f"balance {me['balance']}")

    svc = tool(skey, "list_service", {"name": f"Echo probe {stamp}", "price": 2, "check_kind": "nonempty_text",
                                      "input_schema": {"type": "object", "required": ["text"], "properties": {"text": {"type": "string"}}},
                                      "output_schema": {"type": "object", "required": ["text"], "properties": {"text": {"type": "string"}}}})
    found = [s for s in mcp(bkey, "browse_services", {"query": "Echo probe"}) if s["id"] == svc["id"]]
    check("buyer finds the service by search", bool(found))
    job = mcp(bkey, "hire", {"service_id": svc["id"], "input": {"text": "hello"}, "max_price": 2, "idempotency_key": f"dod-{stamp}"})
    again = mcp(bkey, "hire", {"service_id": svc["id"], "input": {"text": "hello"}, "max_price": 2, "idempotency_key": f"dod-{stamp}"})
    check("retried hire returns the same job (no double pay)", again["id"] == job["id"])
    todo = tool(skey, "poll_jobs")["to_do"]
    check("seller sees the job", any(j["id"] == job["id"] for j in todo))
    bad_code = None
    try:
        tool(skey, "deliver", {"job_id": job["id"], "output": {"wrong": 1}})
    except RuntimeError as e:
        bad_code = str(e)
    check("off-schema delivery rejected instantly", bad_code is not None and "422" in bad_code)
    tool(skey, "deliver", {"job_id": job["id"], "output": {"text": "HELLO"}})
    review = mcp(bkey, "poll_jobs", {})["to_review"]
    check("buyer sees the delivery for review", any(j["id"] == job["id"] for j in review))
    done = mcp(bkey, "accept", {"job_id": job["id"]})
    elapsed = time.time() - t0
    check("job settled", done["state"] == "settled")
    check("register -> grant -> one finished job under 5 minutes", elapsed < 300, f"{elapsed:.1f} s")
    s_bal = tool(skey, "whoami")["balance"]; b_bal = mcp(bkey, "whoami", {})["balance"]
    # seller: 25 + 1.96 + 25 (tranche 2); buyer: 25 - 2 + 25 (tranche 2)
    check("payout minus 2% fee, tranche 2 released to both", abs(s_bal - 51.96) < 1e-9 and abs(b_bal - 48) < 1e-9, f"seller {s_bal}, buyer {b_bal}")

    time.sleep(1.5)
    mine = [e for e in ws.events if job["id"] in (e.get("job_id"), e.get("memo")) or (e.get("kind") == "payment" and {e.get("from"), e.get("to")} == {bid, sid})]
    kinds = {e["kind"] for e in mine}
    need = {"job_opened", "job_assigned", "delivered", "payment", "settled"}
    check("world WebSocket showed every step", need <= kinds, f"saw {sorted(kinds)}")

    codes = [req("POST", "/api/v1/whoami", {}, token=bkey)[0] for _ in range(62)]
    check("rate limit refuses calls past 60/min", 429 in codes, f"first 429 at call {codes.index(429) + 1 if 429 in codes else None}")

    code, text = req("GET", "/api/admin/reconcile", token=ADMIN)
    rec = json.loads(text)
    check("ledger reconciles with zero drift", rec["ok"], f"total {rec['total']}, drift rows {len(rec['drift'])}")

    tool(skey, "close_service", {"service_id": svc["id"]})
    for a in (bid, sid):
        req("POST", f"/api/admin/agents/{a}/revoke", {}, token=ADMIN)
    tool_code = req("POST", "/api/v1/whoami", {}, token=skey)[0]
    check("revoked key stops working", tool_code == 401)

    fails = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(fails)}/{len(results)} passed")
    raise SystemExit(1 if fails else 0)


if __name__ == "__main__":
    main()

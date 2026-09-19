#!/usr/bin/env python3
"""Write realistic demo data (with fresh timestamps) for README screenshots. Usage: make_fixtures.py <dir>"""
import datetime as dt, json, pathlib, sys

out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
now = dt.datetime.now(dt.timezone.utc)
ts = lambda minutes: (now - dt.timedelta(minutes=minutes)).strftime("%Y-%m-%d %H:%M:%S")
me = "jane@example.com"

def alias(i, address, description, received, enabled=True, burner=False, minutes=0):
    real = {f"q{i}x7@int.proxiedmail.com" if burner else me: {"is_enabled": enabled, "is_verified": True}}
    return {"type": "proxy_bindings", "id": f"DEMO-{i}", "attributes": {
        "real_addresses": real, "proxy_address": address, "is_browsable": True, "received_emails": received,
        "description": description, "callback_url": "", "created_at": ts(minutes + 60 * 24 * i), "updated_at": ts(minutes)}}

aliases = [
    alias(1, "k3v9x2mq7p@pxdmail.net", "netflix.com", 14, minutes=2),
    alias(2, "shop@pxdmail.net", "Amazon orders", 57, minutes=90),
    alias(3, "n8w2fj4ta1@pxdmail.net", "github.com", 23, minutes=300),
    alias(4, "r5t1zq8vbe@pxdmail.net", "Newsletter I might regret", 112, enabled=False, minutes=900),
    alias(5, "b7m3kd9s2x@pxdmail.net", "Burner for a Wi-Fi portal", 1, burner=True, minutes=4000),
]
json.dump({"meta": {"usedProxyBindings": 5, "availableProxyBindings": 100}, "data": aliases}, open(out / "GET_proxy-bindings.json", "w"))
json.dump({"data": {"attributes": {"username": me}}}, open(out / "GET_users_me.json", "w"))
json.dump([{"domain": d, "isPremium": p, "isShared": True, "user_id": 0} for d, p in
           [("pxdmail.net", False), ("pxdmail.com", True), ("iam-rich.net", True)]], open(out / "GET_gapi_available-domains.json", "w"))

emails = [
    ("E1", "info@account.netflix.com", "Your Netflix sign-in code", 1, "Enter this code to sign in:\n\n482 913\n\nIf this wasn't you, reset your password."),
    ("E2", "noreply@github.com", "[GitHub] Please verify your device", 45, "Verification code: 736205\n\nhttps://github.com/sessions/verified-device"),
    ("E3", "hello@netflix.com", "New on Netflix this week", 60 * 26, "Here's what's new this week.\nhttps://www.netflix.com/browse"),
]
links = {"data": [{"type": "received_emails_link", "id": i, "attributes": {"recipient_email": "k3v9x2mq7p@pxdmail.net", "sender_email": s, "subject": subj,
          "attachmentsCounter": 0, "is_processed": True, "created_at": ts(m), "updated_at": ts(m)}} for i, s, subj, m, _ in emails]}
json.dump(links, open(out / "GET_received-emails-links_DEMO-1.json", "w"))
for i, s, subj, m, body in emails:
    html = "".join(f"<p>{line}</p>" for line in body.split("\n") if line)
    json.dump({"data": {"id": i, "attributes": {"recipient_email": "k3v9x2mq7p@pxdmail.net", "sender_email": s, "is_processed": True,
               "created_at": ts(m), "payload": {"From": s, "To": "k3v9x2mq7p@pxdmail.net", "Subject": subj, "body-plain": body, "body-html": html}, "attachments": []}}},
              open(out / f"GET_received-emails_{i}.json", "w"))
print(out)

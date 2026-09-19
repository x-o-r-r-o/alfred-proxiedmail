#!/usr/bin/env python3
"""Generate workflow/info.plist and package dist/ProxiedMail.alfredworkflow.

Usage: python3 tools/build.py [--install]
  --install  also copy the build into the installed workflow in Alfred's preferences,
             keeping its configuration (prefs.plist), instead of re-importing
"""
import pathlib
import plistlib
import shutil
import sys
import uuid
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / "workflow"
DIST = ROOT / "dist"
VERSION = "0.2.0"
BUNDLE_ID = "com.x-o-r-r-o.alfred.proxiedmail"
# Earlier bundle IDs, so --install can find and update an older installed copy
OLD_BUNDLE_IDS = ["com.zaqlimited.alfred.proxiedmail"]


def uid(name):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"proxiedmail-alfred/{name}")).upper()


objects, connections, uidata = [], {}, {}


def add(name, type_, version, config, x, y, note=None):
    objects.append({"uid": uid(name), "type": type_, "version": version, "config": config})
    uidata[uid(name)] = {"xpos": x, "ypos": y, **({"note": note} if note else {})}


def connect(src, dst, condition=None):
    link = {"destinationuid": uid(dst), "modifiers": 0, "modifiersubtext": "", "vitoclose": False}
    if condition:
        link["sourceoutputuid"] = uid(condition)
    connections.setdefault(uid(src), []).append(link)


def script_filter(name, keyword_var, mode, title, subtext, running, x, y):
    add(name, "alfred.workflow.input.scriptfilter", 3, {
        "alfredfiltersresults": False,
        "alfredfiltersresultsmatchmode": 0,
        "argumenttreatemptyqueryasnil": False,
        "argumenttrimmode": 0,
        "argumenttype": 1,
        "escaping": 102,
        "keyword": "{var:%s}" % keyword_var,
        "queuedelaycustom": 3,
        "queuedelayimmediatelyinitially": True,
        "queuedelaymode": 0,
        "queuemode": 1,
        "runningsubtext": running,
        "script": f'./proxiedmail.js {mode} "${{1}}"',
        "scriptargtype": 1,
        "scriptfile": "",
        "skipuniversalaction": True,
        "subtext": subtext,
        "title": title,
        "type": 11,
        "withspace": True,
    }, x, y)


def run_script(name, script, x, y, note=None):
    add(name, "alfred.workflow.action.script", 2, {
        "concurrently": False,
        "escaping": 102,
        "script": script,
        "scriptargtype": 1,
        "scriptfile": "",
        "type": 11,
    }, x, y, note)


def clipboard(name, autopaste, x, y):
    add(name, "alfred.workflow.output.clipboard", 3, {
        "autopaste": autopaste,
        "clipboardtext": "{query}",
        "ignoredynamicplaceholders": True,
        "transient": False,
    }, x, y)


# ── Inputs ──────────────────────────────────────────────────────────────────
script_filter("sf_aliases", "kw_aliases", "aliases", "Search ProxiedMail aliases",
              "Copy, paste, pause, edit or delete an alias", "Loading aliases…", 30, 30)
script_filter("sf_create", "kw_create", "create", "Create ProxiedMail alias",
              "Random, custom, for the current website, or a burner", "Loading…", 30, 180)
script_filter("sf_inbox", "kw_inbox", "inbox", "ProxiedMail inbox",
              "Read received emails, copy codes and links", "Loading inbox…", 30, 330)
script_filter("sf_code", "kw_code", "code", "ProxiedMail verification codes",
              "Watch for new emails and copy their codes", "Checking inboxes…", 30, 900)

add("ua_text", "alfred.workflow.trigger.universalaction", 1, {
    "acceptsfiles": False, "acceptsmulti": 0, "acceptstext": True, "acceptsurls": False,
    "name": "Search ProxiedMail Aliases",
}, 30, 500)
add("ua_url", "alfred.workflow.trigger.universalaction", 1, {
    "acceptsfiles": False, "acceptsmulti": 0, "acceptstext": False, "acceptsurls": True,
    "name": "Create ProxiedMail Alias for Website",
}, 30, 630)
add("hotkey_site", "alfred.workflow.trigger.hotkey", 2, {
    "action": 0, "argument": 0, "focusedappvariable": False, "focusedappvariablename": "",
    "hotkey": 0, "hotmod": 0, "leftcursor": False, "modsmode": 0, "relatedAppsMode": 0,
}, 30, 760, "Set a hotkey to create an alias for the frontmost browser tab and paste it")
add("hotkey_codes", "alfred.workflow.trigger.hotkey", 2, {
    "action": 0, "argument": 0, "focusedappvariable": False, "focusedappvariablename": "",
    "hotkey": 0, "hotmod": 0, "leftcursor": False, "modsmode": 0, "relatedAppsMode": 0,
}, 30, 1030, "Set a hotkey to show the latest verification codes")

# ── Actions ─────────────────────────────────────────────────────────────────
run_script("run", './proxiedmail.js run "${1}"', 300, 180)
run_script("run_find", './proxiedmail.js find "${1}"', 300, 500)
run_script("run_url", './proxiedmail.js createForURL "${1}"', 300, 630)
run_script("run_site", "./proxiedmail.js createForSite", 300, 760)
run_script("run_codes", "./proxiedmail.js showCodes", 300, 1030)

add("route", "alfred.workflow.utility.conditional", 1, {
    "conditions": [
        {"inputstring": "{var:out}", "matchcasesensitive": False, "matchmode": 0,
         "matchstring": value, "outputlabel": label, "uid": uid(f"cond_{value}")}
        for value, label in [("copy", "Copy"), ("copy_notify", "Copy + Notify"), ("paste", "Paste"), ("notify", "Notify")]
    ],
    "elselabel": "Nothing", "hideelse": True,
}, 500, 200)

clipboard("clip_copy", False, 700, 30)
clipboard("clip_copy_notify", False, 700, 180)
clipboard("clip_paste", True, 700, 330)
add("notify", "alfred.workflow.output.notification", 1, {
    "lastpathcomponent": False, "onlyshowifquerypopulated": False, "removeextension": False,
    "text": "{var:notif_text}", "title": "{var:notif_title}",
}, 900, 250)

connect("hotkey_codes", "run_codes")
for sf in ("sf_aliases", "sf_create", "sf_inbox", "sf_code"):
    connect(sf, "run")
connect("ua_text", "run_find")
connect("ua_url", "run_url")
connect("hotkey_site", "run_site")
for src in ("run", "run_url", "run_site"):
    connect(src, "route")
connect("route", "clip_copy", "cond_copy")
connect("route", "clip_copy_notify", "cond_copy_notify")
connect("route", "clip_paste", "cond_paste")
connect("route", "notify", "cond_notify")
connect("clip_copy_notify", "notify")

# ── User configuration ──────────────────────────────────────────────────────
def textfield(variable, label, default="", placeholder="", description="", required=False):
    return {"type": "textfield", "variable": variable, "label": label, "description": description,
            "config": {"default": default, "placeholder": placeholder, "required": required, "trim": True}}


def checkbox(variable, label, text, default, description=""):
    return {"type": "checkbox", "variable": variable, "label": label, "description": description,
            "config": {"default": default, "required": False, "text": text}}


user_config = [
    textfield("api_token", "API Token", required=True,
              description="Copy it from the API section of https://proxiedmail.com/en/settings"),
    {"type": "popupbutton", "variable": "after_create", "label": "After Creating", "description": "⌘↩ does the opposite.",
     "config": {"default": "copy", "pairs": [["Copy alias to clipboard", "copy"], ["Paste alias into frontmost app", "paste"]]}},
    checkbox("new_browsable", "Inbox Browsing", "Turn on inbox browsing for new aliases", True,
             "Required to read emails in Alfred. Burner aliases always have it on."),
    checkbox("remote_images", "Remote Images", "Load remote images when viewing emails", False,
             "Off by default so senders can't track when you open an email."),
    textfield("kw_aliases", "Search Keyword", default="pmail"),
    textfield("kw_create", "Create Keyword", default="pmnew"),
    textfield("kw_inbox", "Inbox Keyword", default="pminbox"),
    textfield("kw_code", "Codes Keyword", default="pmcode"),
]

README = """## Usage

Search your [ProxiedMail](https://proxiedmail.com) aliases via the `pmail` keyword. Type to filter by address, description, or forwarding address.

* <kbd>↩</kbd> Copy alias.
* <kbd>⌘</kbd><kbd>↩</kbd> Paste alias into the frontmost app.
* <kbd>⌥</kbd><kbd>↩</kbd> Open alias inbox.
* <kbd>⌃</kbd><kbd>↩</kbd> Pause or resume forwarding.
* <kbd>⇧</kbd><kbd>↩</kbd> Show more actions: edit description, change forwarding address, set webhook, watch for codes, delete alias. Type after the address to enter a new description, forwarding address, or webhook URL.

Create aliases via the `pmnew` keyword, optionally followed by a description. Start with `name@` for a custom address, e.g. `pmnew shop@ Amazon orders`.

* <kbd>↩</kbd> Create alias and copy it (or paste it, as set in the Workflow’s Configuration).
* <kbd>⌘</kbd><kbd>↩</kbd> Create alias and do the opposite of the above.
* <kbd>⌥</kbd><kbd>↩</kbd> Create alias, copy it, and wait for its first email and code.

Create a random alias, one described by the website in the frontmost browser tab, or a burner inbox with no forwarding. Choose the domain and forwarding address for new aliases from the rows below the create options.

Read received emails via the `pminbox` keyword. Pick an alias, then an email to open it, copy its verification code, or open its links.

* <kbd>⌘</kbd><kbd>↩</kbd> Open email in the default browser.
* <kbd>⌥</kbd><kbd>↩</kbd> Copy verification code.
* <kbd>⌃</kbd><kbd>↩</kbd> Copy email text.
* <kbd>⌘</kbd><kbd>Y</kbd> Quick Look email.

Emails can only be read for aliases with inbox browsing on, and only emails received after it was turned on are listed. Remote images are blocked unless allowed in the Workflow’s Configuration.

Watch for verification codes via the `pmcode` keyword. New emails to aliases with inbox browsing are checked every few seconds for three minutes, showing codes and verification links from the last 15 minutes.

* <kbd>↩</kbd> Copy code or open verification link.
* <kbd>⌘</kbd><kbd>↩</kbd> Paste code into the frontmost app.
* <kbd>⌥</kbd><kbd>↩</kbd> Open email.

Alternatively, search aliases from selected text or create an alias for a selected URL via the Universal Actions.

Configure the Hotkeys to create an alias for the frontmost browser tab and paste it in one step, or to jump straight to the latest codes.

This workflow was built with the help of an AI assistant (Claude).
"""

info = {
    "bundleid": BUNDLE_ID,
    "category": "Productivity",
    "connections": connections,
    "createdby": "x-o-r-r-o",
    "description": "Manage ProxiedMail aliases and read their inboxes",
    "disabled": False,
    "name": "ProxiedMail",
    "objects": objects,
    "readme": README,
    "uidata": uidata,
    "userconfigurationconfig": user_config,
    "variablesdontexport": [],
    "version": VERSION,
    "webaddress": "https://github.com/x-o-r-r-o/alfred-proxiedmail",
}

with open(WORKFLOW / "info.plist", "wb") as f:
    plistlib.dump(info, f, sort_keys=True)

DIST.mkdir(exist_ok=True)
package = DIST / "ProxiedMail.alfredworkflow"
with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as z:
    for path in sorted(WORKFLOW.rglob("*")):
        if path.is_file() and path.name != ".DS_Store" and path.name != "prefs.plist":
            info_ = zipfile.ZipInfo.from_file(path, path.relative_to(WORKFLOW).as_posix())
            with open(path, "rb") as src:
                z.writestr(info_, src.read(), zipfile.ZIP_DEFLATED)

print(f"Built {package.relative_to(ROOT)} (v{VERSION}, {len(objects)} objects)")

if "--install" in sys.argv:
    prefs = pathlib.Path.home() / "Library/Application Support/Alfred/prefs.json"
    import json
    workflows = pathlib.Path(json.loads(prefs.read_text()).get("current", "")) / "workflows"
    targets = [
        d for d in workflows.iterdir()
        if (d / "info.plist").exists()
        and plistlib.loads((d / "info.plist").read_bytes()).get("bundleid") in [BUNDLE_ID, *OLD_BUNDLE_IDS]
    ]
    if not targets:
        sys.exit("Not installed yet: open dist/ProxiedMail.alfredworkflow to import it first")
    for target in targets:
        for path in target.iterdir():
            if path.name != "prefs.plist":
                shutil.rmtree(path) if path.is_dir() else path.unlink()
        for path in WORKFLOW.iterdir():
            if path.name in (".DS_Store", "prefs.plist"):
                continue
            dest = target / path.name
            shutil.copytree(path, dest) if path.is_dir() else shutil.copy2(path, dest)
        print(f"Installed into {target}")

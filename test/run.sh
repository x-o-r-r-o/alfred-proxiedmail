#!/bin/zsh
# Runs the workflow script against fixtures and checks outputs. Usage: test/run.sh
cd "${0:A:h}/../workflow" || exit 1
export PM_FIXTURES="$(mktemp -d)"
cp ../test/fixtures/*.json "$PM_FIXTURES/"
# The code watcher only looks at recent emails, so make the Netflix code email 2 minutes old
recent="$(date -u -v-2M '+%Y-%m-%d %H:%M:%S')"
sed -i '' "s/2026-09-19 09:59:0[58]/$recent/g" "$PM_FIXTURES"/GET_received-emails*81F8*.json "$PM_FIXTURES"/GET_received-emails-links_C6C4*.json
export alfred_workflow_cache="$(mktemp -d)"
export alfred_workflow_data="$(mktemp -d)"
export alfred_workflow_bundleid="com.proxiedmail.alfred.test"
export api_token="test-token"
fail=0
check() { # name, command output, jq-ish python assertion
  local name="$1" out="$2" expr="$3"
  if print -r -- "$out" | /usr/bin/python3 -c "import json,sys; d=json.load(sys.stdin); assert $expr, d" 2>/tmp/pm_test_err; then
    print "✓ $name"
  else
    print "✗ $name"; print -r -- "$out" | head -c 600; print; cat /tmp/pm_test_err | tail -3; fail=1
  fi
}
t() { ./proxiedmail.js "$@" 2>&1; }
check "list all aliases"        "$(t aliases '')"            "len(d['items'])==4 and d['items'][0]['title']=='burner42@proxiedmail.com' and '3 aliases · limit 10' in d['items'][-1]['title']"
check "search aliases"          "$(t aliases 'netflix')"     "d['items'][0]['title']=='v7do1zfs8w@proxiedmail.com' and 'Create new alias' in d['items'][-1]['title']"
check "paused alias subtitle"   "$(t aliases 'news')"        "'paused' in d['items'][0]['subtitle'] and d['items'][0]['mods']['ctrl']['subtitle']=='Resume forwarding'"
check "burner alias"            "$(t aliases 'burner42')"    "'burner' in d['items'][0]['subtitle'] and d['items'][0]['mods']['ctrl']['valid']==False"
check "alias actions"           "$(t aliases '›v7do1zfs8w@proxiedmail.com ')" "[i['title'] for i in d['items']][:4]==['Copy v7do1zfs8w@proxiedmail.com','Open inbox (2 received)','Watch for verification codes','Pause forwarding']"
check "action: set description" "$(t aliases '›v7do1zfs8w@proxiedmail.com Streaming stuff')" "any(i['title']=='Set description: “Streaming stuff”' for i in d['items'])"
check "action: forward"         "$(t aliases '›v7do1zfs8w@proxiedmail.com new@me.com')" "any(i['title']=='Forward only to new@me.com' for i in d['items']) and any(i['title']=='Also forward to new@me.com' for i in d['items'])"
check "action: webhook"         "$(t aliases '›v7do1zfs8w@proxiedmail.com https://x.io/h')" "any(i['title'].startswith('Set webhook URL: https://x.io/h') for i in d['items'])"
check "delete confirm"          "$(t aliases '›v7do1zfs8w@proxiedmail.com ›delete')" "d['items'][0]['title'].startswith('Delete v7do1zfs8w')"
check "create menu"             "$(t create 'Amazon')"       "[i['title'] for i in d['items']][:3]==['Create random alias','Create alias for current website','Create burner inbox (no forwarding)'] and '→ me@example.com' in d['items'][0]['subtitle'] and d['items'][3]['title']=='Alias domain: chosen by ProxiedMail' and d['items'][4]['title']=='Forwarding to: me@example.com'"
check "create custom"           "$(t create 'shop@ Amazon orders')" "d['items'][0]['title']=='Create shop@pxdmail.net' and 'Amazon orders' in d['items'][0]['subtitle']"
check "domain picker"           "$(t create '›domain ')"     "[i['title'] for i in d['items']]==['Let ProxiedMail choose','pxdmail.net','pxdmail.com','iam-rich.net','Back'] and 'Premium' in d['items'][2]['subtitle'] and d['items'][0]['subtitle'].startswith('✓')"
check "forward picker"          "$(t create '›forward ')"    "[i['title'] for i in d['items']][:3]==['Automatic (currently me@example.com)','me@example.com','account@example.com'] and d['items'][2]['subtitle']=='Your account email'"
check "forward picker: typed"   "$(t create '›forward new@x.io')" "any(i['title']=='Use new@x.io' for i in d['items'])"
t run '{"op":"setPref","key":"domain","value":"pxdmail.com"}' >/dev/null; t run '{"op":"setPref","key":"forward","value":"account@example.com"}' >/dev/null
check "prefs applied"           "$(t create 'X')"            "'@pxdmail.com → account@example.com' in d['items'][0]['subtitle'] and d['items'][3]['title']=='Alias domain: pxdmail.com' and 'Chosen by you' in d['items'][4]['subtitle']"
check "create uses prefs"       "$(t run '{"op":"create","kind":"random"}')" "d['alfredworkflow']['variables']['out']=='copy_notify'"
t run '{"op":"setPref","key":"domain","value":""}' >/dev/null; t run '{"op":"setPref","key":"forward","value":""}' >/dev/null
check "actions: quick forwards" "$(t aliases '›v7do1zfs8w@proxiedmail.com ')" "any(i['title']=='Forward only to account@example.com' and i['mods']['cmd']['subtitle']=='Also forward to account@example.com' for i in d['items'])"
check "inbox picker"            "$(t inbox '')"              "len(d['items'])==4 and d['items'][-1]['title']=='Turn on inbox browsing for 1 alias'"
check "inbox list"              "$(t inbox '›v7do1zfs8w@proxiedmail.com ')" "d['items'][0]['title']=='Your Netflix verification code' and d['items'][1]['subtitle'].endswith('📎1')"
check "inbox not browsable"     "$(t inbox '›news-65ddf8@proxiedmail.com ')" "'browsing is off' in d['items'][0]['title']"
check "email detail"            "$(t inbox '›v7do1zfs8w@proxiedmail.com ›81F8AD00-0000-0000-00003CC8 ')" "d['items'][1]['title']=='Copy code 482913' and any(i['subtitle'].startswith('https://www.netflix.com/help?x=1&y=2') for i in d['items'])"
check "code: keyword"           "$(t codes 'Sign in' 'Your verification code is 739201. It expires in 10 minutes.')" "d==['739201']"
check "code: alnum"             "$(t codes 'Confirm' 'Use code: AB12CD to continue')" "d==['AB12CD']"
check "code: no false year"     "$(t codes 'Newsletter' 'Best of 2025 edition, 1200 readers')" "d==[]"
check "run: copy"               "$(t run '{"op":"copy","text":"a@b.c"}')" "d['alfredworkflow']['variables']['out']=='copy' and d['alfredworkflow']['arg']=='a@b.c'"
check "run: create random"      "$(t run '{"op":"create","kind":"random","description":"Amazon"}')" "d['alfredworkflow']['variables']['out']=='copy_notify' and d['alfredworkflow']['arg']=='7uj7s9gbnp@proxiedmail.com'"
check "create: own address"     "$(t run '{"op":"create","kind":"custom","address":"v7do1zfs8w@proxiedmail.com"}')" "d['alfredworkflow']['variables']['notif_title']=='You already have this alias'"
echo '{"__status":500,"body":{"data":{"attributes":{"message":"SQLSTATE[23000]: Duplicate entry x"}}}}' > "$PM_FIXTURES/POST_proxy-bindings.json.err"
cp "$PM_FIXTURES/POST_proxy-bindings.json" "$PM_FIXTURES/POST_ok.bak"; cp "$PM_FIXTURES/POST_proxy-bindings.json.err" "$PM_FIXTURES/POST_proxy-bindings.json"
check "create: taken (SQL 500)" "$(t run '{"op":"create","kind":"custom","address":"admin@pxdmail.net"}')" "d['alfredworkflow']['variables']['notif_text']=='That address is already taken'"
echo '{"__status":500,"body":{"data":{"attributes":{"message":"x","exception":"E","file":"/app/X.php"}}}}' > "$PM_FIXTURES/POST_proxy-bindings.json"
check "create: server error"    "$(t run '{"op":"create","kind":"random"}')" "d['alfredworkflow']['variables']['notif_text'] in ('x','ProxiedMail server error (500)')"
mv "$PM_FIXTURES/POST_ok.bak" "$PM_FIXTURES/POST_proxy-bindings.json"
check "run: toggle"             "$(t run '{"op":"toggle","id":"C6C4C547-6000-0000-00000BAE"}')" "d['alfredworkflow']['variables']['notif_title']=='Forwarding paused'"
check "run: copy code"          "$(t run '{"op":"copyCode","id":"81F8AD00-0000-0000-00003CC8"}')" "d['alfredworkflow']['arg']=='482913'"
html=$(ls "$alfred_workflow_cache"/emails/*.html | head -1)
grep -q "Content-Security-Policy" "$html" && grep -q "img-src data: cid:" "$html" && print "✓ email HTML blocks remote images" || { print "✗ CSP missing"; fail=1; }
check "codes: first run"        "$(t code '')"               "d['items'][0]['title']=='482913' and d['rerun']==3 and d['items'][1]['title']=='Still watching for new emails…' and 'without inbox browsing' in d['items'][-1]['title']"
before=$(grep -c received-emails-links "$PM_FIXTURES/requests.log")
check "codes: rerun keeps results" "$(t code '')"            "d['items'][0]['title']=='482913'"
after=$(grep -c received-emails-links "$PM_FIXTURES/requests.log")
[[ $before == $after ]] && print "✓ codes: rerun skips unchanged inboxes" || { print "✗ rerun refetched inboxes ($before → $after)"; fail=1; }
check "codes: filter"           "$(t code 'zzz')"            "d['items'][0]['title']=='Still watching for new emails…'"
check "codes: scoped waiting"   "$(t code '›burner42@proxiedmail.com ')" "d['items'][0]['title']=='Waiting for email to burner42@proxiedmail.com…' and 'arg' in d['items'][0]"
check "codes: scoped not browsable" "$(t code '›news-65ddf8@proxiedmail.com ')" "d['items'][0]['title']=='Inbox browsing is off for this alias'"
t code "" >/dev/null
python3 -c "import json,time,sys;p=sys.argv[1];d=json.load(open(p));d['started']=int(time.time()*1000)-200000;json.dump(d,open(p,'w'))" "$alfred_workflow_cache/watch.json"
check "codes: stops after 3 min" "$(t code '')" "'rerun' not in d and d['items'][1]['title']=='Stopped watching'"
check "create + watch"          "$(t run '{"op":"create","kind":"burner","watch":true}')" "d['alfredworkflow']['variables']['out']=='copy'"
[[ "$(cat $PM_FIXTURES/nav.log)" == "pmcode ›7uj7s9gbnp@proxiedmail.com " ]] && print "✓ create + watch opens pmcode" || { print "✗ nav: $(cat $PM_FIXTURES/nav.log)"; fail=1; }
check "delete email confirm"    "$(t inbox '›v7do1zfs8w@proxiedmail.com ›81F8AD00-0000-0000-00003CC8 ›delete')" "d['items'][0]['title']=='Delete this email?'"
check "delete email"            "$(t run '{"op":"deleteEmail","id":"81F8AD00-0000-0000-00003CC8","aliasId":"C6C4C547-6000-0000-00000BAE","back":"›v7do1zfs8w@proxiedmail.com "}')" "d['alfredworkflow']['variables']['notif_title']=='Email deleted'"


# ── v0.3.0 features ──
PB="$PM_FIXTURES/GET_proxy-bindings.json"; cp "$PB" "$PM_FIXTURES/pb.bak"; fresh() { rm -f "$alfred_workflow_cache/aliases.json"; }
check "filter :paused"            "$(t aliases ':paused ')"   "[i['title'] for i in d['items']]==['news-65ddf8@proxiedmail.com']"
check "filter :burner"            "$(t aliases ':burner ')"   "[i['title'] for i in d['items']]==['burner42@proxiedmail.com']"
check "filter :webhook + text"    "$(t aliases 'news :webhook ')" "[i['title'] for i in d['items']]==['news-65ddf8@proxiedmail.com']"
check "filter no match"           "$(t aliases ':burner :webhook ')" "d['items'][0]['title']=='No aliases match these filters'"
check "filter suggestions"        "$(t aliases ':')"          "[i['title'] for i in d['items']][:3]==[':paused',':burner',':unverified'] and d['items'][0]['autocomplete']==':paused '"
check "filter partial"            "$(t aliases 'net :we')"    "d['items'][0]['title']==':webhook' and d['items'][0]['autocomplete']=='net :webhook '"
check "hide automatic"            "$(hide_automatic=1 t aliases '')" "not any(i['title'].startswith('news-') for i in d['items'])"
check "hide automatic + :all"     "$(hide_automatic=1 t aliases ':all ')" "any(i['title'].startswith('news-') for i in d['items'])"
check "sort a-z"                  "$(sort_order=az t aliases '')" "[i['title'] for i in d['items']][:3]==['burner42@proxiedmail.com','news-65ddf8@proxiedmail.com','v7do1zfs8w@proxiedmail.com'] and d.get('skipknowledge')==True"
check "sort received"             "$(sort_order=received t aliases '')" "d['items'][0]['title']=='v7do1zfs8w@proxiedmail.com'"
check "↩ pastes when set"         "$(pmail_enter=paste t aliases 'netflix')" "'\"op\":\"paste\"' in d['items'][0]['arg'] and d['items'][0]['mods']['cmd']['subtitle']=='Copy alias'"
python3 -c "import json,sys;p=sys.argv[1];d=json.load(open(p));d['data'][0]['attributes']['real_addresses']={'me@example.com':{'is_enabled':True,'is_verified':True},'new@x.io':{'is_enabled':True,'is_verified':False}};json.dump(d,open(p,'w'))" "$PB"; fresh
check "unverified in list"        "$(t aliases 'netflix')"    "'new@x.io ⚠️ unverified' in d['items'][0]['subtitle'] and d['items'][0]['icon']['path']=='icons/warn.png'"
check "filter :unverified"        "$(t aliases ':unverified ')" "[i['title'] for i in d['items']]==['v7do1zfs8w@proxiedmail.com']"
check "unverified in actions"     "$(t aliases '›v7do1zfs8w@proxiedmail.com ')" "d['items'][0]['title']==\"new@x.io isn't verified\""
check "remove forwarding rows"    "$(t aliases '›v7do1zfs8w@proxiedmail.com ')" "sum(i['title'].startswith('Stop forwarding to') for i in d['items'])==2"
check "forward picker unverified" "$(t create '›forward ')"   "any(i['title']=='new@x.io' and '⚠️ unverified' in i['subtitle'] for i in d['items'])"
: > "$PM_FIXTURES/requests.log"
check "forward: add"              "$(t run '{"op":"forward","id":"C6C4C547-6000-0000-00000BAE","address":"b@c.io","mode":"add"}')" "d['alfredworkflow']['variables']['notif_title']=='Forwarding address added'"
grep -q '"real_addresses":{"me@example.com":true,"new@x.io":true,"b@c.io":true}' "$PM_FIXTURES/requests.log" && print "✓ forward: add keeps existing" || { print "✗ forward add body"; grep PATCH "$PM_FIXTURES/requests.log"; fail=1; }
: > "$PM_FIXTURES/requests.log"
check "forward: remove"           "$(t run '{"op":"forward","id":"C6C4C547-6000-0000-00000BAE","address":"new@x.io","mode":"remove"}')" "d['alfredworkflow']['variables']['notif_title']=='Forwarding address removed'"
grep -q '"real_addresses":{"me@example.com":true}' "$PM_FIXTURES/requests.log" && print "✓ forward: remove drops only that address" || { print "✗ forward remove body"; fail=1; }
cp "$PM_FIXTURES/pb.bak" "$PB"; fresh
check "forward: remove unknown"   "$(t run '{"op":"forward","id":"C6C4C547-6000-0000-00000BAE","address":"nobody@x.io","mode":"remove"}')" "d['alfredworkflow']['variables']['notif_title']=='Not forwarding to nobody@x.io'"
check "forward: can't remove last" "$(t run '{"op":"forward","id":"C6C4C547-6000-0000-00000BAE","address":"me@example.com","mode":"remove"}')" "d['alfredworkflow']['variables']['notif_title']==\"Can't remove the only forwarding address\""
: > "$PM_FIXTURES/requests.log"
check "browse all"                "$(t run '{"op":"browseAll"}')" "d['alfredworkflow']['variables']['notif_text']=='1 alias updated'"
grep -q '"path":"proxy-bindings/DBE6A547-6000-0000-00000BAE".*"is_browsable":true' "$PM_FIXTURES/requests.log" && [[ $(grep -c PATCH "$PM_FIXTURES/requests.log") == 1 ]] && print "✓ browse all patches only aliases with it off" || { print "✗ browse all requests"; fail=1; }
fresh
check "secret: copy code"         "$(t run '{"op":"copyCode","id":"81F8AD00-0000-0000-00003CC8"}')" "d['alfredworkflow']['variables']['out']=='secret_notify'"
check "secret: paste code"        "$(t run '{"op":"paste","text":"123456","secret":true}')" "d['alfredworkflow']['variables']['out']=='secret_paste'"
check "secret: code rows"         "$(t inbox '›v7do1zfs8w@proxiedmail.com ›81F8AD00-0000-0000-00003CC8 ')" "'\"secret\":true' in d['items'][1]['arg']"
check "notifications off"         "$(notifications=0 t run '{"op":"create","kind":"random"}')" "d['alfredworkflow']['variables']['out']=='copy'"
check "notifications off: errors" "$(notifications=0 t run '{"op":"bogus"}')" "d['alfredworkflow']['variables']['out']=='notify'"
check "notifications off: secret" "$(notifications=0 t run '{"op":"copyCode","id":"81F8AD00-0000-0000-00003CC8"}')" "d['alfredworkflow']['variables']['out']=='secret'"
rm -f "$alfred_workflow_cache/watch.json"
check "watch duration setting"    "$(watch_minutes=1 code_window_minutes=5 t code '')" "any('stops in 1:00' in i.get('subtitle','') for i in d['items'])"
check "code row offers bulk"      "$(t code '')" "any(i.get('arg')=='{\"op\":\"browseAll\"}' for i in d['items'])"
cp "$PM_FIXTURES/pb.bak" "$PB"; fresh

# ── Regression tests for audit findings ──
F="$PM_FIXTURES"; INBOX="$F/GET_received-emails-links_C6C4C547-6000-0000-00000BAE.json"; cp "$INBOX" "$F/inbox.bak"
check "audit1: ⏎ pastes in paste mode"  "$(after_create=paste t run '{"op":"create","kind":"random"}')" "d['alfredworkflow']['variables']['out']=='paste'"
check "audit1: ⌘ copies in paste mode"  "$(after_create=paste t run '{"op":"create","kind":"random","invert":true}')" "d['alfredworkflow']['variables']['out']=='copy_notify'"
check "audit1: ⌘ pastes in copy mode"   "$(t run '{"op":"create","kind":"random","invert":true}')" "d['alfredworkflow']['variables']['out']=='paste'"
check "audit1: menu sends invert"       "$(t create 'x')" "'\"invert\":true' in d['items'][0]['mods']['cmd']['arg']"
echo '{"__status":500,"body":{"data":{"attributes":{"message":"boom"}}}}' > "$INBOX"; rm -rf "$alfred_workflow_cache/inbox"
check "audit2: 500 isn't 'browsing off'" "$(t inbox '›v7do1zfs8w@proxiedmail.com ')" "d['items'][0]['title']=='ProxiedMail error (500)'"
check "audit3: retry stays in pminbox"   "$(t inbox '›v7do1zfs8w@proxiedmail.com ')" "'\"keyword\":\"pminbox\"' in d['items'][0]['arg']"
# audit4: count goes up while the inbox fetch fails, then recovers → the code must still appear
rm -f "$alfred_workflow_cache/watch.json"; echo '{"data":[]}' > "$INBOX"
t code '' >/dev/null
python3 -c "import json,sys;p=sys.argv[1];d=json.load(open(p));d['data'][0]['attributes']['received_emails']=3;json.dump(d,open(p,'w'))" "$F/GET_proxy-bindings.json"
echo '{"__status":502,"body":{}}' > "$INBOX"; t code '' >/dev/null
cp "$F/inbox.bak" "$INBOX"
check "audit4: email after failed poll"  "$(t code '')" "d['items'][0]['title']=='482913'"
python3 -c "import json,sys;p=sys.argv[1];d=json.load(open(p));print('✓ audit5: lastPoll set after run' if d['lastPoll']>=d['started'] else '✗ lastPoll')" "$alfred_workflow_cache/watch.json"
# audit6: meta refresh / base / link stripped from rendered email
python3 -c "
import json,sys;p=sys.argv[1];d=json.load(open(p));d['data']['id']='EVIL';d['data']['attributes']['payload']['body-html']='<meta http-equiv=\"refresh\" content=\"0;url=https://t.example\"><base href=\"https://t.example/\"><link rel=dns-prefetch href=\"//t.example\"><p>hi</p>';json.dump(d,open(sys.argv[2],'w'))" "$F/GET_received-emails_81F8AD00-0000-0000-00003CC8.json" "$F/GET_received-emails_EVIL.json"
t run '{"op":"copyText","id":"EVIL"}' >/dev/null; t inbox '›v7do1zfs8w@proxiedmail.com ›EVIL ' >/dev/null
grep -qiE '<meta http-equiv="refresh"|<base |<link ' "$alfred_workflow_cache/emails/EVIL.html" && { print "✗ audit6: dangerous tags kept"; fail=1; } || print "✓ audit6: meta/base/link stripped"
grep -q "form-action 'none'" "$alfred_workflow_cache/emails/EVIL.html" && print "✓ audit6: CSP blocks forms" || { print "✗ audit6: CSP"; fail=1; }
check "audit7: 'pinned' isn't a code"    "$(t codes 'News' 'Our pinned post has 1500 likes')" "d==[]"
check "audit7: 'user2024' isn't a code"  "$(t codes 'Alert' 'The password for user2024 was changed')" "d==[]"
check "audit7: barcode/zip aren't codes" "$(t codes 'Order' 'Show barcode 99887766 at zip code 90210')" "d==[]"
check "audit7: German compound code"     "$(t codes 'Anmeldung' 'Dein Bestätigungscode lautet 551122')" "d==['551122']"
# lower: alias with no forwarding addresses
python3 -c "import json,sys;p=sys.argv[1];d=json.load(open(p));d['data'][0]['attributes']['real_addresses']=[];json.dump(d,open(p,'w'))" "$F/GET_proxy-bindings.json"; rm -f "$alfred_workflow_cache/aliases.json"
check "lower: no-forward alias ⌃ disabled" "$(t aliases 'v7do1zfs8w')" "d['items'][0]['mods']['ctrl']['valid']==False"
echo '{"meta":{},"data":[]}' > "$F/GET_proxy-bindings.json"; rm -f "$alfred_workflow_cache/aliases.json" "$alfred_workflow_cache/watch.json"
check "lower: empty account in pmcode"   "$(t code '')" "any(i['title']==\"You don't have any aliases yet\" for i in d['items'])"
check "empty account in pmail"           "$(t aliases '')" "d['items'][0]['title']=='No aliases yet'"

print "\n--- API requests made ---"; cat "$PM_FIXTURES/requests.log" | grep -v '"GET"'
exit $fail

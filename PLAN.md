# ProxiedMail for Alfred — Research & Build Plan

_Researched 2026-09-19. Sources: docs.proxiedmail.com (all 30 pages), Swagger `api-docs.yaml`, `proxiedmail-php-client` (source), `proxiedmail-js-client` (source), the proxiedmail.com web app bundles, live route probing (unauthenticated, no side effects), alfred.app Gallery rules, Alfred 5 docs._

---

## 1. What ProxiedMail's API can do

**Base URL:** `https://proxiedmail.com/api/v1/`. The docs ask you not to hard-code the host, so it will be a config field. It's a Laravel backend with JSON:API-style bodies (`{"data":{"type":…,"attributes":{…}}}`).

**Auth:** there are two token types.
| Token | How you get it | Header | Expiry |
|---|---|---|---|
| **API token** (use this one) | Settings page https://proxiedmail.com/en/settings, or `GET /api-token` | `Token: <token>` | None (revocable) |
| Bearer | `POST /auth` with username and password | `Authorization: Bearer <t>` | Expires, can't be refreshed |

The workflow only needs the **API token**. We never handle the user's password.

### 1a. Documented endpoints

| # | Method & path | Purpose | Alfred use |
|---|---|---|---|
| 1 | `GET /proxy-bindings` | Lists all aliases, plus `meta.usedProxyBindings` / `availableProxyBindings` / `isVerificationEmailSend` | Main alias list and quota display |
| 2 | `POST /proxy-bindings` | Creates an alias: `real_addresses[]`, `proxy_address`, `callback_url`, `description`, `is_browsable` | "New alias" |
| 3 | `PATCH /proxy-bindings/{id}` | Updates an alias: `real_addresses` as a map `{addr: true/false}`, `proxy_address`, `description`, `callback_url` | Rename, forwarding, enable/disable, webhook |
| 4 | `GET /received-emails-links/{bindingId}` | Last 55 received emails (id, sender, subject, attachment count, date). **Only works when the alias is `is_browsable`** | Inbox browser |
| 5 | `GET /received-emails/{id}` | Full email: From/To/Subject, `body-html`, `body-plain`, attachment URLs | Read email, extract OTP codes and links |
| 6 | `POST /callback` | Creates a built-in webhook receiver (`call_url`, `get_url`, `id`) | Advanced: webhook testing |
| 7 | `GET /callback/get/{hash}` | Polls the receiver (`is_received`, `payload`, `method`) | Same |
| 8 | `GET /api-token` (Bearer) / `POST /auth` | Token bootstrap | **Not needed** |

**Alias object fields:** `id`, `proxy_address`, `real_addresses{addr:{is_enabled,is_verified,is_verification_needed}}`, `is_browsable`, `received_emails` (count), `description`, `callback_url`, `created_at`, `updated_at`.

**Special forward targets:** use `@int.proxiedmail.com` or `@proxiedmail-int.int` as the real address to get **no email delivery**. Mail then lands only in the API inbox or webhook, which makes a true burner inbox possible.

### 1b. Undocumented routes I confirmed exist

I probed these without auth. A 401 means the route exists and 404 means it doesn't. None of them are in the docs or Swagger.

| Route | Status | Likely purpose |
|---|---|---|
| `DELETE /proxy-bindings/{id}` | 401 ✅ | **Delete alias.** The PHP client README lists delete as "todo" |
| `DELETE /received-emails/{id}` | 401 ✅ | Delete a received email |
| `POST /received-emails/{id}/flush` | 401 ✅ | Used by the PHP client's `flushReceivedEmail()`. Probably marks the email processed or clears its body |
| `GET /users/me` | 401 ✅ | Account info, which could give the default forwarding address |
| `GET /gapi/available-domains` | 401 ✅ | **Domains the user can create aliases on**, probably including custom domains |
| `POST /send-message` | 401 ✅ | Internal and test-only (the PHP client says "shouldn't work for you"). **Out of scope** |

These have to be checked with your API key before we rely on them (see §5). The workflow will hide any feature whose endpoint turns out not to work.

### 1c. What the API cannot do (per docs and probes)
- Send or reply as the alias (reverse aliasing). There's no public endpoint.
- Manage AI bots. They're UI-only for now; the only possible link is "open bot settings in the browser".
- Push new-mail notifications to a desktop app. We'd have to poll.
- Page past 55 emails per alias.

---

## 2. Alfred platform facts that shape the design

- **Alfred 5.8 with Powerpack** is installed here. Workflows need the Powerpack.
- **Gallery rules** (alfred.app/submit): keywords of 3+ characters that users can configure; icon at least 256×256; no auto-updater; no downloading or installing anything at runtime (no `pip`/`brew`/`npm install`); any binaries must be signed and notarised; code must be auditable. User configuration is strongly preferred.
- **Runtime choice:** macOS doesn't ship Python or Node. `/usr/bin/jq` only exists on macOS 15 and later. **JXA (JavaScript for Automation, `osascript -l JavaScript`) with `/usr/bin/curl`** runs on every supported macOS with zero dependencies, handles JSON natively and is fully auditable. **Recommendation: JXA.**
- **User Configuration** (`userconfigurationconfig` in `info.plist`) gives an install-time form for the API key and defaults. Values arrive as environment variables.
- **Script Filter JSON** supports `items`, per-modifier (`mods`) args and subtitles, `quicklookurl`, `variables`, `rerun` (live polling), `skipknowledge`, and the Alfred 5.5+ `cache` object (`seconds`, `loosereload`). That's enough for a fast cached alias list that refreshes in the background.
- **Gallery gap:** there's **no ProxiedMail, SimpleLogin or addy.io workflow in the Alfred Gallery**, so this would be the first alias manager there.

---

## 3. Feature plan

Default keywords are shown below and all of them are configurable. `⏎` is the primary action; ⌘ ⌥ ⌃ ⇧ are modifiers.

### Phase 1 — MVP (core daily use)

**F1. Search aliases — `pm {query}`**
- Fuzzy search across address, description and forward target, using a cached list with a 5-minute TTL and background refresh.
- Title is the alias. Subtitle is `→ forward@addr · 12 received · description`. A dimmed icon means forwarding is disabled.
- `⏎` copies the alias · `⌘⏎` pastes it into the frontmost app · `⌥⏎` opens the actions menu (F4) · `⌃⏎` opens its inbox (F3) · `⇧` / ⌘Y shows a Quick Look summary.
- The top row shows account status, e.g. `8 / 10 aliases used`, plus a warning if the verification email is still pending.

**F2. Create alias — `pmnew {description}`**
- Random alias forwarding to your default real address, with the typed text as the description. The new address is copied and optionally pasted automatically.
- Variants appear as rows in the same Script Filter:
  - `pmnew shop:amazon` requests a custom local part `amazon@…`, if the API accepts it.
  - A domain picker row using `available-domains`.
  - **"Alias for current website"**: reads the front tab URL from Safari, Chrome, Arc, Brave or Edge via AppleScript and uses the site domain as the description. This is the killer feature, similar to Apple's Hide My Email.
  - **"Burner (no forwarding)"**: forwards to `@int.proxiedmail.com` with `is_browsable=true`, so mail only lands in the Alfred inbox.

**F3. Inbox — `pminbox {query}` (or `⌃⏎` on an alias)**
- Pick an alias, then see its last 55 emails as `Subject · From · 2h ago · 📎2`.
- `⏎` renders the HTML email to a cached file and opens it in Quick Look or the browser · `⌘⏎` copies the plain-text body · `⌥⏎` **copies a detected verification code** · `⌃⏎` shows the links in the email (to open or copy) · `⇧` Quick Look.
- If the alias isn't browsable, show a single row: "Inbox disabled for this alias — ⏎ to enable" (if PATCH supports that, otherwise open the web UI).

**F4. Alias actions menu (`⌥⏎` on an alias)**
- Copy / paste
- Enable or disable forwarding (toggles `real_addresses{addr:bool}` via PATCH)
- Edit description
- Change forwarding address(es)
- Set or clear webhook `callback_url`
- Open in the ProxiedMail web dashboard
- Delete alias (with a confirmation row, only if `DELETE` is verified)

**F5. Configuration & setup**
- User Configuration fields: **API token** (required), default forward address, default domain, auto-paste after create (checkbox), new aliases browsable by default (checkbox), cache TTL, API host (default `https://proxiedmail.com`), keyword fields.
- `pm` with no token shows "Set up ProxiedMail: ⏎ to open the Settings page to copy your API token, ⌘⏎ to configure the workflow".
- Clear errors for 401 (bad token), 403/422 (quota reached, invalid address) and network failures.

### Phase 2 — Power features

**F6. Latest verification code — `pmcode`.** Scans the newest emails across recently used or browsable aliases, extracts 4–8 digit OTP codes and magic links, and `⏎` copies the code. `rerun` polls every 2 seconds for about 60 seconds, so you can run it before the email arrives.

**F7. Wait for the next email.** After creating a burner (F2), Alfred keeps showing "Waiting for first email…" and then shows the email and its code. This mirrors the PHP client's `waitUntilFirstEmail`.

**F8. Universal Actions.** Select an email address anywhere and choose "Find in ProxiedMail" or "Disable this alias". Select a URL and choose "Create alias for this site".

**F9. Hotkey.** One key combination creates an alias for the current website and pastes it into the focused field.

**F10. Delete a received email / flush**, if the undocumented routes are verified.

### Phase 3 — Optional or advanced
- **F11. Webhook tester — `pmhook`:** creates a built-in receiver, attaches it to an alias as `callback_url`, and shows the JSON payload once it arrives. Useful for developers.
- **F12. New-mail notifications:** an opt-in `launchd` agent that polls, installed only when the user presses a button (installing it silently wouldn't be Gallery-safe). Could be dropped.
- **F13. Export aliases to CSV/JSON.**
- **F14. Open AI-bot settings** for an alias in the browser.
- **Keychain storage** for the token as an alternative to the plain-text preferences file.

---

## 4. Architecture

```
ProxiedMail.alfredworkflow/
├── info.plist              # objects, connections, userconfigurationconfig
├── icon.png                # 512×512 main icon
├── icons/                  # alias, alias-off, inbox, mail, code, new, trash, warn…
├── lib/
│   ├── api.js              # JXA: curl via NSTask (no shell quoting), Token header, errors
│   ├── cache.js            # $alfred_workflow_cache JSON with TTL and stale-while-revalidate
│   └── util.js             # fuzzy match, relative time, OTP/link extraction, html→file
├── sf_aliases.js           # Script Filter F1
├── sf_create.js            # Script Filter F2
├── sf_inbox.js             # Script Filter F3
├── sf_email.js             # Script Filter per-email actions
├── sf_actions.js           # Script Filter F4
├── sf_code.js              # Script Filter F6 (rerun)
├── run_action.js           # Run Script: create/patch/delete, then refresh cache + notify
├── frontmost_url.js        # current browser tab URL
└── README.md               # Gallery-style instructions
```

- **HTTP:** `/usr/bin/curl -sS --max-time 10 -H "Token: …" -H "Accept: application/json"`, run through `NSTask` with an argument array so no shell injection is possible.
- **Caching:** the alias list is cached for the TTL and every write invalidates it. Inbox and email bodies are cached per ID (email bodies don't change).
- **Security:** the token is only ever sent to the configured host. Rendered HTML emails are written to the cache and opened locally with remote images left alone. No telemetry.
- **Testing:** a small `test/` runner that calls each script with fixture JSON (from the docs examples) and mocks curl. A manual checklist runs against the live API.

---

## 5. Phase 0 — verify with your API key before building

These are read-only calls first, then create, patch and delete on one throwaway alias.

1. `GET /proxy-bindings` returns 200 with `Token` header. Record the real shape and whether `is_browsable` is present.
2. `GET /users/me` with `Token` header: can we read the account email to default the forward address?
3. `GET /gapi/available-domains`: which auth header does it take, and what does it return? Are custom domains included?
4. `POST /proxy-bindings` with `proxy_address` omitted or null: does the server generate a random address? Is a custom local part allowed? What do the quota-exceeded and invalid-address errors look like?
5. `PATCH` with `real_addresses {addr:false}`: does it disable forwarding? Can PATCH change `is_browsable`?
6. `GET /received-emails-links/{id}`: order (the PHP client assumes oldest first) and format of `created_at` (timezone?).
7. `GET /received-emails/{id}`: whether attachment URLs need auth.
8. `DELETE /proxy-bindings/{id}` on the throwaway alias: does it hard-delete?
9. `DELETE /received-emails/{id}` and `POST …/flush`: what they actually do.
10. Rate limits: look for `X-RateLimit-*` headers.
11. The web dashboard URL pattern for a single alias, for the "Open in web" action.

Each of these either unlocks or hides a feature listed above.

---

### 5a. Phase 0 results (verified against the live API, 2026-09-19)

| # | Question | Result |
|---|---|---|
| 1 | `GET /proxy-bindings` with `Token` | ✅ 200. Extra undocumented fields: `delivery_method`, `wildcard_auto_create_on`, `type`, `meta.confirmationType` |
| 2 | `GET /users/me` with `Token` | ✅ Works. `data.attributes.username` is the account email, used as the fallback forwarding address |
| 3 | `GET /gapi/available-domains` | ✅ Works when the API token is sent as `Authorization: Bearer <token>` (401 with the `Token` header). Returns `domain`, `isPremium`, `isShared`. Used for the domain picker in `pmnew` |
| 4 | Create without `proxy_address` | ✅ **The server generates one** on the account's default domain (e.g. `98e936425@pxdmail.net`). Custom local parts work. `description` is accepted in the POST |
| 5 | PATCH semantics | ✅ Partial bodies are fine. `real_addresses {addr:false}` pauses forwarding. Sending a new map **replaces** the forwarding list. ⚠️ **Any PATCH that omits `is_browsable` resets it to `false`**, so the workflow always sends the current value |
| 6 | Inbox on a non-browsable alias | 403 "Proxy email is not browsable…". A browsable alias with no mail returns `{"data":[]}` |
| 7 | Timestamps | UTC (`created_at` matched `date -u`) |
| 8 | `DELETE /proxy-bindings/{id}` | ✅ 204, alias removed. ⚠️ `meta.usedProxyBindings` still counts deleted aliases |
| 9 | Bad token | **403 "Token not found"**, not 401. Treated as an auth error |
| 10 | Rate limits | No `X-RateLimit-*` headers seen |
| — | Received-email detail / delete / flush | Not yet verified. Needs a browsable alias that has received mail |

## 6. Requirements summary
- **User:** macOS with Alfred 5 and Powerpack (present on this Mac: Alfred 5.8, macOS 26.6.2). A ProxiedMail account with an API token from https://proxiedmail.com/en/settings.
- **Build:** no dependencies. JXA and `/usr/bin/curl` are built in. `plutil` is used to build and validate `info.plist`, and the `.alfredworkflow` is just a zip.
- **Gallery-ready:** configurable keywords of 3+ characters, a 256px+ icon, user configuration, no runtime downloads, no binaries, a Style-Guide README, and a forum post before submitting.

## 7. Proposed order of work
1. Phase 0 API verification (about 30 minutes, needs your key).
2. `lib/` and F5 config, then F1 search, then F2 create, then F3 inbox, then F4 actions. That's the MVP, which I'll package as `.alfredworkflow` and install for you to try.
3. Phase 2 features: F6 codes, F7 wait, F8/F9 Universal Actions and hotkey.
4. Icons, README, Gallery polish, forum post.

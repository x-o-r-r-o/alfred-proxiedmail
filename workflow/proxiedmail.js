#!/usr/bin/osascript -l JavaScript
// ProxiedMail for Alfred
// Usage: ./proxiedmail.js <mode> [query]
//   Script Filter modes: aliases, create, inbox, code
//   Action mode:         run <json>

ObjC.import("Foundation")
ObjC.import("AppKit")

const SEP = "›"
const INTERNAL_DOMAINS = ["int.proxiedmail.com", "proxiedmail-int.int"]

// ─── Environment ────────────────────────────────────────────────────────────

function envVar(name, fallback = "") {
  const value = $.NSProcessInfo.processInfo.environment.objectForKey(name).js
  return value === undefined || value === "" ? fallback : value
}

function envFlag(name, fallback) {
  const value = envVar(name, "")
  if (value === "") return fallback
  return value === "1" || value.toLowerCase() === "true"
}

const config = {
  token: envVar("api_token"),
  host: envVar("api_host", "https://proxiedmail.com").replace(/\/+$/, ""),
  browsable: envFlag("new_browsable", true),
  afterCreate: envVar("after_create", "copy"),
  remoteImages: envFlag("remote_images", false),
  cacheTTL: Number(envVar("cache_ttl", "300")),
  timeout: Number(envVar("timeout_seconds", "15")),
  kwAliases: envVar("kw_aliases", "pmail"),
  kwCreate: envVar("kw_create", "pmnew"),
  kwInbox: envVar("kw_inbox", "pminbox"),
  kwCode: envVar("kw_code", "pmcode"),
  cacheDir: envVar("alfred_workflow_cache", $.NSTemporaryDirectory().js + "proxiedmail-alfred"),
  dataDir: envVar("alfred_workflow_data", $.NSTemporaryDirectory().js + "proxiedmail-alfred-data"),
  bundleId: envVar("alfred_workflow_bundleid", "com.proxiedmail.alfred"),
  fixtures: envVar("PM_FIXTURES"),
}

// ─── Files ──────────────────────────────────────────────────────────────────

function mkpath(path) {
  $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(path, true, $(), $())
}

function readText(path) {
  const s = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, $())
  return s.isNil() ? undefined : s.js
}

function writeText(path, text) {
  mkpath($(path).stringByDeletingLastPathComponent.js)
  $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, $())
}

function readJSON(path) {
  const text = readText(path)
  if (text === undefined) return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

function writeJSON(path, value) { writeText(path, JSON.stringify(value)) }

function removePath(path) { $.NSFileManager.defaultManager.removeItemAtPathError(path, $()) }

function fileExists(path) { return $.NSFileManager.defaultManager.fileExistsAtPath(path) }

// ─── HTTP ───────────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }

  // A bad token comes back as 403 "Token not found"; a missing one as 401
  get isAuth() {
    return this.status === 401 || (this.status === 403 && /token/i.test(this.message))
  }
}

// Quote a value for a curl config file (read from stdin so the token never shows in `ps`)
function curlQuote(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r") + '"'
}

function runProcess(executable, args, stdinText) {
  const task = $.NSTask.alloc.init
  const outPipe = $.NSPipe.pipe
  const errPipe = $.NSPipe.pipe
  const inPipe = $.NSPipe.pipe
  task.executableURL = $.NSURL.fileURLWithPath(executable)
  task.arguments = args
  task.standardOutput = outPipe
  task.standardError = errPipe
  task.standardInput = inPipe
  task.launchAndReturnError($())
  if (stdinText !== undefined) {
    inPipe.fileHandleForWriting.writeData($(stdinText).dataUsingEncoding($.NSUTF8StringEncoding))
  }
  inPipe.fileHandleForWriting.closeFile
  const out = outPipe.fileHandleForReading.readDataToEndOfFile
  const err = errPipe.fileHandleForReading.readDataToEndOfFile
  task.waitUntilExit
  const decode = data => $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js || ""
  return { status: task.terminationStatus, stdout: decode(out), stderr: decode(err) }
}

function errorMessage(body, status) {
  const pick = d => d && d.attributes && d.attributes.message
  let msg
  if (body && typeof body === "object") {
    msg = (Array.isArray(body) ? pick(body[0] && body[0].data) : pick(body.data)) || body.message
  }
  // A taken address comes back as 409, or sometimes as a 500 with a raw SQL error
  if (status === 409 || /Duplicate entry|same proxy address/i.test(msg || "")) return "That address is already taken"
  if (msg && !/SQLSTATE|Exception|\.php/.test(msg)) return msg.length > 160 ? msg.slice(0, 157) + "…" : msg
  if (status >= 500) return `ProxiedMail server error (${status})`
  if (status === 401) return "Unauthorized"
  if (status === 404) return "Not found"
  return `HTTP ${status}`
}

function fixtureRequest(method, path, body, gapi) {
  const log = `${config.fixtures}/requests.log`
  writeText(log, (readText(log) || "") + JSON.stringify({ method, path, body }) + "\n")
  const file = `${config.fixtures}/${method}_${gapi ? "gapi_" : ""}${path.replace(/[/?=&]/g, "_")}.json`
  const data = readJSON(file)
  if (data && data.__status) throw new ApiError(data.__status, errorMessage(data.body, data.__status))
  return data === undefined ? {} : data
}

// gapi = the web app's API (/gapi/...), which accepts the same token as a Bearer
function api(method, path, body, gapi = false) {
  if (config.fixtures) return fixtureRequest(method, path, body, gapi)
  if (!config.token) throw new ApiError(401, "No API token configured")

  const lines = [
    `url = ${curlQuote(`${config.host}/${gapi ? "gapi" : "api/v1"}/${path}`)}`,
    `request = ${curlQuote(method)}`,
    `header = ${curlQuote("Accept: application/json")}`,
    `header = ${curlQuote("Content-Type: application/json")}`,
    `header = ${curlQuote(gapi ? `Authorization: Bearer ${config.token}` : `Token: ${config.token}`)}`,
    `user-agent = ${curlQuote("ProxiedMail-Alfred/1.0")}`,
    `max-time = ${config.timeout}`,
    "silent",
    "show-error",
    `write-out = ${curlQuote("\n%{http_code}")}`,
  ]
  if (body !== undefined) lines.push(`data-binary = ${curlQuote(JSON.stringify(body))}`)

  const result = runProcess("/usr/bin/curl", ["--config", "-"], lines.join("\n") + "\n")
  const cut = result.stdout.lastIndexOf("\n")
  const status = Number(result.stdout.slice(cut + 1)) || 0
  const text = result.stdout.slice(0, Math.max(cut, 0))

  if (status === 0) throw new ApiError(0, result.stderr.trim().replace(/^curl: \(\d+\) /, "") || "Network error")

  let parsed
  try { parsed = text ? JSON.parse(text) : {} } catch { parsed = text }
  if (status < 200 || status >= 300) throw new ApiError(status, errorMessage(parsed, status))
  return parsed
}

// ─── Data ───────────────────────────────────────────────────────────────────

const aliasCachePath = () => `${config.cacheDir}/aliases.json`
const inboxCachePath = id => `${config.cacheDir}/inbox/${id}.json`
const emailCachePath = id => `${config.cacheDir}/emails/${id}.json`
const emailHTMLPath = id => `${config.cacheDir}/emails/${id}.html`

function loadAliases(force = false) {
  const cached = readJSON(aliasCachePath())
  if (!force && cached && Date.now() - cached.fetchedAt < config.cacheTTL * 1000) return { ...cached, stale: false }
  try {
    const response = api("GET", "proxy-bindings")
    const fresh = { fetchedAt: Date.now(), data: response.data || [], meta: response.meta || {} }
    writeJSON(aliasCachePath(), fresh)
    return { ...fresh, stale: false }
  } catch (error) {
    if (cached && !error.isAuth) return { ...cached, stale: true, error }
    throw error
  }
}

function invalidateAliases() { removePath(aliasCachePath()) }

function findAlias(aliases, key) {
  const k = key.toLowerCase()
  return aliases.find(a => a.id === key || a.attributes.proxy_address.toLowerCase() === k)
}

// Like findAlias, but refreshes the cache once if the alias isn't there
function lookupAlias(aliases, key) {
  const alias = findAlias(aliases, key)
  if (alias) return alias
  try { return findAlias(loadAliases(true).data, key) } catch { return undefined }
}

function realAddresses(alias) {
  return Object.entries(alias.attributes.real_addresses || {}).map(([address, state]) => ({
    address,
    enabled: state === true || Boolean(state && state.is_enabled),
    verified: Boolean(state && state.is_verified),
    internal: isInternal(address),
  }))
}

function isInternal(address) {
  return INTERNAL_DOMAINS.some(d => address.toLowerCase().endsWith("@" + d))
}

function forwardingEnabled(alias) { return realAddresses(alias).some(r => r.enabled) }

function isBurner(alias) {
  const reals = realAddresses(alias)
  return reals.length > 0 && reals.every(r => r.internal)
}

// Choices made in the pmnew pickers, kept in the workflow's data folder
const prefsPath = () => `${config.dataDir}/prefs.json`
const loadPrefs = () => readJSON(prefsPath()) || {}

function savePref(key, value) {
  const prefs = loadPrefs()
  if (value) prefs[key] = value
  else delete prefs[key]
  writeJSON(prefsPath(), prefs)
}

// Empty string = let ProxiedMail pick the domain
const chosenDomain = () => loadPrefs().domain || ""

// Forwarding addresses already used by aliases, most used first, plus the account email
function knownForwards(aliases) {
  const counts = {}
  for (const alias of aliases || []) {
    for (const r of realAddresses(alias)) if (!r.internal) counts[r.address] = (counts[r.address] || 0) + 1
  }
  const account = accountEmail()
  if (account && !(account in counts)) counts[account] = 0
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([address, count]) => ({ address, count, account: address === account }))
}

function defaultForward(aliases) {
  const chosen = loadPrefs().forward
  if (chosen) return [chosen]
  const best = knownForwards(aliases)[0]
  return best ? [best.address] : []
}

function loadDomains() {
  const path = `${config.cacheDir}/domains.json`
  const cached = readJSON(path)
  if (cached && Date.now() - cached.fetchedAt < 24 * 3600 * 1000) return cached.data
  try {
    const response = api("GET", "available-domains", undefined, true)
    const data = (Array.isArray(response) ? response : response.data || []).map(d => ({
      domain: d.domain,
      premium: Boolean(d.isPremium),
      custom: !d.isShared,
    }))
    writeJSON(path, { fetchedAt: Date.now(), data })
    return data
  } catch {
    // Remember the failure for a minute so each keystroke doesn't wait on the network again
    const data = cached ? cached.data : []
    writeJSON(path, { fetchedAt: Date.now() - 24 * 3600 * 1000 + 60 * 1000, data })
    return data
  }
}

function accountEmail() {
  const path = `${config.cacheDir}/account.json`
  const cached = readJSON(path)
  if (cached && (cached.username || Date.now() - cached.failedAt < 60 * 1000)) return cached.username
  try {
    const me = api("GET", "users/me")
    const username = me.data && me.data.attributes && me.data.attributes.username
    writeJSON(path, username ? { username } : { failedAt: Date.now() })
    return username
  } catch {
    writeJSON(path, { failedAt: Date.now() })
    return undefined
  }
}

function loadInbox(aliasId, force = false) {
  const cached = readJSON(inboxCachePath(aliasId))
  if (!force && cached && Date.now() - cached.fetchedAt < 30 * 1000) return cached.data
  const response = api("GET", `received-emails-links/${aliasId}`)
  const data = (response.data || []).slice().sort((a, b) => parseDate(b.attributes.created_at) - parseDate(a.attributes.created_at))
  writeJSON(inboxCachePath(aliasId), { fetchedAt: Date.now(), data })
  return data
}

function loadEmail(emailId) {
  const cached = readJSON(emailCachePath(emailId))
  if (cached) return cached
  const response = api("GET", `received-emails/${emailId}`)
  const email = response.data || response
  if (!email.attributes || email.attributes.is_processed !== false) writeJSON(emailCachePath(emailId), email)
  return email
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseDate(value) {
  if (!value) return 0
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(" ", "T") + "Z" : value
  const time = Date.parse(iso)
  return isNaN(time) ? 0 : time
}

function relativeTime(value) {
  const time = parseDate(value)
  if (!time) return ""
  const s = Math.max(0, Math.round((Date.now() - time) / 1000))
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`
  return new Date(time).toISOString().slice(0, 10)
}

function matches(query, ...fields) {
  const haystack = fields.filter(Boolean).join(" ").toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(token => haystack.includes(token))
}

function randomLocalPart(length = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  let out = ""
  for (let i = 0; i < length; i++) out += chars.charAt(Math.floor(Math.random() * chars.length))
  return out
}

function hostname(url) {
  try { return $.NSURL.URLWithString(url).host.js.replace(/^www\d?\./, "") } catch { return undefined }
}

function decodeEntities(text) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] || m)
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  ).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim()
}

function escapeHTML(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function emailParts(email) {
  const a = email.attributes || {}
  const p = a.payload || {}
  const html = p["body-html"] || ""
  const plain = p["body-plain"] || p["stripped-text"] || (html ? htmlToText(html) : "")
  return {
    subject: p.Subject || p.subject || a.subject || "(no subject)",
    from: p.From || p.from || a.sender_email || "",
    to: p.To || a.recipient_email || "",
    date: a.created_at,
    html,
    plain,
    attachments: (a.attachments || []).map(x => x.url).filter(Boolean),
  }
}

// Find verification / one-time codes. Returns best-first list of unique codes.
function extractCodes(subject, text) {
  const found = []
  const add = code => { if (code && !found.includes(code)) found.push(code) }
  const keyword = "(?:^|[^\\p{L}])(code|otp|pin|passcode|verification|verify|confirm|one[- ]time|security code|login|sign[- ]in|2fa|код|código|bestätigungscode|bestätigung|sicherheitscode|verifizierungscode|anmeldecode)(?![\\p{L}])"
  const isYear = c => /^(19|20)\d\d$/.test(c)
  // Postal codes aren't verification codes
  const sources = [subject || "", text || ""].map(t => t.replace(/\b(zip|postal|post)[- ]?code\b/gi, ""))

  for (const source of sources) {
    // Keyword followed closely by a code, e.g. "Your code is 123-456" or "Verification code: AB12CD"
    // Numeric codes, e.g. "Your code is 123-456"
    const numeric = new RegExp(keyword + "[^\\n]{0,40}?(?<![\\p{L}\\d])([0-9]{3}[- ]?[0-9]{3}|[0-9]{4,8})(?![\\p{L}\\d])", "giu")
    for (const m of source.matchAll(numeric)) {
      const code = m[2].replace(/[- ]/g, "")
      if (!isYear(code)) add(code)
    }
    // Letter+digit codes, e.g. "Verification code: AB12CD" (uppercase only, so words like user2024 don't match)
    const keywordOnly = new RegExp(keyword, "giu")
    for (const k of source.matchAll(keywordOnly)) {
      const tail = source.slice(k.index + k[0].length, k.index + k[0].length + 48).split("\n")[0]
      const m = tail.match(/(?<![A-Za-z0-9])((?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{5,8})(?![A-Za-z0-9])/u)
      if (m) add(m[1])
    }
  }
  for (const source of sources) {
    // A code on a line by itself (common in OTP emails)
    for (const m of source.matchAll(/^\s*([0-9]{4,8}|[0-9]{3}[- ][0-9]{3})\s*$/gm)) {
      const code = m[1].replace(/[- ]/g, "")
      if (!isYear(code)) add(code)
    }
  }
  // Any 6-digit number in the subject
  for (const m of (subject || "").matchAll(/\b(\d{6})\b/g)) add(m[1])
  return found
}

function extractLinks(html, plain) {
  const links = []
  const seen = new Set()
  if (html) {
    for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = decodeEntities(m[1].trim())
      if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
      seen.add(url)
      links.push({ url, text: htmlToText(m[2]).replace(/\s+/g, " ").slice(0, 80) })
    }
  }
  for (const m of (plain || "").matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
    if (seen.has(m[0])) continue
    seen.add(m[0])
    links.push({ url: m[0], text: "" })
  }
  return links
}

function writeEmailHTML(email) {
  const e = emailParts(email)
  const csp = config.remoteImages
    ? "default-src 'none'; img-src * data: cid:; style-src 'unsafe-inline' *; font-src *; form-action 'none'; base-uri 'none'"
    : "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"
  const safeHTML = e.html
    .replace(/<meta\b[^>]*>/gi, "")
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/<link\b[^>]*>/gi, "")
  const body = safeHTML || `<pre style="white-space:pre-wrap;font:14px/1.5 -apple-system,sans-serif">${escapeHTML(e.plain)}</pre>`
  const header = `
<div style="font:13px/1.5 -apple-system,sans-serif;padding:12px 16px;margin:0 0 16px;background:#f4f5f7;color:#222;border-bottom:1px solid #ddd">
  <div style="font-size:16px;font-weight:600;margin-bottom:4px">${escapeHTML(e.subject)}</div>
  <div><b>From:</b> ${escapeHTML(e.from)}</div>
  <div><b>To:</b> ${escapeHTML(e.to)}</div>
  <div><b>Received:</b> ${escapeHTML(e.date || "")} UTC</div>
  ${config.remoteImages ? "" : '<div style="color:#888">Remote images and scripts are blocked for privacy.</div>'}
</div>`
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${escapeHTML(e.subject)}</title></head><body style="margin:0">${header}${body}</body></html>`
  const path = emailHTMLPath(email.id)
  writeText(path, doc)
  return path
}

// ─── Alfred output ──────────────────────────────────────────────────────────

const ICONS = {
  alias: "icons/alias.png",
  aliasOff: "icons/alias-off.png",
  burner: "icons/burner.png",
  inbox: "icons/inbox.png",
  mail: "icons/mail.png",
  new: "icons/new.png",
  code: "icons/code.png",
  link: "icons/link.png",
  edit: "icons/edit.png",
  web: "icons/web.png",
  trash: "icons/trash.png",
  warn: "icons/warn.png",
  refresh: "icons/refresh.png",
  back: "icons/back.png",
  info: "icons/info.png",
}

const icon = name => ({ path: ICONS[name] || "icon.png" })
const op = (name, params = {}) => JSON.stringify({ op: name, ...params })

function scriptFilter(items, extra = {}) {
  return JSON.stringify({ skipknowledge: true, ...extra, items })
}

function errorItems(error, retryQuery, keyword = config.kwAliases) {
  if (error.isAuth) {
    return [{
      title: config.token ? "ProxiedMail rejected your API token" : "Set up ProxiedMail",
      subtitle: "⏎ Enter your API token in the workflow configuration · ⌘⏎ Open ProxiedMail settings to copy it",
      arg: op("configure"),
      icon: icon("warn"),
      mods: { cmd: { arg: op("open", { url: `${config.host}/en/settings` }), subtitle: "Open proxiedmail.com/en/settings (API token is on that page)" } },
    }]
  }
  return [{
    title: error.status === 0 ? "Can't reach ProxiedMail" : `ProxiedMail error (${error.status})`,
    subtitle: `${error.message} · ⏎ Retry`,
    arg: op("nav", { query: retryQuery, keyword }),
    icon: icon("warn"),
  }]
}

// ─── Script Filter: aliases ─────────────────────────────────────────────────

function aliasItem(alias) {
  const a = alias.attributes
  const address = a.proxy_address
  const reals = realAddresses(alias)
  const enabled = forwardingEnabled(alias)
  const burner = isBurner(alias)
  const target = burner ? "no forwarding (burner)" : reals.map(r => r.address).join(", ") || "no forwarding"
  const parts = [
    `${enabled || burner ? "→" : "⏸"} ${target}${!enabled && !burner ? " (paused)" : ""}`,
    `${a.received_emails || 0} received`,
  ]
  if (a.description) parts.push(a.description)

  return {
    uid: alias.id,
    title: address,
    subtitle: parts.join(" · "),
    arg: op("copy", { text: address }),
    autocomplete: `${SEP}${address} `,
    icon: icon(burner ? "burner" : enabled ? "alias" : "aliasOff"),
    text: { copy: address, largetype: address },
    action: address,
    mods: {
      cmd: { arg: op("paste", { text: address }), subtitle: "Paste alias into the frontmost app" },
      alt: { arg: op("nav", { query: `${SEP}${address} `, keyword: config.kwInbox }), subtitle: `Open inbox (${a.received_emails || 0} received)` },
      ctrl: burner || !reals.length
        ? { valid: false, subtitle: burner ? "Burner aliases have no forwarding to pause" : "This alias has no forwarding address" }
        : { arg: op("toggle", { id: alias.id }), subtitle: enabled ? "Pause forwarding" : "Resume forwarding" },
      shift: { arg: op("nav", { query: `${SEP}${address} ` }), subtitle: "More actions (or press ⇥)" },
    },
  }
}

function modeAliases(query) {
  if (query.startsWith(SEP)) return modeAliasActions(query)

  let result
  try { result = loadAliases() } catch (error) { return scriptFilter(errorItems(error, query)) }

  const items = []
  if (result.stale) {
    items.push({ title: "Showing cached aliases", subtitle: `Couldn't refresh: ${result.error.message} · ⏎ Retry`, arg: op("refresh", { query }), icon: icon("warn") })
  }

  const aliases = result.data
    .slice()
    .sort((x, y) => parseDate(y.attributes.created_at) - parseDate(x.attributes.created_at))
    .filter(alias => {
      const a = alias.attributes
      return matches(query, a.proxy_address, a.description, Object.keys(a.real_addresses || {}).join(" "))
    })

  items.push(...aliases.map(aliasItem))

  if (query.trim()) {
    items.push({
      title: `Create new alias “${query.trim()}”`,
      subtitle: "Random address with this description, forwarding to your default address",
      arg: op("create", { kind: "random", description: query.trim() }),
      icon: icon("new"),
      mods: { cmd: { arg: op("create", { kind: "random", description: query.trim(), invert: true }), subtitle: config.afterCreate === "paste" ? "Create and copy instead of pasting" : "Create and paste into the frontmost app" } },
    })
  } else {
    const meta = result.meta || {}
    // usedProxyBindings also counts deleted aliases, so show the live count alongside the limit
    const count = `${result.data.length} alias${result.data.length === 1 ? "" : "es"}`
    const quota = meta.availableProxyBindings !== undefined ? `${count} · limit ${meta.availableProxyBindings}` : count
    items.push({
      title: `ProxiedMail · ${quota}`,
      subtitle: `${meta.isVerificationEmailSend ? "Verification email pending · " : ""}⏎ Refresh · ⌘⏎ Open dashboard · ⌥⏎ Configure workflow`,
      arg: op("refresh", { query: "" }),
      icon: icon("info"),
      valid: true,
      mods: {
        cmd: { arg: op("open", { url: `${config.host}/en/` }), subtitle: "Open the ProxiedMail dashboard" },
        alt: { arg: op("configure"), subtitle: "Open the workflow configuration" },
      },
    })
    if (result.data.length === 0) {
      items.unshift({ title: "No aliases yet", subtitle: `Type ${config.kwCreate} to create one`, valid: false, autocomplete: "", icon: icon("new") })
    }
  }

  return JSON.stringify({ items })
}

function modeAliasActions(query) {
  const match = query.match(new RegExp(`^${SEP}(\\S+)\\s*(${SEP}\\S+)?\\s*(.*)$`))
  const key = match ? match[1] : ""
  const sub = match && match[2] ? match[2].slice(1) : ""
  const text = match ? match[3].trim() : ""

  let result
  try { result = loadAliases() } catch (error) { return scriptFilter(errorItems(error, query)) }
  const alias = lookupAlias(result.data, key)
  if (!alias) {
    return scriptFilter([{ title: `Alias not found: ${key}`, subtitle: "⏎ Back to all aliases", valid: false, autocomplete: "", icon: icon("warn") }])
  }

  const a = alias.attributes
  const address = a.proxy_address
  const base = `${SEP}${address} `
  const back = { title: "Back to all aliases", subtitle: address, valid: false, autocomplete: "", icon: icon("back") }

  if (sub === "delete") {
    return scriptFilter([
      {
        title: `Delete ${address}?`,
        subtitle: "⏎ Permanently delete this alias. Mail sent to it will stop arriving. This can't be undone.",
        arg: op("delete", { id: alias.id, address }),
        icon: icon("trash"),
      },
      { title: "Cancel", subtitle: "Back to alias actions", valid: false, autocomplete: base, icon: icon("back") },
    ])
  }

  const reals = realAddresses(alias)
  const enabled = forwardingEnabled(alias)
  const burner = isBurner(alias)
  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)
  const looksLikeURL = /^https?:\/\/\S+$/i.test(text)
  const items = []

  items.push({
    title: `Copy ${address}`,
    subtitle: "⏎ Copy · ⌘⏎ Paste into frontmost app",
    arg: op("copy", { text: address }),
    icon: icon("alias"),
    mods: { cmd: { arg: op("paste", { text: address }), subtitle: "Paste into the frontmost app" } },
  })

  items.push({
    title: `Open inbox (${a.received_emails || 0} received)`,
    subtitle: a.is_browsable === false ? "Inbox browsing is off for this alias" : "Read received emails, copy codes and links",
    arg: op("nav", { query: base, keyword: config.kwInbox }),
    icon: icon("inbox"),
  })

  items.push({
    title: "Watch for verification codes",
    subtitle: `Show new emails and codes to this alias as they arrive (${config.kwCode})`,
    arg: op("nav", { query: base, keyword: config.kwCode }),
    icon: icon("code"),
  })

  if (!burner && reals.length) {
    items.push({
      title: enabled ? "Pause forwarding" : "Resume forwarding",
      subtitle: `${enabled ? "Stop" : "Start"} forwarding to ${reals.map(r => r.address).join(", ")}`,
      arg: op("toggle", { id: alias.id }),
      icon: icon(enabled ? "aliasOff" : "alias"),
    })
  }

  items.push(text && !looksLikeEmail && !looksLikeURL
    ? { title: `Set description: “${text}”`, subtitle: a.description ? `Currently: ${a.description}` : "Currently empty", arg: op("patch", { id: alias.id, changes: { description: text } }), icon: icon("edit") }
    : { title: "Edit description", subtitle: a.description ? `“${a.description}” · Type a new description after the address` : "Type a description after the address", valid: false, autocomplete: base + (a.description || ""), icon: icon("edit") })

  items.push(looksLikeEmail
    ? { title: `Forward to ${text}`, subtitle: "Replace the forwarding address. A new address may need to be verified by email.", arg: op("forward", { id: alias.id, address: text }), icon: icon("edit") }
    : { title: "Change forwarding address", subtitle: `Currently: ${burner ? "none (burner)" : reals.map(r => r.address).join(", ")} · Pick one below or type an email after the alias`, valid: false, autocomplete: base, icon: icon("edit") })

  if (!text) {
    for (const k of knownForwards(result.data).filter(k => !reals.some(r => r.address === k.address)).slice(0, 3)) {
      items.push({ title: `Forward to ${k.address}`, subtitle: k.count ? `Used by ${k.count} other alias${k.count === 1 ? "" : "es"}` : "Your account email", arg: op("forward", { id: alias.id, address: k.address }), icon: icon("alias") })
    }
  }

  if (looksLikeURL) {
    items.push({ title: `Set webhook URL: ${text}`, subtitle: "ProxiedMail will POST every received email to this URL", arg: op("patch", { id: alias.id, changes: { callback_url: text } }), icon: icon("link") })
  } else if (a.callback_url) {
    items.push({ title: "Remove webhook", subtitle: `Currently: ${a.callback_url}`, arg: op("patch", { id: alias.id, changes: { callback_url: "" } }), icon: icon("link") })
  } else {
    items.push({ title: "Set webhook URL", subtitle: "Type an https:// URL after the alias to POST received emails to it", valid: false, autocomplete: base + "https://", icon: icon("link") })
  }

  items.push({ title: "Open ProxiedMail dashboard", subtitle: `${config.host}/en/`, arg: op("open", { url: `${config.host}/en/` }), icon: icon("web") })
  items.push({ title: "Delete alias…", subtitle: "Asks for confirmation", valid: false, autocomplete: `${base}${SEP}delete`, icon: icon("trash") })
  items.push(back)

  return scriptFilter(text && !looksLikeEmail && !looksLikeURL ? items : items.filter(i => matches(text, i.title) || i === back))
}

// ─── Script Filter: create ──────────────────────────────────────────────────

function modeCreate(query) {
  if (query.startsWith(`${SEP}domain`)) return createDomainPicker(query.slice(SEP.length + 6).trim())
  if (query.startsWith(`${SEP}forward`)) return createForwardPicker(query.slice(SEP.length + 7).trim())

  let aliases = []
  try { aliases = loadAliases().data } catch (error) {
    if (error.isAuth) return scriptFilter(errorItems(error, query, config.kwCreate))
  }

  // "name@ description" or "name@domain.com description" requests a custom address
  let custom
  let description = query.trim()
  const m = description.match(/^([a-z0-9][a-z0-9._-]*)@([a-z0-9.-]+\.[a-z]{2,})?(?:\s+|$)(.*)$/i)
  if (m) {
    const fallback = chosenDomain() || ((loadDomains().find(d => !d.premium) || {}).domain) || "pxdmail.net"
    custom = `${m[1].toLowerCase()}@${(m[2] || fallback).toLowerCase()}`
    description = m[3].trim()
  }

  const forward = defaultForward(aliases)
  const fwdText = forward.length ? `→ ${forward.join(", ")}` : "→ (no forwarding address)"
  const descText = description ? ` · “${description}”` : ""
  const pasteMod = params => ({
    cmd: {
      arg: op("create", { ...params, invert: true }),
      subtitle: config.afterCreate === "paste" ? "Create and copy instead of pasting" : "Create and paste into the frontmost app",
    },
    alt: {
      arg: op("create", { ...params, watch: true }),
      subtitle: "Create, copy, and wait for the first email and its code",
    },
  })

  const items = []
  if (!forward.length) {
    items.push({
      title: "Choose a forwarding address",
      subtitle: "No forwarding address found yet · ⏎ Pick or type one (burners work without it)",
      valid: false,
      autocomplete: `${SEP}forward `,
      icon: icon("warn"),
    })
  }

  if (custom) {
    items.push({
      title: `Create ${custom}`,
      subtitle: `${fwdText}${descText}`,
      arg: op("create", { kind: "custom", address: custom, description }),
      icon: icon("new"),
      valid: forward.length > 0,
      mods: pasteMod({ kind: "custom", address: custom, description }),
    })
  }

  items.push({
    title: "Create random alias",
    subtitle: `${chosenDomain() ? "@" + chosenDomain() : "Random address"} ${fwdText}${descText}`,
    arg: op("create", { kind: "random", description }),
    icon: icon("new"),
    valid: forward.length > 0,
    mods: pasteMod({ kind: "random", description }),
  })

  items.push({
    title: "Create alias for current website",
    subtitle: `Uses the frontmost browser tab's domain as the description ${fwdText}`,
    arg: op("create", { kind: "site", description }),
    icon: icon("web"),
    valid: forward.length > 0,
    mods: pasteMod({ kind: "site", description }),
  })

  items.push({
    title: "Create burner inbox (no forwarding)",
    subtitle: `Mail is only readable with ${config.kwInbox}${descText}`,
    arg: op("create", { kind: "burner", description }),
    icon: icon("burner"),
    mods: pasteMod({ kind: "burner", description }),
  })

  items.push({
    title: `Alias domain: ${chosenDomain() || "chosen by ProxiedMail"}`,
    subtitle: "⏎ Change the domain for new aliases",
    valid: false,
    autocomplete: `${SEP}domain `,
    icon: icon("web"),
  })
  items.push({
    title: `Forwarding to: ${forward.length ? forward.join(", ") : "not set"}`,
    subtitle: `${loadPrefs().forward ? "Chosen by you" : "Automatic (your most used address)"} · ⏎ Change where new aliases forward`,
    valid: false,
    autocomplete: `${SEP}forward `,
    icon: icon("edit"),
  })

  if (!query.trim()) {
    items.push({
      title: "Tip: type a description, or name@ for a custom address",
      subtitle: `e.g. “${config.kwCreate} Netflix” or “${config.kwCreate} shop@ Amazon orders”`,
      valid: false,
      icon: icon("info"),
    })
  }

  return scriptFilter(items)
}

function createDomainPicker(text) {
  const current = chosenDomain()
  const domains = loadDomains()
  const items = [{
    title: "Let ProxiedMail choose",
    subtitle: `${current ? "" : "✓ Selected · "}Random address on your account's default domain`,
    arg: op("setPref", { key: "domain", value: "" }),
    icon: icon("new"),
  }]
  for (const d of domains) {
    items.push({
      title: d.domain,
      subtitle: `${d.domain === current ? "✓ Selected · " : ""}${d.custom ? "Your custom domain" : d.premium ? "Premium domain (needs a paid plan)" : "Free shared domain"}`,
      arg: op("setPref", { key: "domain", value: d.domain }),
      icon: icon("web"),
    })
  }
  const typed = text.toLowerCase().replace(/^@/, "")
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(typed) && !domains.some(d => d.domain === typed)) {
    items.push({ title: `Use ${typed}`, subtitle: "Not in your available domains; creating aliases may fail", arg: op("setPref", { key: "domain", value: typed }), icon: icon("web") })
  }
  if (!domains.length) items.push({ title: "Couldn't load your domains", subtitle: "Type a domain to use it anyway", valid: false, icon: icon("warn") })

  const filtered = items.filter(i => i.title.startsWith("Use ") || matches(text, i.title))
  filtered.push({ title: "Back", subtitle: "Return to alias creation", valid: false, autocomplete: "", icon: icon("back") })
  return scriptFilter(filtered)
}

function createForwardPicker(text) {
  let aliases = []
  try { aliases = loadAliases().data } catch {}
  const chosen = loadPrefs().forward
  const known = knownForwards(aliases)
  const items = [{
    title: `Automatic${known[0] ? ` (currently ${known[0].address})` : ""}`,
    subtitle: `${chosen ? "" : "✓ Selected · "}Use the address your aliases forward to most`,
    arg: op("setPref", { key: "forward", value: "" }),
    icon: icon("new"),
  }]
  for (const k of known) {
    const usage = k.count ? `Used by ${k.count} alias${k.count === 1 ? "" : "es"}` : "Your account email"
    items.push({
      title: k.address,
      subtitle: `${k.address === chosen ? "✓ Selected · " : ""}${usage}${k.account && k.count ? " · account email" : ""}`,
      arg: op("setPref", { key: "forward", value: k.address }),
      icon: icon("alias"),
    })
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) && !known.some(k => k.address === text.toLowerCase())) {
    items.push({ title: `Use ${text}`, subtitle: "New address: ProxiedMail emails it a verification link the first time", arg: op("setPref", { key: "forward", value: text }), icon: icon("edit") })
  } else if (!text) {
    items.push({ title: "Or type a new email address", subtitle: "It will need to be verified by ProxiedMail", valid: false, icon: icon("info") })
  }

  const filtered = items.filter(i => i.title.startsWith("Use ") || i.valid === false || matches(text, i.title))
  filtered.push({ title: "Back", subtitle: "Return to alias creation", valid: false, autocomplete: "", icon: icon("back") })
  return scriptFilter(filtered)
}

// ─── Script Filter: inbox ───────────────────────────────────────────────────

function modeInbox(query) {
  const match = query.match(new RegExp(`^${SEP}(\\S+)\\s*(?:${SEP}(\\S+))?\\s*(.*)$`))
  if (!match) return inboxPickAlias(query)

  let result
  try { result = loadAliases() } catch (error) { return scriptFilter(errorItems(error, query, config.kwInbox)) }
  const alias = lookupAlias(result.data, match[1])
  if (!alias) return scriptFilter([{ title: `Alias not found: ${match[1]}`, subtitle: "⏎ Back", valid: false, autocomplete: "", icon: icon("warn") }])
  if (match[2]) return inboxEmail(alias, match[2], match[3].trim())
  return inboxList(alias, match[3].trim())
}

function inboxPickAlias(query) {
  let result
  try { result = loadAliases() } catch (error) { return scriptFilter(errorItems(error, query, config.kwInbox)) }

  const items = result.data
    .slice()
    .sort((x, y) => parseDate(y.attributes.updated_at) - parseDate(x.attributes.updated_at) || (y.attributes.received_emails || 0) - (x.attributes.received_emails || 0))
    .filter(alias => matches(query, alias.attributes.proxy_address, alias.attributes.description))
    .map(alias => {
      const a = alias.attributes
      return {
        uid: `inbox-${alias.id}`,
        title: a.proxy_address,
        subtitle: `${a.received_emails || 0} received${a.description ? " · " + a.description : ""}${a.is_browsable === false ? " · inbox browsing off" : ""}`,
        valid: false,
        autocomplete: `${SEP}${a.proxy_address} `,
        icon: icon(isBurner(alias) ? "burner" : "inbox"),
        text: { copy: a.proxy_address, largetype: a.proxy_address },
      }
    })

  if (!items.length) items.push({ title: "No matching aliases", valid: false, icon: icon("info") })
  return JSON.stringify({ items })
}

function inboxList(alias, query) {
  const address = alias.attributes.proxy_address
  const base = `${SEP}${address} `
  let emails
  try { emails = loadInbox(alias.id, query === "!") } catch (error) {
    if (error.status === 403 && /browsable/i.test(error.message)) {
      return scriptFilter([
        {
          title: "Inbox browsing is off for this alias",
          subtitle: "⏎ Turn it on (emails received from now on will be listed here)",
          arg: op("patch", { id: alias.id, changes: { is_browsable: true }, then: { query: base, keyword: config.kwInbox } }),
          icon: icon("warn"),
        },
        { title: "Back", valid: false, autocomplete: "", icon: icon("back") },
      ])
    }
    return scriptFilter(errorItems(error, base, config.kwInbox))
  }

  const items = emails
    .filter(e => matches(query === "!" ? "" : query, e.attributes.subject, e.attributes.sender_email))
    .map(e => {
      const a = e.attributes
      const cached = fileExists(emailHTMLPath(e.id))
      return {
        uid: e.id,
        title: a.subject || "(no subject)",
        subtitle: `${a.sender_email} · ${relativeTime(a.created_at)}${a.attachmentsCounter ? ` · 📎${a.attachmentsCounter}` : ""}`,
        valid: false,
        autocomplete: `${base}${SEP}${e.id} `,
        icon: icon("mail"),
        quicklookurl: cached ? emailHTMLPath(e.id) : undefined,
        mods: {
          cmd: { valid: true, arg: op("openEmail", { id: e.id }), subtitle: "Open email in browser" },
          alt: { valid: true, arg: op("copyCode", { id: e.id }), subtitle: "Copy verification code" },
          ctrl: { valid: true, arg: op("copyText", { id: e.id }), subtitle: "Copy plain-text body" },
        },
      }
    })

  if (!items.length) {
    items.push({ title: query ? "No matching emails" : "No emails yet", subtitle: `Send something to ${address} · ⏎ Refresh`, valid: false, autocomplete: `${base}!`, icon: icon("info") })
  }
  items.push({ title: "Refresh inbox", subtitle: `${address} · last 55 emails`, valid: false, autocomplete: `${base}!`, icon: icon("refresh") })
  items.push({ title: "Back to all inboxes", valid: false, autocomplete: "", icon: icon("back") })

  return scriptFilter(items, { skipknowledge: true })
}

function inboxEmail(alias, emailId, query) {
  const address = alias.attributes.proxy_address
  if (query === `${SEP}delete`) {
    return scriptFilter([
      {
        title: "Delete this email?",
        subtitle: "⏎ Permanently delete it from ProxiedMail. This can't be undone.",
        arg: op("deleteEmail", { id: emailId, aliasId: alias.id, back: `${SEP}${address} ` }),
        icon: icon("trash"),
      },
      { title: "Cancel", subtitle: "Back to the email", valid: false, autocomplete: `${SEP}${address} ${SEP}${emailId} `, icon: icon("back") },
    ])
  }
  let email
  try { email = loadEmail(emailId) } catch (error) { return scriptFilter(errorItems(error, `${SEP}${address} ${SEP}${emailId} `, config.kwInbox)) }

  const e = emailParts(email)
  const htmlPath = writeEmailHTML(email)
  const codes = extractCodes(e.subject, e.plain)
  const links = extractLinks(e.html, e.plain)
  const items = []

  items.push({
    title: e.subject,
    subtitle: `${e.from} · ${relativeTime(e.date)} · ⏎ Open in browser · ⇧ Quick Look · ⌘⏎ Copy text`,
    arg: op("openFile", { path: htmlPath }),
    quicklookurl: htmlPath,
    icon: icon("mail"),
    text: { copy: e.plain, largetype: e.plain.slice(0, 1000) },
    mods: { cmd: { arg: op("copy", { text: e.plain, notify: "Email text copied" }), subtitle: "Copy plain-text body" } },
  })

  for (const code of codes) {
    items.push({
      title: `Copy code ${code}`,
      subtitle: "⏎ Copy · ⌘⏎ Paste into frontmost app",
      arg: op("copy", { text: code, notify: `Code ${code} copied` }),
      icon: icon("code"),
      mods: { cmd: { arg: op("paste", { text: code }), subtitle: "Paste code into the frontmost app" } },
    })
  }

  for (const [i, url] of e.attachments.entries()) {
    items.push({ title: `Attachment ${i + 1}`, subtitle: url, arg: op("open", { url }), icon: icon("link") })
  }

  for (const link of links.slice(0, 30)) {
    items.push({
      title: link.text || hostname(link.url) || link.url,
      subtitle: `${link.url} · ⏎ Open · ⌘⏎ Copy`,
      arg: op("open", { url: link.url }),
      icon: icon("link"),
      mods: { cmd: { arg: op("copy", { text: link.url, notify: "Link copied" }), subtitle: "Copy link" } },
      quicklookurl: link.url,
    })
  }

  items.push({ title: "Delete this email…", subtitle: "Asks for confirmation", valid: false, autocomplete: `${SEP}${address} ${SEP}${emailId} ${SEP}delete`, icon: icon("trash") })
  items.push({ title: "Back to inbox", subtitle: address, valid: false, autocomplete: `${SEP}${address} `, icon: icon("back") })
  return scriptFilter(query ? items.filter(i => matches(query, i.title, i.subtitle)) : items)
}

// ─── Script Filter: code (watch for verification codes) ─────────────────────

const WATCH_SECONDS = 180
const WATCH_WINDOW_MINUTES = 15
const RERUN_SECONDS = 3
const watchStatePath = () => `${config.cacheDir}/watch.json`

// Links that look like account verification or magic sign-in links
function verificationLinks(links) {
  return links.filter(l => {
    const text = `${l.url} ${l.text}`
    return /verif|confirm|activat|magic|sign[-_ ]?in|log[-_ ]?in|validate/i.test(text) && !/unsubscribe|privacy|terms|preferences/i.test(text)
  })
}

function codeResult(email, aliasAddress) {
  const e = emailParts(email)
  return {
    id: email.id,
    alias: aliasAddress,
    subject: e.subject,
    from: e.from.replace(/\s*<[^>]+>$/, "").replace(/^"|"$/g, "") || e.from,
    date: e.date,
    codes: extractCodes(e.subject, e.plain).slice(0, 2),
    link: (verificationLinks(extractLinks(e.html, e.plain))[0] || {}).url,
  }
}

function codeItems(r) {
  const meta = `${r.from} · ${relativeTime(r.date)} · to ${r.alias}`
  const openEmail = { arg: op("openEmail", { id: r.id }), subtitle: "Open the email" }
  if (r.codes.length) {
    return r.codes.map(code => ({
      title: code,
      subtitle: `${r.subject} · ${meta}`,
      arg: op("copy", { text: code, notify: `Code ${code} copied` }),
      icon: icon("code"),
      text: { copy: code, largetype: code },
      mods: { cmd: { arg: op("paste", { text: code }), subtitle: "Paste code into the frontmost app" }, alt: openEmail },
    }))
  }
  if (r.link) {
    return [{
      title: "Open verification link",
      subtitle: `${r.subject} · ${hostname(r.link) || r.link} · ${meta}`,
      arg: op("open", { url: r.link }),
      icon: icon("link"),
      mods: { cmd: { arg: op("copy", { text: r.link, notify: "Link copied" }), subtitle: "Copy link" }, alt: openEmail },
    }]
  }
  return [{ title: r.subject, subtitle: `No code found · ${meta} · ⏎ Open email`, arg: op("openEmail", { id: r.id }), icon: icon("mail") }]
}

// Alfred reruns this every few seconds while its window stays open.
// State lives in the cache so each run only fetches what changed.
function modeCode(query) {
  const match = query.match(new RegExp(`^${SEP}(\\S+)\\s*(.*)$`))
  const scopeKey = match ? match[1] : ""
  const filter = (match ? match[2] : query).trim()
  const now = Date.now()

  let state = readJSON(watchStatePath())
  // Alfred reruns RERUN_SECONDS after a run finishes, so allow for a slow run before calling it a new session
  if (!state || state.scope !== scopeKey || now - state.lastPoll > (RERUN_SECONDS + 5) * 1000) {
    state = { scope: scopeKey, started: now, counts: null, seen: {}, results: [] }
  }
  const remaining = Math.max(0, Math.round((state.started + WATCH_SECONDS * 1000 - now) / 1000))
  const watching = remaining > 0

  let aliases
  try { aliases = loadAliases(!scopeKey).data } catch (error) { return scriptFilter(errorItems(error, query, config.kwCode)) }

  let candidates
  let scoped
  if (scopeKey) {
    scoped = lookupAlias(aliases, scopeKey)
    if (!scoped) return scriptFilter([{ title: `Alias not found: ${scopeKey}`, valid: false, autocomplete: "", icon: icon("warn") }])
    const address = scoped.attributes.proxy_address
    if (scoped.attributes.is_browsable !== true) {
      return scriptFilter([{
        title: "Inbox browsing is off for this alias",
        subtitle: "⏎ Turn it on and start watching for emails",
        arg: op("patch", { id: scoped.id, changes: { is_browsable: true }, then: { query: `${SEP}${address} `, keyword: config.kwCode } }),
        icon: icon("warn"),
      }])
    }
    candidates = [scoped]
  } else {
    const browsable = aliases.filter(a => a.attributes.is_browsable === true)
    if (state.counts === null) {
      // First run: check the most recently active inboxes
      candidates = browsable
        .filter(a => (a.attributes.received_emails || 0) > 0)
        .sort((x, y) => parseDate(y.attributes.updated_at) - parseDate(x.attributes.updated_at))
        .slice(0, 5)
    } else {
      // Later runs: only inboxes whose received count went up
      candidates = browsable.filter(a => (a.attributes.received_emails || 0) > (state.counts[a.id] || 0))
    }
  }

  // Aliases whose new mail couldn't be fetched yet keep their old count, so they're retried next run
  const retry = new Set()
  if (watching) {
    const since = now - WATCH_WINDOW_MINUTES * 60 * 1000
    for (const alias of candidates) {
      let emails
      try { emails = loadInbox(alias.id, true) } catch { retry.add(alias.id); continue }
      let found = 0
      for (const link of emails) {
        if (state.seen[link.id] || parseDate(link.attributes.created_at) < since) continue
        if (link.attributes.is_processed === false) { retry.add(alias.id); continue }
        try {
          state.results.push(codeResult(loadEmail(link.id), alias.attributes.proxy_address))
          state.seen[link.id] = true
          found++
        } catch { retry.add(alias.id) }
      }
      // The count went up but the email isn't listed yet
      if (state.counts !== null && found === 0) retry.add(alias.id)
    }
  }
  const previous = state.counts || {}
  state.counts = Object.fromEntries(aliases.map(a => [a.id, retry.has(a.id) ? previous[a.id] || 0 : a.attributes.received_emails || 0]))
  state.lastPoll = Date.now()
  writeJSON(watchStatePath(), state)

  const items = state.results
    .slice()
    .sort((x, y) => parseDate(y.date) - parseDate(x.date))
    .flatMap(codeItems)
    .filter(i => matches(filter, i.title, i.subtitle))

  const address = scoped && scoped.attributes.proxy_address
  const clock = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`
  const status = watching
    ? {
        title: state.results.length ? "Still watching for new emails…" : address ? `Waiting for email to ${address}…` : "Waiting for verification codes…",
        subtitle: `Checking every ${RERUN_SECONDS}s · stops in ${clock}${address ? " · ⏎ Copy the address" : ` · emails from the last ${WATCH_WINDOW_MINUTES} min`}`,
        icon: icon("refresh"),
        ...(address ? { arg: op("copy", { text: address }) } : { valid: false }),
      }
    : { title: "Stopped watching", subtitle: "⏎ Watch again", arg: op("watchAgain", { scope: scopeKey }), icon: icon("refresh") }

  if (state.results.length) items.push(status)
  else items.unshift(status)

  if (!scopeKey) {
    const off = aliases.filter(a => a.attributes.is_browsable !== true).length
    if (!aliases.length) {
      items.push({ title: "You don't have any aliases yet", subtitle: `Create one with ${config.kwCreate}`, valid: false, icon: icon("info") })
    } else if (off === aliases.length) {
      items.push({
        title: "None of your aliases have inbox browsing on",
        subtitle: `Codes only appear for aliases with inbox browsing · turn it on in ${config.kwInbox}, or create a burner with ${config.kwCreate}`,
        valid: false,
        icon: icon("warn"),
      })
    } else if (off) {
      items.push({ title: `${off} alias${off === 1 ? "" : "es"} without inbox browsing aren't checked`, subtitle: `Turn it on per alias in ${config.kwInbox}`, valid: false, icon: icon("info") })
    }
  }

  return JSON.stringify({ skipknowledge: true, items, ...(watching ? { rerun: RERUN_SECONDS } : {}) })
}

// ─── Actions ────────────────────────────────────────────────────────────────

// Output routed by the workflow's Conditional on {var:out}: copy | copy_notify | paste | notify | none
function output(out, arg = "", notifyTitle = "", notifyText = "") {
  return JSON.stringify({ alfredworkflow: { arg, variables: { out, notif_title: notifyTitle, notif_text: notifyText } } })
}

function alfred() { return Application("com.runningwithcrayons.Alfred") }

function navigate(query, keyword = config.kwAliases) {
  if (config.fixtures) return writeText(`${config.fixtures}/nav.log`, `${keyword} ${query}`)
  alfred().search(`${keyword} ${query}`)
}

function openURL(url) {
  $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(url))
}

function frontmostBrowserURL() {
  const safari = ["com.apple.Safari", "com.apple.SafariTechnologyPreview", "com.kagi.kagimacOS"]
  const chromium = ["com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.canary", "com.brave.Browser", "com.microsoft.edgemac", "company.thebrowser.Browser", "com.vivaldi.Vivaldi", "com.operasoftware.Opera", "org.chromium.Chromium"]
  const workspace = $.NSWorkspace.sharedWorkspace
  const front = workspace.frontmostApplication.bundleIdentifier.js
  const running = workspace.runningApplications.js.map(app => app.bundleIdentifier.js)
  const candidates = [front, ...running].filter((b, i, all) => b && all.indexOf(b) === i && (safari.includes(b) || chromium.includes(b)))

  for (const bundle of candidates) {
    try {
      const app = Application(bundle)
      const url = safari.includes(bundle) ? app.documents[0].url() : app.windows[0].activeTab.url()
      if (url && /^https?:/.test(url)) return url
    } catch {}
  }
  return undefined
}

function patchBody(alias, changes) {
  const a = alias.attributes
  const real = {}
  for (const r of realAddresses(alias)) real[r.address] = r.enabled
  const attributes = {
    real_addresses: changes.real_addresses || real,
    proxy_address: a.proxy_address,
    description: changes.description !== undefined ? changes.description : a.description || "",
    callback_url: changes.callback_url !== undefined ? changes.callback_url : a.callback_url || "",
  }
  // The API resets is_browsable to false whenever a PATCH omits it, so always send it
  attributes.is_browsable = changes.is_browsable !== undefined ? changes.is_browsable : a.is_browsable === true
  return { data: { id: alias.id, type: "proxy_bindings", attributes } }
}

function getAliasFresh(id) {
  const alias = findAlias(loadAliases(true).data, id)
  if (!alias) throw new ApiError(404, "Alias not found")
  return alias
}

function actionCreate(params) {
  const aliases = loadAliases().data
  let description = params.description || ""
  let address
  let reals

  if (params.kind === "burner") {
    reals = [`${randomLocalPart(16)}@${INTERNAL_DOMAINS[0]}`]
  } else {
    reals = defaultForward(aliases)
    if (!reals.length) return output("notify", "", "No forwarding address", "Set a default forwarding address in the workflow configuration")
  }

  if (params.kind === "custom") {
    // The API returns the existing alias instead of an error when you already own the address
    const existing = findAlias(loadAliases(true).data, params.address)
    if (existing) return output("copy_notify", existing.attributes.proxy_address, "You already have this alias", `${existing.attributes.proxy_address} copied`)
    address = params.address
  }
  else if (chosenDomain()) address = `${randomLocalPart()}@${chosenDomain()}`

  if (params.kind === "site") {
    const url = params.url || frontmostBrowserURL()
    const host = url && hostname(url)
    if (!host) return output("notify", "", "No browser tab found", "Open the website in Safari or a Chromium browser (Chrome, Arc, Brave, Edge…)")
    description = description ? `${host} · ${description}` : host
  }

  // Without proxy_address the server generates one on the account's default domain
  const attributes = {
    real_addresses: reals,
    callback_url: "",
    description,
    is_browsable: params.kind === "burner" || params.watch ? true : config.browsable,
  }
  if (address) {
    attributes.proxy_address = address
    attributes.generateOnExists = params.kind !== "custom"
  }
  const response = api("POST", "proxy-bindings", { data: { type: "proxy_bindings", attributes } })
  invalidateAliases()

  const created = (response.data && response.data.attributes && response.data.attributes.proxy_address) || address

  if (params.watch) {
    removePath(watchStatePath())
    navigate(`${SEP}${created} `, config.kwCode)
    return output("copy", created)
  }

  const detail = params.kind === "burner" ? `Burner inbox · read it with ${config.kwInbox}` : `→ ${reals.join(", ")}`
  const verification = response.meta && response.meta.isVerificationEmailSend ? " · Check your email to verify the forwarding address" : ""
  // ⌘ (invert) does the opposite of the After Creating setting
  const paste = params.forcePaste || ((config.afterCreate === "paste") !== Boolean(params.invert))
  return output(paste ? "paste" : "copy_notify", created, `Created ${created}`, `${detail}${verification}`)
}

function actionToggle(id) {
  const alias = getAliasFresh(id)
  if (!realAddresses(alias).length) return output("notify", "", "No forwarding address", alias.attributes.proxy_address)
  const enable = !forwardingEnabled(alias)
  const real = {}
  for (const r of realAddresses(alias)) real[r.address] = enable
  api("PATCH", `proxy-bindings/${alias.id}`, patchBody(alias, { real_addresses: real }))
  invalidateAliases()
  return output("notify", "", enable ? "Forwarding resumed" : "Forwarding paused", alias.attributes.proxy_address)
}

function actionForward(id, address) {
  const alias = getAliasFresh(id)
  const response = api("PATCH", `proxy-bindings/${alias.id}`, patchBody(alias, { real_addresses: { [address]: true } }))
  invalidateAliases()
  const verify = response.meta && response.meta.isVerificationEmailSend ? " · Check that inbox for a verification email" : ""
  return output("notify", "", "Forwarding updated", `${alias.attributes.proxy_address} → ${address}${verify}`)
}

function actionPatch(id, changes, then) {
  const alias = getAliasFresh(id)
  api("PATCH", `proxy-bindings/${alias.id}`, patchBody(alias, changes))
  invalidateAliases()
  if (then) {
    removePath(inboxCachePath(alias.id))
    navigate(then.query, then.keyword)
    return output("none")
  }
  const what = changes.description !== undefined ? "Description updated"
    : changes.callback_url !== undefined ? (changes.callback_url ? "Webhook set" : "Webhook removed")
    : "Alias updated"
  return output("notify", "", what, alias.attributes.proxy_address)
}

function actionDelete(id, address) {
  api("DELETE", `proxy-bindings/${id}`)
  invalidateAliases()
  return output("notify", "", "Alias deleted", address)
}

function actionRun(json) {
  let params
  try { params = JSON.parse(json) } catch { return output("notify", "", "ProxiedMail", "Unknown action") }

  try {
    switch (params.op) {
      case "copy": return output(params.notify ? "copy_notify" : "copy", params.text, params.notify || "", params.text)
      case "paste": return output("paste", params.text)
      case "open": openURL(params.url); return output("none")
      case "openFile": $.NSWorkspace.sharedWorkspace.openURL($.NSURL.fileURLWithPath(params.path)); return output("none")
      case "nav": navigate(params.query || "", params.keyword); return output("none")
      case "configure": alfred().revealWorkflow(config.bundleId, { configuration: true }); return output("none")
      case "refresh":
        invalidateAliases()
        removePath(`${config.cacheDir}/inbox`)
        navigate(params.query || "")
        return output("none")
      case "create": return actionCreate(params)
      case "setPref":
        savePref(params.key, params.value)
        navigate("", config.kwCreate)
        return output("none")
      case "toggle": return actionToggle(params.id)
      case "forward": return actionForward(params.id, params.address)
      case "patch": return actionPatch(params.id, params.changes || {}, params.then)
      case "delete": return actionDelete(params.id, params.address)
      case "deleteEmail":
        api("DELETE", `received-emails/${params.id}`)
        removePath(inboxCachePath(params.aliasId))
        removePath(emailCachePath(params.id))
        removePath(emailHTMLPath(params.id))
        navigate(params.back, config.kwInbox)
        return output("notify", "", "Email deleted", "")
      case "watchAgain":
        removePath(watchStatePath())
        navigate(params.scope ? `${SEP}${params.scope} ` : "", config.kwCode)
        return output("none")
      case "openEmail": {
        const path = writeEmailHTML(loadEmail(params.id))
        $.NSWorkspace.sharedWorkspace.openURL($.NSURL.fileURLWithPath(path))
        return output("none")
      }
      case "copyText": {
        const e = emailParts(loadEmail(params.id))
        return output("copy_notify", e.plain, "Email text copied", e.subject)
      }
      case "copyCode": {
        const e = emailParts(loadEmail(params.id))
        const code = extractCodes(e.subject, e.plain)[0]
        return code
          ? output("copy_notify", code, `Code ${code} copied`, e.subject)
          : output("notify", "", "No code found", e.subject)
      }
      default: return output("notify", "", "ProxiedMail", `Unknown action: ${params.op}`)
    }
  } catch (error) {
    const message = error.isAuth ? "API token missing or invalid. Check the workflow configuration." : error.message
    return output("notify", "", "ProxiedMail error", message)
  }
}

// ─── Entry point ────────────────────────────────────────────────────────────

function run(argv) {
  const [mode, query = ""] = argv
  switch (mode) {
    case "aliases": return modeAliases(query.replace(/^\s+/, ""))
    case "create": return modeCreate(query)
    case "inbox": return modeInbox(query.replace(/^\s+/, ""))
    case "code": return modeCode(query.replace(/^\s+/, ""))
    case "run": return actionRun(query)
    // Universal Actions and hotkey
    case "find": navigate(query.trim()); return output("none")
    case "createForURL": return actionRun(JSON.stringify({ op: "create", kind: "site", url: query.trim() }))
    case "createForSite": return actionRun(JSON.stringify({ op: "create", kind: "site", forcePaste: true }))
    case "showCodes": navigate("", config.kwCode); return output("none")
    // Exposed for tests
    case "codes": return JSON.stringify(extractCodes(argv[1], argv[2]))
    default: return `Unknown mode: ${mode}`
  }
}

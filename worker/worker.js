// Cloudflare Worker: logs into TimeTree, counts days per name, returns JSON to the website,
// and lets people with the edit PIN merge names (saved to config.json in the GitHub repo).
//
// Secrets on the Worker:
//   TIMETREE_EMAIL, TIMETREE_PASSWORD  TimeTree login
//   GH_TOKEN   fine-grained GitHub token, this repo only, "Contents: Read and write"
//   EDIT_PIN   shared PIN/passphrase needed to merge or unmerge from the website
//
// Endpoints:
//   GET  /counts    counts (TimeTree pulled fresh if older than CACHE_HOURS)
//   POST /refresh   pull TimeTree fresh now (at most once per REFRESH_COOLDOWN_SECONDS)
//   POST /merge     {from, to, pin}  count "from" as "to"
//   POST /unmerge   {from, pin}      remove a merge

const OWNER = "jayo86";
const REPO = "echo-chamber-prevention";
const CONFIG_PATH = "config.json";
const ALLOWED_ORIGIN = "https://jayo86.github.io";
const CACHE_HOURS = 24;
const REFRESH_COOLDOWN_SECONDS = 60;

const API = "https://timetreeapp.com/api/v1";
const TT_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "X-Timetreea": "web/2.1.0/en",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
};

// Kept in memory while Cloudflare keeps this Worker warm. Best effort, not permanent.
let pulled = null; // { events, calendar, at }
let lastData = null;
let inflight = null;

// ---------- TimeTree ----------

async function login(email, password) {
  const r = await fetch(`${API}/auth/email/signin`, {
    method: "PUT",
    headers: TT_HEADERS,
    body: JSON.stringify({ uid: email.trim(), password, uuid: crypto.randomUUID().replace(/-/g, "") }),
  });
  if (r.status !== 200) {
    const text = await r.text().catch(() => "");
    let code = null;
    try { code = JSON.parse(text)?.error?.code; } catch {}
    if (code === -702) throw new Error("TimeTree login failed: wrong email or password");
    if (code === -495) throw new Error("TimeTree is rate limiting logins, try again later");
    throw new Error(`TimeTree login failed (${r.status}): ${text.replace(/\s+/g, " ").slice(0, 200) || "no details"}`);
  }
  const cookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get("set-cookie") || ""];
  for (const c of cookies) {
    const m = /(?:^|[;,]\s*)_session_id=([^;]+)/.exec(c);
    if (m) return m[1];
  }
  throw new Error("TimeTree login gave no session. They may have changed their API.");
}

async function tt(session, path) {
  const r = await fetch(`${API}${path}`, { headers: { ...TT_HEADERS, Cookie: `_session_id=${session}` } });
  if (!r.ok) throw new Error(`TimeTree said ${r.status} for ${path.split("?")[0]}`);
  return r.json();
}

async function pullTimeTree(env, calendarCode) {
  if (!env.TIMETREE_EMAIL || !env.TIMETREE_PASSWORD) throw new Error("TIMETREE_EMAIL / TIMETREE_PASSWORD secrets not set on the Worker");
  const session = await login(env.TIMETREE_EMAIL, env.TIMETREE_PASSWORD);
  const cals = (await tt(session, "/calendars?since=0")).calendars.filter(c => c.deactivated_at == null);
  const cal = cals.find(c => c.alias_code === calendarCode);
  if (!cal) throw new Error(`Calendar ${calendarCode} not found on this account`);
  const events = [];
  let since = null;
  for (let page = 0; ; page++) {
    if (page >= 40) throw new Error("Too many pages of events");
    const data = await tt(session, `/calendar/${cal.id}/events/sync${since !== null ? `?since=${since}` : ""}`);
    events.push(...data.events);
    if (!data.chunk) break;
    since = data.since;
  }
  return { events, calendar: cal.name, at: Date.now() };
}

// ---------- config.json in GitHub ----------

const b64decode = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, "")), c => c.charCodeAt(0)));
const b64encode = s => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

function gh(env, path, init = {}) {
  if (!env.GH_TOKEN) throw new Error("GH_TOKEN secret not set on the Worker");
  return fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "echo-chamber-worker",
      ...(init.headers || {}),
    },
  });
}

async function getConfig(env) {
  const r = await gh(env, `/contents/${CONFIG_PATH}?ref=main`);
  if (!r.ok) throw new Error(`Couldn't read config.json from GitHub (${r.status})`);
  const j = await r.json();
  const cfg = JSON.parse(b64decode(j.content));
  cfg.aliases ||= {};
  return { cfg, sha: j.sha };
}

async function saveConfig(env, cfg, sha, message) {
  const r = await gh(env, `/contents/${CONFIG_PATH}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: b64encode(JSON.stringify(cfg, null, 2) + "\n"), sha, branch: "main" }),
  });
  if (r.status === 409 || r.status === 422) return false; // someone else saved first
  if (!r.ok) throw new Error(`Couldn't save config.json to GitHub (${r.status})`);
  return true;
}

// ---------- Counting ----------

function cleanTitle(title) {
  let t = (title || "(no title)").replace(/[‘’]/g, "'");
  t = t.split(/\s+/).filter(Boolean).join(" ").replace(/\?+$/, "").trim();
  return t || "(no title)";
}

// Case-insensitive, apostrophes ignored, so Keirs == Keir's
const titleKey = t => cleanTitle(t).replace(/'/g, "").toLowerCase();

const fmtCache = {};
function localParts(ms, tz) {
  const f = (fmtCache[tz] ||= new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }));
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, midnight: p.hour === "00" && p.minute === "00" && p.second === "00" };
}

const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function eventDays(ev, defaultTz) {
  const start = localParts(ev.start_at, ev.start_timezone || defaultTz).date;
  const endP = localParts(ev.end_at, ev.end_timezone || defaultTz);
  let end = endP.date;
  // A timed event ending exactly at midnight doesn't really touch that day
  if (!ev.all_day && endP.midnight && end > start) end = addDays(end, -1);
  const days = [];
  for (let d = start; d <= end && days.length < 1000; d = addDays(d, 1)) days.push(d);
  return days;
}

// Follow merges, including chains (A -> B -> C), safely
function makeResolver(aliases) {
  const byKey = Object.fromEntries(Object.entries(aliases).map(([from, to]) => [titleKey(from), cleanTitle(to)]));
  return title => {
    const seen = new Set();
    let t = title;
    while (byKey[titleKey(t)] && !seen.has(titleKey(t)) && seen.size < 20) {
      seen.add(titleKey(t));
      t = byKey[titleKey(t)];
    }
    return t;
  };
}

function count(events, cfg, today) {
  const resolve = makeResolver(cfg.aliases || {});
  const people = new Map(); // key -> { past:Set, future:Set, titles:Map(resolved title -> n), spellings:Map(raw -> n) }

  for (const ev of events) {
    if (ev.deactivated_at || ev.deleted_at) continue;
    if (ev.type === 1 || ev.category === 2) continue; // birthdays and memos
    const raw = cleanTitle(ev.title);
    const title = resolve(raw);
    const key = titleKey(title);
    const p = people.get(key) || people.set(key, { past: new Set(), future: new Set(), titles: new Map(), spellings: new Map() }).get(key);
    p.titles.set(title, (p.titles.get(title) || 0) + 1);
    p.spellings.set(raw, (p.spellings.get(raw) || 0) + 1);
    for (const d of eventDays(ev, cfg.timezone)) {
      if (d < cfg.start_date) continue;
      (d <= today ? p.past : p.future).add(d);
    }
  }

  // Most-used spelling wins; on a tie prefer the one with an apostrophe
  const pick = m => [...m].sort((a, b) => b[1] - a[1] || b[0].includes("'") - a[0].includes("'"))[0][0];

  const rows = [];
  for (const [key, p] of people) {
    if (!p.past.size && !p.future.size) continue;
    const title = pick(p.titles);
    const merged = Object.keys(cfg.aliases || {}).filter(from => titleKey(resolve(from)) === key).sort();
    rows.push({
      title,
      days_to_date: p.past.size,
      days_booked_ahead: p.future.size,
      total: p.past.size + p.future.size,
      dates_to_date: [...p.past].sort(),
      dates_ahead: [...p.future].sort(),
      spellings: [...p.spellings].sort((a, b) => b[1] - a[1]).map(([s, n]) => ({ spelling: s, events: n })),
      merged,
    });
  }
  return rows.sort((a, b) => b.total - a.total || b.days_to_date - a.days_to_date || a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
}

// ---------- Putting it together ----------

async function build(env, { freshEvents }) {
  const { cfg } = await getConfig(env);
  if (freshEvents || !pulled) pulled = await pullTimeTree(env, cfg.calendar_code);
  const today = localParts(Date.now(), cfg.timezone).date;
  lastData = {
    generated: new Date(pulled.at).toISOString(),
    calendar: pulled.calendar,
    start_date: cfg.start_date,
    today,
    counts: count(pulled.events, cfg, today),
  };
  return lastData;
}

// One build at a time, even if several visitors arrive together
function buildShared(env, opts) {
  inflight ||= build(env, opts).finally(() => { inflight = null; });
  return inflight;
}

async function editAliases(env, change) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { cfg, sha } = await getConfig(env);
    const message = change(cfg);
    if (await saveConfig(env, cfg, sha, message)) return;
  }
  throw new Error("Couldn't save, someone else was editing at the same time. Try again.");
}

// ---------- HTTP ----------

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const path = new URL(req.url).pathname;

    try {
      if (path === "/counts" && req.method === "GET") {
        if (lastData && pulled && Date.now() - pulled.at < CACHE_HOURS * 3600e3) return json(lastData);
        return json(await buildShared(env, { freshEvents: true }));
      }

      if (req.method === "POST" && req.headers.get("Origin") !== ALLOWED_ORIGIN) return json({ error: "forbidden" }, 403);

      if (path === "/refresh" && req.method === "POST") {
        if (lastData && pulled && Date.now() - pulled.at < REFRESH_COOLDOWN_SECONDS * 1000) {
          return json({ ...lastData, note: "Already refreshed in the last minute." });
        }
        return json(await buildShared(env, { freshEvents: true }));
      }

      if ((path === "/merge" || path === "/unmerge") && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        if (!env.EDIT_PIN) return json({ error: "Editing is switched off (no EDIT_PIN set on the Worker)" }, 403);
        if (String(body.pin || "") !== env.EDIT_PIN) {
          await new Promise(r => setTimeout(r, 1000)); // slow down guessing
          return json({ error: "Wrong PIN" }, 403);
        }
        const from = cleanTitle(String(body.from || ""));
        if (!from || from === "(no title)") return json({ error: "Nothing to merge" }, 400);

        if (path === "/merge") {
          const to = cleanTitle(String(body.to || ""));
          if (!to || titleKey(to) === titleKey(from)) return json({ error: "Pick a different name to merge into" }, 400);
          await editAliases(env, cfg => {
            if (titleKey(makeResolver(cfg.aliases)(to)) === titleKey(from)) throw new Error(`"${to}" is already merged into "${from}"`);
            for (const k of Object.keys(cfg.aliases)) if (titleKey(k) === titleKey(from)) delete cfg.aliases[k];
            cfg.aliases[from] = to;
            return `Merge "${from}" into "${to}" (from the website)`;
          });
        } else {
          await editAliases(env, cfg => {
            const k = Object.keys(cfg.aliases).find(k => titleKey(k) === titleKey(from));
            if (!k) throw new Error(`"${from}" isn't merged into anything`);
            const was = cfg.aliases[k];
            delete cfg.aliases[k];
            return `Unmerge "${k}" from "${was}" (from the website)`;
          });
        }
        return json(await build(env, { freshEvents: false }));
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      const msg = String(e.message || e);
      // If TimeTree or GitHub hiccups on a read, show the last good data rather than nothing
      if (lastData && (path === "/counts" || path === "/refresh")) return json({ ...lastData, warning: msg });
      return json({ error: msg }, 502);
    }
  },
};

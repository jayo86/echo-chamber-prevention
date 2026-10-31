// Cloudflare Worker: logs into TimeTree, counts days per name, returns JSON to the website.
//
// Secrets on the Worker: TIMETREE_EMAIL, TIMETREE_PASSWORD
// Settings (calendar, start date, typo aliases) come from config.json in the GitHub repo,
// so they can change without redeploying this Worker.
//
// Endpoints:
//   GET  /counts    cached counts (pulled fresh if older than CACHE_HOURS)
//   POST /refresh   pull fresh now (at most once per REFRESH_COOLDOWN_SECONDS)

const CONFIG_URL = "https://raw.githubusercontent.com/jayo86/echo-chamber-prevention/main/config.json";
const ALLOWED_ORIGIN = "https://jayo86.github.io";
const CACHE_HOURS = 24;
const REFRESH_COOLDOWN_SECONDS = 60;

const API = "https://timetreeapp.com/api/v1";
const TT_HEADERS = { "Content-Type": "application/json", "X-Timetreea": "web/2.1.0/en" };

// Kept in memory while Cloudflare keeps this Worker warm. Best effort, not permanent.
let cached = null; // { data, at }
let inflight = null;

// ---------- TimeTree ----------

async function login(email, password) {
  const r = await fetch(`${API}/auth/email/signin`, {
    method: "PUT",
    headers: TT_HEADERS,
    body: JSON.stringify({ uid: email, password, uuid: crypto.randomUUID().replace(/-/g, "") }),
  });
  if (r.status !== 200) {
    let code = null;
    try { code = (await r.json())?.error?.code; } catch {}
    if (code === -702) throw new Error("TimeTree login failed: wrong email or password");
    if (code === -495) throw new Error("TimeTree is rate limiting logins, try again later");
    throw new Error(`TimeTree login failed (${r.status})`);
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

async function getEvents(session, calId) {
  const events = [];
  let since = null;
  for (let page = 0; page < 40; page++) {
    const data = await tt(session, `/calendar/${calId}/events/sync${since !== null ? `?since=${since}` : ""}`);
    events.push(...data.events);
    if (!data.chunk) return events;
    since = data.since;
  }
  throw new Error("Too many pages of events");
}

// ---------- Counting ----------

function cleanTitle(title) {
  let t = (title || "(no title)").replace(/[‘’]/g, "'");
  t = t.split(/\s+/).filter(Boolean).join(" ").replace(/\?+$/, "").trim();
  return t || "(no title)";
}

// Case-insensitive, apostrophes ignored, so Keirs == Keir's
const titleKey = t => t.replace(/'/g, "").toLowerCase();

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

function count(events, cfg, today) {
  const aliasKeys = Object.fromEntries(Object.entries(cfg.aliases || {}).map(([k, v]) => [titleKey(cleanTitle(k)), v]));
  const past = new Map(), future = new Map(), variants = new Map();
  const add = (m, k, d) => (m.get(k) || m.set(k, new Set()).get(k)).add(d);

  for (const ev of events) {
    if (ev.deactivated_at || ev.deleted_at) continue;
    if (ev.type === 1 || ev.category === 2) continue; // birthdays and memos
    let title = cleanTitle(ev.title);
    title = aliasKeys[titleKey(title)] || title;
    const key = titleKey(title);
    const v = variants.get(key) || variants.set(key, new Map()).get(key);
    v.set(title, (v.get(title) || 0) + 1);
    for (const d of eventDays(ev, cfg.timezone)) {
      if (d < cfg.start_date) continue;
      add(d <= today ? past : future, key, d);
    }
  }

  // Most-used spelling wins; on a tie prefer the one with an apostrophe
  const display = key => [...variants.get(key)].sort((a, b) => b[1] - a[1] || b[0].includes("'") - a[0].includes("'"))[0][0];

  const keys = new Set([...past.keys(), ...future.keys()]);
  return [...keys].map(k => {
    const p = past.get(k)?.size || 0, f = future.get(k)?.size || 0;
    return { title: display(k), days_to_date: p, days_booked_ahead: f, total: p + f };
  }).sort((a, b) => b.total - a.total || b.days_to_date - a.days_to_date || a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
}

async function pull(env) {
  if (!env.TIMETREE_EMAIL || !env.TIMETREE_PASSWORD) throw new Error("TIMETREE_EMAIL / TIMETREE_PASSWORD secrets not set on the Worker");
  const cfgRes = await fetch(CONFIG_URL + "?t=" + Date.now(), { cf: { cacheTtl: 0 } });
  if (!cfgRes.ok) throw new Error(`Couldn't load config.json (${cfgRes.status})`);
  const cfg = await cfgRes.json();

  const session = await login(env.TIMETREE_EMAIL, env.TIMETREE_PASSWORD);
  const cals = (await tt(session, "/calendars?since=0")).calendars.filter(c => c.deactivated_at == null);
  const cal = cals.find(c => c.alias_code === cfg.calendar_code);
  if (!cal) throw new Error(`Calendar ${cfg.calendar_code} not found on this account`);
  const events = await getEvents(session, cal.id);

  const today = localParts(Date.now(), cfg.timezone).date;
  return {
    generated: new Date().toISOString(),
    calendar: cal.name,
    start_date: cfg.start_date,
    today,
    counts: count(events, cfg, today),
  };
}

// One pull at a time, even if several visitors arrive together
function pullShared(env) {
  inflight ||= pull(env)
    .then(data => { cached = { data, at: Date.now() }; return data; })
    .finally(() => { inflight = null; });
  return inflight;
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
        if (cached && Date.now() - cached.at < CACHE_HOURS * 3600e3) return json(cached.data);
        return json(await pullShared(env));
      }

      if (path === "/refresh" && req.method === "POST") {
        if (req.headers.get("Origin") !== ALLOWED_ORIGIN) return json({ error: "forbidden" }, 403);
        if (cached && Date.now() - cached.at < REFRESH_COOLDOWN_SECONDS * 1000) {
          return json({ ...cached.data, note: "Already refreshed in the last minute." });
        }
        return json(await pullShared(env));
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      const msg = String(e.message || e);
      // If TimeTree hiccups, show the last good data rather than nothing
      if (cached) return json({ ...cached.data, warning: msg });
      return json({ error: msg }, 502);
    }
  },
};

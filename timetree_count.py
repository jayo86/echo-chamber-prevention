"""
timetree_count.py
Logs into TimeTree (unofficial internal API), pulls every event from one
calendar, and counts how many days each event title has been marked.

Usage:
    python timetree_count.py            # print counts, write counts.json
    python timetree_count.py --dump     # also save raw events to events_raw.json

Creds and settings live in timetree.ini next to this script.
Requires: pip install requests tzdata
"""

import argparse
import configparser
import json
import os
import sys
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

API = "https://timetreeapp.com/api/v1"
HEADERS = {"Content-Type": "application/json", "X-Timetreea": "web/2.1.0/en"}
HERE = Path(__file__).resolve().parent


def load_config():
    """Environment variables win (GitHub Actions); timetree.ini is the local fallback."""
    c = {}
    cfg_path = HERE / "timetree.ini"
    if cfg_path.exists():
        cfg = configparser.ConfigParser()
        cfg.read(cfg_path, encoding="utf-8")
        c = dict(cfg["timetree"])

    def get(key, default=None):
        return os.environ.get(f"TIMETREE_{key.upper()}") or c.get(key) or default

    conf = {
        "email": get("email"),
        "password": get("password"),
        "calendar_code": get("calendar_code", "nbkqQWhJ3fJa"),
        "start_date": date.fromisoformat(get("start_date", "2026-08-03")),
        "timezone": get("timezone", "Australia/Brisbane"),
    }
    if not conf["email"] or not conf["password"]:
        sys.exit("No creds found. Set TIMETREE_EMAIL / TIMETREE_PASSWORD or create timetree.ini.")
    return conf


def login(session, email, password):
    r = session.put(
        f"{API}/auth/email/signin",
        json={"uid": email, "password": password, "uuid": uuid.uuid4().hex},
        headers=HEADERS,
        timeout=15,
    )
    if r.status_code != 200:
        code = None
        try:
            code = r.json().get("error", {}).get("code")
        except ValueError:
            pass
        if code == -702:
            sys.exit("Login failed: wrong email or password.")
        if code == -495:
            sys.exit("Login failed: rate limited by TimeTree, try again later.")
        sys.exit(f"Login failed ({r.status_code}): {r.text[:300]}")
    if "_session_id" not in session.cookies:
        sys.exit("Login returned 200 but no session cookie. TimeTree may have changed their API.")


def find_calendar(session, code):
    r = session.get(f"{API}/calendars?since=0", headers=HEADERS, timeout=15)
    r.raise_for_status()
    cals = [c for c in r.json()["calendars"] if c.get("deactivated_at") is None]
    for c in cals:
        if c.get("alias_code") == code:
            return c
    names = ", ".join(f"{c.get('name') or 'Unnamed'} ({c.get('alias_code')})" for c in cals)
    sys.exit(f"Calendar code {code} not found. Your calendars: {names}")


def get_labels(session, cal_id):
    r = session.get(f"{API}/calendar/{cal_id}/labels", headers=HEADERS, timeout=15)
    if r.status_code != 200:
        return {}
    return {l["id"]: l.get("name", "") for l in r.json().get("calendar_labels", [])}


def get_events(session, cal_id):
    events, since = [], None
    while True:
        url = f"{API}/calendar/{cal_id}/events/sync"
        if since is not None:
            url += f"?since={since}"
        r = session.get(url, headers=HEADERS, timeout=30)
        r.raise_for_status()
        data = r.json()
        events.extend(data["events"])
        if not data.get("chunk"):
            return events
        since = data["since"]


def clean_title(title):
    # Normalise curly quotes and spacing so "Keir’s" and "Keir's" count together
    t = (title or "(no title)").replace("’", "'").replace("‘", "'")
    return " ".join(t.split())


def event_days(ev, default_tz):
    """Return the set of local calendar dates an event covers."""
    tz = ZoneInfo(ev.get("start_timezone") or default_tz)
    start = datetime.fromtimestamp(ev["start_at"] / 1000, tz).date()
    end_tz = ZoneInfo(ev.get("end_timezone") or default_tz)
    end_dt = datetime.fromtimestamp(ev["end_at"] / 1000, end_tz)
    end = end_dt.date()
    # Timed event ending exactly at midnight doesn't really touch that day
    if not ev.get("all_day") and end_dt.time() == datetime.min.time() and end > start:
        end -= timedelta(days=1)
    # all-day end_at is inclusive in TimeTree
    return {start + timedelta(days=i) for i in range((end - start).days + 1)}


def count(events, labels, start_date, today, default_tz):
    past = defaultdict(set)    # title -> dates up to and including today
    future = defaultdict(set)  # title -> dates after today
    title_label = {}
    skipped = {"birthday/memo": 0, "deleted": 0, "recurring": []}

    for ev in events:
        if ev.get("deactivated_at") or ev.get("deleted_at"):
            skipped["deleted"] += 1
            continue
        if ev.get("type") == 1 or ev.get("category") == 2:
            skipped["birthday/memo"] += 1
            continue
        title = clean_title(ev.get("title"))
        if ev.get("recurrences"):
            skipped["recurring"].append(title)  # only first occurrence counted
        title_label.setdefault(title, labels.get(ev.get("label_id"), ""))
        for d in event_days(ev, default_tz):
            if d < start_date:
                continue
            (past if d <= today else future)[title].add(d)

    titles = set(past) | set(future)
    rows = sorted(
        (
            {
                "title": t,
                "label": title_label.get(t, ""),
                "days_to_date": len(past[t]),
                "days_booked_ahead": len(future[t]),
                "total": len(past[t]) + len(future[t]),
            }
            for t in titles
        ),
        key=lambda r: (-r["total"], -r["days_to_date"], r["title"].lower()),
    )
    return rows, skipped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", action="store_true", help="save raw events to events_raw.json")
    args = ap.parse_args()

    cfg = load_config()
    today = datetime.now(ZoneInfo(cfg["timezone"])).date()

    s = requests.Session()
    login(s, cfg["email"], cfg["password"])
    cal = find_calendar(s, cfg["calendar_code"])
    labels = get_labels(s, cal["id"])
    events = get_events(s, cal["id"])

    if args.dump:
        (HERE / "events_raw.json").write_text(
            json.dumps(events, indent=2, ensure_ascii=False), encoding="utf-8"
        )

    rows, skipped = count(events, labels, cfg["start_date"], today, cfg["timezone"])

    print(f"\nCalendar: {cal.get('name') or 'Unnamed'}  |  {len(events)} events fetched")
    print(f"Counting from {cfg['start_date']} | today is {today}\n")
    w = max([len(r["title"]) for r in rows] + [5])
    print(f"{'Title':<{w}}  {'To date':>7}  {'Ahead':>5}  {'Total':>5}")
    print("-" * (w + 24))
    for r in rows:
        print(f"{r['title']:<{w}}  {r['days_to_date']:>7}  {r['days_booked_ahead']:>5}  {r['total']:>5}")

    if skipped["recurring"]:
        print(f"\nNote: recurring events only counted once: {', '.join(sorted(set(skipped['recurring'])))}")

    out = {
        "generated": datetime.now(ZoneInfo(cfg["timezone"])).isoformat(timespec="seconds"),
        "calendar": cal.get("name"),
        "start_date": cfg["start_date"].isoformat(),
        "today": today.isoformat(),
        "counts": rows,
    }
    (HERE / "counts.json").write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nWrote {HERE / 'counts.json'}")


if __name__ == "__main__":
    main()

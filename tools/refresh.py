#!/usr/bin/env python3
"""Refresh one card's offers from its issuer CSV (CLAUDE.md, "Refreshing a card").

    python3 tools/refresh.py report --card "Capital One" FILE.csv [MORE.csv] [--read-date YYYY-MM-DD]
                                    [--template decisions.json] [--json report.json]
    python3 tools/refresh.py apply  --card "Capital One" FILE.csv [MORE.csv] [--read-date YYYY-MM-DD]
                                    --decisions decisions.json [--part]

report reads the CSV(s) and site/data/offers.json with the pending phone edits on top (with_pending()) and
changes nothing. apply makes the same plan, refuses while anything needs a decision, then writes offers.json
(and moves cuisine entries for renames that add no alias), runs tools/cuisines.py sync and tools/validate.py,
and puts both files back if either fails.

Multi-part batches: --part saves a part without marking anything missing, without the size check and without a
batches entry; at "batch complete" run apply --complete-parts on the last part (offers already read on that date
count as in the batch), or plain apply on every part at once.

The tool encodes the mechanical rules. Judgment stays with the session, through the decisions file:
  {"card": ..., "read_date": ...,                       must equal the card and read date of the run
   "pairs": [{"saved": "<offer id>", "file": "<file merchant>", "bonus": "<file bonus>", "accept": true}],
   "categories": {"<new merchant>": "<category>" or {"category": "...", "unsure": true}},
   "clashes": {"<merchant>": "<category>"},             set on every offer with that name, on every card
   "new_names": {"<file merchant>": {"merchant": "...", "aliases": [...]}},  a new offer saved under another name
   "owner_approved": ["size_check", "missing", "new_share", "card_check", "parts"]}   only after the owner said go ahead
report --template writes one with every open question set to null. A pair the tool did not propose can be added.

Never stored: card or account numbers. Columns such as card / card_name / card_last4 are read only by the card
check (the file's own card column decides which card it is; the file name never does), and apply refuses if any
value it would write contains the digits of such a column (or a 4-digit group of the file name that is not a date).
Never touched: site/data/phone-edits.json (not written, never folded), any field a pending phone edit sets,
and cleanup of offers with a pending edit.
"""
import argparse, copy, csv, difflib, html, json, re, subprocess, sys, unicodedata
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "site/data"
OFFERS, CUISINES = DATA / "offers.json", DATA / "cuisines.json"
sys.path.insert(0, str(ROOT / "tools"))
from fold_phone_edits import load_pending, with_pending  # noqa: E402

DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
FIELDS = ["id", "card", "merchant", "category", "bonus", "expires", "expires_text", "activation", "channel",
          "spend_cap", "minimum_spend", "fine_print", "other_details", "last_read", "first_seen", "status",
          "status_since"]
SIZE_MIN = 0.70          # size check: batch under 70% of the prior active count
MISSING_MAX = (5, 0.05)  # stop when more would go missing than the larger of 5 or 5% of the prior active count
NEW_MAX = 0.25           # stop when new offers are more than 25% of the batch
LAST_WARN = 0.40         # warn (never stop) when the batch is under 40% of the card's last full read: after a mass
                         # expiry a short export is only warned about, since ended offers are hidden either way and a
                         # re-read brings renewed ones back
CLEANUP_DAYS = 30
CATEGORY_EXCEPTIONS = {"alibaba"}  # Alibaba (marketplace) / Ali Baba (restaurant): two businesses (validate.py)
DOMAIN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.-]*\.(com|us|co|io|ai|org)$", re.I)


class Refused(Exception):
    pass


SECRETS = set()  # digit groups of the run's card/account columns: hidden in everything printed or saved


def mask(text):
    for d in sorted(SECRETS, key=len, reverse=True):
        text = re.sub(r"(?<!\d)" + re.escape(d) + r"(?!\d)", "*" * len(d), text)
    return text


# ---------- text helpers ----------

def deaccent(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if not unicodedata.combining(c))


def compact(s):
    """The page's search normalisation: no accents, lowercase, letters and digits only."""
    return re.sub(r"[^a-z0-9]", "", deaccent(s or "").lower())


def nkey(s):
    """Name key for matching a file row to a saved offer: compact(), with '&' read as 'and'."""
    return compact(re.sub(r"\s*&\s*", " and ", s or ""))


def words(s):
    return re.findall(r"[a-z0-9]+", deaccent(s or "").lower().replace("'", "").replace("’", ""))


def slug(s):
    """How offer ids are made from merchant names: 'Gaby's Cafe' -> 'gaby-s-cafe' (as tools/cuisines.py)."""
    return re.sub(r"[^a-z0-9]+", "-", deaccent(s).lower()).strip("-")


def bonus_key(b):
    """Bonus compared ignoring case, spacing, punctuation and the word 'cash'; % and $ kept (7% back != $7 back)."""
    if b is None:
        return None
    s = deaccent(b).lower()
    s = re.sub(r"\bcash\s*back\b", "back", s)
    s = re.sub(r"(\d)\.0+\b", r"\1", s)
    s = re.sub(r"[^a-z0-9%$.]", "", s)
    return re.sub(r"(?<!\d)\.|\.(?!\d)", "", s)


def truncated(name):
    return name.endswith("…") or name.endswith("...")


def stem(name):
    return re.sub(r"(…|\.\.\.)$", "", name)


def bare_domain(name):
    """Only a lowercase web address ('loop-mobile.com', 'stix.golf')."""
    return bool(re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}", name))


def domain_base(name):
    return re.sub(r"\.(com|us|co|io|ai|org)$", "", name.strip(), flags=re.I)


def page_text(s):
    """Issuer HTML as text: entities decoded, tags stripped, spacing tidied."""
    s = html.unescape(s or "")
    s = re.sub(r"<br\s*/?>", " ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    return re.sub(r"\s+", " ", s).strip()


def plus_days(d, n):
    return (date.fromisoformat(d) + timedelta(days=n)).isoformat()


def real_date(s):
    if not (isinstance(s, str) and DATE.match(s)):
        return False
    try:
        date.fromisoformat(s)
        return True
    except ValueError:
        return False


def eastern_date(ts):
    """'2026-11-01T03:59:59Z' -> '2026-10-31' (the date in US Eastern time)."""
    dt = datetime.fromisoformat(ts.strip().replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError(f"timestamp {ts!r} has no time zone")
    try:
        from zoneinfo import ZoneInfo
        return dt.astimezone(ZoneInfo("America/New_York")).date().isoformat()
    except Exception:  # no tz database: US rule, DST from the 2nd Sunday of March to the 1st Sunday of November
        u = dt.astimezone(timezone.utc)
        def sunday(y, m, n):
            d = date(y, m, 1)
            return d + timedelta(days=(6 - d.weekday()) % 7 + 7 * (n - 1))
        start = datetime.combine(sunday(u.year, 3, 2), datetime.min.time(), timezone.utc) + timedelta(hours=7)
        end = datetime.combine(sunday(u.year, 11, 1), datetime.min.time(), timezone.utc) + timedelta(hours=6)
        return (u - timedelta(hours=4 if start <= u < end else 5)).date().isoformat()


def end_date(ts, where):
    """eastern_date() for a file value, refused with its place when it is not a timestamp."""
    try:
        return eastern_date(ts)
    except ValueError as e:
        raise Refused(f"end timestamp {ts!r} ({where}) is not a UTC timestamp like 2026-11-01T03:59:59Z: {e}")


def blank(v):
    return v is None or str(v).strip() == ""


def number_or_none(v, none_values=("0",)):
    """A bare minimum-spend number as given; blank or a 'none' placeholder -> None."""
    if blank(v):
        return None
    v = str(v).strip()
    try:
        if any(float(v) == float(n) for n in none_values):
            return None
    except ValueError:
        pass
    return v


# ---------- one incoming offer (one or more CSV rows) ----------

class Inc:
    def __init__(self, merchant, bonus, lines):
        self.merchant = re.sub(r"\s+", " ", merchant).strip()
        self.bonus = bonus.strip() if isinstance(bonus, str) and bonus.strip() else None  # None: keep saved
        self.lines = lines        # CSV line numbers
        self.set = {}             # fields written on every matched / new offer
        self.fill = {}            # fields written only where the saved value is empty
        self.new = {}             # defaults for a new offer (channel / activation the file does not show)
        self.add_notes = []       # added when absent
        self.drop_notes = []      # removed when present
        self.replace = []         # [(regex, note or None)]: notes matching regex replaced by the note
        self.promo_notes = []     # added only when the offer has no 'Promo text reads' note yet
        self.new_aliases = []     # aliases this row brings (a Citi domain name matched to the app's name)
        self.tld = None           # Capital One merchant_tld
        self.flags = []           # report lines about this row

    @property
    def channel(self):
        return self.set.get("channel")

    def label(self):
        return f"{self.merchant} | {self.bonus or '(no bonus shown)'}"


# ---------- issuer adapters ----------

CARD_COLUMNS = re.compile(r"(card|account|acct|last_?4|last_?four|pan)", re.I)


class Adapter:
    card = slugp = None
    required = set()
    used = set()             # columns read; every other column is ignored
    # Columns that hold the owner's card details: never stored, digits guarded. `card` (the app nickname a Chrome
    # read adds from the card picked on the page) and `card_name` are read only by the card check.
    card_columns = {"card", "card_name", "card_last4"}
    snapshot = True          # every batch is a complete snapshot of the card
    pair_note_drop = ()      # notes dropped when a truncated name is paired with its full name

    def check_columns(self, cols):
        missing = self.required - set(cols)
        if missing:
            raise Refused(f"this file is not a {self.card} CSV in the format the tool knows: missing columns {sorted(missing)}")
        ignored = [c for c in cols if c not in self.used]
        return ignored, [c for c in cols if c in self.card_columns]

    def guarded(self, cols, rows):
        """Columns holding the owner's card details: the known ones, plus any ignored column named like a card or
        account column whose values carry a 4-digit group or a long number (card_aria_label text is not one)."""
        out = [c for c in cols if c in self.card_columns]
        for c in cols:
            if c not in out and c not in self.used and CARD_COLUMNS.search(c) and any(
                    re.fullmatch(r"\D{0,12}\d{4}", (r.get(c) or "").strip()) or re.search(r"\d{12,19}", r.get(c) or "")
                    for _, r in rows):
                out.append(c)
        return out

    def check_rows(self, rows):
        pass

    def parse(self, rows, read_date, app):
        raise NotImplementedError

    def pair_name(self, saved, inc, rule):
        """(merchant, alias to add or None, notes to drop) for a saved offer paired with a file row."""
        if truncated(inc.merchant) and not truncated(saved["merchant"]):
            return saved["merchant"], None, ()  # the file's name is cut off: the full saved name stays
        if nkey(saved["merchant"]) == nkey(inc.merchant):
            return saved["merchant"], None, ()
        if rule == "truncated":
            if truncated(inc.merchant):  # both cut off: the longer one, still cut off, so the note stays
                longer = max((inc.merchant, saved["merchant"]), key=lambda n: len(nkey(stem(n))))
                return longer, None, ()
            return inc.merchant, None, self.pair_note_drop
        if bare_domain(inc.merchant):
            return saved["merchant"], None, ()
        return inc.merchant, saved["merchant"], ()


def chase_channel(v):
    m = {"ONLINE": "online", "INSTORE": "in_store", "SINGLE_LOCATION": "in_store", "PUMP": "pay_at_pump"}
    v = (v or "").strip().upper()
    if v in ("", "NONE"):
        return None  # no location restriction: never overwrites the saved channel
    if v not in m:
        raise Refused(f"unknown Chase channel {v!r}: add it to chase_channel() in tools/refresh.py")
    return m[v]


class Chase(Adapter):
    """Chase method B: a complete live-page CSV per card (Freedom Flex and Freedom never combined)."""
    pair_note_drop = ("Name truncated on screen",)
    FORMATS = {
        "flex": {"bonus": "bonus", "end": "offer_end_timestamp", "new": lambda v: v.strip() == "New"},
        "freedom": {"bonus": "bonus_as_shown", "end": "end_timestamp", "new": lambda v: v.strip().lower() == "yes"},
    }

    def __init__(self, card, slugp, file_card_name):
        self.card, self.slugp, self.file_card_name = card, slugp, file_card_name
        self.required = {"merchant", "channel", "expiration_text", "min_spend", "reward_description", "new_badge"}

    def check_columns(self, cols):
        self.fmt = self.FORMATS["flex" if "offer_end_timestamp" in cols else "freedom"]
        self.required = self.required | {self.fmt["bonus"], self.fmt["end"]}
        self.used = self.required | {"offer_id"}
        return super().check_columns(cols)

    def parse(self, rows, read_date, app):
        f = self.fmt
        out = []
        for line, r in rows:
            inc = Inc(r["merchant"], r[f["bonus"]], [line])
            if not blank(r[f["end"]]):
                inc.set["expires"] = end_date(r[f["end"]], f"line {line}")
            t = (r.get("expiration_text") or "").strip()
            if t and nkey(inc.merchant) == "chasetravel":
                inc.flags.append("Chase Travel: expiration_text is a travel-timing sentence, date only")
                t = ""
            elif t and not re.search(r"(?i)expir", t):
                inc.flags.append(f"expiration_text {t!r} does not read like expiry wording: kept as shown, check it")
            inc.set["expires_text"] = re.sub(r"\.$", "", t) or None
            ch = chase_channel(r["channel"])
            if ch:
                inc.set["channel"] = ch
            inc.set["minimum_spend"] = number_or_none(r["min_spend"])
            inc.set["spend_cap"] = None  # reward_cap caps the cash back, already in the reward text
            if page_text(r["reward_description"]):
                inc.fill["fine_print"] = page_text(r["reward_description"])
            # added_state / tile buttons say nothing about activation: the saved value is never changed.
            inc.new.update(channel="none_shown", activation="needs_activation")
            if f["new"](r["new_badge"] or ""):
                inc.add_notes.append("Tagged New")
            else:
                inc.drop_notes.append("Tagged New")
            out.append(inc)
        return out

    def pair_name(self, saved, inc, rule):
        if rule == "extends" and len(compact(inc.merchant)) > len(compact(saved["merchant"])):
            return saved["merchant"], None, ()  # a long banner name in the file keeps the app's plain name
        return super().pair_name(saved, inc, rule)


class USBank(Adapter):
    card, slugp = "U.S. Bank", "us-bank"
    required = {"merchant", "bonus_as_shown", "min_spend", "channel", "activation_state", "activation_model",
                "promo_text", "reward_copy", "end_date", "days_left_badge"}
    used = required | {"deal_id"}
    CHANNEL = {"online|in store": "in_store_and_online", "in store|online": "in_store_and_online",
               "online": "online", "in store": "in_store", "pay at pump": "pay_at_pump"}
    LOCATION = "Offer only applies to the following location:"

    def parse(self, rows, read_date, app):
        out = []
        for line, r in rows:
            inc = Inc(r["merchant"], r["bonus_as_shown"], [line])
            if not blank(r["end_date"]):
                inc.set["expires"] = end_date(r["end_date"], f"line {line}")
            inc.set["expires_text"] = r["days_left_badge"].strip() or None
            ch = r["channel"].strip().lower()
            if ch and ch not in self.CHANNEL:
                raise Refused(f"unknown U.S. Bank channel {r['channel']!r} (line {line})")
            inc.set["channel"] = self.CHANNEL[ch] if ch else "none_shown"  # blank -> none_shown
            model, state = r["activation_model"].strip().upper(), r["activation_state"].strip().upper()
            if model == "AUTO_ACTIVATED":
                inc.set["activation"] = "auto_enrolled"
            elif state in ("ACTIVATED", "SERVED"):
                inc.set["activation"] = "already_activated" if state == "ACTIVATED" else "needs_activation"
            else:
                raise Refused(f"unknown U.S. Bank activation {state!r} / {model!r} (line {line})")
            inc.set["minimum_spend"] = number_or_none(r["min_spend"], ("0", "0.2"))
            inc.set["spend_cap"] = None  # max_reward_amount caps the cash back, already in the reward text
            if page_text(r["reward_copy"]):
                inc.fill["fine_print"] = page_text(r["reward_copy"])
            promo = r["promo_text"] or ""
            if promo.strip().startswith(self.LOCATION):
                parts = [page_text(p) for p in re.split(r"<br\s*/?>", promo[promo.index(":") + 1:], flags=re.I)]
                addr = ", ".join(p for p in parts if p)
                if addr:
                    inc.replace.append((r"^" + re.escape(self.LOCATION), f"{self.LOCATION} {addr}"))
            out.append(inc)
        return out
    # Paired truncated names take the file's full name with no alias; the 'Name truncated on screen' note stays.


class CapitalOne(Adapter):
    card, slugp = "Capital One", "capital-one"
    required = {"merchant", "merchant_tld", "tile_kind", "channel", "bonus", "min_spend", "badge", "promo_text",
                "activation_label"}
    used = required | {"passes", "seq", "section", "source", "offer_types", "tile_class", "expiration", "category",
                       "view_context_id", "raw_text"}
    CHANNEL = {"online": "online", "in-store": "in_store", "at the pump": "pay_at_pump",
               "in-store & online": "in_store_and_online", "in-store & in-app": "in_store_and_app"}
    BADGES = ("BONUS", "NEW OFFER", "EXCLUSIVE COUPON")

    def check_rows(self, rows):
        # The page shows no expiry; a file that starts carrying one needs a rule first.
        if any(not blank(r.get("expiration")) for _, r in rows):
            raise Refused("the Capital One file has expiration values: CLAUDE.md says no expiry is shown; decide the rule first")

    def parse(self, rows, read_date, app):
        groups = {}
        for line, r in rows:
            if r["merchant"].strip().upper() == "UNREADABLE":
                self.skipped = getattr(self, "skipped", 0) + 1
                continue
            k = (nkey(r["merchant"]), bonus_key(r["bonus"]) if r["bonus"].strip() else None)
            groups.setdefault(k, []).append((line, r))
        out = []
        for g in groups.values():
            first = g[0][1]
            inc = Inc(first["merchant"], first["bonus"], [l for l, _ in g])
            ch = next((r["channel"].strip() for _, r in g if r["channel"].strip()), "")
            if ch:
                if ch.lower() not in self.CHANNEL:
                    raise Refused(f"unknown Capital One channel {ch!r} ({inc.label()})")
                inc.set["channel"] = self.CHANNEL[ch.lower()]
            mn = next((r["min_spend"].strip() for _, r in g if r["min_spend"].strip()), "")
            if mn:
                inc.set["minimum_spend"] = mn
            inc.new.update(channel="none_shown", activation="none_shown")
            for _, r in g:
                lab = r["activation_label"].strip().lower()
                if not lab.startswith("none shown"):
                    raise Refused(f"unknown Capital One activation label {r['activation_label']!r} ({inc.label()})")
                if "get this offer" in lab:
                    inc.add_notes.append("Top-offer tile shows a 'Get This Offer' button")
                b = r["badge"].strip()
                if b:
                    if b.upper() not in self.BADGES:
                        inc.flags.append(f"badge {b!r} is not one of {', '.join(self.BADGES)}: not stored")
                    else:
                        inc.add_notes.append(f"Tile label reads '{b.upper()}'")
                p = r["promo_text"].strip()
                if p and r["tile_kind"].strip() != "top-offer":  # the top-offer tile's schedule text is not copied
                    inc.promo_notes.append('Promo text reads "' + re.sub(r"\s*\|\s*", " ", p) + '"')
            inc.replace.append((r"^\d+ tiles listed$", f"{len(g)} tiles listed" if len(g) > 1 else None))
            inc.tld = next((r["merchant_tld"].strip() for _, r in g if r["merchant_tld"].strip()), None)
            inc.add_notes = list(dict.fromkeys(inc.add_notes))
            inc.promo_notes = list(dict.fromkeys(inc.promo_notes))
            out.append(inc)
        return out


class BankOfAmerica(Adapter):
    card, slugp = "Bank of America", "bank-of-america"
    required = {"merchant", "bonus", "channel", "icon_label", "tag"}
    used = required | {"offer_id"}
    CHANNEL = {"in-store only": "in_store", "online only": "online", "in-store and online": "in_store_and_online"}
    ACTIVATION = {"activateBadge": "needs_activation", "activatedBadge": "already_activated",
                  "autoEnrolledBadge": "auto_enrolled", "shopBadge": "via_shop_link"}
    RANK = ["needs_activation", "via_shop_link", "already_activated", "auto_enrolled"]

    def parse(self, rows, read_date, app):
        groups = {}
        for line, r in rows:
            name = re.sub(r"\s+", " ", r["merchant"]).strip()
            ch = r["channel"].strip().lower()
            if ch not in self.CHANNEL:
                raise Refused(f"unknown Bank of America channel {r['channel']!r} (line {line})")
            if r["icon_label"].strip() not in self.ACTIVATION:
                raise Refused(f"unknown Bank of America icon_label {r['icon_label']!r} (line {line})")
            # Same merchant (ignoring case and repeated spaces), bonus and channel = one offer (the file has no location).
            groups.setdefault((name.lower(), r["bonus"].strip(), ch), []).append((line, r, name))
        out = []
        for (_, bonus, ch), g in groups.items():
            inc = Inc(g[0][2], bonus, [l for l, _, _ in g])
            inc.set["channel"] = self.CHANNEL[ch]
            acts = [self.ACTIVATION[r["icon_label"].strip()] for _, r, _ in g]
            inc.set["activation"] = min(acts, key=self.RANK.index)
            if len(set(acts)) > 1:
                if len(g) == 2 and set(acts) == {"needs_activation", "auto_enrolled"}:
                    inc.replace.append((r"^Listed twice\b", "Listed twice: once needing activation, once auto-enrolled"))
                else:
                    inc.flags.append(f"rows with different badges {sorted(set(acts))}: kept {inc.set['activation']}")
            # Rows with one badge are locations; rows with different badges are one listing shown twice.
            same = len(set(acts)) == 1
            inc.replace.append((r"^\d+ locations listed$", f"{len(g)} locations listed" if len(g) > 1 and same else None))
            for _, r, _ in g:
                if r["tag"].strip():
                    inc.add_notes.append(f"Tagged {r['tag'].strip()}")
            inc.add_notes = list(dict.fromkeys(inc.add_notes))
            out.append(inc)
        return out


class Citi(Adapter):
    """One Citi card's Merchant Offers list (each Citi card is its own read and CSV)."""
    required = {"offer_id", "merchant", "bonus", "enrollment_state", "section", "expiration", "promo_tag", "source_tab"}
    used = required | {"min_spend", "max_reward_cap", "channel", "category", "passes_seen"}
    # Domain names the owner approved as the same merchant as a saved one (CLAUDE.md, Citi Double Cash).
    CLOSE = {"oribe.com": "Oribe Hair Care", "airdoctorpro.com": "AirDoctor", "tataharperskincare.com": "Tata Harper",
             "forkfulmeals.com": "Forkful", "ecko.com": "Ecko Unltd", "shopjura.com": "Jura"}
    RENAMES = {"splash": ("Splash Wines", ["Splash"])}  # a wine club, apart from Capital One's Splash
    ACTIVATION = {"enroll in offer": "needs_activation", "enrolled": "already_activated"}

    def __init__(self, card, slugp):
        self.card, self.slugp = card, slugp

    def parse(self, rows, read_date, app):
        self.skipped = 0
        by_id = {}
        for line, r in rows:
            if r["source_tab"].strip().lower() == "redeemed" or r["enrollment_state"].strip().lower().startswith("redeemed"):
                self.skipped += 1  # history: skipped, never marks anything used
                continue
            oid = r["offer_id"].strip()
            if oid in by_id:  # one row per offer_id; sections combined
                by_id[oid][1]["section"] += ";" + r["section"]
                by_id[oid][0].append(line)
            else:
                by_id[oid] = ([line], dict(r))
        recs = []
        for oid, (lines, r) in by_id.items():
            full = re.sub(r"\s+", " ", r["merchant"]).strip()
            base, loc = full, None
            if oid.upper().startswith("RN-") and " - " in full:
                base, loc = [p.strip() for p in full.split(" - ", 1)]
            recs.append({"oid": oid, "lines": lines, "r": r, "full": full, "base": base, "loc": loc,
                         "bkey": bonus_key(r["bonus"]), "exp": r["expiration"].strip()})
        # Restaurant rows with the same base name and bonus are one offer ("N locations listed"), unless their
        # expirations differ (then each keeps its full name; the owner decides).
        groups = {}
        for rec in recs:
            if rec["oid"].upper().startswith("RN-"):
                groups.setdefault((compact(rec["base"]), rec["bkey"]), []).append(rec)
        merged, split = {}, set()
        for k, g in groups.items():
            if len(g) > 1:
                if len({x["exp"] for x in g}) == 1:
                    merged[k] = g
                else:
                    split.add(k)
        out, done = [], set()
        for rec in recs:
            k = (compact(rec["base"]), rec["bkey"])
            if rec["oid"] in done:
                continue
            if k in merged:
                g = merged[k]
                done.update(x["oid"] for x in g)
                plain = next((x for x in g if not x["loc"]), g[0])
                inc = self.row(plain["base"], g, read_date)
                locs = [x["loc"] for x in g if x["loc"]]
                inc.replace.append((r"^\d+ locations listed$", f"{len(g)} locations listed"))
                inc.replace.append((r"^Locations? listed: ", (("Location listed: " if len(locs) == 1 else "Locations listed: ")
                                                              + "; ".join(locs)) if locs else None))
                out.append(inc)
                continue
            name = rec["full"]
            if rec["loc"]:
                spelled = app.spelling(rec["full"])
                if spelled:
                    name = spelled  # the full name, location included, is already in the app: its spelling
                elif k in split:
                    name = rec["full"]
                else:
                    name = rec["base"]
            inc = self.row(name, [rec], read_date)
            if rec["loc"] and name == rec["base"]:
                inc.replace.append((r"^Locations? listed: ", f"Location listed: {rec['loc']}"))
            if k in split:
                inc.flags.append("same base name and bonus as another row with a different expiration: "
                                 "kept separate under the full name (ask the owner before merging)")
            out.append(inc)
        return out

    def row(self, name, recs, read_date):
        r = recs[0]["r"]
        inc = Inc(name, r["bonus"], [l for x in recs for l in x["lines"]])
        if DOMAIN.match(inc.merchant) and " " not in inc.merchant:
            self.domain(inc)
        if compact(inc.merchant) in self.RENAMES:
            new, al = self.RENAMES[compact(inc.merchant)]
            inc.new_aliases = al + inc.new_aliases
            inc.merchant = new
        states = {x["r"]["enrollment_state"].strip().lower() for x in recs}
        if not states <= set(self.ACTIVATION):
            raise Refused(f"unknown Citi enrollment_state {sorted(states)} ({inc.label()})")
        acts = [self.ACTIVATION[s] for s in states]
        inc.set["activation"] = "needs_activation" if "needs_activation" in acts else acts[0]
        m = re.fullmatch(r"(\d+)d left", r["expiration"].strip())
        if m:
            inc.set["expires"] = plus_days(read_date, int(m.group(1)))  # countdown: an estimate
            inc.set["expires_text"] = r["expiration"].strip()
        elif r["expiration"].strip():
            inc.flags.append(f"expiration {r['expiration'].strip()!r} is not an 'Nd left' countdown: expiry not changed")
        inc.new.update(channel="none_shown", activation="needs_activation")
        if any(x["r"]["promo_tag"].strip() == "Featured" or "featured" in [s.strip().lower() for s in re.split(r"[;|]", x["r"]["section"])]
               for x in recs):
            inc.add_notes.append("Shown in the Featured section")
        return inc

    def domain(self, inc):
        """A domain name takes the app's name for that merchant, with the domain in aliases."""
        d = inc.merchant
        target = self.CLOSE.get(d.lower())
        if not target:
            target = self.app.domain_match(domain_base(d))
        if target:
            inc.merchant = target
            if compact(target) != compact(d):
                inc.new_aliases.append(d)


# Cards read from the same page format with the same columns: a file for one must never be applied to the other.
SIBLING = {"Chase Freedom Flex": "Chase Freedom", "Chase Freedom": "Chase Freedom Flex",
           "Citi Double Cash": "Citi Custom Cash", "Citi Custom Cash": "Citi Double Cash"}
# card_name values the issuer pages use (the Chase Freedom file), as app nicknames.
CARD_NAME = {"freedom": "Chase Freedom", "freedomflex": "Chase Freedom Flex", "doublecash": "Citi Double Cash",
             "customcash": "Citi Custom Cash"}


def file_cards(rows):
    """The cards the file's own columns name: `card` (an app nickname) and `card_name` (the issuer's label, digits
    ignored). Returns (set of app card names or raw values, which columns were there, {column: blank cells} for a
    column filled on some rows and blank on others)."""
    named, cols, partial = set(), [], {}
    for c in ("card", "card_name"):
        cells = [re.sub(r"\s+", " ", re.sub(r"\d", "", r.get(c) or "")).strip(" *\u2022-.") for _, r in rows if c in r]
        vals = set(cells)
        if not any(c in r for _, r in rows):
            continue
        cols.append(c)
        if "" in vals and vals != {""}:
            partial[c] = cells.count("")
        for v in vals - {""}:
            if c == "card":
                named.add(next((a for a in ADAPTERS if compact(a) == compact(v)), v))
            else:
                named.add(CARD_NAME.get(compact(v).replace("chase", "").replace("citi", ""), v))
    return named, cols, partial


def card_check(card, rows, incs, view_list):
    """(refusal or None, stop or None, warning or None). The file's own `card` / `card_name` column decides: naming
    this card accepts, naming any other card refuses; an unknown value or, on the four sibling cards, no such column
    stops for the owner (`card_check`). The file name is never evidence. A list that leans to the sibling card's
    exclusive offers is only a warning."""
    named, cols, partial = file_cards(rows)
    refusal = stop = warning = None
    known = [n for n in named if n in ADAPTERS]
    if len(named) > 1:
        refusal = f"the file's {'/'.join(cols)} column names more than one card ({', '.join(sorted(named))})"
    elif known and known[0] != card:
        refusal = f"the file's {'/'.join(cols)} column names {known[0]}, not {card}"
    elif partial:  # the column must be on every row: one filled cell never vouches for the rest
        c, n = next(iter(partial.items()))
        stop = f"the file's {c} column is blank on {n} of {len(rows)} rows, so it can't show which card the file is"
    elif named and not known:
        stop = f"the file's {'/'.join(cols)} column says {next(iter(named))!r}, which is not a card in the app"
    elif not named and card in SIBLING:
        stop = (f"the file has no card column, so it can't show it is the {card} read and not {SIBLING[card]}'s "
                f"(the two share a format)")
    other = SIBLING.get(card)
    if other and not refusal:
        def keys(c):
            return {(nkey(x), bonus_key(o["bonus"])) for o in view_list if o["card"] == c
                    for x in [o["merchant"]] + o.get("aliases", [])}
        own, sib = keys(card), keys(other)
        own, sib = own - sib, sib - own
        hits = lambda ks: sum(1 for i in incs if (nkey(i.merchant), bonus_key(i.bonus)) in ks
                              or any((nkey(a), bonus_key(i.bonus)) in ks for a in i.new_aliases))
        a, b = hits(own), hits(sib)
        if b > a:
            warning = (f"the list has {b} of the offers only {other} has saved and {a} of those only {card} has; "
                       f"check that {card} was the card picked on the page")
    return refusal, stop, warning


ADAPTERS = {
    "Chase Freedom Flex": lambda: Chase("Chase Freedom Flex", "chase-freedom-flex", "Freedom Flex"),
    "Chase Freedom": lambda: Chase("Chase Freedom", "chase-freedom", "Freedom"),
    "U.S. Bank": USBank,
    "Capital One": CapitalOne,
    "Bank of America": BankOfAmerica,
    "Citi Double Cash": lambda: Citi("Citi Double Cash", "citi-double-cash"),
    "Citi Custom Cash": lambda: Citi("Citi Custom Cash", "citi-custom-cash"),
}


# ---------- the app's names (every card) ----------

class App:
    def __init__(self, offers):
        self.offers = offers
        self.names = {}  # compact name -> [(spelling, offer)]
        for o in offers:
            for n in [o["merchant"]] + o.get("aliases", []):
                self.names.setdefault(compact(n), []).append((n, o))

    def spelling(self, name):
        """The app's most used spelling of a merchant name (compared like search), or None."""
        hits = [o["merchant"] for n, o in self.names.get(compact(name), []) if compact(o["merchant"]) == compact(name)]
        return max(sorted(set(hits)), key=hits.count) if hits else None

    def domain_match(self, base):
        hits = [o["merchant"] for _, o in self.names.get(compact(base), [])]
        if not hits:
            return None
        proper = [h for h in hits if not bare_domain(h)] or hits
        return max(sorted(set(proper)), key=proper.count)

    def category(self, name):
        """{category: [card, ...]} for merchants with this name (case, accents, punctuation ignored)."""
        out = {}
        k = compact(name)
        for n, o in self.names.get(k, []):
            if k in CATEGORY_EXCEPTIONS and n != name:
                continue
            out.setdefault(o["category"], set()).add(o["card"])
        return out


# ---------- reading files ----------

# Dates in file names are not card digits, but only a real date within a month of the read date counts as one
# (a last-four such as 2034 before _10_25 is not the file's date). Forms: 2026-10-25, 2026_10_25, 10-25-2026,
# 20261025, Oct_25_2026, 25-Oct-2026, 25-10-2026, Oct_2026.
MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split()
_MON = r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*"
MONTH_YEAR = re.compile(r"(?i)(?<![a-z])" + _MON + r"[ _.,-]*((?:19|20)\d\d)(?!\d)")
DATE_FORMS = [
    (re.compile(r"(?<!\d)((?:19|20)\d\d)([-_.])(\d{1,2})\2(\d{1,2})(?!\d)"), lambda m: (m[1], m[3], m[4])),
    (re.compile(r"(?<!\d)(\d{1,2})([-_.])(\d{1,2})\2((?:19|20)\d\d)(?!\d)"), lambda m: (m[4], m[1], m[3])),
    (re.compile(r"(?<!\d)((?:19|20)\d\d)(\d\d)(\d\d)(?!\d)"), lambda m: (m[1], m[2], m[3])),
    (re.compile(r"(?i)(?<![a-z])" + _MON + r"[ _.-]?(\d{1,2})(?:st|nd|rd|th)?[ _.,-]*((?:19|20)\d\d)(?!\d)"),
     lambda m: (m[3], str(MONTHS.index(m[1].lower()) + 1), m[2])),
    (re.compile(r"(?i)(?<!\d)(\d{1,2})[ _.-]?" + _MON + r"[ _.,-]*((?:19|20)\d\d)(?!\d)"),
     lambda m: (m[3], str(MONTHS.index(m[2].lower()) + 1), m[1])),
    (re.compile(r"(?<!\d)(\d{1,2})([-_.])(\d{1,2})\2((?:19|20)\d\d)(?!\d)"), lambda m: (m[4], m[3], m[1])),  # 25-10-2026
    (MONTH_YEAR, lambda m: (m[2], str(MONTHS.index(m[1].lower()) + 1), "1")),  # Oct_2026: the 1st of that month
]
FOUR = re.compile(r"(?<![0-9A-Za-z])\d{4}(?![0-9A-Za-z])")


def date_spans(name, read_date):
    """Where a file name holds a date near the read date (no read date known: none)."""
    spans = []
    if not read_date:
        return spans
    rd = date.fromisoformat(read_date)
    for rx, ymd in DATE_FORMS:
        for m in rx.finditer(name):
            try:
                d = date(*(int(x) for x in ymd(m)))
            except ValueError:
                continue
            if rx is MONTH_YEAR:  # Oct_2026: the whole month, give or take a month
                ok = -31 <= (rd - d).days <= 62
            else:
                ok = abs((d - rd).days) <= 31
            if ok:
                spans.append(m.span())
    return spans


def name_digits(name, read_date):
    """The 4-digit groups of a file name that are not part of a date: possible last-fours."""
    spans = date_spans(name, read_date)
    return [m for m in FOUR.finditer(name) if not any(a <= m.start() and m.end() <= b for a, b in spans)]


def secret_digits(paths, rows, guarded, read_date):
    """Digit groups that must never be stored: values of card/account columns and 4-digit groups in file names."""
    out = set()
    for _, r in rows:
        for c in guarded:
            out.update(re.findall(r"\d{4,19}", r.get(c) or ""))
    for p in paths:
        n = Path(p).name
        out.update(m.group(0) for m in name_digits(n, read_date))
        out.update(re.findall(r"\d{12,19}", n))
    return out


def masked(name, read_date=None):
    """A file name for the report, with any 4-digit group that is not part of a date hidden (a last-four)."""
    n = Path(name).name
    for m in reversed(name_digits(n, read_date)):
        n = n[:m.start()] + "****" + n[m.end():]
    return n


def read_csvs(paths, adapter):
    rows, cols0 = [], None
    for p in paths:
        with open(p, encoding="utf-8-sig", newline="") as f:
            rd = csv.DictReader(f)
            cols = list(rd.fieldnames or [])
            if cols0 is not None and cols != cols0:
                raise Refused("the parts of one batch must have the same columns")
            cols0 = cols
            for i, r in enumerate(rd, start=2):
                if not any((v or "").strip() for v in r.values() if isinstance(v, str)):
                    continue
                rows.append((f"file {paths.index(p) + 1} line {i}" if len(paths) > 1 else i, r))
    ignored, _ = adapter.check_columns(cols0 or [])
    return rows, cols0, ignored, adapter.guarded(cols0 or [], rows)


def pick_read_date(rows, cols, given):
    if "read_date" in (cols or []):
        vals = {(r.get("read_date") or "").strip() for _, r in rows}
        if len(vals) == 1 and real_date(next(iter(vals))):
            v = next(iter(vals))
            if given and given != v:
                raise Refused(f"--read-date {given} differs from the file's read_date {v}")
            return v, "the file's read_date column"
        if not given:
            raise Refused("the read_date column is blank or not the same on every row: pass --read-date "
                          "(the date the owner read the page, US Pacific)")
    if not given:
        raise Refused("no read date: pass --read-date YYYY-MM-DD, the date the owner read the page in US Pacific "
                      "time, as the owner states it (never today's date or the container clock)")
    if not real_date(given):
        raise Refused(f"--read-date {given!r} is not a real YYYY-MM-DD date")
    return given, "--read-date"



# ---------- the plan (report and apply share it) ----------

def plan(card, paths, given_date, decisions=None, part=False, complete_parts=False):
    if card not in ADAPTERS:
        raise Refused(f"unknown card {card!r}; one of: {', '.join(ADAPTERS)}")
    ad = ADAPTERS[card]()
    text = OFFERS.read_text()
    data = json.loads(text)
    if json.dumps(data, indent=2, ensure_ascii=False) + "\n" != text:
        raise Refused("offers.json is not in the standard layout; fix that first")
    pending = load_pending(DATA)
    view_list = with_pending(data, pending)
    rows, cols, ignored, guarded = read_csvs(paths, ad)
    ad.check_rows(rows)
    read_date, date_source = pick_read_date(rows, cols, given_date)
    dec = decisions or {}
    if decisions is not None:
        unknown = set(dec) - {"card", "read_date", "pairs", "categories", "clashes", "new_names", "owner_approved", "notes"}
        if unknown:
            raise Refused(f"decisions file: unknown keys {sorted(unknown)}")
        if dec.get("card") != card or dec.get("read_date") != read_date:
            raise Refused(f"decisions file is for {dec.get('card')!r} read {dec.get('read_date')!r}, "
                          f"not {card!r} read {read_date}")
    batches = [b["read_date"] for b in data["batches"] if b.get("card") == card]
    if batches and read_date < max(batches):
        raise Refused(f"read date {read_date} is before this card's newest batch ({max(batches)}): a stale file")

    app = App(view_list)
    ad.app = app
    incs = ad.parse(rows, read_date, app)
    raw_by_id = {o["id"]: o for o in data["offers"]}
    view = {o["id"]: o for o in view_list}
    mine = [o for o in view_list if o["card"] == card]
    # The size check and the missing limit compare with the active offers still live on the read date: an offer
    # whose expires is before the read date has simply ended (expires on the read date, or no expires, counts).
    def ended(o):
        return bool(o.get("expires")) and o["expires"] < read_date
    prior_active = sum(1 for o in mine if o["status"] == "active" and not ended(o))
    prior_ended = sum(1 for o in mine if o["status"] == "active" and ended(o))
    wrong, card_stop, card_warning = card_check(card, rows, incs, view_list)
    if wrong:
        raise Refused(f"this is not the {card} file: {wrong}. Each card is its own read; never combined")

    # 1. exact matches: name (merchant, then aliases) + bonus; a blank file bonus matches on the name alone.
    idx = {}
    for o in mine:
        for i, n in enumerate([o["merchant"]] + o.get("aliases", [])):
            idx.setdefault(nkey(n), []).append((i > 0, o))
    claimed, match = set(), {}  # match: inc index -> (offer id, rule, reason)

    def cands(inc, same_bonus=True):
        out = []
        for via_alias, o in idx.get(nkey(inc.merchant), []) + [x for a in inc.new_aliases for x in idx.get(nkey(a), [])]:
            if o["id"] in claimed or any(o is c for _, c in out):
                continue
            if inc.bonus is None or not same_bonus or bonus_key(o["bonus"]) == bonus_key(inc.bonus):
                out.append((via_alias, o))
        return out

    def prefer(inc, cs):
        return sorted(cs, key=lambda x: (inc.channel is not None and x[1]["channel"] != inc.channel, x[0],
                                         x[1]["status"] != "active", x[1]["id"]))

    for i, inc in enumerate(incs):
        cs = cands(inc)
        if cs:
            via_alias, o = prefer(inc, cs)[0]
            claimed.add(o["id"])
            match[i] = (o["id"], "alias" if via_alias else "exact", "")

    # 2. mechanical pairs of leftovers (same bonus, unique on both sides).
    def left_incs():
        return [i for i in range(len(incs)) if i not in match]

    def left_saved():
        return [o for o in mine if o["id"] not in claimed]

    def names(o):
        return [o["merchant"]] + o.get("aliases", [])

    def rule_truncated(inc, o):
        for n in names(o):
            if truncated(n) and len(nkey(stem(n))) >= 4 and nkey(inc.merchant).startswith(nkey(stem(n))):
                return f"saved name {n!r} is cut off; the file has the full name"
        if truncated(inc.merchant) and len(nkey(stem(inc.merchant))) >= 4 and \
                any(nkey(n).startswith(nkey(stem(inc.merchant))) for n in names(o)):
            return "the file's name is cut off"
        return None

    def rule_extends(inc, o):
        a = words(inc.merchant)
        for n in names(o):
            b = words(n)
            s, l = (a, b) if len(a) <= len(b) else (b, a)
            if s and s != l and l[:len(s)] == s and len("".join(s)) >= 3:
                return f"{' '.join(s)!r} is the start of {' '.join(l)!r}"
        return None

    def rule_tld(inc, o):
        if not inc.tld:
            return None
        for n in names(o):
            if compact(n) and compact(n) in (compact(domain_base(inc.tld)), compact(inc.tld)):
                return f"the file's merchant_tld {inc.tld} is the saved name {n!r}"
        return None

    rules = [("truncated", rule_truncated), ("extends", rule_extends), ("tld", rule_tld)]
    # A file name that is already a saved merchant of this card, or a saved name still in the file, is that
    # merchant's own tile, never an automatic rename of another one (Pura vs Pura Vida): those are proposed.
    saved_names = {nkey(n) for o in mine for n in names(o)}
    file_names = {nkey(inc.merchant) for inc in incs}
    for rname, fn in rules:
        found = {}
        for i in left_incs():
            if nkey(incs[i].merchant) in saved_names:
                continue
            for o in left_saved():
                if bonus_key(o["bonus"]) != bonus_key(incs[i].bonus) and incs[i].bonus is not None:
                    continue
                if any(nkey(n) in file_names for n in names(o)):
                    continue
                why = fn(incs[i], o)
                if why:
                    found.setdefault(i, []).append((o, why))
        by_saved = {}
        for i, hits in found.items():
            for o, _ in hits:
                by_saved.setdefault(o["id"], []).append(i)
        for i, hits in found.items():
            if len(hits) == 1 and len(by_saved[hits[0][0]["id"]]) == 1:
                claimed.add(hits[0][0]["id"])
                match[i] = (hits[0][0]["id"], rname, hits[0][1])

    # 3. same name, different bonus: a bonus change on the same offer (unique per name and channel).
    by_name_inc, by_name_saved = {}, {}
    for i in left_incs():
        by_name_inc.setdefault(nkey(incs[i].merchant), []).append(i)
    for o in left_saved():
        for n in names(o):
            by_name_saved.setdefault(nkey(n), []).append(o)
    proposals = []
    for k, ii in by_name_inc.items():
        ss = by_name_saved.get(k, [])
        if not ss:
            continue
        if len(ii) == 1 and len(ss) == 1:
            if ss[0]["status"] == "used":  # a new bonus where the owner used the old one may be a new offer
                proposals.append((ii[0], ss[0], "same name, different bonus, and the saved offer is used: "
                                               "accept = bonus change on the used offer (it stays used), reject = a new offer"))
                continue
            claimed.add(ss[0]["id"])
            match[ii[0]] = (ss[0]["id"], "bonus_change", "same name, different bonus")
            continue
        for i in ii:  # several on one side: pair on channel when that settles it, otherwise ask
            same = [o for o in ss if o["id"] not in claimed and incs[i].channel and o["channel"] == incs[i].channel]
            if len(same) == 1 and same[0]["status"] != "used" and sum(1 for j in ii if incs[j].channel == incs[i].channel) == 1:
                claimed.add(same[0]["id"])
                match[i] = (same[0]["id"], "bonus_change", "same name and channel, different bonus")
            else:
                for o in ss:
                    if o["id"] not in claimed:
                        proposals.append((i, o, "same name, different bonus, several offers at this merchant"))

    # 4. doubtful pairs: proposed, the session decides (web lookups as CLAUDE.md says).
    proposed_ids = {(i, o["id"]) for i, o, _ in proposals}
    leftover_saved = left_saved()
    for i in left_incs():
        inc, scored = incs[i], []
        for o in leftover_saved:
            if inc.bonus is not None and bonus_key(o["bonus"]) != bonus_key(inc.bonus):
                continue
            a, best, why = nkey(inc.merchant), 0, None
            for n in names(o):
                b = nkey(n)
                if not a or not b:
                    continue
                if len(min(a, b, key=len)) >= 4 and (a in b or b in a):
                    score, w = 0.95, "one name contains the other"
                else:
                    score = difflib.SequenceMatcher(None, a, b).ratio()
                    w = f"close spelling ({score:.2f})"
                for fn_name, fn in rules:
                    if fn(inc, o):
                        score, w = 1.0, fn(inc, o) + " (several candidates, so not automatic)"
                if inc.tld and compact(domain_base(inc.tld)) and len(compact(domain_base(inc.tld))) >= 4 and \
                        (compact(domain_base(inc.tld)) in b or b in compact(domain_base(inc.tld))) and score < 0.9:
                    score, w = 0.9, f"the file's merchant_tld {inc.tld} is close to {n!r}"
                if score > best:
                    best, why = score, w
            if best >= 0.8:
                scored.append((best, o, why))
        for best, o, why in sorted(scored, key=lambda x: -x[0])[:3]:
            if (i, o["id"]) not in proposed_ids:
                proposals.append((i, o, why))
                proposed_ids.add((i, o["id"]))

    # decisions on pairs
    def pair_key(i, o):
        return {"saved": o["id"], "file": incs[i].merchant, "bonus": incs[i].bonus}

    decided = {}
    for p in dec.get("pairs", []) or []:
        if not (isinstance(p, dict) and {"saved", "file", "accept"} <= set(p)):
            raise Refused(f"decisions file: each pair needs saved, file, bonus and accept: {p!r}")
        decided[(p["saved"], compact(p["file"]), bonus_key(p.get("bonus")))] = p["accept"]
    open_pairs = []
    for i, o, why in proposals:
        acc = decided.get((o["id"], compact(incs[i].merchant), bonus_key(incs[i].bonus)))
        if acc is None:
            open_pairs.append((i, o, why))
    for (sid, fname, bkey), acc in decided.items():
        if acc is not True:
            continue
        i = next((j for j in left_incs() if compact(incs[j].merchant) == fname and bonus_key(incs[j].bonus) == bkey), None)
        if i is None or sid in claimed or sid not in view or view[sid]["card"] != card:
            raise Refused(f"decisions file: pair {sid} <- {fname!r} is not a leftover file row and saved offer of this card")
        claimed.add(sid)
        match[i] = (sid, "decided", "accepted in the decisions file")
    open_pairs = [(i, o, why) for i, o, why in open_pairs if i not in match and o["id"] not in claimed]

    # ---------- build the new data ----------
    new = copy.deepcopy(data)
    nby = {o["id"]: o for o in new["offers"]}
    changes = {"fields": {}, "notes_added": 0, "notes_removed": 0}
    out = {"card": card, "read_date": read_date, "date_source": date_source, "files": [masked(p, read_date) for p in paths],
           "rows": len(rows), "offers_in_batch": len(incs), "prior_active": prior_active, "prior_ended": prior_ended, "ignored_columns": ignored,
           "card_columns": guarded, "matched": [], "paired": [], "bonus_changes": [], "wording_changes": [],
           "new": [], "missing": [], "held": [], "stays_used": [], "still_absent": [], "returning": [],
           "proposals": [], "flags": [], "renames": [], "expired": [], "deleted": [], "skipped_redeemed": getattr(ad, "skipped", 0),
           "part": part}
    for i, inc in enumerate(incs):
        for fl in inc.flags:
            out["flags"].append(f"{inc.label()} (line {', '.join(map(str, inc.lines))}): {fl}")

    def touch(o, f, v):
        if o.get(f) != v:
            changes["fields"][f] = changes["fields"].get(f, 0) + 1
            o[f] = v

    def notes_update(o, inc, extra_drop=(), count=True):
        notes = list(o.get("other_details") or [])
        before = list(notes)
        for rx, note in inc.replace:
            hits = [k for k, t in enumerate(notes) if re.search(rx, t) and not t.startswith("Used on ")]
            if note is None:
                notes = [t for k, t in enumerate(notes) if k not in hits]
            elif hits:
                notes[hits[0]] = note
                notes = [t for k, t in enumerate(notes) if k not in hits[1:]]
            else:
                notes.append(note)
        for t in list(inc.drop_notes) + list(extra_drop):
            notes = [x for x in notes if x != t]
        for t in inc.add_notes:
            if t not in notes:
                notes.append(t)
        if inc.promo_notes and not any(t.startswith("Promo text reads") for t in notes):
            notes += inc.promo_notes
        notes = list(dict.fromkeys(notes))
        if count:
            changes["notes_added"] += len([t for t in notes if t not in before])
            changes["notes_removed"] += len([t for t in before if t not in notes])
        o["other_details"] = notes

    def set_aliases(o, merchant, extra):
        al = [a for a in o.get("aliases", []) + list(extra) if a]
        seen, keep = {compact(merchant)}, []
        for a in al:
            if compact(a) and compact(a) not in seen:
                keep.append(a)
                seen.add(compact(a))
        if keep != o.get("aliases", []) and o["id"] in raw_by_id:
            changes["fields"]["aliases"] = changes["fields"].get("aliases", 0) + 1
        if keep:
            o["aliases"] = keep
        else:
            o.pop("aliases", None)

    def status_after(o_view, expires):
        if o_view["status"] == "used":
            return "used"
        return "expired" if expires and expires < read_date else "active"

    cuisine_moves = []
    for i, inc in enumerate(incs):
        if i not in match:
            continue
        sid, rule, why = match[i]
        o, v, pe = nby[sid], view[sid], pending.get(sid, {})
        old_name, old_bonus = v["merchant"], v["bonus"]
        if rule in ("exact", "alias"):
            merchant, alias, drop = o["merchant"], None, ()
        else:
            eff = rule
            if rule == "decided":  # an accepted pair follows the same name rules as an automatic one
                eff = "truncated" if rule_truncated(inc, v) else ("extends" if rule_extends(inc, v) else "decided")
            merchant, alias, drop = ad.pair_name(v, inc, eff)
            if rule == "decided" and alias is None and merchant == v["merchant"] and bare_domain(inc.merchant) \
                    and nkey(inc.merchant) != nkey(merchant):
                alias = inc.merchant  # the saved name stays; the domain becomes an alias, so the next read matches it
        if merchant != o["merchant"]:
            out["renames"].append({"id": sid, "from": o["merchant"], "to": merchant, "alias_added": bool(alias), "rule": rule})
            if o["category"] == "Dining" and not alias:
                cuisine_moves.append((o["merchant"], merchant))
            touch(o, "merchant", merchant)
        set_aliases(o, merchant, ([alias] if alias else []) + inc.new_aliases)
        if inc.bonus is not None and inc.bonus != o["bonus"]:
            (out["bonus_changes"] if bonus_key(inc.bonus) != bonus_key(o["bonus"]) else out["wording_changes"]).append(
                {"id": sid, "merchant": merchant, "from": o["bonus"], "to": inc.bonus})
            touch(o, "bonus", inc.bonus)
        for f, val in inc.set.items():
            if f in pe:
                continue  # a pending phone edit sets it
            touch(o, f, val)
        for f, val in inc.fill.items():
            if blank(o.get(f)):
                touch(o, f, val)
        notes_update(o, inc, drop)
        touch(o, "last_read", read_date)
        st = status_after(v, o.get("expires"))
        if "status" in pe:
            if st != v["status"]:
                out["held"].append({"id": sid, "merchant": merchant, "would_be": st, "why": "a pending phone edit sets status"})
        elif st != o["status"]:
            if o["status"] in ("missing", "expired") and st == "active":
                out["returning"].append({"id": sid, "merchant": merchant, "was": o["status"]})
            touch(o, "status", st)
            touch(o, "status_since", read_date)
        entry = {"id": sid, "merchant": merchant, "file": inc.merchant, "bonus": inc.bonus, "rule": rule, "why": why}
        (out["matched"] if rule in ("exact", "alias") else out["paired"]).append(entry)
        if v["status"] == "used":
            out["stays_used"].append({"id": sid, "merchant": merchant, "in_batch": True})

    # new offers
    cats = dec.get("categories", {}) or {}
    names_over = dec.get("new_names", {}) or {}
    need_category, unsure = [], []
    taken = {o["id"] for o in new["offers"]}
    insert_at = max((k for k, o in enumerate(new["offers"]) if o["card"] == card), default=len(new["offers"]) - 1) + 1
    fresh = []
    for i, inc in enumerate(incs):
        if i in match:
            continue
        name, aliases = inc.merchant, list(inc.new_aliases)
        if inc.merchant in names_over:
            ov = names_over[inc.merchant]
            name, aliases = ov["merchant"], list(ov.get("aliases", [])) + aliases
        known = app.category(name)
        for a in aliases:
            for c, cs in app.category(a).items():
                known.setdefault(c, set()).update(cs)
        given = cats.get(name)
        if isinstance(given, dict):
            if given.get("unsure"):
                unsure.append(name)
            given = given.get("category")
        if len(known) == 1 and not given:
            cat, source = next(iter(known)), "reused from " + ", ".join(sorted(next(iter(known.values()))))
        elif given:
            if given not in new["categories"]:
                raise Refused(f"decisions file: category {given!r} for {name!r} is not in the fixed list")
            cat, source = given, "decisions file"
        else:
            cat, source = None, ("same name has several categories: " + json.dumps({k: sorted(v) for k, v in known.items()})
                                 if known else "needs a category")
            need_category.append(name)
        base = f"{ad.slugp}/{slug(name)}"
        nid, n = base, 1
        while nid in taken:
            n += 1
            nid = f"{base}-{n}"
        taken.add(nid)
        o = {"id": nid, "card": card, "merchant": name}
        if aliases:
            o["aliases"] = []
        o.update({"category": cat, "bonus": inc.bonus or "", "expires": None, "expires_text": None,
                  "activation": "none_shown", "channel": "none_shown", "spend_cap": None, "minimum_spend": None,
                  "fine_print": None, "other_details": [], "last_read": read_date, "first_seen": read_date,
                  "status": "active", "status_since": read_date})
        o.update(inc.new)
        o.update(inc.set)
        o.update({f: val for f, val in inc.fill.items() if blank(o.get(f))})
        set_aliases(o, name, aliases)
        notes_update(o, inc, count=False)
        o["status"] = "expired" if o["expires"] and o["expires"] < read_date else "active"
        o = {k: o[k] for k in FIELDS[:3] + (["aliases"] if "aliases" in o else []) + FIELDS[3:]}
        fresh.append(o)
        out["new"].append({"id": nid, "merchant": name, "bonus": o["bonus"], "category": cat, "category_source": source,
                           "file": inc.merchant, "lines": inc.lines})
    new["offers"][insert_at:insert_at] = fresh
    nby = {o["id"]: o for o in new["offers"]}

    # absent from the batch: the snapshot rule. With --complete-parts ("batch complete" after --part runs), an offer
    # already read on this date (an earlier part, or an earlier run of this batch) is in it: missing = active with
    # last_read older than the batch date (OFFER_RECORD.md). Without it, only this run's files are the batch.
    parts_open = complete_parts and not part
    out["from_earlier_parts"], out["expired_absent"] = [], []
    for o_view in mine:
        if o_view["id"] in claimed:
            continue
        o, pe = nby[o_view["id"]], pending.get(o_view["id"], {})
        if o_view["status"] == "used":
            out["stays_used"].append({"id": o["id"], "merchant": o["merchant"], "in_batch": False})
        elif o_view["status"] in ("missing", "expired"):
            out["still_absent"].append({"id": o["id"], "merchant": o["merchant"], "status": o_view["status"]})
        elif parts_open and o_view["last_read"] == read_date:
            out["from_earlier_parts"].append({"id": o_view["id"], "merchant": o_view["merchant"]})
        elif part:
            continue
        elif "status" in pe:
            out["held"].append({"id": o["id"], "merchant": o["merchant"],
                                "would_be": "expired" if ended(o_view) else "missing", "why": "a pending phone edit sets status"})
        elif ended(o_view) and o_view["id"] in pending:  # cleanup skips offers with a pending edit: the fold first
            out["held"].append({"id": o["id"], "merchant": o["merchant"], "would_be": "expired",
                                "why": "a pending phone edit (cleanup waits for the fold)"})
        elif ended(o_view):  # not in the file because it ended: expired by date, not missing
            out["expired_absent"].append({"id": o["id"], "merchant": o["merchant"], "bonus": o["bonus"], "expires": o["expires"]})
            touch(o, "status", "expired")
            touch(o, "status_since", read_date)
        else:
            out["missing"].append({"id": o["id"], "merchant": o["merchant"], "bonus": o["bonus"]})
            touch(o, "status", "missing")
            touch(o, "status_since", read_date)

    # cleanup (this card, never an offer with a pending edit): expiry, then the 30-day deletes, from the read date
    keep = []
    for o in new["offers"]:
        if o["card"] != card or o["id"] in pending:
            keep.append(o)
            continue
        if o["status"] in ("active", "missing") and o.get("expires") and o["expires"] < read_date:
            out["expired"].append({"id": o["id"], "merchant": o["merchant"], "expires": o["expires"]})
            o["status"], o["status_since"] = "expired", read_date
        since = o.get("expires") if o["status"] in ("expired", "used") and o.get("expires") else o["status_since"]
        if o["status"] in ("expired", "used", "missing") and plus_days(since, CLEANUP_DAYS) <= read_date:
            out["deleted"].append({"id": o["id"], "merchant": o["merchant"], "status": o["status"], "since": since})
            continue
        keep.append(o)
    new["offers"] = keep
    batch_n = len(incs) + len(out["from_earlier_parts"])
    if not part:  # one entry per card and read date: a re-run replaces it
        same = [b for b in new["batches"] if b.get("card") == card and b.get("read_date") == read_date]
        if same:
            same[-1]["offers_found"] = batch_n
        else:
            new["batches"].append({"card": card, "read_date": read_date, "offers_found": batch_n})

    # category clashes (same name, different categories), after renames and new offers
    clash_fix = dec.get("clashes", {}) or {}
    for name, cat in clash_fix.items():
        if cat not in new["categories"]:
            raise Refused(f"decisions file: clash category {cat!r} for {name!r} is not in the fixed list")
        for o in new["offers"]:
            same = compact(o["merchant"]) == compact(name) and (compact(name) not in CATEGORY_EXCEPTIONS or o["merchant"] == name)
            if same and o.get("category") != cat:
                o["category"] = cat
    groups = {}
    for o in new["offers"]:
        k = compact(o["merchant"])
        if k in CATEGORY_EXCEPTIONS:
            k = (k, o["merchant"])
        groups.setdefault(k, []).append(o)
    out["clashes"] = []
    for g in groups.values():
        cs = {o["category"] for o in g if o.get("category")}
        if len(cs) > 1 and any(o["card"] == card for o in g):
            out["clashes"].append({"merchant": g[0]["merchant"],
                                   "categories": {c: sorted({f"{o['card']} ({o['merchant']})" for o in g if o['category'] == c}) for c in sorted(cs)}})

    # cuisines: renames that add no alias move the entry; new active Dining names with no entry go on to_classify
    cj = json.loads(CUISINES.read_text()) if CUISINES.exists() else {"merchants": {}, "to_classify": []}
    ekeys = {compact(k): k for k in cj["merchants"]}
    still = {compact(n) for o in new["offers"] if o["category"] == "Dining" for n in [o["merchant"]] + o.get("aliases", [])}
    moves = []
    for old, nw in cuisine_moves:
        if compact(old) in ekeys and compact(nw) not in ekeys and compact(nw) not in {compact(b) for _, b, _ in moves}:
            moves.append((ekeys[compact(old)], nw, "copy" if compact(old) in still else "move"))
    out["cuisine_moves"] = [{"from": a, "to": b, "how": h} for a, b, h in moves]
    tagged = set(ekeys) | {compact(b) for _, b, _ in moves}
    todo = {compact(n) for n in cj.get("to_classify", [])}
    dining = []
    for o in new["offers"]:
        if o["card"] == card and o["category"] == "Dining" and o["status"] == "active":
            ns = [compact(n) for n in [o["merchant"]] + o.get("aliases", [])]
            if not any(n in tagged for n in ns):
                dining.append({"merchant": o["merchant"], "already_on_to_classify": compact(o["merchant"]) in todo})
    out["new_dining"] = sorted({d["merchant"]: d for d in dining}.values(), key=lambda d: d["merchant"].lower())

    # proposals and checks
    out["proposals"] = [{"saved": o["id"], "saved_name": o["merchant"], "saved_bonus": o["bonus"], "saved_status": o["status"],
                         "file": incs[i].merchant, "bonus": incs[i].bonus, "lines": incs[i].lines, "why": why}
                        for i, o, why in open_pairs]
    out["need_category"] = need_category
    out["no_bonus"] = [m["file"] for m in out["new"] if not m["bonus"]]
    out["unsure_categories"] = unsure
    out["changes"] = changes
    # Compared with: the active offers still live on the read date, plus ended ones the file has again (renewed),
    # so renewed offers count on both sides. Skipped only for a card with no active offers at all (its first batch).
    renewed = sum(1 for o in mine if o["id"] in claimed and o["status"] == "active" and ended(o))
    prior_cmp = prior_active + renewed
    had_active = prior_active + prior_ended
    ok_live = batch_n >= SIZE_MIN * prior_cmp
    skipped = part or had_active == 0
    size_ok = skipped or ok_live
    # The last full read (the newest batches entry), minus this card's offers marked used since then: a warning only.
    last = [b for b in data["batches"] if b.get("card") == card and isinstance(b.get("offers_found"), int)]
    last_b = sorted(last, key=lambda b: b["read_date"])[-1] if last else None
    last_n = None
    if last_b:
        used_since = sum(1 for o in mine if o["status"] == "used" and o.get("status_since", "") >= last_b["read_date"])
        last_n = max(last_b["offers_found"] - used_since, 0)
    out["size_warning"] = None
    if not part and last_n and batch_n < LAST_WARN * last_n:
        out["size_warning"] = (f"File is {batch_n / last_n:.0%} of the last full read ({last_n} offers). "
                               f"If the page looked fuller, re-read it.")
    out["size_check"] = {"batch": batch_n, "prior_active": prior_cmp, "renewed": renewed,
                         "ratio": (batch_n / prior_cmp) if prior_cmp else None, "last_batch": last_n,
                         "ratio_last": (batch_n / last_n) if last_n else None, "pass": size_ok, "skipped": skipped,
                         "pass_live": ok_live}
    stops = []
    if card_stop:
        stops.append(("card_check", card_stop))
    left_today = [o for o in mine if o["id"] not in claimed and o["status"] == "active" and o["last_read"] == read_date]
    if not part and not complete_parts and left_today and read_date not in batches:
        stops.append(("parts", f"{len(left_today)} offers not in this file were read on {read_date} by an earlier --part "
                               f"run and no batch is logged for that date yet: use --complete-parts at batch complete"))
    if not size_ok:
        stops.append(("size_check", f"size check failed: {batch_n} offers vs {prior_cmp} active before and still live "
                                    f"on the read date (under 70%)"))
    limit = max(MISSING_MAX[0], MISSING_MAX[1] * prior_cmp)
    if len(out["missing"]) > limit:
        stops.append(("missing", f"{len(out['missing'])} offers would become missing (limit {limit:g})"))
    if batch_n and len(out["new"]) > NEW_MAX * batch_n:
        stops.append(("new_share", f"{len(out['new'])} new offers are more than 25% of the batch ({batch_n})"))
    approved = set(dec.get("owner_approved", []) or [])
    out["stops"] = [{"key": k, "text": t, "owner_approved": k in approved} for k, t in stops]
    blockers = [t for k, t in stops if k not in approved]
    if open_pairs:
        blockers.append(f"{len(open_pairs)} proposed pair(s) need a decision (after web lookups; still doubtful = ask the owner)")
    if need_category:
        blockers.append(f"{len(need_category)} new merchant(s) need a category")
    if out["no_bonus"]:
        blockers.append(f"{len(out['no_bonus'])} new offer(s) with no bonus in the file: " + ", ".join(out["no_bonus"][:5]))
    if out["clashes"]:
        blockers.append(f"{len(out['clashes'])} category clash(es) need a decision")
    out["blockers"] = blockers
    out["card_warning"] = card_warning

    # card numbers: nothing written may carry the digits of a card/account column or of the file name
    secrets = secret_digits(paths, rows, guarded, read_date)
    SECRETS.update(secrets)
    leaks = []
    for o in new["offers"]:
        if o["card"] != card:
            continue
        blob = json.dumps(o, ensure_ascii=False)
        for s in secrets:
            if re.search(r"(?<!\d)" + re.escape(s) + r"(?!\d)", blob):
                leaks.append(o["id"])
    out["leaks"] = sorted(set(leaks))
    if leaks:
        blockers.append(f"{len(set(leaks))} offer(s) would contain digits from a card number column or the file name: "
                        + ", ".join(sorted(set(leaks))[:5]))
    return new, out, moves


# ---------- output ----------

def show(out, limit=40):
    def p(t=""):
        print(mask(str(t)))
    def lst(title, items, fmt, always=False):
        if items or always:
            p(f"\n{title}: {len(items)}")
            for x in items[:limit]:
                p("  " + fmt(x))
            if len(items) > limit:
                p(f"  ... and {len(items) - limit} more (--json has them all)")
    p(f"Refresh {'part' if out['part'] else 'report'}: {out['card']}, read {out['read_date']} (from {out['date_source']})")
    p(f"Files: {', '.join(out['files'])}: {out['rows']} rows -> {out['offers_in_batch']} offers"
      + (f" ({out['skipped_redeemed']} {'UNREADABLE' if out['card'] == 'Capital One' else 'Redeemed'} rows skipped)"
         if out["skipped_redeemed"] else ""))
    if out["card_columns"]:
        p(f"Card detail columns ignored, never stored: {', '.join(out['card_columns'])}")
    p(f"Prior active offers (with pending phone edits, not ended by the read date): {out['prior_active']}"
      + (f" (and {out['prior_ended']} that ended before it)" if out.get("prior_ended") else ""))
    if out.get("card_warning"):
        p(f"WARNING (card check): {out['card_warning']}")
    if out.get("size_warning"):
        p(f"WARNING (size): {out['size_warning']}")
    s = out["size_check"]
    p("Size check: " + ("skipped (" + ("part of a batch" if out["part"] else "no active offers before") + ")" if s["skipped"]
                        else (f"{s['batch']} vs {s['prior_active']}" + (f" ({s['renewed']} of them ended but back in the file)" if s.get("renewed") else "")
                              + (f" = {s['ratio']:.0%}" if s["ratio"] is not None else "") + f" -> {'pass' if s['pass_live'] else 'FAIL (under 70%)'}"
                              )))
    exact = [m for m in out["matched"] if m["rule"] == "exact"]
    alias = [m for m in out["matched"] if m["rule"] == "alias"]
    p(f"\nMatched exactly: {len(exact)}; matched through an alias: {len(alias)}")
    lst("Paired (naming differences)", [m for m in out["paired"] if m["rule"] != "bonus_change"],
        lambda m: f"{m['id']}: {m['merchant']!r} <- file {m['file']!r} [{m['rule']}: {m['why']}]", True)
    lst("Bonus changes", out["bonus_changes"], lambda m: f"{m['id']}: {m['from']!r} -> {m['to']!r}", True)
    lst("Bonus wording changes (same amount)", out["wording_changes"], lambda m: f"{m['id']}: {m['from']!r} -> {m['to']!r}")
    lst("New", out["new"], lambda m: f"{m['id']} | {m['bonus']} | {m['category'] or 'NEEDS CATEGORY'} ({m['category_source']})", True)
    lst("Would become missing", out["missing"], lambda m: f"{m['id']} | {m['merchant']} | {m['bonus']}", True)
    lst("Expired by date, not in the file (not missing)", out["expired_absent"],
        lambda m: f"{m['id']} | {m['merchant']} | {m['bonus']} | expires {m['expires']}", True)
    lst("Already missing / expired, still absent", out["still_absent"], lambda m: f"{m['id']} ({m['status']})")
    lst("Used (stay used)", out["stays_used"], lambda m: f"{m['id']} ({'in the batch' if m['in_batch'] else 'absent'})")
    lst("Returning (missing / expired -> active)", out["returning"], lambda m: f"{m['id']} (was {m['was']})")
    lst("Held by a pending phone edit (not changed)", out["held"], lambda m: f"{m['id']}: would be {m['would_be']} ({m['why']})")
    lst("Renames", out["renames"], lambda m: f"{m['id']}: {m['from']!r} -> {m['to']!r}" + (" (old name added to aliases)" if m["alias_added"] else " (no alias)"))
    lst("PROPOSED PAIRS (decide each)", out["proposals"],
        lambda m: f"{m['saved']} {m['saved_name']!r} ({m['saved_bonus']}, {m['saved_status']}) <- file {m['file']!r} ({m['bonus']}) line {m['lines'][0]}: {m['why']}")
    lst("Category clashes", out["clashes"], lambda m: f"{m['merchant']}: {json.dumps(m['categories'], ensure_ascii=False)}")
    lst("New merchants needing a category", out["need_category"], lambda m: m)
    lst("Categories marked unsure in the decisions file (tell the owner)", out["unsure_categories"], lambda m: m)
    lst("Not in this file but read by an earlier part of this batch (--complete-parts; not missing)", out["from_earlier_parts"],
        lambda m: f"{m['id']} | {m['merchant']}")
    lst("New active Dining merchants with no cuisine (cuisines.py sync puts them on to_classify)", out["new_dining"],
        lambda m: m["merchant"] + (" (already on to_classify)" if m["already_on_to_classify"] else ""))
    lst("Cuisine entries following a rename that adds no alias", out["cuisine_moves"],
        lambda m: f"{m['from']!r} -> {m['to']!r} ({'moved' if m['how'] == 'move' else 'copied: the old name is still on other Dining offers'})")
    lst("Other offers expired by date (cleanup)", out["expired"], lambda m: f"{m['id']} (expires {m['expires']})")
    lst("Deleted by the 30-day cleanup", out["deleted"], lambda m: f"{m['id']} ({m['status']} since {m['since']})")
    lst("Row notes", out["flags"], lambda m: m)
    ch = out["changes"]
    p(f"\nField changes on saved offers: {json.dumps(ch['fields'], sort_keys=True) or '{}'}; "
      f"notes added {ch['notes_added']}, removed {ch['notes_removed']}")
    p("\nStop conditions (CLAUDE.md, Refreshing a card):")
    if not out["stops"]:
        p("  none")
    for st in out["stops"]:
        p(f"  {'approved by the owner' if st['owner_approved'] else 'STOP, ask the owner'}: {st['text']}")
    if out["proposals"]:
        p("  decide the proposed pairs (web lookups as CLAUDE.md says; still doubtful after lookups = STOP, ask the owner)")
    p("\nApply: " + ("ready" if not out["blockers"] else "blocked: " + "; ".join(out["blockers"])))


def template(out):
    return {"card": out["card"], "read_date": out["read_date"],
            "pairs": [{"saved": m["saved"], "file": m["file"], "bonus": m["bonus"], "accept": None, "why": m["why"]}
                      for m in out["proposals"]],
            "categories": {n: None for n in out["need_category"]},
            "clashes": {c["merchant"]: None for c in out["clashes"]},
            "new_names": {}, "owner_approved": []}


def run(cmd):
    r = subprocess.run([sys.executable] + cmd, cwd=ROOT, capture_output=True, text=True)
    return r.returncode, (r.stdout + r.stderr).strip()


def apply(card, paths, given_date, decisions, part, complete_parts=False):
    new, out, moves = plan(card, paths, given_date, decisions, part, complete_parts)
    show(out)
    if out["blockers"]:
        raise Refused("not applied: " + "; ".join(out["blockers"]))
    offers_text = OFFERS.read_text()
    cuisines_text = CUISINES.read_text() if CUISINES.exists() else None
    edits = DATA / "phone-edits.json"
    edits_text = edits.read_text() if edits.exists() else None
    try:
        OFFERS.write_text(json.dumps(new, indent=2, ensure_ascii=False) + "\n")
        if moves and cuisines_text is not None:
            import cuisines as cu
            c = json.loads(cuisines_text)
            for a, b, how in moves:
                # a renamed merchant keeps its cuisine: never re-classified by a refresh
                c["merchants"][b] = c["merchants"].pop(a) if how == "move" else copy.deepcopy(c["merchants"][a])
            cu.write(c)
        code, txt = run(["tools/cuisines.py", "sync"])
        print(mask("\ncuisines.py sync:\n" + txt))
        if code:
            raise Refused("cuisines.py sync failed")
        code, txt = run(["tools/validate.py"])
        print(mask("\nvalidate.py:\n" + txt))
        if code:
            raise Refused("validate.py failed")
    except BaseException:
        OFFERS.write_text(offers_text)
        if cuisines_text is not None:
            CUISINES.write_text(cuisines_text)
        print("\nNothing kept: offers.json and cuisines.json put back.")
        raise
    if (edits.read_text() if edits.exists() else None) != edits_text:
        raise Refused("phone-edits.json changed during the run (it must never be written by a refresh)")
    print(f"\nApplied: {card} read {out['read_date']}" + (" (part; no missing, no batches entry)" if part else ""))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=["report", "apply"])
    ap.add_argument("csv", nargs="+")
    ap.add_argument("--card", required=True, choices=list(ADAPTERS))
    ap.add_argument("--read-date")
    ap.add_argument("--decisions")
    ap.add_argument("--template")
    ap.add_argument("--json")
    ap.add_argument("--part", action="store_true", help="save one part of a multi-part batch")
    ap.add_argument("--complete-parts", action="store_true",
                    help="batch complete after --part runs: offers already read on this date count as in the batch")
    a = ap.parse_args(argv)
    try:
        if a.mode == "report":
            if a.decisions:
                decisions = json.loads(Path(a.decisions).read_text())
            else:
                decisions = None
            if a.part and a.complete_parts:
                raise Refused("--part and --complete-parts do not go together")
            _, out, _ = plan(a.card, a.csv, a.read_date, decisions, a.part, a.complete_parts)
            show(out)
        else:
            if not a.decisions:
                raise Refused("apply needs --decisions (write one with report --template; an empty plan still needs card and read_date)")
            if a.part and a.complete_parts:
                raise Refused("--part and --complete-parts do not go together")
            out = apply(a.card, a.csv, a.read_date, json.loads(Path(a.decisions).read_text()), a.part, a.complete_parts)
        if a.json:
            Path(a.json).write_text(mask(json.dumps(out, indent=2, ensure_ascii=False)) + "\n")
        if a.template and a.mode == "report":
            Path(a.template).write_text(mask(json.dumps(template(out), indent=2, ensure_ascii=False)) + "\n")
            print(f"\nDecisions template written: {a.template}")
    except Refused as e:
        print(mask(f"\nREFUSED: {e}"), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())

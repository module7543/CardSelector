#!/usr/bin/env python3
"""Check site/data/offers.json against OFFER_RECORD.md. Exits non-zero on problems."""
import json, re, sys, unicodedata
from datetime import date
from pathlib import Path

PATH = Path(__file__).resolve().parent.parent / "site/data/offers.json"
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
STATUS = {"active", "missing", "expired", "used"}
ACTIVATION = {"needs_activation", "already_activated", "auto_enrolled", "via_shop_link", "none_shown"}
CHANNEL = {"in_store", "online", "pay_at_pump", "in_store_and_online", "in_store_and_app", "none_shown"}
STR_OR_NULL = ("expires_text", "spend_cap", "minimum_spend", "fine_print")

def compact(s):
    """Same normalisation as the phone page's search: no accents, lowercase, letters and digits only."""
    s = "".join(c for c in unicodedata.normalize("NFD", s) if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]", "", s.lower())

errors = []
data = json.loads(PATH.read_text())
CATEGORIES = data.get("categories")
if not (isinstance(CATEGORIES, list) and CATEGORIES and all(isinstance(c, str) and c for c in CATEGORIES)
        and len(set(CATEGORIES)) == len(CATEGORIES)):
    errors.append("categories must be a non-empty list of unique strings")
    CATEGORIES = []
seen = set()
merchant_category = {}
# Different businesses whose names match loosely; each spelling is checked on its own.
CATEGORY_EXCEPTIONS = {compact("Alibaba")}  # Alibaba (Capital One marketplace) vs Ali Baba (Bank of America restaurant)
for o in data["offers"]:
    i = o.get("id", "<no id>")
    def bad(msg): errors.append(f"{i}: {msg}")
    if i in seen: bad("duplicate id")
    seen.add(i)
    for k in ("id", "card", "merchant", "bonus"):
        if not isinstance(o.get(k), str) or not o[k]: bad(f"{k} must be a non-empty string")
    if "/" not in str(i): bad("id must be card-slug/merchant-slug")
    cat = o.get("category")
    if cat not in CATEGORIES: bad(f"category {cat!r} is not in the fixed category list")
    else:
        # Same merchant = same category, compared like search (case, accents, spaces, punctuation ignored).
        key = compact(str(o.get("merchant")))
        if key in CATEGORY_EXCEPTIONS: key = (key, o.get("merchant"))
        seen_name, seen_cat = merchant_category.setdefault(key, (o.get("merchant"), cat))
        if seen_cat != cat:
            bad(f"merchant {o.get('merchant')!r} has category {cat!r} here but {seen_name!r} has {seen_cat!r}")
    for k in ("last_read", "first_seen", "status_since"):
        if not DATE.match(str(o.get(k))): bad(f"{k} must be YYYY-MM-DD")
    if o.get("expires") is not None and not DATE.match(str(o["expires"])): bad("expires must be YYYY-MM-DD or null")
    for k in STR_OR_NULL:
        if k not in o or not (o[k] is None or isinstance(o[k], str)): bad(f"{k} must be string or null")
    if o.get("activation") not in ACTIVATION: bad("bad activation")
    if o.get("channel") not in CHANNEL: bad("bad channel")
    if o.get("status") not in STATUS: bad("bad status")
    if not isinstance(o.get("other_details"), list): bad("other_details must be a list")
    # aliases: optional extra names the search matches (earlier names, alternate spellings); omitted when none.
    if "aliases" in o:
        al = o["aliases"]
        if not (isinstance(al, list) and al and all(isinstance(a, str) and compact(a) for a in al)):
            bad("aliases must be a non-empty list of names with letters or digits (omit the field if there are none)")
        else:
            keys = [compact(a) for a in al]
            if len(set(keys)) != len(keys): bad("duplicate alias")
            if compact(str(o.get("merchant"))) in keys: bad("alias repeats the merchant name")
    for t in o.get("other_details") or []:
        if isinstance(t, str) and re.match(r"(Earlier name|Name shown as)\b", t): bad(f"rename note {t!r} belongs in aliases")
for b in data["batches"]:
    if not DATE.match(str(b.get("read_date"))) or not b.get("card"): errors.append(f"bad batch {b}")
# The page's "Offer freshness" panel reads each card's newest batch read_date (the last complete read).
# Every card needs one, and a batch can't be dated after the newest offer it read.
newest_read, newest_batch = {}, {}
for o in data["offers"]:
    if DATE.match(str(o.get("last_read"))): newest_read[o["card"]] = max(newest_read.get(o["card"], ""), o["last_read"])
for b in data["batches"]:
    if DATE.match(str(b.get("read_date"))) and b.get("card"): newest_batch[b["card"]] = max(newest_batch.get(b["card"], ""), b["read_date"])
for card in sorted(newest_read):
    if card not in newest_batch: errors.append(f"{card}: no batches entry (the freshness panel would show Unknown)")
    elif newest_batch[card] > newest_read[card]:
        errors.append(f"{card}: newest batch read_date {newest_batch[card]} is after its newest offer last_read {newest_read[card]}")

# card-links.json: optional per-card offers-page address, keyed by the card nickname.
LINKS = PATH.parent / "card-links.json"
if LINKS.exists():
    links = json.loads(LINKS.read_text())
    if not isinstance(links, dict): errors.append("card-links.json must be an object keyed by card nickname")
    else:
        for card, entry in links.items():
            url = entry.get("url") if isinstance(entry, dict) else None
            if not (isinstance(url, str) and re.match(r"^https?://\S+$", url)):
                errors.append(f"card-links.json: {card!r} needs a url starting with http(s)://")

# cuisines.json: one cuisine per Dining merchant, keyed by merchant name (see OFFER_RECORD.md, Cuisines).
CUIS = PATH.parent / "cuisines.json"
notes = []
if CUIS.exists():
    cj = json.loads(CUIS.read_text())
    clist = cj.get("cuisines")
    if not (isinstance(clist, list) and all(isinstance(c, str) and c for c in clist)
            and len(set(clist)) == len(clist) and "Unclassified" in clist):
        errors.append("cuisines.json: cuisines must be a list of unique names including 'Unclassified'")
        clist = []
    entries = cj.get("merchants")
    if not isinstance(entries, dict): errors.append("cuisines.json: merchants must be an object"); entries = {}
    FIELDS = {"cuisine", "confidence", "detail", "evidence", "source", "checked", "locked"}
    by_key = {}
    for name, e in entries.items():
        def cbad(msg): errors.append(f"cuisines.json {name!r}: {msg}")
        k = compact(name)
        if not k: cbad("name needs letters or digits")
        elif k in by_key: cbad(f"same name as {by_key[k]!r} (ignoring case and punctuation)")
        by_key[k] = name
        if not isinstance(e, dict): cbad("must be an object"); continue
        if set(e) - FIELDS: cbad(f"unknown fields {sorted(set(e) - FIELDS)}")
        if e.get("cuisine") not in clist: cbad(f"cuisine {e.get('cuisine')!r} is not in the fixed list")
        if e.get("cuisine") == "Unclassified":
            if e.get("confidence") is not None: cbad("an Unclassified entry has confidence null")
        elif e.get("confidence") not in ("Confirmed", "Likely", "Unsure"): cbad("confidence must be Confirmed, Likely or Unsure")
        if "detail" in e and not (isinstance(e["detail"], str) and e["detail"].strip()): cbad("detail must be a non-empty string (omit it if none)")
        if not (isinstance(e.get("evidence"), str) and e["evidence"].strip()): cbad("evidence must be a non-empty string")
        if not (e.get("source") is None or (isinstance(e["source"], str) and e["source"].strip())): cbad("source must be a string or null")
        if not DATE.match(str(e.get("checked"))): cbad("checked must be YYYY-MM-DD")
        if not isinstance(e.get("locked"), bool): cbad("locked must be true or false")
    todo = cj.get("to_classify")
    if not (isinstance(todo, list) and all(isinstance(n, str) for n in todo)):
        errors.append("cuisines.json: to_classify must be a list of names"); todo = []
    todo_keys = {}
    for n in todo:
        if compact(n) in todo_keys: errors.append(f"cuisines.json: {n!r} is on to_classify twice")
        todo_keys[compact(n)] = n
    used = set()
    # Entries apply to Dining offers only: "Ali Baba" (restaurant) must not tag Capital One's "Alibaba" (marketplace).
    for o in data["offers"]:
        if o.get("category") != "Dining": continue
        hit = sorted({by_key[compact(n)] for n in [o["merchant"]] + o.get("aliases", []) if compact(n) in by_key})
        used.update(hit)
        if len(hit) > 1:
            errors.append(f"{o['id']}: its name and aliases match more than one cuisine entry {hit}")
        if o.get("status") == "active":
            k = compact(o["merchant"])
            if hit and k in todo_keys:
                errors.append(f"{o['id']}: tagged but still on to_classify")
            elif not hit and k not in todo_keys:
                errors.append(f"{o['id']}: active Dining merchant {o['merchant']!r} has no cuisine and is not on to_classify "
                              "(run python3 tools/cuisines.py sync)")
    active_dining = {compact(o["merchant"]) for o in data["offers"] if o.get("category") == "Dining" and o.get("status") == "active"}
    for k, n in todo_keys.items():
        if k not in active_dining: errors.append(f"cuisines.json: {n!r} is on to_classify but is not an active Dining merchant (run sync)")
        elif k in by_key: errors.append(f"cuisines.json: {n!r} is on to_classify but already has an entry")
    for name in entries:
        if name not in used: notes.append(f"note: cuisine entry {name!r} matches no Dining offer now (kept on purpose)")

# bonus-categories.json: card bonus categories shown in the strip and as search rows (CLAUDE.md, Bonus categories).
BONUS = PATH.parent / "bonus-categories.json"
bonus_entries = []
if BONUS.exists():
    bj = json.loads(BONUS.read_text())
    def bbad(msg): errors.append(f"bonus-categories.json: {msg}")
    cuisine_names = set(json.loads(CUIS.read_text()).get("cuisines", [])) if CUIS.exists() else set()
    lists = bj.get("keyword_lists")
    if not isinstance(lists, dict): bbad("keyword_lists must be an object"); lists = {}
    for ln, l in lists.items():
        kws = l.get("keywords") if isinstance(l, dict) else None
        if not (isinstance(kws, list) and kws and all(isinstance(k, str) and compact(k) for k in kws)):
            bbad(f"list {ln!r}: keywords must be a non-empty list of names"); continue
        if len({compact(k) for k in kws}) != len(kws): bbad(f"list {ln!r}: a keyword is listed twice")
        mnc = l.get("may_not_count", {})
        if not isinstance(mnc, dict): bbad(f"list {ln!r}: may_not_count must be an object")
        else:
            for k, why in mnc.items():
                if k not in kws: bbad(f"list {ln!r}: may_not_count {k!r} is not one of its keywords")
                if not (isinstance(why, str) and why.strip()): bbad(f"list {ln!r}: may_not_count {k!r} needs a reason")
        ex = l.get("exclude", [])
        if not (isinstance(ex, list) and all(isinstance(k, str) and compact(k) for k in ex)): bbad(f"list {ln!r}: exclude must be a list of names")
        elif {compact(k) for k in ex} & {compact(k) for k in kws}: bbad(f"list {ln!r}: a name is both a keyword and excluded")
        # full_name: a keyword counts only once all its words are typed ("costco ga" hits "Costco Gas", "costco" does not).
        if "full_name" in l and not isinstance(l["full_name"], bool): bbad(f"list {ln!r}: full_name must be true or false")
    cards = {o["card"] for o in data["offers"]}
    bonus_entries = bj.get("entries")
    if not isinstance(bonus_entries, list): bbad("entries must be a list"); bonus_entries = []
    ids = set()
    today = date.today().isoformat()
    entry_cards = {e.get("card") for e in bonus_entries if isinstance(e, dict)}
    if sum(1 for e in bonus_entries if isinstance(e, dict) and e.get("everyday")) > 1: bbad("only one entry can be everyday")
    for e in bonus_entries:
        eid = e.get("id", "<no id>")
        def ebad(msg): bbad(f"{eid}: {msg}")
        if eid in ids: ebad("duplicate id")
        ids.add(eid)
        for f in ("id", "card", "categories_text", "cap_text", "source_url", "checked"):
            if not (isinstance(e.get(f), str) and e[f].strip()): ebad(f"{f} must be a non-empty string")
        for f in ("card", "app_card"):
            if re.search(r"\d{4}", str(e.get(f, ""))): ebad(f"{f} has a run of 4 digits (nicknames only, never card numbers)")
        # app_card null = a card with no offers in the app (Costco Visa): its rows show only with no card filter.
        if e.get("app_card") is not None and e.get("app_card") not in cards: ebad(f"app_card {e.get('app_card')!r} is not a card in offers.json (or null for a card with no offers)")
        if e.get("kind") not in ("rotating", "top_category", "chosen", "fixed"): ebad("kind must be rotating, top_category, chosen or fixed")
        st, en = e.get("start"), e.get("end")
        if (st is None) != (en is None): ebad("start and end must both be dates or both null")
        elif st is not None:
            if not (DATE.match(str(st)) and DATE.match(str(en))): ebad("start and end must be YYYY-MM-DD")
            elif st > en: ebad("start is after end")
            elif en < today: notes.append(f"note: bonus entry {eid} ended {en} (hidden on the page; refresh due)")
        if e.get("kind") == "rotating" and st is None: ebad("a rotating entry needs start and end dates")
        def is_rate(r): return isinstance(r, (int, float)) and not isinstance(r, bool) and 0 < r <= 100
        if not is_rate(e.get("rate")):
            # A card earning several rates at once sets rate null and a rate on every match group.
            gs = e.get("match") if isinstance(e.get("match"), list) else []
            if not (e.get("rate") is None and e.get("kind") == "fixed" and gs and all(isinstance(g, dict) and is_rate(g.get("rate")) for g in gs)):
                ebad("rate must be a number (percent); null only for a fixed entry whose match groups each have a rate")
        if e.get("activation") not in ("not_confirmed", "activated", "not_needed"): ebad("activation must be not_confirmed, activated or not_needed")
        ab = e.get("activate_by")
        if ab is not None:
            if not DATE.match(str(ab)): ebad("activate_by must be YYYY-MM-DD or null")
            elif en and ab > en: ebad("activate_by is after the entry's end date")
        if e.get("activation") == "not_confirmed" and ab is None: ebad("a not_confirmed entry needs activate_by")
        for f in ("activation_note", "likely_note", "strip_note", "unconfirmed", "short", "eligible_text"):
            if not (e.get(f) is None or (isinstance(e[f], str) and e[f].strip())): ebad(f"{f} must be a non-empty string or null")
        if not str(e.get("source_url", "")).startswith("https://"): ebad("source_url must start with https://")
        if not DATE.match(str(e.get("checked"))): ebad("checked must be YYYY-MM-DD")
        if not isinstance(e.get("search"), bool): ebad("search must be true or false")
        groups = e.get("match")
        if not isinstance(groups, list): ebad("match must be a list"); groups = []
        # Top-category cards list every eligible category; the page matches only the planned one.
        elig = e.get("eligible")
        if elig is not None:
            if not (isinstance(elig, list) and elig and all(isinstance(g, dict) for g in elig)): ebad("eligible must be a non-empty list of categories"); elig = []
            names = [g.get("name") for g in elig]
            if len(set(names)) != len(names): ebad("eligible has a category listed twice")
            for g in elig:
                if not (isinstance(g.get("topic"), str) and g["topic"].strip()): ebad(f"eligible {g.get('name')!r}: topic must be a non-empty string")
            if e.get("planned") not in names: ebad(f"planned {e.get('planned')!r} must be one of the eligible categories {names}")
            if groups: ebad("an entry with eligible categories gets its match from planned; leave match empty")
        elif "planned" in e: ebad("planned needs an eligible list")
        # Chosen-category cards (Customized Cash) list every choice; the page adds the current choice to match,
        # at the entry's rate, next to the fixed groups (which carry their own rates).
        choices = e.get("choices")
        if choices is not None:
            if not (isinstance(choices, list) and choices and all(isinstance(g, dict) for g in choices)): ebad("choices must be a non-empty list of categories"); choices = []
            cnames = [g.get("name") for g in choices]
            if len(set(cnames)) != len(cnames): ebad("choices has a category listed twice")
            for g in choices:
                if not (isinstance(g.get("topic"), str) and g["topic"].strip()): ebad(f"choice {g.get('name')!r}: topic must be a non-empty string")
                if "rate" in g: ebad(f"choice {g.get('name')!r}: a choice pays the entry's rate (no rate of its own)")
            if e.get("choice") not in cnames: ebad(f"choice {e.get('choice')!r} must be one of the choices {cnames}")
            if not (isinstance(e.get("choices_text"), str) and e["choices_text"].strip()): ebad("choices_text must be a non-empty string")
            for g in groups:
                if isinstance(g, dict) and "rate" not in g: ebad(f"match {g.get('name')!r}: next to choices, each fixed group needs its own rate")
        elif "choice" in e: ebad("choice needs a choices list")
        # everyday: the card used when no bonus beats it (Smartly). It matches everything, so it has no match groups.
        if "everyday" in e and not isinstance(e["everyday"], bool): ebad("everyday must be true or false")
        if e.get("everyday"):
            if e.get("kind") != "fixed" or not is_rate(e.get("rate")): ebad("an everyday entry must be kind fixed with a rate")
            if groups or elig: ebad("an everyday entry has no match groups or eligible list (it applies everywhere)")
            if st is not None: ebad("an everyday entry has no start or end date")
        if not (e.get("headline_note") is None or (isinstance(e["headline_note"], str) and e["headline_note"].strip())): ebad("headline_note must be a non-empty string or null")
        if e.get("search") and not groups and not elig and not e.get("everyday"): ebad("search is true but match is empty")
        for g in groups + list(elig or []) + list(choices or []):
            if not (isinstance(g, dict) and isinstance(g.get("name"), str) and g["name"].strip()): ebad("each match group needs a name"); continue
            cats = g.get("app_categories", [])
            if not isinstance(cats, list) or any(c not in CATEGORIES for c in cats): ebad(f"match {g['name']!r}: app_categories must be app category names")
            bc = g.get("button_categories")
            if bc is not None and not (isinstance(bc, list) and bc and all(c in CATEGORIES for c in bc)):
                ebad(f"match {g['name']!r}: button_categories must be a non-empty list of app category names")
            if not (g.get("button_note") is None or (isinstance(g["button_note"], str) and g["button_note"].strip())):
                ebad(f"match {g['name']!r}: button_note must be a non-empty string or omitted")
            if g.get("button_note") and not (bc or cats): ebad(f"match {g['name']!r}: button_note needs button_categories")
            gl = g.get("list")
            if gl is not None:
                gl_names = gl if isinstance(gl, list) else [gl]
                if not (gl_names and all(isinstance(n, str) and n in lists for n in gl_names)): ebad(f"match {g['name']!r}: unknown keyword list {gl!r}")
            if "rate" in g and not is_rate(g["rate"]): ebad(f"match {g['name']!r}: rate must be a number (percent)")
            if not (g.get("rate_note") is None or (isinstance(g["rate_note"], str) and g["rate_note"].strip())):
                ebad(f"match {g['name']!r}: rate_note must be a non-empty string or omitted")
            if "notes" in g and not (isinstance(g["notes"], list) and g["notes"] and all(isinstance(n, str) and n.strip() for n in g["notes"])):
                ebad(f"match {g['name']!r}: notes must be a non-empty list of strings or omitted")
            # channel: an offer whose channel is this (online-only merchants) counts too.
            if g.get("channel") is not None and g["channel"] not in CHANNEL: ebad(f"match {g['name']!r}: unknown channel {g['channel']!r}")
            if not cats and g.get("list") is None: ebad(f"match {g['name']!r}: needs app_categories or a keyword list")
            hn = g.get("headline_notes")
            if hn is not None and not (isinstance(hn, dict) and hn and all(c in entry_cards and isinstance(t, str) and t.strip() for c, t in hn.items())):
                ebad(f"match {g['name']!r}: headline_notes must map bonus entry card names to text")
            cu = list(g.get("exclude_cuisines", [])) + list(g.get("caveat_cuisines", {}) or {})
            if cu and "Dining" not in cats: ebad(f"match {g['name']!r}: cuisine rules need app_categories Dining")
            if cuisine_names and any(c not in cuisine_names for c in cu): ebad(f"match {g['name']!r}: unknown cuisine in exclude_cuisines / caveat_cuisines")
            for c, t in (g.get("caveat_cuisines") or {}).items():
                if not (isinstance(t, str) and t.strip()): ebad(f"match {g['name']!r}: caveat for {c!r} needs text")
    if bonus_entries and not any(e.get("kind") == "rotating" and e.get("start") and e["start"] <= today <= e["end"] for e in bonus_entries):
        notes.append("note: no quarterly bonus entry is live today (refresh due)")

# cards.json: what each card earns with no merchant offer, and which cards each offer list pays on
# (CLAUDE.md, "Use:" headline). Checked like the bonus file.
CARDS = PATH.parent / "cards.json"
card_defs = []
if CARDS.exists():
    cj = json.loads(CARDS.read_text())
    def cbad(msg): errors.append(f"cards.json: {msg}")
    def is_rate(r): return isinstance(r, (int, float)) and not isinstance(r, bool) and 0 < r <= 100
    blists = json.loads(BONUS.read_text()).get("keyword_lists", {}) if BONUS.exists() else {}
    bcards = {e.get("card") for e in bonus_entries if isinstance(e, dict)}
    card_defs = cj.get("cards")
    if not isinstance(card_defs, list) or not card_defs: cbad("cards must be a non-empty list"); card_defs = []
    names = set()
    for c in card_defs:
        n = c.get("name") if isinstance(c, dict) else None
        def kbad(msg): cbad(f"{n!r}: {msg}")
        if not (isinstance(n, str) and n.strip()): cbad("each card needs a name"); continue
        if n in names: kbad("listed twice")
        names.add(n)
        if re.search(r"\d{4}", n): kbad("name has a run of 4 digits (nicknames only, never card numbers)")
        if not is_rate(c.get("base_rate")): kbad("base_rate must be a number (percent)")
        if c.get("bonus_card") is not None and c["bonus_card"] not in bcards: kbad(f"bonus_card {c['bonus_card']!r} is not a card in bonus-categories.json (or null)")
        if not str(c.get("source_url", "")).startswith("https://"): kbad("source_url must start with https://")
        if not (isinstance(c.get("source"), str) and c["source"].strip()): kbad("source must be a non-empty string")
        if not DATE.match(str(c.get("checked"))): kbad("checked must be YYYY-MM-DD")
        st = c.get("standing")
        if not isinstance(st, list): kbad("standing must be a list (empty for none)"); st = []
        for g in st:
            gn = g.get("name") if isinstance(g, dict) else None
            if not (isinstance(gn, str) and gn.strip()): kbad("each standing group needs a name"); continue
            if not is_rate(g.get("rate")): kbad(f"standing {gn!r}: rate must be a number (percent)")
            cats = g.get("app_categories", [])
            if not isinstance(cats, list) or any(x not in CATEGORIES for x in cats): kbad(f"standing {gn!r}: app_categories must be app category names")
            if g.get("list") is not None and g["list"] not in blists: kbad(f"standing {gn!r}: unknown keyword list {g['list']!r}")
            kw = g.get("keywords")
            if kw is not None and not (isinstance(kw, list) and kw and all(isinstance(k, str) and compact(k) for k in kw)): kbad(f"standing {gn!r}: keywords must be a non-empty list of names")
            if g.get("channel") is not None and g["channel"] not in CHANNEL: kbad(f"standing {gn!r}: unknown channel {g['channel']!r}")
            if not (cats or g.get("list") or kw or g.get("channel")): kbad(f"standing {gn!r}: needs app_categories, a list, keywords or a channel")
            if g.get("exclude_cuisines") and "Dining" not in cats: kbad(f"standing {gn!r}: exclude_cuisines needs app_categories Dining")
    # preferred_rewards: Bank of America's boost on the named cards' rates, percent through "until", then then_percent.
    pr = cj.get("preferred_rewards")
    if pr is not None:
        def pbad(msg): cbad(f"preferred_rewards: {msg}")
        if not isinstance(pr, dict): pbad("must be an object"); pr = {}
        prc = pr.get("cards")
        if not (isinstance(prc, list) and prc and all(x in names for x in prc)): pbad("cards must list card names from cards")
        for f in ("percent", "then_percent"):
            v = pr.get(f)
            if not (isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v <= 100): pbad(f"{f} must be a number from 0 to 100")
        if not DATE.match(str(pr.get("until"))): pbad("until must be YYYY-MM-DD")
        elif pr["until"] < date.today().isoformat():
            notes.append(f"note: Preferred Rewards {pr.get('percent')}% ended {pr['until']}; the page now uses {pr.get('then_percent')}% (update cards.json if the tier or date changed)")
        if not DATE.match(str(pr.get("checked"))): pbad("checked must be YYYY-MM-DD")
        if not (isinstance(pr.get("note"), str) and pr["note"].strip()): pbad("note must be a non-empty string")
    ol = cj.get("offer_lists")
    if not isinstance(ol, dict): cbad("offer_lists must be an object keyed by the card name in offers.json"); ol = {}
    for app, l in ol.items():
        def lbad(msg): cbad(f"offer list {app!r}: {msg}")
        if app not in {o["card"] for o in data["offers"]}: lbad("is not a card in offers.json")
        if not (isinstance(l, dict) and isinstance(l.get("cards"), list) and l["cards"] and all(x in names for x in l["cards"])): lbad("cards must list card names from cards"); continue
        if l.get("activation") not in ("stored", "add_to_card"): lbad("activation must be stored or add_to_card")
        if not (isinstance(l.get("label"), str) and l["label"].strip()): lbad("label must be a non-empty string")
        # row_name: the cards a shared offer list stands for, shown on each offer ("Quicksilver / Discover it").
        if l.get("row_name") is not None and not (isinstance(l["row_name"], str) and l["row_name"].strip()): lbad("row_name must be a non-empty string")
        if re.search(r"\d{4}", str(l.get("row_name", ""))): lbad("row_name has a run of 4 digits (nicknames only)")
    for app in sorted({o["card"] for o in data["offers"]} - set(ol)): cbad(f"offer list missing for {app!r} (its offers would never reach the headline)")

# phone-edits.json: pending phone edits to offers, keyed by offer id (site/js/edits.js); folded into offers.json
# by the Fold phone edits workflow. Optional: a missing file means no pending edits.
EDITS = PATH.parent / "phone-edits.json"
pending = {}
if EDITS.exists():
    def ebad(msg): errors.append(f"phone-edits.json: {msg}")
    etext = EDITS.read_text()
    try: pending = json.loads(etext)
    except ValueError as ex: ebad(f"not valid JSON ({ex})"); pending = {}
    if not isinstance(pending, dict): ebad("must be an object keyed by offer id"); pending = {}
    elif json.dumps(pending, indent=2, ensure_ascii=False) + "\n" != etext:
        ebad("not in the standard layout (2-space JSON and a final newline), so a phone save would refuse it")
    # Cards that stand for two of the owner's cards: "Used on" names one of them (same as USED_ON in edits.js).
    USED_ON = {"Capital One": ["Quicksilver", "Discover it"], "U.S. Bank": ["Cash+", "Smartly"],
               "Bank of America": ["Customized Cash Rewards", "Unlimited Cash Rewards"]}
    SWITCH = ("needs_activation", "already_activated")
    by_id = {o.get("id"): o for o in data["offers"]}
    for oid, e in pending.items():
        def pbad(msg): ebad(f"{oid}: {msg}")
        o = by_id.get(oid)
        if o is None: pbad("no offer with this id in offers.json (an offer with a pending phone edit must keep its id until the Fold phone edits workflow has run)"); continue
        if not (isinstance(e, dict) and e): pbad("must be a non-empty object"); continue
        extra_keys = sorted(set(e) - {"status", "status_since", "used_on", "activation"})
        if extra_keys: pbad(f"unexpected field(s) {extra_keys}; only status, status_since, used_on, activation")
        if {"status", "status_since", "used_on"} & set(e):
            if e.get("status") not in ("active", "used"): pbad("status must be active or used (and comes with status_since)")
            ss = e.get("status_since")
            try: ok_date = bool(DATE.match(str(ss))) and bool(date.fromisoformat(ss))
            except ValueError: ok_date = False
            if not ok_date: pbad("status_since must be a real YYYY-MM-DD date")
            cards = USED_ON.get(o.get("card"))
            if e.get("status") == "used" and cards:
                if e.get("used_on") not in cards: pbad(f"used_on must be {' or '.join(cards)} for a used {o.get('card')} offer")
            elif "used_on" in e: pbad("used_on belongs only on a used Capital One, U.S. Bank or Bank of America offer")
        if "activation" in e:
            if e["activation"] not in SWITCH: pbad("activation must be needs_activation or already_activated")
            if o.get("activation") not in SWITCH: pbad(f"the phone can't switch activation {o.get('activation')!r}")

if errors:
    print("\n".join(errors)); sys.exit(1)
for n in notes: print(n)
extra = f", {len(entries)} cuisine entries, {len(todo)} to classify" if CUIS.exists() else ""
extra += f", {len(bonus_entries)} bonus entries" if BONUS.exists() else ""
extra += f", {len(card_defs)} cards" if CARDS.exists() else ""
extra += f", {len(pending)} pending phone edits" if EDITS.exists() else ""
print(f"OK: {len(data['offers'])} offers, {len(data['batches'])} batches{extra}")

#!/usr/bin/env python3
"""Keep site/data/cuisines.json in step with site/data/offers.json.

    python3 tools/cuisines.py sync            rebuild to_classify, report possible renames
    python3 tools/cuisines.py sync --rename   same, and move entries whose merchant was renamed

to_classify = every active Dining merchant with no cuisine entry (matched on the merchant name or
any alias, ignoring case, accents and punctuation; entries apply to Dining offers only). Entries
are never edited, except that --rename changes the name an entry is filed under. Entries whose merchant has left the data are
kept, so a merchant that comes back keeps its cuisine. The file is rewritten in a fixed format.
"""
import json, re, sys, unicodedata
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "site/data"
OFFERS, CUISINES = DATA / "offers.json", DATA / "cuisines.json"


def compact(s):
    """Same normalisation as the phone page's search: no accents, lowercase, letters and digits only."""
    s = "".join(c for c in unicodedata.normalize("NFD", s) if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]", "", s.lower())


def slug(s):
    """How offer ids were made from merchant names: 'Gaby's Cafe' -> 'gaby-s-cafe'."""
    s = "".join(c for c in unicodedata.normalize("NFD", s) if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def names(o):
    return [o["merchant"]] + o.get("aliases", [])


def write(c):
    """One entry per line so diffs stay readable."""
    out = ['{', '  "cuisines": ' + json.dumps(c["cuisines"], ensure_ascii=False) + ',', '  "merchants": {']
    keys = sorted(c["merchants"], key=lambda k: (k.lower(), k))
    for i, k in enumerate(keys):
        out.append("    " + json.dumps(k, ensure_ascii=False) + ": " +
                   json.dumps(c["merchants"][k], ensure_ascii=False) + ("," if i < len(keys) - 1 else ""))
    out.append('  },')
    out.append('  "to_classify": [')
    todo = c["to_classify"]
    for i, n in enumerate(todo):
        out.append("    " + json.dumps(n, ensure_ascii=False) + ("," if i < len(todo) - 1 else ""))
    out.append('  ]')
    out.append('}')
    CUISINES.write_text("\n".join(out) + "\n")


def sync(rename):
    offers = json.loads(OFFERS.read_text())["offers"]
    c = json.loads(CUISINES.read_text())
    entries = c["merchants"]
    dining = [o for o in offers if o["category"] == "Dining" and o["status"] == "active"]

    def tagged(o):
        return any(compact(n) in keys for n in names(o))

    keys = {compact(k) for k in entries}

    # Entries whose name no longer appears on any Dining offer. Offer ids keep the slug of the name the
    # offer was first saved under, so a renamed merchant can be found by its id.
    seen = {compact(n) for o in offers if o["category"] == "Dining" for n in names(o)}
    for key in [k for k in entries if compact(k) not in seen]:
        hits = sorted({o["merchant"] for o in dining if not tagged(o)
                       and re.sub(r"-\d+$", "", o["id"].split("/", 1)[1]) == slug(key)})
        if len(hits) == 1 and rename:
            entries[hits[0]] = entries.pop(key)
            keys = {compact(k) for k in entries}
            print(f"renamed: {key!r} -> {hits[0]!r}")
        elif hits:
            print(f"possible rename: {key!r} -> {hits} (run with --rename to move it)")
        else:
            print(f"kept, merchant not in the data now: {key!r}")

    old = set(c.get("to_classify", []))
    todo = {}
    for o in dining:
        if not tagged(o):
            todo.setdefault(compact(o["merchant"]), set()).add(o["merchant"])
    c["to_classify"] = sorted((min(v) for v in todo.values()), key=lambda n: (n.lower(), n))
    new = set(c["to_classify"])
    write(c)
    print(f"to_classify: {len(new)} ({len(new - old)} added, {len(old - new)} removed); "
          f"{len(entries)} cuisine entries")


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] != "sync":
        sys.exit(__doc__)
    sync("--rename" in sys.argv[2:])

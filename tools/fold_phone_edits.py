#!/usr/bin/env python3
"""Pending phone edits (site/data/phone-edits.json) on top of site/data/offers.json.

Folding (writing them into offers.json, then emptying phone-edits.json) runs only in the "Fold phone edits"
GitHub Actions workflow (.github/workflows/fold-phone-edits.yml, via tools/fold_on_main.sh), on main. Sessions
never fold and never write phone-edits.json; they read offers.json plus the pending edits with:

    import sys; sys.path.insert(0, "tools"); sys.dont_write_bytecode = True
    from fold_phone_edits import load_pending, with_pending
    pending = load_pending()            # {offer id: edit}
    offers = with_pending(data)         # copies of data["offers"] with the edits on top

Each edit lands exactly as a phone save wrote it into offers.json before phone edits had their own file
(site/js/edits.js): status and status_since; the "Used on <card>" note in other_details replaced (added when the
edit has used_on); activation. Folding twice changes nothing.

Command line: python3 tools/fold_phone_edits.py [data folder]. With no folder (the repo's own data) it refuses
unless run by the workflow (GITHUB_ACTIONS=true and FOLD_PHONE_EDITS=1). A folder argument is for test copies.
"""
import copy, json, os, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO_DATA = ROOT / "site/data"
EMPTY = "{}\n"


def dump(d):
    return json.dumps(d, indent=2, ensure_ascii=False) + "\n"


def apply_edit(o, e):
    """Puts one pending edit on an offer (changed in place)."""
    if "status" in e:
        o["status"] = e["status"]
        o["status_since"] = e["status_since"]
        notes = [t for t in (o.get("other_details") or []) if not (isinstance(t, str) and t.startswith("Used on "))]
        if e.get("used_on"):
            notes.append("Used on " + e["used_on"])
        o["other_details"] = notes
    if "activation" in e:
        o["activation"] = e["activation"]


def load_pending(data_dir=REPO_DATA):
    """The pending edits, {offer id: edit}; {} when the file is missing."""
    p = Path(data_dir) / "phone-edits.json"
    if not p.exists():
        return {}
    edits = json.loads(p.read_text())
    if not isinstance(edits, dict):
        raise ValueError("phone-edits.json must be an object keyed by offer id")
    return edits


def with_pending(data, pending=None):
    """Copies of data["offers"] with the pending edits on top: the offers as the phone page shows them."""
    pending = load_pending() if pending is None else pending
    out = []
    for o in data["offers"]:
        o = copy.deepcopy(o)  # every offer: changing the result never changes data
        if o.get("id") in pending:
            apply_edit(o, pending[o["id"]])
        out.append(o)
    return out


def fold(data_dir):
    """Writes the pending edits into offers.json and empties phone-edits.json. Returns how many were folded."""
    data_dir = Path(data_dir)
    offers_p, edits_p = data_dir / "offers.json", data_dir / "phone-edits.json"
    if not edits_p.exists():
        print("No phone-edits.json: nothing to fold.")
        return 0
    text = edits_p.read_text()
    edits = load_pending(data_dir)
    if not edits:
        if text != EMPTY:
            edits_p.write_text(EMPTY)
        print("No pending phone edits.")
        return 0
    data = json.loads(offers_p.read_text())
    by_id = {o.get("id"): o for o in data["offers"]}
    unknown = [i for i in edits if i not in by_id]
    if unknown:
        sys.exit("Not folded (nothing written): no offer with id " + ", ".join(unknown) + " in offers.json")
    for oid, e in edits.items():
        apply_edit(by_id[oid], e)
        print("folded", oid, json.dumps(e, ensure_ascii=False))
    offers_p.write_text(dump(data))
    edits_p.write_text(EMPTY)
    print(f"{len(edits)} phone edit(s) written into offers.json; phone-edits.json emptied.")
    return len(edits)


def main():
    if len(sys.argv) > 1:
        data_dir = Path(sys.argv[1])
        if data_dir.resolve() == REPO_DATA.resolve():
            sys.exit("Not folded: the folder argument is for test copies.")
    else:
        if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("FOLD_PHONE_EDITS") != "1":
            sys.exit("Not folded: the fold runs only in the 'Fold phone edits' GitHub Actions workflow. "
                     "Sessions never fold; read offers.json plus pending edits with with_pending().")
        data_dir = REPO_DATA
    fold(data_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Checks for tools/refresh.py:  python3 tools/refresh_test.py

Each check runs the tool in a throwaway copy of the repo layout: tools/ (refresh, validate, cuisines,
fold_phone_edits) and site/data/ holding the fixture snapshot (tools/fixtures/offers.json, cuisines.json: 45 offers
copied from offers.json on 2026-10-20) plus the repo's cards.json, bonus-categories.json, card-links.json and
merchant-locations.json (empty; checks that need groups write their own).
The fixture CSVs (tools/fixtures/*.csv) are in each issuer's real column format and reproduce the snapshot when
read on 2026-10-25 (Citi countdowns and Chase end timestamps are set for that date). Checks change a copy of a
CSV or of the snapshot, run report / apply, and compare. The repo's own data is never touched.
"""
import csv, io, json, os, re, shutil, subprocess, sys, tempfile, unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parent.parent
FIX = REPO / "tools/fixtures"
READ = "2026-10-25"
CSVS = {"Chase Freedom Flex": "chase_freedom_flex.csv", "Chase Freedom": "chase_freedom.csv", "U.S. Bank": "us_bank.csv",
        "Capital One": "capital_one.csv", "Bank of America": "bank_of_america.csv",
        "Citi Double Cash": "citi_double_cash.csv", "Citi Custom Cash": "citi_custom_cash.csv"}


class Tree:
    """A throwaway repo layout with the fixture data."""

    def __init__(self, edits=None):
        self.root = Path(tempfile.mkdtemp(prefix="refresh-test-"))
        (self.root / "tools").mkdir()
        data = self.root / "site/data"
        data.mkdir(parents=True)
        for f in ("refresh.py", "validate.py", "cuisines.py", "fold_phone_edits.py"):
            shutil.copy(REPO / "tools" / f, self.root / "tools" / f)
        for f in ("offers.json", "cuisines.json"):
            shutil.copy(FIX / f, data / f)
        for f in ("cards.json", "bonus-categories.json", "card-links.json", "merchant-locations.json"):
            shutil.copy(REPO / "site/data" / f, data / f)
        self.data = data
        self.write_json("phone-edits.json", edits or {})

    def close(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def read(self, name):
        return (self.data / name).read_text()

    def load(self, name="offers.json"):
        return json.loads(self.read(name))

    def write_json(self, name, d):
        (self.data / name).write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n")

    def offers(self):
        return {o["id"]: o for o in self.load()["offers"]}

    def change_offers(self, fn):
        d = self.load()
        fn({o["id"]: o for o in d["offers"]}, d)
        self.write_json("offers.json", d)

    def csv(self, card, fn=None, name=None, extra_cols=(), drop_cols=()):
        """A copy of the card's fixture CSV, rows changed by fn(rows) -> rows."""
        with open(FIX / CSVS[card], newline="", encoding="utf-8") as f:
            rd = csv.DictReader(f)
            cols, rows = [c for c in rd.fieldnames if c not in drop_cols] + list(extra_cols), list(rd)
        if fn:
            rows = fn(rows)
        p = self.root / (name or CSVS[card])
        with open(p, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            for r in rows:
                w.writerow({c: r.get(c, "") for c in cols})
        return p

    def run(self, mode, card, paths, read_date=READ, decisions=None, extra=(), dec_date=None):
        args = [sys.executable, str(self.root / "tools/refresh.py"), mode, "--card", card] + [str(p) for p in paths]
        if read_date:
            args += ["--read-date", read_date]
        if decisions is not None:
            dp = self.root / "decisions.json"
            dp.write_text(json.dumps({"card": card, "read_date": dec_date or read_date or READ, **decisions}))
            args += ["--decisions", str(dp)]
        jp = self.root / "report.json"
        if jp.exists():
            jp.unlink()
        args += ["--json", str(jp)] + list(extra)
        r = subprocess.run(args, cwd=self.root, capture_output=True, text=True)
        rep = json.loads(jp.read_text()) if jp.exists() else None
        return r.returncode, r.stdout + r.stderr, rep


class RefreshTest(unittest.TestCase):
    def setUp(self):
        self.t = Tree()

    def tearDown(self):
        self.t.close()

    def apply_ok(self, card, paths, decisions=None, **kw):
        code, out, rep = self.t.run("apply", card, paths, decisions=decisions or {}, **kw)
        self.assertEqual(code, 0, out)
        return out, rep

    # --- round trip ---------------------------------------------------------------------------------------------

    def test_no_change_round_trip_every_card(self):
        for card in CSVS:
            with self.subTest(card=card):
                before = self.t.offers()
                cuis, edits = self.t.read("cuisines.json"), self.t.read("phone-edits.json")
                p = self.t.csv(card)
                code, out, rep = self.t.run("report", card, [p])
                self.assertEqual(code, 0, out)
                self.assertEqual((len(rep["new"]), len(rep["bonus_changes"]), len(rep["missing"]), len(rep["proposals"])),
                                 (0, 0, 0, 0), out)
                self.assertEqual(rep["blockers"], [], out)
                self.assertEqual(self.t.offers(), before, "report must change nothing")
                self.apply_ok(card, [p])
                after = self.t.offers()
                self.assertEqual(set(after), set(before))
                for i, o in after.items():
                    b = dict(before[i])
                    if o["card"] == card:
                        self.assertEqual(o["last_read"], READ, i)
                        b["last_read"] = READ
                    self.assertEqual(o, b, f"{i}: only last_read may move")
                bt = [x for x in self.t.load()["batches"] if x["card"] == card]
                self.assertEqual(bt[-1], {"card": card, "read_date": READ, "offers_found": sum(1 for o in after.values() if o["card"] == card)})
                self.assertEqual(self.t.read("cuisines.json"), cuis)
                self.assertEqual(self.t.read("phone-edits.json"), edits)

    # --- snapshot rule ------------------------------------------------------------------------------------------

    def test_dropped_offer_becomes_missing(self):
        p = self.t.csv("Chase Freedom Flex", lambda rows: [r for r in rows if r["merchant"] != "Babbel"])
        code, out, rep = self.t.run("report", "Chase Freedom Flex", [p])
        self.assertEqual([m["id"] for m in rep["missing"]], ["chase-freedom-flex/babbel"], out)
        self.apply_ok("Chase Freedom Flex", [p])
        o = self.t.offers()["chase-freedom-flex/babbel"]
        self.assertEqual((o["status"], o["status_since"], o["last_read"], o["first_seen"]), ("missing", READ, "2026-10-18", "2026-10-18"))

    def test_used_offer_absent_stays_used(self):
        self.t.change_offers(lambda by, d: by["capital-one/pura-vida"].update(status="used", status_since="2026-10-20"))
        p = self.t.csv("Capital One", lambda rows: [r for r in rows if r["merchant"] != "Pura Vida"])
        code, out, rep = self.t.run("report", "Capital One", [p])
        self.assertEqual(rep["missing"], [], out)
        self.assertIn("capital-one/pura-vida", [m["id"] for m in rep["stays_used"]])
        self.apply_ok("Capital One", [p])
        o = self.t.offers()["capital-one/pura-vida"]
        self.assertEqual((o["status"], o["status_since"]), ("used", "2026-10-20"))

    def test_used_offer_in_batch_stays_used(self):
        self.t.change_offers(lambda by, d: by["chase-freedom/whisker"].update(status="used", status_since="2026-10-20"))
        self.apply_ok("Chase Freedom", [self.t.csv("Chase Freedom")])
        o = self.t.offers()["chase-freedom/whisker"]
        self.assertEqual((o["status"], o["status_since"], o["last_read"]), ("used", "2026-10-20", READ))

    def test_missing_offer_reappears_active(self):
        self.t.change_offers(lambda by, d: by["bank-of-america/trust-will"].update(status="missing", status_since="2026-10-20"))
        out, rep = self.apply_ok("Bank of America", [self.t.csv("Bank of America")])
        self.assertEqual([m["id"] for m in rep["returning"]], ["bank-of-america/trust-will"])
        o = self.t.offers()["bank-of-america/trust-will"]
        self.assertEqual((o["status"], o["status_since"], o["first_seen"]), ("active", READ, "2026-10-18"))

    def test_bonus_change_on_same_offer(self):
        def fn(rows):
            for r in rows:
                if r["merchant"] == "Pura Vida":
                    r["bonus"] = "Spend $20, earn $20"
            return rows
        p = self.t.csv("Capital One", fn)
        code, out, rep = self.t.run("report", "Capital One", [p])
        self.assertEqual([(m["id"], m["to"]) for m in rep["bonus_changes"]], [("capital-one/pura-vida", "Spend $20, earn $20")], out)
        self.assertEqual((rep["new"], rep["missing"]), ([], []))
        self.apply_ok("Capital One", [p])
        o = self.t.offers()["capital-one/pura-vida"]
        self.assertEqual((o["bonus"], o["first_seen"], o["status"]), ("Spend $20, earn $20", "2026-10-18", "active"))

    def test_dollar_and_percent_stay_separate(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("refresh_mod", self.t.root / "tools/refresh.py")
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        self.assertNotEqual(m.bonus_key("7% back"), m.bonus_key("$7 back"))
        self.assertEqual(m.bonus_key("7% cash back"), m.bonus_key("7% Back"))

        def add(by, d):
            o = dict(by["capital-one/pura-2"], id="capital-one/pura-3", bonus="$2 back")
            d["offers"].append(o)
        self.t.change_offers(add)

        def fn(rows):
            r = dict(next(r for r in rows if r["merchant"] == "Pura" and r["bonus"] == "2% back"), bonus="$2 back")
            return rows + [r]
        p = self.t.csv("Capital One", fn)
        code, out, rep = self.t.run("report", "Capital One", [p])
        self.assertEqual((rep["bonus_changes"], rep["new"], rep["missing"]), ([], [], []), out)
        self.assertEqual([m for m in rep["paired"] if m["id"].startswith("capital-one/pura")], [])
        got = {m["id"]: m["bonus"] for m in rep["matched"] if m["id"] in ("capital-one/pura-2", "capital-one/pura-3")}
        self.assertEqual(got, {"capital-one/pura-2": "2% back", "capital-one/pura-3": "$2 back"})

    # --- names --------------------------------------------------------------------------------------------------

    def test_truncated_chase_name_pairs_without_alias(self):
        self.t.change_offers(lambda by, d: by["chase-freedom-flex/anantra-thai-restaurant"].update(
            merchant="Anantra Thai Resta…", other_details=["Name truncated on screen"]))
        p = self.t.csv("Chase Freedom Flex")
        code, out, rep = self.t.run("report", "Chase Freedom Flex", [p])
        self.assertEqual([(m["id"], m["rule"]) for m in rep["paired"]], [("chase-freedom-flex/anantra-thai-restaurant", "truncated")], out)
        self.apply_ok("Chase Freedom Flex", [p])
        o = self.t.offers()["chase-freedom-flex/anantra-thai-restaurant"]
        self.assertEqual(o["merchant"], "Anantra Thai Restaurant")
        self.assertNotIn("aliases", o)
        self.assertNotIn("Name truncated on screen", o["other_details"])

    def test_truncated_us_bank_name_keeps_its_note(self):
        self.t.change_offers(lambda by, d: by["us-bank/two-hands-corn-dogs"].update(merchant="Two Hands Corn Dogs - Lit..."))
        self.apply_ok("U.S. Bank", [self.t.csv("U.S. Bank")])
        o = self.t.offers()["us-bank/two-hands-corn-dogs"]
        self.assertEqual(o["merchant"], "Two Hands Corn Dogs - Little Tokyo")
        self.assertNotIn("aliases", o)
        self.assertIn("Name truncated on screen", o["other_details"])

    def test_capital_one_rename_adds_alias(self):
        def fn(rows):
            for r in rows:
                if r["merchant"] == "eBay":
                    r["merchant"] = "eBay Marketplace"
            return rows
        p = self.t.csv("Capital One", fn)
        code, out, rep = self.t.run("report", "Capital One", [p])
        self.assertEqual([(m["id"], m["rule"]) for m in rep["paired"] if m["id"] == "capital-one/ebay"], [("capital-one/ebay", "extends")], out)
        self.apply_ok("Capital One", [p])
        o = self.t.offers()["capital-one/ebay"]
        self.assertEqual((o["merchant"], o["aliases"], o["category"]), ("eBay Marketplace", ["eBay"], "Marketplaces & Department Stores"))

    def test_extension_onto_another_saved_merchant_is_only_proposed(self):
        def fn(rows):  # Pura's $10 tile is gone; Pura Vida now also shows a $10 tile
            for r in rows:
                if r["merchant"] == "Pura" and r["bonus"] == "Spend $20, earn $10":
                    r["merchant"] = "Pura Vida"
            return rows
        p = self.t.csv("Capital One", fn)
        code, out, rep = self.t.run("report", "Capital One", [p])
        self.assertNotIn("capital-one/pura", [m["id"] for m in rep["paired"]], out)
        self.assertIn(("capital-one/pura", "Pura Vida"), [(m["saved"], m["file"]) for m in rep["proposals"]], out)

    def test_bare_domain_keeps_app_name(self):
        p = self.t.csv("Capital One")  # the fixture lists LOOP MOBILE as loop-mobile.com
        code, out, rep = self.t.run("report", "Capital One", [p])
        self.assertIn(("capital-one/loop-mobile", "loop-mobile.com"), [(m["id"], m["file"]) for m in rep["paired"]], out)
        self.apply_ok("Capital One", [p])
        o = self.t.offers()["capital-one/loop-mobile"]
        self.assertEqual(o["merchant"], "LOOP MOBILE")
        self.assertNotIn("aliases", o)

    def test_repeat_tiles_collapse(self):
        def fn(rows):
            extra = dict(next(r for r in rows if r["merchant"] == "CVS"), tile_kind="hero", badge="NEW OFFER")
            return rows + [extra]
        p = self.t.csv("Capital One", fn)
        code, out, rep = self.t.run("report", "Capital One", [p])
        self.assertEqual(rep["offers_in_batch"], 8, out)
        self.apply_ok("Capital One", [p])
        notes = self.t.offers()["capital-one/cvs"]["other_details"]
        self.assertIn("3 tiles listed", notes)
        self.assertNotIn("2 tiles listed", notes)
        self.assertIn("Tile label reads 'NEW OFFER'", notes)

    def test_bank_of_america_rows_collapse(self):
        out, rep = self.apply_ok("Bank of America", [self.t.csv("Bank of America")])
        by = self.t.offers()
        self.assertIn("2 locations listed", by["bank-of-america/shiraz-restaurant"]["other_details"])
        le = by["bank-of-america/life-extension"]
        self.assertEqual(le["activation"], "needs_activation")
        self.assertEqual(le["other_details"], ["Listed twice: once needing activation, once auto-enrolled"])
        self.assertEqual(by["bank-of-america/hatch-yakitori-restaurant"]["merchant"], "HATCH (yakitori restaurant)")

    def test_doubtful_pair_needs_a_decision(self):
        def fn(rows):
            for r in rows:
                if r["merchant"] == "Carhartt":
                    r["merchant"] = "carharttworkwear.com"
            return rows
        p = self.t.csv("Capital One", fn)
        code, out, rep = self.t.run("report", "Capital One", [p])
        self.assertEqual([(m["saved"], m["file"]) for m in rep["proposals"]], [("capital-one/carhartt", "carharttworkwear.com")], out)
        code, out, _ = self.t.run("apply", "Capital One", [p], decisions={})
        self.assertEqual(code, 2, out)
        self.assertIn("need a decision", out)
        pair = {"saved": "capital-one/carhartt", "file": "carharttworkwear.com", "bonus": "Up to 25% back", "accept": True}
        self.apply_ok("Capital One", [p], decisions={"pairs": [pair]})
        o = self.t.offers()["capital-one/carhartt"]
        self.assertEqual(o["merchant"], "Carhartt")  # a bare lowercase domain keeps the app's name
        self.assertEqual(o["status"], "active")

    def test_rejected_pair_is_new_plus_missing(self):
        def fn(rows):
            for r in rows:
                if r["merchant"] == "Carhartt":
                    r["merchant"] = "carharttworkwear.com"
            return rows
        p = self.t.csv("Capital One", fn)
        pair = {"saved": "capital-one/carhartt", "file": "carharttworkwear.com", "bonus": "Up to 25% back", "accept": False}
        code, out, rep = self.t.run("report", "Capital One", [p], decisions={"pairs": [pair]})
        self.assertIn("carharttworkwear.com", rep["need_category"], out)
        self.apply_ok("Capital One", [p], decisions={"pairs": [pair], "categories": {"carharttworkwear.com": "Clothing & Jewelry"}})
        by = self.t.offers()
        self.assertEqual(by["capital-one/carhartt"]["status"], "missing")
        self.assertEqual(by["capital-one/carharttworkwear-com"]["first_seen"], READ)

    def test_category_clash_needs_a_decision(self):
        def fn(rows):  # Darn Tough Vermont (Clothing) renamed to Hydro Flask, which Chase Freedom has in Home & Garden
            for r in rows:
                if r["merchant"] == "Darn Tough Vermont":
                    r["merchant"] = "Hydro Flask"
            return rows
        p = self.t.csv("Capital One", fn)
        pair = {"saved": "capital-one/darn-tough", "file": "Hydro Flask", "bonus": "Spend $20, earn $10", "accept": True}
        code, out, rep = self.t.run("report", "Capital One", [p], decisions={"pairs": [pair]})
        self.assertEqual([c["merchant"] for c in rep["clashes"]], ["Hydro Flask"], out)
        self.assertNotEqual(self.t.run("apply", "Capital One", [p], decisions={"pairs": [pair]})[0], 0)
        self.apply_ok("Capital One", [p], decisions={"pairs": [pair], "clashes": {"Hydro Flask": "Home & Garden"}})
        by = self.t.offers()
        self.assertEqual((by["capital-one/darn-tough"]["category"], by["chase-freedom/hydro-flask"]["category"]), ("Home & Garden", "Home & Garden"))
        self.assertEqual(by["capital-one/darn-tough"]["aliases"], ["Darn Tough", "Darn Tough Vermont"])

    # --- new offers ---------------------------------------------------------------------------------------------

    def test_first_seen_kept_and_set_only_on_new(self):
        def fn(rows):
            return rows + [dict(rows[0], merchant="Zenni Optical", bonus="9% back", tile_kind="standard", badge="")]
        p = self.t.csv("Capital One", fn)
        code, out, rep = self.t.run("report", "Capital One", [p])
        self.assertEqual([(m["id"], m["category"]) for m in rep["new"]], [("capital-one/zenni-optical", "Health, Fitness & Vision")], out)
        self.apply_ok("Capital One", [p])
        by = self.t.offers()
        n = by["capital-one/zenni-optical"]
        self.assertEqual((n["first_seen"], n["status_since"], n["last_read"], n["status"], n["activation"]), (READ, READ, READ, "active", "none_shown"))
        self.assertEqual(by["capital-one/cvs"]["first_seen"], "2026-10-18")

    def test_new_merchant_needs_a_category(self):
        p = self.t.csv("Bank of America", lambda rows: rows + [dict(rows[0], merchant="Zyx Unknown Shop", channel="online only")])
        code, out, rep = self.t.run("report", "Bank of America", [p])
        self.assertEqual(rep["need_category"], ["Zyx Unknown Shop"], out)
        self.assertEqual(self.t.run("apply", "Bank of America", [p], decisions={})[0], 2)
        self.apply_ok("Bank of America", [p], decisions={"categories": {"Zyx Unknown Shop": {"category": "Services & Utilities", "unsure": True}}})
        self.assertEqual(self.t.offers()["bank-of-america/zyx-unknown-shop"]["category"], "Services & Utilities")

    def test_new_dining_merchant_goes_on_to_classify(self):
        p = self.t.csv("Citi Double Cash", lambda rows: rows + [dict(rows[0], offer_id="RN-99999", merchant="Fixture Noodle House")])
        code, out, rep = self.t.run("report", "Citi Double Cash", [p], decisions={"categories": {"Fixture Noodle House": "Dining"}})
        self.assertEqual([d["merchant"] for d in rep["new_dining"]], ["Fixture Noodle House"], out)
        self.apply_ok("Citi Double Cash", [p], decisions={"categories": {"Fixture Noodle House": "Dining"}})
        self.assertEqual(self.t.load("cuisines.json")["to_classify"], ["Fixture Noodle House"])

    # --- issuer details -----------------------------------------------------------------------------------------

    def test_chase_end_timestamp_in_eastern_time(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("refresh_mod2", self.t.root / "tools/refresh.py")
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        cases = {"2026-11-01T03:59:59Z": "2026-10-31", "2026-11-08T04:59:59Z": "2026-11-07", "2026-03-08T04:59:59Z": "2026-03-07",
                 "2026-07-01T03:59:59Z": "2026-06-30", "2026-12-01T04:59:59Z": "2026-11-30"}
        for ts, want in cases.items():
            self.assertEqual(m.eastern_date(ts), want, ts)
        saved = sys.modules.get("zoneinfo")
        sys.modules["zoneinfo"] = None  # no tz database: the built-in US rule gives the same dates
        try:
            for ts, want in cases.items():
                self.assertEqual(m.eastern_date(ts), want, "fallback " + ts)
        finally:
            if saved is None:
                sys.modules.pop("zoneinfo", None)
            else:
                sys.modules["zoneinfo"] = saved

        def fn(rows):
            for r in rows:
                if r["merchant"] == "Babbel":
                    r["offer_end_timestamp"], r["expiration_text"] = "2026-11-01T03:59:59Z", "Offer expires 10/31/2026."
            return rows
        self.apply_ok("Chase Freedom Flex", [self.t.csv("Chase Freedom Flex", fn)])
        o = self.t.offers()["chase-freedom-flex/babbel"]
        self.assertEqual((o["expires"], o["expires_text"]), ("2026-10-31", "Offer expires 10/31/2026"))

    def test_chase_tagged_new_follows_badge(self):
        def fn(rows):
            for r in rows:
                r["new_badge"] = "New" if r["merchant"] == "Babbel" else ""
            return rows
        self.apply_ok("Chase Freedom Flex", [self.t.csv("Chase Freedom Flex", fn)])
        by = self.t.offers()
        self.assertIn("Tagged New", by["chase-freedom-flex/babbel"]["other_details"])
        self.assertNotIn("Tagged New", by["chase-freedom-flex/directv"]["other_details"])

    def test_citi_countdown_estimate(self):
        def fn(rows):
            for r in rows:
                if r["merchant"] == "BestBuy":
                    r["expiration"] = "12d left"
            return rows
        self.apply_ok("Citi Double Cash", [self.t.csv("Citi Double Cash", fn)])
        o = self.t.offers()["citi-double-cash/bestbuy"]
        self.assertEqual((o["expires"], o["expires_text"]), ("2026-11-06", "12d left"))

    def test_citi_redeemed_rows_skipped(self):
        code, out, rep = self.t.run("report", "Citi Custom Cash", [self.t.csv("Citi Custom Cash")])
        self.assertEqual(rep["skipped_redeemed"], 1, out)
        self.assertNotIn("Macy's", json.dumps(rep["new"]))
        self.assertEqual(rep["stays_used"], [])

    def test_us_bank_activation_and_location(self):
        def fn(rows):
            for r in rows:
                if r["merchant"] == "Misfits Market":
                    r["activation_state"] = "ACTIVATED"
            return rows
        self.apply_ok("U.S. Bank", [self.t.csv("U.S. Bank", fn)])
        by = self.t.offers()
        self.assertEqual(by["us-bank/misfits-market"]["activation"], "already_activated")
        self.assertEqual(by["us-bank/misfits-market"]["minimum_spend"], "5")
        self.assertIn("Offer only applies to the following location: 1267 W Temple St, Los Angeles, CA 90026",
                      by["us-bank/park-s-finest-bbq-the"]["other_details"])

    # --- checks that stop the run -------------------------------------------------------------------------------

    def test_size_check_refuses(self):
        p = self.t.csv("Citi Double Cash", lambda rows: rows[:5])  # 5 of 8 offers
        code, out, rep = self.t.run("report", "Citi Double Cash", [p])
        self.assertFalse(rep["size_check"]["pass"], out)
        self.assertIn("STOP", out)
        before = self.t.read("offers.json")
        code, out, _ = self.t.run("apply", "Citi Double Cash", [p], decisions={})
        self.assertEqual(code, 2, out)
        self.assertEqual(self.t.read("offers.json"), before)
        self.apply_ok("Citi Double Cash", [p], decisions={"owner_approved": ["size_check"]})
        self.assertEqual(self.t.offers()["citi-double-cash/subway-woodland-hills"]["status"], "missing")

    def test_too_many_missing_stops(self):
        d = self.t.load()
        base = next(o for o in d["offers"] if o["id"] == "us-bank/misfits-market")
        for k in range(20):  # 26 active U.S. Bank offers, then a batch of 20 that drops 6 (size check passes)
            d["offers"].append(dict(base, id=f"us-bank/extra-{k}", merchant=f"Extra Shop {k}", category="Services & Utilities",
                                    other_details=[]))
        self.t.write_json("offers.json", d)
        row = lambda rows: next(r for r in rows if r["merchant"] == "Misfits Market")
        p = self.t.csv("U.S. Bank", lambda rows: rows + [dict(row(rows), merchant=f"Extra Shop {k}") for k in range(14)])
        code, out, rep = self.t.run("report", "U.S. Bank", [p])
        self.assertEqual(len(rep["missing"]), 6, out)
        self.assertTrue(rep["size_check"]["pass"], out)
        self.assertEqual([s["key"] for s in rep["stops"]], ["missing"], out)
        self.assertEqual(self.t.run("apply", "U.S. Bank", [p], decisions={})[0], 2)
        self.apply_ok("U.S. Bank", [p], decisions={"owner_approved": ["missing"]})

    def test_new_share_stops(self):
        p = self.t.csv("Bank of America", lambda rows: rows + [dict(rows[0], merchant=f"Shiraz Restaurant {k}") for k in range(3)])
        code, out, rep = self.t.run("report", "Bank of America", [p])
        self.assertIn("new_share", [s["key"] for s in rep["stops"]], out)

    def test_read_date_rules(self):
        card = "Citi Custom Cash"
        p = self.t.csv(card, lambda rows: [dict(r, read_date="2026-10-24") for r in rows], extra_cols=["read_date"])
        code, out, rep = self.t.run("report", card, [p], read_date=None)
        self.assertEqual((code, rep["read_date"], rep["date_source"]), (0, "2026-10-24", "the file's read_date column"), out)
        self.assertEqual(self.t.run("report", card, [p], read_date="2026-10-25")[0], 2)  # differs from the column
        p2 = self.t.csv(card, lambda rows: [dict(r, read_date="2026-10-2" + str(k % 2)) for k, r in enumerate(rows)],
                        extra_cols=["read_date"], name="mixed.csv")
        code, out, _ = self.t.run("report", card, [p2], read_date=None)
        self.assertEqual(code, 2, out)
        self.assertIn("--read-date", out)
        code, out, _ = self.t.run("report", card, [self.t.csv(card)], read_date=None)
        self.assertEqual(code, 2, out)
        self.assertIn("no read date", out)
        code, out, _ = self.t.run("report", card, [self.t.csv(card)], read_date="2026-10-17")
        self.assertEqual(code, 2, out)
        self.assertIn("stale", out)
        self.assertEqual(self.t.run("report", card, [self.t.csv(card)], read_date="2026-02-30")[0], 2)

    # --- card numbers -------------------------------------------------------------------------------------------

    def test_card_last4_never_leaks(self):
        fake = "4729"  # a made-up last four, written only into this temporary copy

        def fn(rows):
            rows = [dict(r, card_last4=fake) for r in rows]
            return rows + [dict(rows[0], merchant="Fixture Store", bonus_as_shown="5% cash back",
                                reward_description=f"Earn 5% on your card ending in {fake}.")]
        p = self.t.csv("Chase Freedom", fn, name=f"chase_freedom_{fake}_2026-10-25.csv")
        dec = {"categories": {"Fixture Store": "Home & Garden"}}
        code, out, rep = self.t.run("report", "Chase Freedom", [p], decisions=dec)
        self.assertNotIn(fake, out)
        self.assertNotIn(fake, (self.t.root / "report.json").read_text())
        self.assertIn("card_last4", rep["card_columns"])
        self.assertTrue(rep["leaks"], out)
        before = self.t.read("offers.json")
        code, out, _ = self.t.run("apply", "Chase Freedom", [p], decisions=dec)
        self.assertEqual(code, 2, out)
        self.assertNotIn(fake, out)
        self.assertEqual(self.t.read("offers.json"), before)
        p = self.t.csv("Chase Freedom", lambda rows: fn(rows)[:-1] + [dict(fn(rows)[-1], reward_description="Earn 5%.")],
                       name=f"chase_freedom_{fake}_2026-10-25.csv")
        self.apply_ok("Chase Freedom", [p], decisions=dec)
        self.assertNotIn(fake, self.t.read("offers.json"))

    # --- phone edits --------------------------------------------------------------------------------------------

    def test_pending_phone_edit_fields_left_alone(self):
        self.t.close()
        edits = {"us-bank/misfits-market": {"activation": "already_activated"},
                 "chase-freedom-flex/away": {"status": "active", "status_since": "2026-10-21"},
                 "us-bank/round-table-pizza": {"activation": "needs_activation"}}
        self.t = Tree(edits)

        def setup(by, d):
            by["chase-freedom-flex/away"].update(status="used", status_since="2026-10-20")  # restored on the phone
            by["us-bank/round-table-pizza"].update(status="used", expires="2026-09-01", status_since="2026-09-01")
        self.t.change_offers(setup)
        edits_text = self.t.read("phone-edits.json")
        # Flex: Away absent. U.S. Bank: Misfits says SERVED (needs activation); Round Table (used, long expired) absent.
        flex = self.t.csv("Chase Freedom Flex", lambda rows: [r for r in rows if r["merchant"] != "Away"])
        code, out, rep = self.t.run("report", "Chase Freedom Flex", [flex])
        self.assertEqual([h["id"] for h in rep["held"]], ["chase-freedom-flex/away"], out)
        self.assertEqual(rep["missing"], [])
        self.apply_ok("Chase Freedom Flex", [flex])
        a = self.t.offers()["chase-freedom-flex/away"]
        self.assertEqual((a["status"], a["status_since"]), ("used", "2026-10-20"))
        us = self.t.csv("U.S. Bank", lambda rows: [r for r in rows if r["merchant"] != "Round Table Pizza"])
        out, rep = self.apply_ok("U.S. Bank", [us])
        by = self.t.offers()
        self.assertEqual(by["us-bank/misfits-market"]["activation"], "needs_activation")  # the file's value not written
        self.assertIn("us-bank/round-table-pizza", by)  # no cleanup for an offer with a pending edit
        self.assertEqual(self.t.read("phone-edits.json"), edits_text)

    def test_cleanup_deletes_old_offers_without_pending_edit(self):
        self.t.change_offers(lambda by, d: by["us-bank/round-table-pizza"].update(status="used", expires="2026-09-01", status_since="2026-09-01"))
        us = self.t.csv("U.S. Bank", lambda rows: [r for r in rows if r["merchant"] != "Round Table Pizza"])
        out, rep = self.apply_ok("U.S. Bank", [us])
        self.assertEqual([d["id"] for d in rep["deleted"]], ["us-bank/round-table-pizza"])
        self.assertNotIn("us-bank/round-table-pizza", self.t.offers())

    # --- modes and safety ---------------------------------------------------------------------------------------

    def test_part_marks_nothing_missing(self):
        p = self.t.csv("Chase Freedom Flex", lambda rows: rows[:2])
        out, rep = self.apply_ok("Chase Freedom Flex", [p], extra=["--part"])
        by = self.t.offers()
        self.assertEqual(by["chase-freedom-flex/babbel"]["status"], "active")
        self.assertEqual(len([b for b in self.t.load()["batches"] if b["card"] == "Chase Freedom Flex"]), 1)

    # --- merchant locations (site/data/merchant-locations.json) ----------------------------------------------------

    def test_location_candidates_are_reported_never_written(self):
        groups = {"groups": {"Pura Vida": ["Pura Vida - Santa Monica"]}}
        self.t.write_json("merchant-locations.json", groups)
        before = self.t.read("merchant-locations.json")
        extra = [("CVS - Pasadena", "5% back"), ("Pura Vida - Venice", "6% back"), ("Zyxnew - Downtown", "7% back"),
                 ("CVS Pharmacy Online", "8% back")]
        p = self.t.csv("Capital One", lambda rows: rows + [dict(rows[0], merchant=m, bonus=b) for m, b in extra])
        cats = {"CVS - Pasadena": "Health, Fitness & Vision", "Pura Vida - Venice": "Clothing & Jewelry",
                "Zyxnew - Downtown": "Services & Utilities", "CVS Pharmacy Online": "Health, Fitness & Vision"}
        dec = {"categories": cats, "owner_approved": ["new_share"]}
        code, out, rep = self.t.run("report", "Capital One", [p], decisions=dec)
        self.assertEqual(code, 0, out)
        got = {c["merchant"]: c["matches"] for c in rep["location_candidates"]}
        # a saved merchant's name or an approved group's name before " - "; no " - " or no such base: not listed
        self.assertEqual(got, {"CVS - Pasadena": "saved merchant 'CVS'", "Pura Vida - Venice": "approved group 'Pura Vida'"}, out)
        self.assertIn("Possible new locations for the owner to review", out)
        self.assertEqual(rep["blockers"], [], out)  # report-only: nothing to decide
        self.assertEqual(self.t.read("merchant-locations.json"), before)
        self.apply_ok("Capital One", [p], decisions=dec)
        self.assertEqual(self.t.read("merchant-locations.json"), before, "apply never adds a location group or member")
        # once saved, the next read does not list it again
        code, out, rep = self.t.run("report", "Capital One", [p])
        self.assertEqual(rep["location_candidates"], [], out)

    def test_location_candidates_new_base_and_sibling_names(self):
        # base and location both new in one read; a new location whose base only another " - " name carries
        self.t.change_offers(lambda by, d: by["capital-one/pura-vida"].update(merchant="Zyxsib - North"))
        extra = [("Zyxbase", "5% back"), ("Zyxbase - Downtown", "6% back"), ("Zyxsib - South", "7% back")]
        p = self.t.csv("Capital One", lambda rows: [dict(r, merchant="Zyxsib - North") if r["merchant"] == "Pura Vida" else r for r in rows]
                       + [dict(rows[0], merchant=m, bonus=b) for m, b in extra])
        dec = {"categories": {m: "Services & Utilities" for m, _ in extra}, "owner_approved": ["new_share"]}
        code, out, rep = self.t.run("report", "Capital One", [p], decisions=dec)
        self.assertEqual(code, 0, out)
        got = {c["merchant"]: c["matches"] for c in rep["location_candidates"]}
        self.assertEqual(got, {"Zyxbase - Downtown": "merchant new in this read 'Zyxbase'",
                               "Zyxsib - South": "another location-style name 'Zyxsib - North'"}, out)

    def test_broken_location_file_refuses_cleanly(self):
        (self.t.data / "merchant-locations.json").write_text("{ nope")
        code, out, _ = self.t.run("report", "Capital One", [self.t.csv("Capital One")])
        self.assertEqual(code, 2, out)
        self.assertIn("merchant-locations.json is not valid JSON", out)
        self.assertNotIn("Traceback", out)

    def test_renamed_location_member_extended_automatically_is_held(self):
        # "eBay - LA" -> "eBay - La Habra" is proposed, never automatic; accepted, the approved member still stays
        self.t.change_offers(lambda by, d: by["capital-one/ebay"].update(merchant="eBay - LA"))
        self.t.write_json("merchant-locations.json", {"groups": {"eBay": ["eBay - LA"]}})
        before = self.t.read("merchant-locations.json")
        p = self.t.csv("Capital One", lambda rows: [dict(r, merchant="eBay - La Habra") if r["merchant"] == "eBay" else r for r in rows])
        self.assertEqual(self.t.run("apply", "Capital One", [p], decisions={})[0], 2)
        pair = {"saved": "capital-one/ebay", "file": "eBay - La Habra", "bonus": "Spend $20, earn $10", "accept": True}
        out, rep = self.apply_ok("Capital One", [p], decisions={"pairs": [pair], "owner_approved": ["location_pairs"]})
        self.assertEqual(self.t.offers()["capital-one/ebay"]["merchant"], "eBay - La Habra", out)
        self.assertEqual(rep["location_moves"], [], out)
        self.assertEqual([m["to"] for m in rep["location_held"]], ["eBay - La Habra"], out)
        self.assertEqual(self.t.read("merchant-locations.json"), before)

    def test_member_whose_old_name_is_still_on_another_card_is_held(self):
        # completing a cut-off member on one card while another card keeps the cut name: nothing is added, so a
        # later read can't complete it a second way
        def two(by, d):
            by["capital-one/ebay"].update(merchant="eBay - Newport Be...")
            by["bank-of-america/" + next(o["id"].split("/")[1] for o in d["offers"] if o["card"] == "Bank of America")].update(
                merchant="eBay - Newport Be...", category="Marketplaces & Department Stores")
        self.t.change_offers(two)
        self.t.write_json("merchant-locations.json", {"groups": {"eBay": ["eBay - Newport Be..."]}})
        before = self.t.read("merchant-locations.json")
        p = self.t.csv("Capital One", lambda rows: [dict(r, merchant="eBay - Newport Beach") if r["merchant"] == "eBay" else r for r in rows])
        out, rep = self.apply_ok("Capital One", [p])
        self.assertEqual(rep["location_moves"], [], out)
        self.assertEqual([(m["to"], m["why"]) for m in rep["location_held"]],
                         [("eBay - Newport Beach", "another offer still has the old name (the approved member stays as it is)")], out)
        self.assertEqual(self.t.read("merchant-locations.json"), before)

    def test_cut_off_member_completed_differently_on_another_offer_is_held(self):
        # R10: an earlier read completed the approved cut-off name one way (now on another card's offer); this read
        # completes it another way. The ambiguity is never settled automatically: the member stays as approved.
        def setup(by, d):
            by["capital-one/ebay"].update(merchant="eBay - Newport Be...")
            boa = next(o for o in d["offers"] if o["card"] == "Bank of America")
            boa.update(merchant="eBay - Newport Beach", category="Marketplaces & Department Stores")
        self.t.change_offers(setup)
        self.t.write_json("merchant-locations.json", {"groups": {"eBay": ["eBay - Newport Be..."]}})
        before = self.t.read("merchant-locations.json")
        p = self.t.csv("Capital One", lambda rows: [dict(r, merchant="eBay - Newport Bend") if r["merchant"] == "eBay" else r for r in rows])
        out, rep = self.apply_ok("Capital One", [p])
        self.assertEqual(self.t.offers()["capital-one/ebay"]["merchant"], "eBay - Newport Bend", out)  # a visible cut: the offer follows
        self.assertEqual(rep["location_moves"], [], out)
        self.assertEqual([(m["to"], m["why"]) for m in rep["location_held"]],
                         [("eBay - Newport Bend", "another offer completes the cut-off name differently ('eBay - Newport Beach')")], out)
        self.assertEqual(self.t.read("merchant-locations.json"), before)

    def test_location_style_names_with_a_different_location_never_pair_automatically(self):
        for old, new in [("eBay - LA", "eBay - La Habra"), ("eBay - West", "eBay - West Hollywood"), ("eBay - North", "eBay - Northridge")]:
            with self.subTest(old=old, new=new):
                t = Tree()
                try:
                    t.change_offers(lambda by, d: by["capital-one/ebay"].update(merchant=old))
                    p = t.csv("Capital One", lambda rows: [dict(r, merchant=new) if r["merchant"] == "eBay" else r for r in rows])
                    code, out, rep = t.run("report", "Capital One", [p])
                    self.assertEqual(code, 0, out)
                    self.assertNotIn("capital-one/ebay", [m["id"] for m in rep["paired"]], out)
                    self.assertEqual([(m["saved"], m["file"]) for m in rep["proposals"]], [("capital-one/ebay", new)], out)
                    self.assertIn("never automatic", rep["proposals"][0]["why"], out)
                    code, out, _ = t.run("apply", "Capital One", [p], decisions={})
                    self.assertEqual(code, 2, out)  # waits for the decision
                finally:
                    t.close()

    def test_location_changes_are_decided_per_offer_never_automatic(self):
        # Review 1A F1-F3: a base alias on the saved offer, a dashless file name, or a location dropped all leave the
        # pair for the owner, with the reason.
        cases = [("eBay - LA", ["eBay"], "eBay - La Habra"), ("eBay - Canoga Park", ["eBay"], "eBay - Northridge"),
                 ("eBay - LA", None, "eBay La Habra"), ("eBay - Encino", None, "eBay")]
        for old, aliases, new in cases:
            with self.subTest(old=old, aliases=aliases, new=new):
                t = Tree()
                try:
                    def f(by, d):
                        by["capital-one/ebay"].update(merchant=old)
                        if aliases:
                            by["capital-one/ebay"]["aliases"] = aliases
                    t.change_offers(f)
                    p = t.csv("Capital One", lambda rows: [dict(r, merchant=new) if r["merchant"] == "eBay" else r for r in rows])
                    code, out, rep = t.run("report", "Capital One", [p])
                    self.assertNotIn("capital-one/ebay", [m["id"] for m in rep["paired"]], out)
                    self.assertEqual([(m["saved"], m["file"]) for m in rep["proposals"]], [("capital-one/ebay", new)], out)
                    self.assertIn("never automatic", rep["proposals"][0]["why"], out)
                finally:
                    t.close()

    def test_citi_saved_location_now_listed_under_the_base_is_proposed(self):
        # Review 1A F3b: "Subway - Woodland Hills" is saved; Citi's tile now reads just "Subway"
        p = self.t.csv("Citi Double Cash", lambda rows: [dict(r, merchant="Subway") if r["merchant"] == "Subway - Woodland Hills" else r for r in rows])
        code, out, rep = self.t.run("report", "Citi Double Cash", [p])
        self.assertEqual(rep["renames"], [], out)
        self.assertEqual([(m["saved"], m["file"]) for m in rep["proposals"]], [("citi-double-cash/subway-woodland-hills", "Subway")], out)

    def test_conflicting_completion_new_in_the_same_read_holds_the_member(self):
        # Review 1A S1: the other completion arrives as a new offer in the same read
        self.t.change_offers(lambda by, d: by["capital-one/ebay"].update(merchant="eBay - Newport Be..."))
        self.t.write_json("merchant-locations.json", {"groups": {"eBay": ["eBay - Newport Be..."]}})
        before = self.t.read("merchant-locations.json")
        def fn(rows):
            e = next(r for r in rows if r["merchant"] == "eBay")
            return [dict(r, merchant="eBay - Newport Bend") if r["merchant"] == "eBay" else r for r in rows] + \
                   [dict(e, merchant="eBay - Newport Beach", bonus="Spend $50, earn $25")]
        out, rep = self.apply_ok("Capital One", [self.t.csv("Capital One", fn)],
                                 decisions={"categories": {"eBay - Newport Beach": "Marketplaces & Department Stores"}})
        self.assertEqual(rep["location_moves"], [], out)
        self.assertEqual(self.t.read("merchant-locations.json"), before)

    def _accept_location_pair(self, card, sid, old, new, file_old):
        self.t.change_offers(lambda by, d: by[sid].update(merchant=old))
        p = self.t.csv(card, lambda rows: [dict(r, merchant=new) if r["merchant"] == file_old else r for r in rows])
        code, out, rep = self.t.run("report", card, [p])
        self.assertEqual([(x["saved"], x["file"]) for x in rep["proposals"]], [(sid, new)], out)
        pair = {"saved": sid, "file": new, "bonus": rep["proposals"][0]["bonus"], "accept": True}
        # deciding a location pair is the owner's call: refused until owner_approved names it
        code, out, rep = self.t.run("report", card, [p], decisions={"pairs": [pair]})
        self.assertIn("location_pairs", [st["key"] for st in rep["stops"]], out)
        self.assertEqual(self.t.run("apply", card, [p], decisions={"pairs": [pair]})[0], 2)
        self.apply_ok(card, [p], decisions={"pairs": [pair], "owner_approved": ["location_pairs"]})
        return p

    def test_chase_accepted_location_change_takes_the_file_name(self):
        # Review 1A G1: the banner rule must not keep "X - LA" once the owner accepted "X - La Habra"
        sid = "chase-freedom-flex/anantra-thai-restaurant"
        self._accept_location_pair("Chase Freedom Flex", sid, "Anantra Thai - LA", "Anantra Thai - La Habra", "Anantra Thai Restaurant")
        self.assertEqual(self.t.offers()[sid]["merchant"], "Anantra Thai - La Habra")

    def test_chase_accepted_base_to_location_is_not_asked_again(self):
        # Review 1A G2: accepted once, the next read of the same file matches it
        sid = "chase-freedom-flex/anantra-thai-restaurant"
        p = self._accept_location_pair("Chase Freedom Flex", sid, "Anantra Thai Restaurant", "Anantra Thai Restaurant - Encino",
                                       "Anantra Thai Restaurant")
        o = self.t.offers()[sid]
        self.assertEqual((o["merchant"], o.get("aliases")), ("Anantra Thai Restaurant - Encino", None))
        code, out, rep = self.t.run("report", "Chase Freedom Flex", [p])
        self.assertEqual((rep["proposals"], rep["stops"]), ([], []), out)

    def test_names_cut_at_the_base_still_pair_automatically(self):
        # Review 1A G3-G3c: a visible cut right at the base is the same name, never a location change
        for card, sid, old, file_old, new, rule in [
                ("Capital One", "capital-one/ebay", "eBay - Newport Beach", "eBay", "eBay...", "truncated"),
                ("Capital One", "capital-one/ebay", "eBay...", "eBay", "eBay - Newport Beach", "truncated"),
                ("U.S. Bank", "us-bank/two-hands-corn-dogs", None, "Two Hands Corn Dogs - Little Tokyo", "Two Hands Corn Dogs -...", None)]:
            with self.subTest(old=old or file_old, new=new):
                t = Tree()
                try:
                    if old:
                        t.change_offers(lambda by, d: by[sid].update(merchant=old))
                    p = t.csv(card, lambda rows: [dict(r, merchant=new) if r["merchant"] == file_old else r for r in rows])
                    code, out, rep = t.run("report", card, [p])
                    self.assertEqual(rep["proposals"], [], out)
                    if rule:
                        self.assertEqual([(m["id"], m["rule"]) for m in rep["paired"] if m["id"] == sid], [(sid, rule)], out)
                finally:
                    t.close()

    def test_accepted_location_change_with_a_cut_file_name_is_settled(self):
        # Review 1A H8: "eBay - LA" accepted as the file's "eBay - La Ha...": the offer shows the new place and the
        # next read of the same file asks nothing
        p = self._accept_location_pair("Capital One", "capital-one/ebay", "eBay - LA", "eBay - La Ha...", "eBay")
        o = self.t.offers()["capital-one/ebay"]
        self.assertEqual((o["merchant"], o.get("aliases")), ("eBay - La Ha...", ["eBay - LA"]))
        code, out, rep = self.t.run("report", "Capital One", [p])
        self.assertEqual((rep["proposals"], rep["stops"]), ([], []), out)

    def test_later_read_completes_an_accepted_cut_location_automatically(self):
        # Review 1A H9: accepted "eBay - LA" -> "eBay - La Ha..." (old name kept as an alias); the next read shows
        # "eBay - La Habra": a visible cut completed, automatic; the old alias doesn't reopen it
        p = self._accept_location_pair("Capital One", "capital-one/ebay", "eBay - LA", "eBay - La Ha...", "eBay")
        p2 = self.t.csv("Capital One", lambda rows: [dict(r, merchant="eBay - La Habra") if r["merchant"] == "eBay" else r for r in rows])
        code, out, rep = self.t.run("report", "Capital One", [p2])
        self.assertEqual([(m["id"], m["rule"]) for m in rep["paired"] if m["id"] == "capital-one/ebay"], [("capital-one/ebay", "truncated")], out)
        self.assertEqual((rep["proposals"], rep["stops"]), ([], []), out)

    def test_cut_right_after_the_dash_is_the_same_name(self):
        # Review 1A H3: "eBay - ..." on screen against the saved "eBay - Newport Beach"
        self.t.change_offers(lambda by, d: by["capital-one/ebay"].update(merchant="eBay - Newport Beach"))
        p = self.t.csv("Capital One", lambda rows: [dict(r, merchant="eBay - ...") if r["merchant"] == "eBay" else r for r in rows])
        code, out, rep = self.t.run("report", "Capital One", [p])
        self.assertEqual(rep["proposals"], [], out)
        self.assertEqual([(m["id"], m["rule"]) for m in rep["paired"] if m["id"] == "capital-one/ebay"], [("capital-one/ebay", "truncated")], out)

    def test_rejected_location_pair_also_needs_the_owner(self):
        self.t.change_offers(lambda by, d: by["capital-one/ebay"].update(merchant="eBay - LA"))
        p = self.t.csv("Capital One", lambda rows: [dict(r, merchant="eBay - La Habra") if r["merchant"] == "eBay" else r for r in rows])
        pair = {"saved": "capital-one/ebay", "file": "eBay - La Habra", "bonus": "Spend $20, earn $10", "accept": False}
        dec = {"pairs": [pair], "categories": {"eBay - La Habra": "Marketplaces & Department Stores"}}
        code, out, rep = self.t.run("report", "Capital One", [p], decisions=dec)
        self.assertIn("rejected", next(st["text"] for st in rep["stops"] if st["key"] == "location_pairs"), out)
        self.assertEqual(self.t.run("apply", "Capital One", [p], decisions=dec)[0], 2)
        dec["owner_approved"] = ["location_pairs"]
        self.apply_ok("Capital One", [p], decisions=dec)

    def test_accepted_bare_domain_pair_keeps_its_alias_on_a_location_name(self):
        # Review 1A nit: the base-alias rule drops only the old name, never the domain alias of a bare-domain pair
        self.t.change_offers(lambda by, d: by["capital-one/ebay"].update(merchant="eBay - Newport Beach"))
        p = self.t.csv("Capital One", lambda rows: [dict(r, merchant="ebay.com", merchant_tld="") if r["merchant"] == "eBay" else r for r in rows])
        pair = {"saved": "capital-one/ebay", "file": "ebay.com", "bonus": "Spend $20, earn $10", "accept": True}
        dec = {"pairs": [pair], "owner_approved": ["location_pairs"]}
        out, rep = self.apply_ok("Capital One", [p], decisions=dec)
        o = self.t.offers()["capital-one/ebay"]
        self.assertEqual((o["merchant"], o.get("aliases")), ("eBay - Newport Beach", ["ebay.com"]), out)

    def test_visibly_cut_location_still_pairs_automatically(self):
        # "eBay - Newport Be..." on screen, "eBay - Newport Beach" now: the same place, completed (no location file needed)
        self.t.change_offers(lambda by, d: by["capital-one/ebay"].update(merchant="eBay - Newport Be..."))
        p = self.t.csv("Capital One", lambda rows: [dict(r, merchant="eBay - Newport Beach") if r["merchant"] == "eBay" else r for r in rows])
        code, out, rep = self.t.run("report", "Capital One", [p])
        self.assertEqual([(m["id"], m["rule"]) for m in rep["paired"] if m["id"] == "capital-one/ebay"], [("capital-one/ebay", "truncated")], out)
        self.assertEqual(rep["proposals"], [], out)

    def test_cut_off_member_completed_two_ways_is_held(self):
        def two(by, d):
            by["capital-one/ebay"].update(merchant="eBay - Newport Be...")
            by["capital-one/pura"].update(merchant="eBay - Newport Be...", category="Marketplaces & Department Stores")
        self.t.change_offers(two)
        self.t.write_json("merchant-locations.json", {"groups": {"eBay": ["eBay - Newport Be..."]}})
        before = self.t.read("merchant-locations.json")
        def fn(rows):
            for r in rows:
                if r["merchant"] == "eBay":
                    r["merchant"] = "eBay - Newport Beach"
                elif r["merchant"] == "Pura" and r["bonus"] == "Spend $20, earn $10":
                    r["merchant"] = "eBay - Newport Bend"
            return rows
        pairs = [{"saved": "capital-one/ebay", "file": "eBay - Newport Beach", "bonus": "Spend $20, earn $10", "accept": True},
                 {"saved": "capital-one/pura", "file": "eBay - Newport Bend", "bonus": "Spend $20, earn $10", "accept": True}]
        code, out, rep = self.t.run("report", "Capital One", [self.t.csv("Capital One", fn)], decisions={"pairs": pairs})
        self.assertEqual(code, 0, out)
        self.assertEqual(sorted(r["to"] for r in rep["renames"] if r["from"] == "eBay - Newport Be..."), ["eBay - Newport Beach", "eBay - Newport Bend"], out)
        self.assertEqual(rep["location_moves"], [], out)
        self.assertEqual(sorted((m["to"], m["why"]) for m in rep["location_held"]),
                         [("eBay - Newport Beach", "renamed to more than one name in this read"), ("eBay - Newport Bend", "renamed to more than one name in this read")], out)
        self.assertEqual(self.t.read("merchant-locations.json"), before)

    def test_renamed_location_member_to_another_place_is_held(self):
        self.t.change_offers(lambda by, d: by["capital-one/ebay"].update(merchant="eBay - Outlet"))
        self.t.write_json("merchant-locations.json", {"groups": {"eBay": ["eBay - Outlet"]}})
        before = self.t.read("merchant-locations.json")
        def fn(rows):
            for r in rows:
                if r["merchant"] == "eBay":
                    r["merchant"] = "eBay - Irvine"
            return rows
        p = self.t.csv("Capital One", fn)
        pair = {"saved": "capital-one/ebay", "file": "eBay - Irvine", "bonus": "Spend $20, earn $10", "accept": True}
        code, out, rep = self.t.run("report", "Capital One", [p], decisions={"pairs": [pair], "owner_approved": ["location_pairs"]})
        self.assertTrue(any(m["id"] == "capital-one/ebay" for m in rep["paired"]), out)
        out, rep = self.apply_ok("Capital One", [p], decisions={"pairs": [pair], "owner_approved": ["location_pairs"]})
        self.assertEqual(self.t.read("merchant-locations.json"), before, out)
        self.assertEqual([m["why"] for m in rep["location_held"]], ["the location part changed (only a name cut off on screen and now complete is followed)"], out)

    def test_same_place_by_whole_words(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("refresh_sp", self.t.root / "tools/refresh.py")
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        for a, b, want in [("Newport Beach", "newport beach", True), ("Newport Be...", "Newport Beach", True),
                           ("Newport Be…", "Newport Beach", True), ("Newport", "Newport Beach", False),
                           ("Newport Be", "Newport Beach", False), ("Newport Beach", "Newport Be...", False),
                           ("LA", "Lakewood", False), ("LA", "La Habra", False), ("North", "North Hollywood", False),
                           ("North", "Northridge", False), ("Irvine", "Newport Beach", False)]:
            with self.subTest(a=a, b=b):
                self.assertEqual(m.same_place(a, b), want)

    def test_rename_is_not_a_candidate_of_its_own_old_name(self):
        self.t.change_offers(lambda by, d: by["capital-one/ebay"].update(merchant="eBay - Outlet"))
        def fn(rows):
            for r in rows:
                if r["merchant"] == "eBay":
                    r["merchant"] = "eBay - Outlet Store"
            return rows
        pair = {"saved": "capital-one/ebay", "file": "eBay - Outlet Store", "bonus": "Spend $20, earn $10", "accept": True}
        code, out, rep = self.t.run("report", "Capital One", [self.t.csv("Capital One", fn)], decisions={"pairs": [pair]})
        self.assertEqual(code, 0, out)
        self.assertIn("capital-one/ebay", [r["id"] for r in rep["renames"]], out)
        self.assertEqual(rep["location_candidates"], [], out)

    def test_renamed_location_member_follows_in_the_same_run(self):
        self.t.change_offers(lambda by, d: by["capital-one/ebay"].update(merchant="eBay - Outlet St..."))
        self.t.write_json("merchant-locations.json", {"groups": {"eBay": ["eBay - Outlet St..."]}})
        def fn(rows):
            for r in rows:
                if r["merchant"] == "eBay":
                    r["merchant"] = "eBay - Outlet Store"
            return rows
        out, rep = self.apply_ok("Capital One", [self.t.csv("Capital One", fn)])
        self.assertEqual(self.t.offers()["capital-one/ebay"]["merchant"], "eBay - Outlet Store")
        self.assertEqual(self.t.load("merchant-locations.json"), {"groups": {"eBay": ["eBay - Outlet Store"]}}, out)
        self.assertEqual([(m["from"], m["to"]) for m in rep["location_moves"]], [("eBay - Outlet St...", "eBay - Outlet Store")])
        self.assertEqual(rep["location_candidates"], [], "an approved member's rename is not a new candidate")

    def test_renamed_location_member_that_no_longer_fits_is_held(self):
        self.t.change_offers(lambda by, d: by["capital-one/ebay"].update(merchant="eBay - Outlet"))
        self.t.write_json("merchant-locations.json", {"groups": {"eBay": ["eBay - Outlet"]}})
        before = self.t.read("merchant-locations.json")
        def fn(rows):
            for r in rows:
                if r["merchant"] == "eBay":
                    r["merchant"] = "eBay Outlet Store"
            return rows
        pair = {"saved": "capital-one/ebay", "file": "eBay Outlet Store", "bonus": "Spend $20, earn $10", "accept": True}
        out, rep = self.apply_ok("Capital One", [self.t.csv("Capital One", fn)], decisions={"pairs": [pair], "owner_approved": ["location_pairs"]})
        self.assertEqual(self.t.read("merchant-locations.json"), before, "never rewritten into a member the validator would refuse")
        self.assertEqual([(m["to"], m["why"]) for m in rep["location_held"]], [("eBay Outlet Store", "the new name is not 'eBay - <location>'")], out)
        self.assertIn("is in no offer now", out)  # validate.py's note on the stale member

    def test_location_file_put_back_when_validate_fails(self):
        self.t.change_offers(lambda by, d: by["capital-one/ebay"].update(merchant="eBay - Outlet St..."))
        self.t.write_json("merchant-locations.json", {"groups": {"eBay": ["eBay - Outlet St..."]}})
        before = self.t.read("merchant-locations.json")
        cards = self.t.load("cards.json")
        cards["offer_lists"].pop("Citi Custom Cash")
        self.t.write_json("cards.json", cards)
        def fn(rows):
            for r in rows:
                if r["merchant"] == "eBay":
                    r["merchant"] = "eBay - Outlet Store"
            return rows
        code, out, _ = self.t.run("apply", "Capital One", [self.t.csv("Capital One", fn)], decisions={})
        self.assertNotEqual(code, 0, out)
        self.assertIn("validate.py failed", out)
        self.assertEqual(self.t.read("merchant-locations.json"), before, out)

    def test_citi_restaurant_location_kept_whole_and_reported(self):
        # R5: a new Citi RN- row "Subway - Encino" is saved under its full name and listed for the owner, never
        # stripped to "Subway" or merged into another location
        p = self.t.csv("Citi Double Cash", lambda rows: rows + [dict(next(r for r in rows if r["offer_id"] == "RN-90008"),
                                                                     offer_id="RN-99998", merchant="Subway - Encino", bonus="7% Back")])
        dec = {"categories": {"Subway - Encino": "Dining"}}
        code, out, rep = self.t.run("report", "Citi Double Cash", [p], decisions=dec)
        self.assertEqual(code, 0, out)
        self.assertEqual([m["merchant"] for m in rep["new"]], ["Subway - Encino"], out)
        self.assertEqual({c["merchant"]: c["matches"] for c in rep["location_candidates"]},
                         {"Subway - Encino": "another location-style name 'Subway - Woodland Hills'"}, out)
        out, rep = self.apply_ok("Citi Double Cash", [p], decisions=dec)
        by = self.t.offers()
        self.assertEqual(by["citi-double-cash/subway-encino"]["merchant"], "Subway - Encino")
        self.assertFalse(any(t.startswith("Location") for t in by["citi-double-cash/subway-encino"]["other_details"]))
        self.assertEqual(self.t.load("merchant-locations.json"), {"groups": {}})

    def test_citi_same_name_rows_are_one_offer_and_locations_stay_apart(self):
        # Two tiles under one name and bonus are one offer ("2 locations listed"); a " - <place>" row stays its own.
        def fn(rows):
            t = next(r for r in rows if r["offer_id"] == "RN-90002")
            return rows + [dict(t, offer_id="RN-99997")]
        code, out, rep = self.t.run("report", "Citi Double Cash", [self.t.csv("Citi Double Cash", fn)])
        self.assertEqual(code, 0, out)
        self.assertEqual(rep["new"], [], out)
        self.apply_ok("Citi Double Cash", [self.t.csv("Citi Double Cash", fn)])
        by = self.t.offers()
        self.assertIn("2 locations listed", by["citi-double-cash/taqueria-el-tapatio"]["other_details"])
        self.assertEqual(by["citi-double-cash/taqueria-el-tapatio-woodland-hills"]["merchant"], "Taqueria El Tapatio - Woodland Hills")

    def test_citi_records_from_the_old_location_rule_are_restored_on_the_next_read(self):
        # Saved as the old rule made them: Taqueria El Tapatio (2 rows merged, location in a note), Subway (location
        # stripped). The next read keeps each row's full name and drops the old notes; the stripped Subway against
        # its "Subway - Woodland Hills" tile is proposed (a location added), and accepted it takes no base alias.
        def old(by, d):
            d["offers"] = [o for o in d["offers"] if not o["id"].endswith("/taqueria-el-tapatio-woodland-hills")]
            for t in d["offers"]:
                if t["id"].endswith("/taqueria-el-tapatio"):
                    t["other_details"] = ["2 locations listed", "Location listed: Woodland Hills"]
            s = next(o for o in d["offers"] if o["id"] == "citi-double-cash/subway-woodland-hills")
            s.update(id="citi-double-cash/subway", merchant="Subway", other_details=["Location listed: Woodland Hills"])
        self.t.change_offers(old)
        p = self.t.csv("Citi Double Cash")
        dec = {"categories": {"Taqueria El Tapatio - Woodland Hills": "Dining"}}
        code, out, rep = self.t.run("report", "Citi Double Cash", [p], decisions=dec)
        self.assertEqual(code, 0, out)
        # until the pair is decided, its file row counts as new (as for any proposed pair)
        self.assertEqual([m["merchant"] for m in rep["new"]], ["Taqueria El Tapatio - Woodland Hills", "Subway - Woodland Hills"], out)
        self.assertEqual(rep["renames"], [], out)
        self.assertEqual([(m["saved"], m["file"]) for m in rep["proposals"]], [("citi-double-cash/subway", "Subway - Woodland Hills")], out)
        self.assertIn("adds or drops the location", rep["proposals"][0]["why"], out)
        self.assertEqual([c["merchant"] for c in rep["location_candidates"]], ["Taqueria El Tapatio - Woodland Hills", "Subway - Woodland Hills"], out)
        dec["pairs"] = [{"saved": "citi-double-cash/subway", "file": "Subway - Woodland Hills", "bonus": "5% Back", "accept": True}]
        dec["owner_approved"] = ["location_pairs"]
        out, rep = self.apply_ok("Citi Double Cash", [p], decisions=dec)
        by = self.t.offers()
        self.assertEqual(by["citi-double-cash/taqueria-el-tapatio"]["other_details"], [])
        s = by["citi-double-cash/subway"]
        self.assertEqual((s["merchant"], s["other_details"], s.get("aliases")), ("Subway - Woodland Hills", [], None))
        self.assertIn("(no alias: the old name is the new name's base)", out)
        self.assertEqual(self.t.load("merchant-locations.json"), {"groups": {}})

    def test_citi_old_rule_record_whose_plain_tile_is_gone_applies_once_decided(self):
        # Review 1A F4: the plain Taqueria tile is gone, only "Taqueria El Tapatio - Woodland Hills" is read. Both
        # names have cuisine entries (as in the real data), so a base alias would make validate.py refuse.
        def old(by, d):
            d["offers"] = [o for o in d["offers"] if not o["id"].endswith("/taqueria-el-tapatio-woodland-hills")]
            for t in d["offers"]:
                if t["id"].endswith("/taqueria-el-tapatio"):
                    t["other_details"] = ["2 locations listed", "Location listed: Woodland Hills"]
        self.t.change_offers(old)
        p = self.t.csv("Citi Double Cash", lambda rows: [r for r in rows if r["offer_id"] != "RN-90002"])
        code, out, rep = self.t.run("report", "Citi Double Cash", [p])
        self.assertEqual([(m["saved"], m["file"]) for m in rep["proposals"]],
                         [("citi-double-cash/taqueria-el-tapatio", "Taqueria El Tapatio - Woodland Hills")], out)
        pair = {"saved": "citi-double-cash/taqueria-el-tapatio", "file": "Taqueria El Tapatio - Woodland Hills", "bonus": "5% Back", "accept": True}
        out, rep = self.apply_ok("Citi Double Cash", [p], decisions={"pairs": [pair], "owner_approved": ["location_pairs"]})
        t = self.t.offers()["citi-double-cash/taqueria-el-tapatio"]
        self.assertEqual((t["merchant"], t.get("aliases"), t["other_details"]), ("Taqueria El Tapatio - Woodland Hills", None, []))

    def test_validate_failure_puts_files_back(self):
        cards = self.t.load("cards.json")
        cards["offer_lists"].pop("Citi Custom Cash")
        self.t.write_json("cards.json", cards)
        before = self.t.read("offers.json")
        code, out, _ = self.t.run("apply", "Citi Custom Cash", [self.t.csv("Citi Custom Cash")], decisions={})
        self.assertNotEqual(code, 0, out)
        self.assertIn("put back", out)
        self.assertEqual(self.t.read("offers.json"), before)

    def test_wrong_file_for_card_refused(self):
        code, out, _ = self.t.run("report", "Chase Freedom Flex", [self.t.csv("Chase Freedom")])
        self.assertEqual(code, 2, out)
        code, out, _ = self.t.run("report", "Capital One", [self.t.csv("Bank of America")])
        self.assertEqual(code, 2, out)

    def test_no_issuer_csv_in_the_repo(self):
        files = subprocess.run(["git", "ls-files", "*.csv", "**/*.csv"], cwd=REPO, capture_output=True, text=True).stdout.split()
        self.assertTrue(files)
        for f in files:
            self.assertTrue(f.startswith("tools/fixtures/"), f"{f}: only test fixtures may be CSVs in the repo")
        for f in FIX.glob("*.csv"):
            with open(f, newline="", encoding="utf-8") as fh:
                for r in csv.DictReader(fh):
                    for c, v in r.items():
                        if re.search(r"card|account|last_?4", c, re.I) and c != "card_aria_label":
                            self.assertFalse(re.search(r"\d", v or ""), f"{f.name}: {c} must stay blank in fixtures")


    # --- review findings (tests written by the reviewer, failing before the fixes) -----------------------------

    # Review finding B1: an accepted (decided) pair of a truncated saved name adds the cut-off name to aliases and keeps the
    # 'Name truncated on screen' note. CLAUDE.md: a paired truncated name takes the full name, NOT added to aliases,
    # and (Chase) the note is removed. The decided path ignores the truncated rule.
    def test_decided_truncated_pair_adds_no_alias(self):
        def ch(by, d):
            by["chase-freedom-flex/anantra-thai-restaurant"].update(merchant="Anantra Thai Resta…",
                                                                   other_details=["Name truncated on screen"])
            o = dict(by["chase-freedom-flex/anantra-thai-restaurant"], id="chase-freedom-flex/anantra-thai-restaurant-2",
                     merchant="Anantra Thai R…", other_details=["Name truncated on screen"])
            d["offers"].append(o)  # two cut-off candidates for one file row: not automatic, proposed
        self.t.change_offers(ch)
        p = self.t.csv("Chase Freedom Flex")
        code, out, rep = self.t.run("report", "Chase Freedom Flex", [p])
        self.assertIn(("chase-freedom-flex/anantra-thai-restaurant", "Anantra Thai Restaurant"),
                      [(m["saved"], m["file"]) for m in rep["proposals"]], out)
        pair = {"saved": "chase-freedom-flex/anantra-thai-restaurant", "file": "Anantra Thai Restaurant",
                "bonus": "5% cash back", "accept": True}
        code, out, rep = self.t.run("apply", "Chase Freedom Flex", [p], decisions={"pairs": [pair]})
        self.assertEqual(code, 0, out)
        o = self.t.offers()["chase-freedom-flex/anantra-thai-restaurant"]
        self.assertEqual(o["merchant"], "Anantra Thai Restaurant")
        self.assertNotIn("aliases", o, "truncated name must not be added to aliases")
        self.assertNotIn("Name truncated on screen", o["other_details"])

    # Review finding B2: when the FILE shows a cut-off name and the app has the full name, the tool replaces the full saved
    # name with the cut-off one (no alias, so searching the full name's tail stops finding it) and drops the note.
    def test_file_truncated_name_keeps_full_saved_name(self):
        def fn(rows):
            for r in rows:
                if r["merchant"] == "Anantra Thai Restaurant":
                    r["merchant"] = "Anantra Thai Resta…"
            return rows
        p = self.t.csv("Chase Freedom Flex", fn)
        code, out, rep = self.t.run("apply", "Chase Freedom Flex", [p], decisions={})
        self.assertEqual(code, 0, out)
        o = self.t.offers()["chase-freedom-flex/anantra-thai-restaurant"]
        self.assertEqual(o["merchant"], "Anantra Thai Restaurant", "a full saved name was replaced by a cut-off one")

    # Review finding B3: multi-part batch. Kept CLAUDE.md / OFFER_RECORD rule: at "batch complete", missing = active offers whose
    # last_read is older than the batch date. Saving part 1, then completing with part 2 marks part 1's offers missing.
    def test_batch_complete_with_last_part_only(self):
        rows_all = []
        p1 = self.t.csv("Chase Freedom Flex", lambda rows: rows[:1], name="part1.csv")
        p2 = self.t.csv("Chase Freedom Flex", lambda rows: rows[1:], name="part2.csv")
        code, out, _ = self.t.run("apply", "Chase Freedom Flex", [p1], decisions={}, extra=["--part"])
        self.assertEqual(code, 0, out)
        code, out, rep = self.t.run("apply", "Chase Freedom Flex", [p2], decisions={}, extra=["--complete-parts"])
        self.assertEqual(code, 0, out)
        by = self.t.offers()
        part1 = ["chase-freedom-flex/at-home"]
        self.assertEqual([by[i]["last_read"] for i in part1], [READ])
        self.assertEqual([by[i]["status"] for i in part1], ["active"],
                         "offers read in part 1 on the batch date were marked missing at batch complete")

    # Review finding B4: the Citi Double Cash file applied as Citi Custom Cash is not refused (the files have the same columns and
    # no card column; the file name says which card). CLAUDE.md: never combined; never copy activation between them.
    def test_citi_file_for_the_other_card_refused(self):
        p = self.t.csv("Citi Double Cash", name="Citi_DoubleCash_2026-10-25.csv")
        code, out, rep = self.t.run("report", "Citi Custom Cash", [p])
        self.assertNotEqual(code, 0, "a Double Cash file was accepted for Citi Custom Cash:\n" + out)

    # Review finding B4b: the Chase Freedom Flex file applied as Chase Freedom is not refused by the card check (only the
    # Freedom file carries card_name, so only Freedom->Flex is caught).
    def test_flex_file_for_freedom_refused_by_card_check(self):
        p = self.t.csv("Chase Freedom Flex", name="chase_freedom_flex_offers_2026-10-25.csv")
        code, out, rep = self.t.run("report", "Chase Freedom", [p])
        self.assertNotEqual(code, 0, "a Freedom Flex file was accepted as a Chase Freedom read:\n" + out[-600:])

    # Review finding B5: Chase expires_text: CLAUDE.md says the file's expiration_text as shown, minus the trailing period (only
    # Chase Travel's travel-timing sentence gets the date only). Any wording not starting "Offer expires" is dropped.
    def test_chase_expiration_text_other_wording_kept(self):
        def fn(rows):
            for r in rows:
                if r["merchant"] == "Babbel":
                    r["expiration_text"] = "Expires in 3 days."
            return rows
        p = self.t.csv("Chase Freedom Flex", fn)
        code, out, rep = self.t.run("apply", "Chase Freedom Flex", [p], decisions={})
        self.assertEqual(code, 0, out)
        self.assertEqual(self.t.offers()["chase-freedom-flex/babbel"]["expires_text"], "Expires in 3 days")

    # Review finding B6: a file name with a US-style date (no card digits at all) makes the year a "secret": every offer whose
    # expires_text holds /2026 is reported as a card-number leak and apply is blocked; the report masks the year.
    def test_us_date_in_file_name_is_not_a_card_number(self):
        p = self.t.csv("Chase Freedom Flex", name="chase_freedom_flex_10-25-2026.csv")
        code, out, rep = self.t.run("apply", "Chase Freedom Flex", [p], decisions={})
        self.assertEqual(code, 0, out[-700:])

    # Review finding B7: re-running apply for the same card and read date appends a second identical batches entry.
    def test_reapply_same_batch_no_duplicate_entry(self):
        p = self.t.csv("U.S. Bank")
        for _ in range(2):
            code, out, _ = self.t.run("apply", "U.S. Bank", [p], decisions={})
            self.assertEqual(code, 0, out)
        bt = [b for b in self.t.load()["batches"] if b["card"] == "U.S. Bank" and b["read_date"] == READ]
        self.assertEqual(len(bt), 1, f"duplicate batches entries: {bt}")

    # Review finding B8: a clash resolution for "Alibaba" also recategorises the restaurant "Ali Baba" (the named exception:
    # two businesses). The clash fix compares compact() names and ignores CATEGORY_EXCEPTIONS.
    def test_clash_fix_respects_alibaba_exception(self):
        def ch(by, d):
            base = by["capital-one/ebay"]
            d["offers"].append(dict(base, id="capital-one/alibaba", merchant="Alibaba", bonus="3% back",
                                    category="Marketplaces & Department Stores", other_details=[]))
            d["offers"].append(dict(by["bank-of-america/shiraz-restaurant"], id="bank-of-america/ali-baba",
                                    merchant="Ali Baba", category="Dining", other_details=[]))
            d["offers"].append(dict(by["chase-freedom/whisker"], id="chase-freedom/alibaba", merchant="Alibaba",
                                    category="Electronics & Software", other_details=[]))
        self.t.change_offers(ch)
        c = json.loads(self.t.read("cuisines.json"))
        c["merchants"]["Ali Baba"] = {"cuisine": "Persian & Mediterranean", "confidence": "Likely",
                                      "evidence": "x", "source": None, "checked": "2026-10-19", "locked": False}
        self.t.write_json("cuisines.json", c)

        def fn(rows):
            r = dict(next(r for r in rows if r["merchant"] == "eBay"), merchant="Alibaba", bonus="3% back", merchant_tld="")
            return rows + [r]
        p = self.t.csv("Capital One", fn)
        code, out, rep = self.t.run("apply", "Capital One", [p],
                                    decisions={"clashes": {"Alibaba": "Marketplaces & Department Stores"}})
        self.assertEqual(code, 0, out[-800:])
        self.assertEqual(self.t.offers()["bank-of-america/ali-baba"]["category"], "Dining",
                         "the Ali Baba restaurant was moved out of Dining by an Alibaba clash fix")

    # Review finding B9: U.S. Bank blank channel. Main CLAUDE.md (U.S. Bank refresh): file channel blank -> none_shown. The tool keeps
    # the saved channel instead (listed in the new CLAUDE.md as a "choice where the rules were silent").
    def test_us_bank_blank_channel_is_none_shown(self):
        self.t.change_offers(lambda by, d: by["us-bank/misfits-market"].update(channel="online"))
        p = self.t.csv("U.S. Bank")  # Misfits Market's channel is blank in the fixture
        code, out, rep = self.t.run("apply", "U.S. Bank", [p], decisions={})
        self.assertEqual(code, 0, out)
        self.assertEqual(self.t.offers()["us-bank/misfits-market"]["channel"], "none_shown")


    # --- after the review ---------------------------------------------------------------------------------------

    def test_bonus_change_on_a_used_offer_is_proposed(self):
        self.t.change_offers(lambda by, d: by["capital-one/pura-vida"].update(status="used", status_since="2026-10-20"))

        def fn(rows):
            for r in rows:
                if r["merchant"] == "Pura Vida":
                    r["bonus"] = "Spend $20, earn $20"
            return rows
        p = self.t.csv("Capital One", fn)
        code, out, rep = self.t.run("report", "Capital One", [p])
        self.assertEqual(rep["bonus_changes"], [], out)
        self.assertIn(("capital-one/pura-vida", "Pura Vida"), [(m["saved"], m["file"]) for m in rep["proposals"]])

    def test_accepted_bare_domain_pair_adds_the_domain_alias(self):
        def fn(rows):
            for r in rows:
                if r["merchant"] == "Carhartt":
                    r["merchant"] = "carharttworkwear.com"
            return rows
        p = self.t.csv("Capital One", fn)
        pair = {"saved": "capital-one/carhartt", "file": "carharttworkwear.com", "bonus": "Up to 25% back", "accept": True}
        self.apply_ok("Capital One", [p], decisions={"pairs": [pair]})
        o = self.t.offers()["capital-one/carhartt"]
        self.assertEqual((o["merchant"], o["aliases"]), ("Carhartt", ["carharttworkwear.com"]))
        code, out, rep = self.t.run("report", "Capital One", [p])  # the next read matches it through the alias
        self.assertEqual((rep["proposals"], rep["new"], rep["missing"]), ([], [], []), out)

    def test_unproposed_pair_can_be_decided(self):
        def fn(rows):
            for r in rows:
                if r["merchant"] == "Carhartt":
                    r["merchant"] = "Workwear Co"
            return rows
        p = self.t.csv("Capital One", fn)
        code, out, rep = self.t.run("report", "Capital One", [p])
        self.assertEqual(rep["proposals"], [], out)
        pair = {"saved": "capital-one/carhartt", "file": "Workwear Co", "bonus": "Up to 25% back", "accept": True}
        self.apply_ok("Capital One", [p], decisions={"pairs": [pair]})
        o = self.t.offers()["capital-one/carhartt"]
        self.assertEqual((o["merchant"], o["aliases"]), ("Workwear Co", ["Carhartt"]))

    def test_bad_timestamp_refused(self):
        def fn(rows):
            rows[0]["end_date"] = "2026-11-30"
            return rows
        code, out, _ = self.t.run("report", "U.S. Bank", [self.t.csv("U.S. Bank", fn)])
        self.assertEqual(code, 2, out)
        self.assertIn("not a UTC timestamp", out)

    def test_no_card_column_stops_for_the_owner(self):
        # A sibling card's file with no card column (and no card_name) stops for card_check; the owner confirms.
        for card, drop in (("Citi Custom Cash", ["card"]), ("Chase Freedom", ["card", "card_name"])):
            with self.subTest(card=card):
                p = self.t.csv(card, drop_cols=drop, name=f"no_card_column_{CSVS[card]}")
                code, out, rep = self.t.run("report", card, [p])
                self.assertEqual(code, 0, out)  # the report still shows everything
                self.assertEqual([x["key"] for x in rep["stops"]], ["card_check"], out)
                self.assertIn("STOP, ask the owner", out)
                code, out, _ = self.t.run("apply", card, [p], decisions={})
                self.assertEqual(code, 2, out)
                self.apply_ok(card, [p], decisions={"owner_approved": ["card_check"]})
        # Cards that are not one of the four siblings need no card column.
        code, out, rep = self.t.run("report", "U.S. Bank", [self.t.csv("U.S. Bank")])
        self.assertEqual(rep["stops"], [], out)


    # --- re-review findings (tests written by the reviewer, failing before the second fixes) --------------------

    # Re-review finding C1: card check refuses a legitimate Citi Custom Cash read (file name says custom cash) when Citi gave Custom
    # Cash offers that Double Cash already has saved: it "matches more of Double Cash's saved offers". Even report
    # is refused, so the session cannot see the report without the owner.
    def test_card_check_legit_custom_cash_read_with_shared_new_offers(self):
        def fn(rows):
            extra = [dict(rows[2], offer_id=f"fixture-new-{k}", merchant=m, bonus=b, enrollment_state="Enroll in Offer")
                     for k, (m, b) in enumerate([("BestBuy", "$10 Back"), ("Lyft", "10% Back"), ("Splash", "$20 Back")])]
            return rows + extra
        p = self.t.csv("Citi Custom Cash", fn, name="citi_custom_cash_2026-10-25.csv")
        code, out, rep = self.t.run("report", "Citi Custom Cash", [p])
        self.assertEqual(code, 0, "legit Custom Cash read refused:\n" + out[-500:])

    # Re-review finding C1b: same for Chase: a legit Chase Freedom read whose new offers Freedom Flex already has.
    def test_card_check_legit_freedom_read_with_shared_new_offers(self):
        def fn(rows):
            extra = []
            for m, b in [("At Home", "15% cash back"), ("Away", "$50 cash back"), ("Babbel", "15% cash back"),
                         ("CarParts.com", "5% cash back"), ("DIRECTV", "$30 cash back"), ("Anantra Thai Restaurant", "5% cash back")]:
                extra.append(dict(rows[0], offer_id="FIXTURE:x" + m, merchant=m, bonus_as_shown=b))
            return rows + extra
        p = self.t.csv("Chase Freedom", fn, name="chase_freedom_offers_2026-10-25.csv")
        code, out, rep = self.t.run("report", "Chase Freedom", [p])
        self.assertEqual(code, 0, "legit Chase Freedom read refused:\n" + out[-500:])

    # Re-review finding C2: the looser FILE_DATE pattern swallows a last-four written next to a month-day: '..._9876_10-25.csv'
    # matches \d{4}[-_.]\d{1,2}[-_.]\d{1,2} as a "date", so 9876 is printed unmasked in the report and is no
    # longer a secret. The first commit masked it.
    def test_last_four_next_to_month_day_is_masked(self):
        p = self.t.csv("Citi Custom Cash", name="citi_custom_cash_9876_10-25.csv")
        code, out, rep = self.t.run("report", "Citi Custom Cash", [p])
        self.assertEqual(code, 0, out[-400:])
        self.assertNotIn("9876", out, "a last-four in the file name was printed")

    # Re-review finding C2b: and it is no longer guarded: an offer carrying those digits is written.
    def test_last_four_next_to_month_day_still_guarded(self):
        def fn(rows):
            rows[4]["merchant"] = "Quik Stop 9876"
            return rows
        p = self.t.csv("Citi Custom Cash", fn, name="citi_custom_cash_9876_10-25.csv")
        code, out, rep = self.t.run("report", "Citi Custom Cash", [p])
        self.assertTrue(rep and rep["leaks"], "digits from the file name's last-four not flagged:\n" + out[-400:])

    # Re-review finding C3: both names cut off (saved 'Anantra Thai R…', file 'Anantra Thai Resta…'): the automatic truncated pair
    # takes the still-cut-off file name AND drops 'Name truncated on screen' (Chase), so a cut-off name loses its note.
    def test_both_truncated_keeps_note(self):
        self.t.change_offers(lambda by, d: by["chase-freedom-flex/anantra-thai-restaurant"].update(
            merchant="Anantra Thai R…", other_details=["Name truncated on screen"]))

        def fn(rows):
            for r in rows:
                if r["merchant"] == "Anantra Thai Restaurant":
                    r["merchant"] = "Anantra Thai Resta…"
            return rows
        p = self.t.csv("Chase Freedom Flex", fn)
        code, out, rep = self.t.run("apply", "Chase Freedom Flex", [p], decisions={})
        self.assertEqual(code, 0, out[-500:])
        o = self.t.offers()["chase-freedom-flex/anantra-thai-restaurant"]
        if o["merchant"].endswith("…"):
            self.assertIn("Name truncated on screen", o["other_details"], f"cut-off name {o['merchant']!r} lost its note")

    # Re-review finding C4: re-running "batch complete" on the last part (CLAUDE.md: "A re-run for the same card and date replaces its
    # batches entry") marks the earlier parts' offers missing, because once the batches entry exists for that date
    # parts_open is False and last_read == batch date no longer counts as "in the batch".
    def test_rerun_batch_complete_keeps_earlier_parts(self):
        p1 = self.t.csv("Chase Freedom Flex", lambda rows: rows[:1], name="part1.csv")
        p2 = self.t.csv("Chase Freedom Flex", lambda rows: rows[1:], name="part2.csv")
        code, out, _ = self.t.run("apply", "Chase Freedom Flex", [p1], decisions={}, extra=["--part"])
        self.assertEqual(code, 0, out)
        for _ in range(2):  # batch complete, then the same final apply run again (e.g. to correct a decision)
            code, out, rep = self.t.run("apply", "Chase Freedom Flex", [p2], decisions={}, extra=["--complete-parts"])
            self.assertEqual(code, 0, out[-400:])
        o = self.t.offers()["chase-freedom-flex/at-home"]
        self.assertEqual((o["last_read"], o["status"]), (READ, "active"), "part-1 offer marked missing by the re-run")


    # --- third review findings (tests written by the reviewer, failing before the third fixes) ----------------

    # Third review finding D1: a last-four in 1900-2099 written before a month-day with the same separator ('_2034_10_25') is taken
    # for a date (year 2034), so it is printed unmasked and is not guarded. The read date is 2026-10-25, so a
    # "date" eight years away is not the file's date.
    def test_last_four_that_looks_like_a_year_is_masked(self):
        p = self.t.csv("Citi Custom Cash", name="citi_custom_cash_2034_10_25.csv")
        code, out, rep = self.t.run("report", "Citi Custom Cash", [p])
        self.assertEqual(code, 0, out[-400:])
        self.assertNotIn("2034", out, "a last-four in the file name was printed")

    def test_last_four_that_looks_like_a_year_is_guarded(self):
        def fn(rows):
            rows[4]["merchant"] = "Quik Stop 2034"
            return rows
        p = self.t.csv("Citi Custom Cash", fn, name="citi_custom_cash_2034_10_25.csv")
        code, out, rep = self.t.run("report", "Citi Custom Cash", [p])
        self.assertTrue(rep and rep["leaks"], "digits from the file name's last-four not flagged")

    # Third review finding D2: a date with the month as a word ('Oct_25_2026') is not recognised, so the year becomes a "secret":
    # every offer whose expires_text has /2026 is a "leak", apply is blocked and the report masks the year.
    def test_month_name_date_in_file_name_is_not_a_card_number(self):
        p = self.t.csv("Chase Freedom Flex", name="chase_freedom_flex_offers_Oct_25_2026.csv")
        code, out, rep = self.t.run("apply", "Chase Freedom Flex", [p], decisions={})
        self.assertEqual(code, 0, out[-500:])

    # Third review finding D3: same-date rule. After a complete read dated D, a second complete read dated D in which a pair is rejected
    # (old offer + new offer) keeps the old offer active next to the new one and counts it in offers_found / the
    # size check, though the file does not have it. (Documented in CLAUDE.md as "cannot mark missing"; the
    # counting is not.) Real data shows it now: Capital One 2026-10-18 reports size 4690 for a 4688-offer file.
    def test_same_date_second_read_counts_only_the_file(self):
        p = self.t.csv("Capital One")
        code, out, _ = self.t.run("apply", "Capital One", [p], decisions={})
        self.assertEqual(code, 0, out[-300:])

        def fn(rows):
            for r in rows:
                if r["merchant"] == "Carhartt":
                    r["merchant"] = "carharttworkwear.com"
            return rows
        p2 = self.t.csv("Capital One", fn, name="capital_one_again.csv")
        pair = {"saved": "capital-one/carhartt", "file": "carharttworkwear.com", "bonus": "Up to 25% back", "accept": False}
        code, out, rep = self.t.run("report", "Capital One", [p2],
                                    decisions={"pairs": [pair], "categories": {"carharttworkwear.com": "Clothing & Jewelry"}})
        self.assertEqual(code, 0, out[-300:])
        self.assertEqual(rep["size_check"]["batch"], rep["offers_in_batch"],
                         f"batch counted {rep['size_check']['batch']} for a file of {rep['offers_in_batch']} offers")


    def test_card_column_decides_not_the_file_name(self):
        # Column names the other card: refused, whatever the file is called, even with card_check approved.
        p = self.t.csv("Citi Double Cash", name="citi_custom_cash_2026-10-25.csv")
        code, out, _ = self.t.run("report", "Citi Custom Cash", [p], decisions={"owner_approved": ["card_check"]})
        self.assertEqual(code, 2, out)
        self.assertIn("names Citi Double Cash", out)
        # Column names this card: accepted, whatever the file is called and however the list leans (a warning).
        p = self.t.csv("Citi Double Cash", lambda rows: [dict(r, card="Citi Custom Cash") for r in rows], name="Citi_DoubleCash.csv")
        code, out, rep = self.t.run("report", "Citi Custom Cash", [p])
        self.assertEqual(code, 0, out)
        self.assertNotIn("card_check", [x["key"] for x in rep["stops"]], out)  # (new_share stops: 5 of 7 are new here)
        self.assertTrue(rep["card_warning"], out)
        self.assertIn("WARNING (card check)", out)
        self.apply_ok("Citi Custom Cash", [p], decisions={"owner_approved": ["new_share"]})

    def test_card_name_names_the_other_chase_card(self):
        p = self.t.csv("Chase Freedom", lambda rows: [dict(r, card_name="Freedom Flex") for r in rows], drop_cols=["card"])
        code, out, _ = self.t.run("report", "Chase Freedom", [p])
        self.assertEqual(code, 2, out)
        self.assertIn("names Chase Freedom Flex", out)

    def test_card_columns_that_disagree_or_are_unknown(self):
        mixed = self.t.csv("Citi Custom Cash", lambda rows: [dict(r, card="Citi Double Cash") if k == 0 else r for k, r in enumerate(rows)])
        code, out, _ = self.t.run("report", "Citi Custom Cash", [mixed])
        self.assertEqual(code, 2, out)
        self.assertIn("more than one card", out)
        odd = self.t.csv("Citi Custom Cash", lambda rows: [dict(r, card="Citi Premier") for r in rows], name="odd.csv")
        code, out, rep = self.t.run("report", "Citi Custom Cash", [odd])
        self.assertEqual([x["key"] for x in rep["stops"]], ["card_check"], out)

    def test_card_name_digits_ignored_and_never_stored(self):
        fake = "5182"  # made up, written only into this temporary copy
        p = self.t.csv("Chase Freedom", lambda rows: [dict(r, card_name=f"Freedom ...{fake}") for r in rows], drop_cols=["card"])
        code, out, rep = self.t.run("report", "Chase Freedom", [p])
        self.assertEqual((code, rep["stops"]), (0, []), out)  # still read as Chase Freedom
        self.assertNotIn(fake, out)
        self.apply_ok("Chase Freedom", [p])
        self.assertNotIn(fake, self.t.read("offers.json"))
        self.assertNotIn("Freedom ...", self.t.read("offers.json"))

    def test_same_date_read_without_complete_parts_marks_missing(self):
        self.apply_ok("Chase Freedom Flex", [self.t.csv("Chase Freedom Flex")])
        p = self.t.csv("Chase Freedom Flex", lambda rows: [r for r in rows if r["merchant"] != "Babbel"], name="again.csv")
        code, out, rep = self.t.run("report", "Chase Freedom Flex", [p])
        self.assertEqual([m["id"] for m in rep["missing"]], ["chase-freedom-flex/babbel"], out)


    # --- fourth review findings (tests written by the reviewer, failing before the fourth fixes) --------------

    def parts(self):
        p1 = self.t.csv("Chase Freedom Flex", lambda rows: rows[:1], name="part1.csv")
        p2 = self.t.csv("Chase Freedom Flex", lambda rows: rows[1:], name="part2.csv")
        code, out, _ = self.t.run("apply", "Chase Freedom Flex", [p1], decisions={}, extra=["--part"])
        self.assertEqual(code, 0, out)
        return p2

    # Fourth review finding E0 (control, expected to pass): round-1 B3 and round-2 C4 with the new --complete-parts flag.
    def test_control_complete_parts_keeps_part_one(self):
        p2 = self.parts()
        for _ in range(2):
            code, out, _ = self.t.run("apply", "Chase Freedom Flex", [p2], decisions={}, extra=["--complete-parts"])
            self.assertEqual(code, 0, out[-300:])
        o = self.t.offers()["chase-freedom-flex/at-home"]
        self.assertEqual((o["status"], o["last_read"]), ("active", READ))

    # Fourth review finding E1: forgetting --complete-parts after a --part run. Nothing stops it: the size check (5 of 6) and the
    # missing limit (1 <= 5) pass, and the offer part 1 read on the batch date is silently marked missing. The tool
    # can see it (this card has offers read on the batch date and no batches entry for that date yet).
    def test_plain_apply_after_part_is_refused_or_warns(self):
        p2 = self.parts()
        code, out, rep = self.t.run("apply", "Chase Freedom Flex", [p2], decisions={})
        if code == 0:
            o = self.t.offers()["chase-freedom-flex/at-home"]
            self.assertEqual(o["status"], "active",
                             "plain apply after --part marked the part-1 offer missing, with no stop or warning")

    # Fourth review finding E2: a month-year date with no day ('Oct_2026') is not taken for a date: 2026 becomes a "secret", every
    # offer whose expires_text holds /2026 is a "leak" and apply is blocked.
    def test_month_year_in_file_name_is_not_a_card_number(self):
        p = self.t.csv("Chase Freedom Flex", name="chase_freedom_flex_offers_Oct_2026.csv")
        code, out, rep = self.t.run("apply", "Chase Freedom Flex", [p], decisions={})
        self.assertEqual(code, 0, out[-400:])

    # Fourth review finding E3: a day-month-year date ('25-10-2026') is read as month 25: not a date, so 2026 becomes a "secret" and
    # apply is blocked.
    def test_day_month_year_in_file_name_is_not_a_card_number(self):
        p = self.t.csv("Chase Freedom Flex", name="chase_freedom_flex_offers_25-10-2026.csv")
        code, out, rep = self.t.run("apply", "Chase Freedom Flex", [p], decisions={})
        self.assertEqual(code, 0, out[-400:])


    def test_plain_apply_after_part_stops_until_approved(self):
        p2 = self.parts()
        code, out, rep = self.t.run("report", "Chase Freedom Flex", [p2])
        self.assertIn("parts", [x["key"] for x in rep["stops"]], out)
        self.assertEqual(rep["missing"][0]["id"], "chase-freedom-flex/at-home")


    # --- fifth review findings (tests written by the reviewer, failing before the fifth fixes) ----------------

    # Fifth review finding G1: the owner's rule is a card column "on every row". A file whose card column is blank on every row but one,
    # and that one names this card, is accepted with no card_check stop: blank cells are dropped before deciding.
    # Here the rows are the Double Cash list; only the first row says Citi Custom Cash.
    def test_card_column_blank_on_most_rows_stops(self):
        def fn(rows):
            for k, r in enumerate(rows):
                r["card"] = "Citi Custom Cash" if k == 0 else ""
            return rows
        p = self.t.csv("Citi Double Cash", fn, name="citi_2026-10-25.csv")
        code, out, rep = self.t.run("report", "Citi Custom Cash", [p])
        stopped = code != 0 or any(s["key"] == "card_check" for s in (rep or {}).get("stops", []))
        self.assertTrue(stopped, "a card column filled on 1 row of 9 settled the card check:\n" + out[-500:])

    # Fifth review finding G2: a file-name month-year ('Oct_2026') counts as a date only within 31 days of the 1st of that month, so a read
    # dated 2026-11-05 makes 2026 a "secret": every offer with /2026 in expires_text is a leak and apply is blocked.
    def test_month_year_file_name_read_early_next_month(self):
        p = self.t.csv("Chase Freedom Flex", name="chase_freedom_flex_offers_Oct_2026.csv")
        code, out, rep = self.t.run("apply", "Chase Freedom Flex", [p], read_date="2026-11-05", decisions={})
        self.assertNotIn("digits from a card number column or the file name", out, out[-400:])


    # --- offers that ended before the read date (a refresh a few weeks after the last one) ---------------------

    def later_read(self, card, read_date, keep, fix=None):
        """The card's fixture CSV as read on a later date: only the rows `keep` accepts, with a read_date column."""
        def fn(rows):
            rows = [dict(r, read_date=read_date) for r in rows if keep(r)]
            return [fix(r) for r in rows] if fix else rows
        return self.t.csv(card, fn, extra_cols=["read_date"], name=f"later_{CSVS[card]}")

    def test_us_bank_later_read_expires_ended_offers(self):
        # Read 2026-11-14: Round Table (ends 11-13) and Two Hands (11-06) are no longer on the page.
        p = self.later_read("U.S. Bank", "2026-11-14", lambda r: r["end_date"] >= "2026-11-15")
        code, out, rep = self.t.run("report", "U.S. Bank", [p], read_date=None)
        self.assertEqual(rep["missing"], [], out)
        self.assertEqual(sorted(m["id"] for m in rep["expired_absent"]), ["us-bank/round-table-pizza", "us-bank/two-hands-corn-dogs"], out)
        self.assertEqual((rep["size_check"]["batch"], rep["size_check"]["prior_active"], rep["size_check"]["pass"]), (4, 4, True), out)
        self.assertIn("Expired by date, not in the file (not missing): 2", out)
        self.assertEqual(rep["stops"], [], out)
        self.apply_ok("U.S. Bank", [p], read_date=None, dec_date="2026-11-14")
        by = self.t.offers()
        for i in ("us-bank/round-table-pizza", "us-bank/two-hands-corn-dogs"):
            self.assertEqual((by[i]["status"], by[i]["status_since"]), ("expired", "2026-11-14"), i)
        self.assertEqual(by["us-bank/la-colombe"]["status"], "active")

    def test_chase_later_read_expires_ended_offers(self):
        # Read 2026-11-10: Away (ends 11-05) and Anantra (11-07) are gone; the others keep their end timestamps.
        p = self.later_read("Chase Freedom Flex", "2026-11-10", lambda r: r["offer_end_timestamp"] >= "2026-11-11")
        code, out, rep = self.t.run("report", "Chase Freedom Flex", [p], read_date=None)
        self.assertEqual(rep["missing"], [], out)
        self.assertEqual(sorted(m["id"] for m in rep["expired_absent"]),
                         ["chase-freedom-flex/anantra-thai-restaurant", "chase-freedom-flex/away"], out)
        self.assertEqual((rep["size_check"]["batch"], rep["size_check"]["prior_active"]), (4, 4), out)
        self.apply_ok("Chase Freedom Flex", [p], read_date=None, dec_date="2026-11-10")
        self.assertEqual(self.t.offers()["chase-freedom-flex/away"]["status"], "expired")

    def test_citi_later_read_expires_ended_countdowns(self):
        # Read 2026-11-01: BestBuy and Splash (estimated end 10-30) are gone; the rest count down to their same end.
        from datetime import date
        ends = {o["merchant"]: o["expires"] for o in self.t.offers().values() if o["card"] == "Citi Double Cash"}
        ends.update({"oribe.com": ends["Oribe Hair Care"], "Splash": ends["Splash Wines"], "Kickin KAsian Encino": ends["Kickin KAsian - Encino"]})
        def fix(r):
            if r["source_tab"] == "Redeemed":
                return r
            left = (date.fromisoformat(ends[r["merchant"]]) - date(2026, 11, 1)).days
            return dict(r, expiration=f"{left}d left")
        p = self.later_read("Citi Double Cash", "2026-11-01",
                            lambda r: r["source_tab"] == "Redeemed" or ends[{"oribe.com": "Oribe Hair Care", "Splash": "Splash Wines",
                                "Kickin KAsian Encino": "Kickin KAsian - Encino"}.get(r["merchant"], r["merchant"])] >= "2026-11-01", fix)
        code, out, rep = self.t.run("report", "Citi Double Cash", [p], read_date=None)
        self.assertEqual(rep["missing"], [], out)
        self.assertEqual(sorted(m["id"] for m in rep["expired_absent"]), ["citi-double-cash/bestbuy", "citi-double-cash/splash-wines"], out)
        self.assertEqual((rep["size_check"]["batch"], rep["size_check"]["prior_active"], rep["changes"]["fields"].get("expires", 0)), (6, 6, 0), out)
        self.apply_ok("Citi Double Cash", [p], read_date=None, dec_date="2026-11-01")
        self.assertEqual(self.t.offers()["citi-double-cash/bestbuy"]["status"], "expired")

    def test_absent_offer_ending_on_the_read_date_is_missing(self):
        # Read 2026-11-15: Park's Finest ends that day, so it should still be on the page; absent = missing.
        p = self.later_read("U.S. Bank", "2026-11-15", lambda r: r["end_date"] >= "2026-11-16" and "Park" not in r["merchant"])
        code, out, rep = self.t.run("report", "U.S. Bank", [p], read_date=None)
        self.assertEqual([m["id"] for m in rep["missing"]], ["us-bank/park-s-finest-bbq-the"], out)
        self.assertNotIn("us-bank/park-s-finest-bbq-the", [m["id"] for m in rep["expired_absent"]])

    def test_offer_in_file_past_its_saved_end_stays_active(self):
        # Round Table's saved end (11-13) has passed on 2026-11-14, but the file still lists it with a new end.
        def fix(r):
            return dict(r, end_date="2026-12-01T04:59:59Z") if r["merchant"] == "Round Table Pizza" else r
        p = self.later_read("U.S. Bank", "2026-11-14", lambda r: r["end_date"] >= "2026-11-15" or r["merchant"] == "Round Table Pizza", fix)
        out, rep = self.apply_ok("U.S. Bank", [p], read_date=None, dec_date="2026-11-14")
        o = self.t.offers()["us-bank/round-table-pizza"]
        self.assertEqual((o["status"], o["expires"], o["last_read"]), ("active", "2026-11-30", "2026-11-14"))
        self.assertEqual((rep["size_check"]["prior_active"], rep["size_check"]["renewed"]), (5, 1))  # 4 live + Round Table

    def test_truncated_later_export_still_fails_the_size_check(self):
        # Only 2 of the 4 offers still live on 2026-11-14 are in the file: under 70%, whatever ended.
        p = self.later_read("U.S. Bank", "2026-11-14", lambda r: r["end_date"] >= "2026-11-29")
        code, out, rep = self.t.run("report", "U.S. Bank", [p], read_date=None)
        self.assertFalse(rep["size_check"]["pass"], out)
        self.assertEqual(len(rep["missing"]), 2, out)


    # --- review of the ended-offers change (tests written by the reviewer; A-C failed before the fixes) --------

    def later_us(self, read_date, keep, fix=None):
        def fn(rows):
            rows = [dict(r, read_date=read_date) for r in rows if keep(r)]
            return [fix(r) for r in rows] if fix else rows
        return self.t.csv("U.S. Bank", fn, extra_cols=["read_date"], name=f"later_{read_date}.csv")

    def test_review_A_long_gap_one_row_export_is_warned_about(self):
        # Read 2026-12-05: every saved U.S. Bank offer's end (latest 11-29) has passed. The export has ONE row
        # (La Colombe, renewed to 12-31). Owner's rule: ended offers are hidden either way, so this is a warning
        # (a re-read brings renewed ones back), never a stop; the size check is not "skipped".
        p = self.later_us("2026-12-05", lambda r: r["deal_id"] == "FIXTURE1",
                       lambda r: dict(r, end_date="2027-01-01T04:59:59Z"))
        code, out, rep = self.t.run("report", "U.S. Bank", [p], read_date=None)
        self.assertFalse(rep["size_check"]["skipped"], "size check reported as skipped ('no active offers before') although 6 were active")
        self.assertEqual(rep["stops"], [], out)
        self.assertIn("WARNING (size): File is 17% of the last full read (6 offers). If the page looked fuller, re-read it.", out)
        self.apply_ok("U.S. Bank", [p], read_date=None, dec_date="2026-12-05")

    def test_review_B_truncated_export_with_renewals_fails_size_check(self):
        # Read 2026-11-14: Round Table (11-13) and Two Hands (11-06) were renewed and are in the file with new ends;
        # of the 4 still-live offers only 2 are in the file (a truncated export: half the live offers dropped).
        renew = {"FIXTURE3", "FIXTURE5"}
        p = self.later_us("2026-11-14", lambda r: r["deal_id"] in renew | {"FIXTURE1", "FIXTURE2"},
                       lambda r: dict(r, end_date="2026-12-31T04:59:59Z") if r["deal_id"] in renew else r)
        code, out, rep = self.t.run("report", "U.S. Bank", [p], read_date=None)
        s = rep["size_check"]
        self.assertFalse(s["pass"], "2 of 4 live offers in the file, yet the size check passes (renewed ended offers count in the batch, not in the prior)")

    def test_review_C_pending_edit_offer_left_to_cleanup(self):
        # Two Hands (ended 11-06) has a pending activation edit and is absent on 2026-11-14. Cleanup never expires an
        # offer with a pending edit (main leaves it as 'missing' and the fold + next cleanup handle it).
        self.t.write_json("phone-edits.json", {"us-bank/two-hands-corn-dogs": {"activation": "already_activated"}})
        p = self.later_us("2026-11-14", lambda r: r["deal_id"] != "FIXTURE5")
        code, out, rep = self.t.run("apply", "U.S. Bank", [p], read_date=None, decisions={"owner_approved": []}, dec_date="2026-11-14")
        self.assertEqual(code, 0, out[-600:])
        o = self.t.offers()["us-bank/two-hands-corn-dogs"]
        self.assertNotEqual(o["status"], "expired", "an offer with a pending phone edit was expired by date")

    def test_review_D_ending_on_read_date_absent_is_missing_and_counts(self):
        p = self.later_us("2026-11-15", lambda r: r["deal_id"] not in ("FIXTURE4", "FIXTURE5", "FIXTURE3"))
        code, out, rep = self.t.run("report", "U.S. Bank", [p], read_date=None)
        self.assertEqual([m["id"] for m in rep["missing"]], ["us-bank/park-s-finest-bbq-the"])
        self.assertEqual(rep["size_check"]["prior_active"], 4)

    def test_review_E_part_then_complete_parts_with_ended(self):
        # Two parts read 2026-11-14: part 1 La Colombe x2, part 2 Misfits + Park's (Round Table, Two Hands ended).
        p1 = self.later_us("2026-11-14", lambda r: r["deal_id"] in ("FIXTURE1", "FIXTURE2"))
        code, out, rep = self.t.run("apply", "U.S. Bank", [p1], read_date=None, decisions={}, dec_date="2026-11-14", extra=["--part"])
        self.assertEqual(code, 0, out[-500:])
        p2 = self.t.csv("U.S. Bank", lambda rows: [dict(r, read_date="2026-11-14") for r in rows if r["deal_id"] in ("FIXTURE4", "FIXTURE6")],
                        extra_cols=["read_date"], name="p2.csv")
        code, out, rep = self.t.run("report", "U.S. Bank", [p2], read_date=None, decisions={}, dec_date="2026-11-14", extra=["--complete-parts"])
        s = rep["size_check"]
        self.assertEqual((s["batch"], s["prior_active"], len(rep["missing"])), (4, 4, 0))


    def test_short_file_against_the_last_full_read_warns_only(self):
        # 3 of the last full read's 6: no warning. 2 of 6 (33%): the warning, but no stop.
        p = self.later_us("2026-12-05", lambda r: r["deal_id"] in ("FIXTURE1", "FIXTURE2", "FIXTURE6"),
                          lambda r: dict(r, end_date="2027-01-01T04:59:59Z"))
        code, out, rep = self.t.run("report", "U.S. Bank", [p], read_date=None)
        self.assertEqual((rep["size_check"]["last_batch"], rep["size_warning"]), (6, None), out)
        p = self.later_us("2026-12-05", lambda r: r["deal_id"] in ("FIXTURE1", "FIXTURE2"),
                          lambda r: dict(r, end_date="2027-01-01T04:59:59Z"))
        code, out, rep = self.t.run("report", "U.S. Bank", [p], read_date=None)
        self.assertEqual(rep["size_warning"], "File is 33% of the last full read (6 offers). If the page looked fuller, re-read it.")
        self.assertNotIn("size_check", [x["key"] for x in rep["stops"]], out)
        # The warning sits near the top of the report, above the matches.
        self.assertLess(out.index("WARNING (size)"), out.index("Matched exactly"))

    # Re-review cases (the reviewer's N1-N4), under the owner's rule: the 40% comparison only warns.

    def test_review_N1_complete_later_read_applies_with_a_warning(self):
        # U.S. Bank read 2026-11-28, complete: only La Colombe (2nd tile) and Misfits are still live.
        p = self.later_us("2026-11-28", lambda r: r["deal_id"] in ("FIXTURE2", "FIXTURE6"))
        code, out, rep = self.t.run("report", "U.S. Bank", [p], read_date=None)
        self.assertEqual((rep["missing"], rep["stops"]), ([], []), out)
        self.assertIn("WARNING (size): File is 33%", out)
        self.apply_ok("U.S. Bank", [p], read_date=None, dec_date="2026-11-28")

    def test_review_N2_cut_off_export_after_mass_expiry_applies_with_a_warning(self):
        # Read 2026-12-05: all saved ends passed; the export has 2 renewed offers and leaves 4 renewed ones out.
        # Ended offers are hidden either way; a live offer left out would still count toward stop b.
        p = self.later_us("2026-12-05", lambda r: r["deal_id"] in ("FIXTURE1", "FIXTURE2"),
                          lambda r: dict(r, end_date="2027-01-01T04:59:59Z"))
        out, rep = self.apply_ok("U.S. Bank", [p], read_date=None, dec_date="2026-12-05")
        self.assertTrue(rep["size_warning"], out)
        self.assertEqual(len(rep["expired_absent"]), 4)

    def test_review_N3_used_offers_since_the_last_read_lower_the_base(self):
        # Citi Double Cash: 6 of 8 offers marked used after the last full read (2026-10-18); a complete read lists 2.
        used = ("citi-double-cash/taqueria-el-tapatio", "citi-double-cash/taqueria-el-tapatio-woodland-hills",
                "citi-double-cash/oribe-hair-care", "citi-double-cash/lyft", "citi-double-cash/kickin-kasian-encino",
                "citi-double-cash/subway-woodland-hills")
        def fn(by, d):
            for i in used:
                by[i]["status"], by[i]["status_since"] = "used", "2026-10-20"
        self.t.change_offers(fn)
        p = self.t.csv("Citi Double Cash", lambda rows: [r for r in rows if r["source_tab"] == "Redeemed" or r["merchant"] in ("BestBuy", "Splash")])
        code, out, rep = self.t.run("report", "Citi Double Cash", [p])
        self.assertEqual((rep["size_check"]["last_batch"], rep["size_warning"], rep["stops"]), (2, None, []), out)

    def test_review_N4_warning_prints_when_no_offer_was_active(self):
        # Every saved U.S. Bank offer is missing; the last full read had 6; a 1-row file.
        def fn(by, d):
            for o in by.values():
                if o["card"] == "U.S. Bank":
                    o["status"], o["status_since"] = "missing", "2026-11-01"
        self.t.change_offers(fn)
        p = self.later_us("2026-11-14", lambda r: r["deal_id"] == "FIXTURE1")
        code, out, rep = self.t.run("report", "U.S. Bank", [p], read_date=None)
        self.assertTrue(rep["size_check"]["skipped"], out)
        self.assertIn("WARNING (size): File is 17% of the last full read (6 offers).", out)


    # --- 2026-10-31 Chase refreshes: rename wording and the sibling card check ---------------------------------

    def rename_line(self, out, sid):
        return next((l.strip() for l in out.splitlines() if l.strip().startswith(sid + ":")
                     and " -> " in l and "<- file" not in l), None)

    def test_rename_report_says_when_the_old_name_was_saved(self):
        def fn(rows):
            for r in rows:
                if r["merchant"] == "eBay":
                    r["merchant"] = "eBay Marketplace"
            return rows
        code, out, rep = self.t.run("report", "Capital One", [self.t.csv("Capital One", fn)])
        self.assertEqual([(m["alias"], m["alias_added"]) for m in rep["renames"]], [("added", True)], out)
        self.assertEqual(self.rename_line(out, "capital-one/ebay"),
                         "capital-one/ebay: 'eBay' -> 'eBay Marketplace' (old name added to aliases)", out)

    def test_rename_report_when_the_old_name_is_the_new_one_ignoring_punctuation(self):
        # 'Darn Tough Vermont' -> 'Darn Tough & Vermont': '&' reads as 'and' for matching, so it is a pair (here
        # automatic, through the 'Darn Tough' alias), but
        # ignoring case, accents and punctuation it is the same name, so set_aliases drops the old name. The offer
        # already has another alias ('Darn Tough'), which must not make the report say one was added.
        def fn(rows):
            for r in rows:
                if r["merchant"] == "Darn Tough Vermont":
                    r["merchant"] = "Darn Tough & Vermont"
            return rows
        p = self.t.csv("Capital One", fn)
        code, out, rep = self.t.run("report", "Capital One", [p])
        self.assertEqual([(m["id"], m["alias"], m["alias_added"]) for m in rep["renames"]],
                         [("capital-one/darn-tough", "same_name", False)], out)
        self.assertEqual(self.rename_line(out, "capital-one/darn-tough"),
                         "capital-one/darn-tough: 'Darn Tough Vermont' -> 'Darn Tough & Vermont' "
                         "(no alias needed: same name once punctuation is ignored)", out)
        self.apply_ok("Capital One", [p])
        o = self.t.offers()["capital-one/darn-tough"]
        self.assertEqual((o["merchant"], o["aliases"]), ("Darn Tough & Vermont", ["Darn Tough"]))  # aliases as before

    def test_rename_report_without_an_alias(self):
        # A paired truncated name takes the full name and never adds an alias.
        self.t.change_offers(lambda by, d: by["us-bank/two-hands-corn-dogs"].update(merchant="Two Hands Corn Dogs - Lit..."))
        code, out, rep = self.t.run("report", "U.S. Bank", [self.t.csv("U.S. Bank")])
        self.assertEqual([(m["alias"], m["alias_added"]) for m in rep["renames"]], [("none", False)], out)
        self.assertEqual(self.rename_line(out, "us-bank/two-hands-corn-dogs"),
                         "us-bank/two-hands-corn-dogs: 'Two Hands Corn Dogs - Lit...' -> 'Two Hands Corn Dogs - Little Tokyo' (no alias)", out)

    NEW_CITI = ("Fixture New Shop A", "Fixture New Shop B", "Fixture New Shop C")

    def citi_file(self, card, label, keep=None, new=True, name=None):
        """A copy of `card`'s Citi fixture, card column = label; keep(row) filters rows; new adds three made-up offers."""
        def fn(rows):
            rows = [dict(r, card=label) for r in rows if keep is None or keep(r)]
            if new:
                tpl = next(r for r in rows if r["source_tab"] != "Redeemed")
                rows += [dict(tpl, offer_id=f"FIX-NEW-{k}", merchant=m, bonus="7% Back", expiration="20d left",
                              source_tab="All", promo_tag="", section="Shopping") for k, m in enumerate(self.NEW_CITI)]
            return rows
        return self.t.csv(card, fn, name=name or f"{label.replace(' ', '_')}_{card.replace(' ', '_')}.csv")

    def refresh_double_cash_with_new_offers(self):
        p = self.citi_file("Citi Double Cash", "Citi Double Cash")
        self.apply_ok("Citi Double Cash", [p], decisions={"categories": {m: "Marketplaces & Department Stores" for m in self.NEW_CITI},
                                                             "owner_approved": ["new_share"]})  # 3 of 10: a tiny fixture
        self.assertEqual({o["first_seen"] for o in self.t.offers().values() if o["merchant"] in self.NEW_CITI}, {READ})

    def test_card_check_ignores_offers_the_sibling_gained_after_this_cards_last_read(self):
        # Double Cash is refreshed on READ with three new offers; the Custom Cash page shows them too. Its correct
        # read (its own fixture plus the three) must not warn: the three were not on Double Cash when Custom Cash
        # was last read (2026-10-18). (The old rule counted them: 3 Double-Cash-only hits against 2 of its own.)
        self.refresh_double_cash_with_new_offers()
        code, out, rep = self.t.run("report", "Citi Custom Cash", [self.citi_file("Citi Custom Cash", "Citi Custom Cash")])
        self.assertEqual(code, 0, out)
        self.assertIsNone(rep["card_warning"], out)
        self.assertNotIn("WARNING (card check)", out)

    def test_card_check_still_warns_on_the_sibling_file_after_its_refresh(self):
        # The same Double Cash file with its card column changed to Custom Cash: all 5 of Double Cash's own older
        # offers are in it and neither of Custom Cash's 2, so it warns (and stays a warning, not a stop).
        self.refresh_double_cash_with_new_offers()
        p = self.citi_file("Citi Double Cash", "Citi Custom Cash")
        code, out, rep = self.t.run("report", "Citi Custom Cash", [p])
        self.assertEqual(code, 0, out)
        self.assertNotIn("card_check", [x["key"] for x in rep["stops"]], out)
        self.assertEqual(rep["card_warning"],
                         "the list has 5 of the 5 offers only Citi Double Cash had when Citi Custom Cash was last read "
                         "(2026-10-18), and 0 of the 2 only Citi Custom Cash had when Citi Double Cash was last read "
                         "(2026-10-25); check that Citi Custom Cash was the card picked on the page", out)

    def test_card_check_counts_the_siblings_offers_against_this_cards_own(self):
        # Run as Double Cash. Custom Cash's own offers: Avis, Quik Stop; Double Cash's: BestBuy, Lyft, Splash (saved as
        # Splash Wines), Kickin KAsian, Subway. Both Custom Cash offers is most of them, but the file also has 3 of
        # Double Cash's own: more of its own, no warning (a card picking up its sibling's offers).
        cc_rows = self.t.csv("Citi Custom Cash", lambda rows: [r for r in rows if r["merchant"] in ("Avis", "Quik Stop")], name="cc_part.csv")
        with open(cc_rows, newline="", encoding="utf-8") as f:
            extra = [dict(r, card="Citi Double Cash", offer_id="cc-" + r["offer_id"]) for r in csv.DictReader(f)]
        def dc_file(own):
            return self.t.csv("Citi Double Cash", lambda rows: [r for r in rows if r["source_tab"] == "Redeemed" or r["merchant"]
                              in ("Taqueria El Tapatio", "lifeextension.com", "oribe.com") + own] + extra, name=f"dc_{len(own)}.csv")
        code, out, rep = self.t.run("report", "Citi Double Cash", [dc_file(("BestBuy", "Lyft", "Splash"))])
        self.assertEqual(code, 0, out)
        self.assertIsNone(rep["card_warning"], out)
        # With only 1 of its own: 2 of the sibling's against 1, a warning.
        code, out, rep = self.t.run("report", "Citi Double Cash", [dc_file(("BestBuy",))])
        self.assertEqual(rep["card_warning"],
                         "the list has 2 of the 2 offers only Citi Custom Cash had when Citi Double Cash was last read "
                         "(2026-10-18), and 1 of the 5 only Citi Double Cash had when Citi Custom Cash was last read "
                         "(2026-10-18); check that Citi Double Cash was the card picked on the page", out)

    def test_card_check_wrong_card_file_after_some_sibling_offers_ended(self):
        # Of Double Cash's 5 own offers, BestBuy went missing, Kickin KAsian expired and Splash Wines ended by date
        # before the read. The Double Cash page (and file) shows the other 2; labelled Custom Cash it must still warn:
        # offers no page can show are not counted (counting them, 2 of 5 is not most of them, and it stayed quiet).
        def fn(by, d):
            by["citi-double-cash/bestbuy"].update(status="missing", status_since="2026-10-20")
            by["citi-double-cash/kickin-kasian-encino"].update(status="expired", status_since="2026-10-20", expires="2026-10-20")
            by["citi-double-cash/splash-wines"]["expires"] = "2026-10-24"
        self.t.change_offers(fn)
        p = self.t.csv("Citi Double Cash", lambda rows: [dict(r, card="Citi Custom Cash") for r in rows
                       if r["merchant"] not in ("BestBuy", "Kickin KAsian Encino", "Splash")], name="dc_as_cc.csv")
        code, out, rep = self.t.run("report", "Citi Custom Cash", [p])
        self.assertEqual(code, 0, out)
        self.assertIn("the list has 2 of the 2 offers only Citi Double Cash had", rep["card_warning"] or "", out)


class CardCheckUnit(unittest.TestCase):
    """card_check called directly on small made-up offer lists (no files)."""

    def setUp(self):
        sys.path.insert(0, str(REPO / "tools"))
        import refresh
        self.r = refresh
        self.batches = [{"card": c, "read_date": "2026-10-18"} for c in ("Chase Freedom", "Chase Freedom Flex")]

    def offer(self, card, merchant, bonus="10% cash back", status="active", expires=None, first_seen="2026-10-18"):
        return {"card": card, "merchant": merchant, "bonus": bonus, "status": status, "expires": expires, "first_seen": first_seen}

    def check(self, offers, file_offers):
        incs = [self.r.Inc(m, b, [k + 2]) for k, (m, b) in enumerate(file_offers)]
        rows = [(k + 2, {"card": "Chase Freedom"}) for k in range(len(file_offers))]
        return self.r.card_check("Chase Freedom", rows, incs, offers, self.batches, "2026-10-31")

    def test_same_name_ignoring_punctuation_is_not_exclusive(self):
        # Flex renamed Fubo with no alias ('&' vs '+'); Freedom still has the old spelling. One offer, not two exclusives.
        offers = [self.offer("Chase Freedom Flex", "Fubo: Live TV + Sports", "40% cash back"),
                  self.offer("Chase Freedom", "Fubo - Live TV & Sports", "40% cash back")]
        self.assertEqual(self.check(offers, [("Fubo: Live TV + Sports", "40% cash back")]), (None, None, None))

    def test_ended_sibling_offers_do_not_count(self):
        flex = [self.offer("Chase Freedom Flex", "Live One"), self.offer("Chase Freedom Flex", "Gone", status="missing"),
                self.offer("Chase Freedom Flex", "Over", status="expired", expires="2026-10-20"),
                self.offer("Chase Freedom Flex", "Ended By Date", expires="2026-10-30")]
        refusal, stop, warning = self.check(flex + [self.offer("Chase Freedom", "Whisker")], [("Live One", "10% cash back")])
        self.assertIn("the list has 1 of the 1 offers only Chase Freedom Flex had", warning or "")

    def test_renewed_own_offers_still_count(self):
        # Freedom's own offers ended by their saved date but shown again (renewed) are this card's evidence.
        offers = ([self.offer("Chase Freedom Flex", f"Flex {k}") for k in "ABC"]
                  + [self.offer("Chase Freedom", f"Freedom {k}", expires="2026-10-30") for k in "DEF"])
        file_offers = [(f"Flex {k}", "10% cash back") for k in "AB"] + [(f"Freedom {k}", "10% cash back") for k in "DEF"]
        self.assertIsNone(self.check(offers, file_offers)[2])

    def test_used_or_missing_sibling_offers_do_not_count_even_if_shown(self):
        # A sibling offer marked used or missing is not on the sibling's page, so it is no evidence either way
        # (Lyft: dropped from Flex on 10-31, on the Freedom page the same day).
        offers = [self.offer("Chase Freedom Flex", "Live One"), self.offer("Chase Freedom Flex", "Used One", status="used"),
                  self.offer("Chase Freedom Flex", "Lyft", status="missing"), self.offer("Chase Freedom", "Whisker")]
        refusal, stop, warning = self.check(offers, [("Live One", "10% cash back")])
        self.assertIn("the list has 1 of the 1 offers only Chase Freedom Flex had", warning or "")  # Used One not counted
        offers[0]["status"] = "missing"
        self.assertIsNone(self.check(offers, [("Lyft", "10% cash back"), ("Whisker", "10% cash back")])[2])

    def test_own_offers_this_card_lost_are_not_its_evidence(self):
        # A wrong-card file (the Flex page) that picked up offers Freedom has lost (missing, used) must not count
        # them for Freedom; 1 of Flex's 1 against 0 still warns.
        offers = [self.offer("Chase Freedom Flex", "Flex A"), self.offer("Chase Freedom", "Gone", status="missing"),
                  self.offer("Chase Freedom", "Spent", status="used"), self.offer("Chase Freedom", "Freedom B")]
        file_offers = [("Flex A", "10% cash back"), ("Gone", "10% cash back"), ("Spent", "10% cash back")]
        self.assertIn("and 0 of the 1 only Chase Freedom had", self.check(offers, file_offers)[2] or "")

    def test_counts_not_shares(self):
        # 2 of the sibling's 2 against 3 of this card's 5: more of its own, no warning.
        offers = ([self.offer("Chase Freedom Flex", f"Flex {k}") for k in "AB"]
                  + [self.offer("Chase Freedom", f"Freedom {k}") for k in "CDEFG"])
        file_offers = [(f"Flex {k}", "10% cash back") for k in "AB"] + [(f"Freedom {k}", "10% cash back") for k in "CDE"]
        self.assertIsNone(self.check(offers, file_offers)[2])
        self.assertIsNotNone(self.check(offers, file_offers[:3])[2])  # 2 against 1: a warning


class ValidateLocationsTest(unittest.TestCase):
    """tools/validate.py on site/data/merchant-locations.json, in the fixture tree (CVS, eBay, Pura, Pura Vida...)."""

    def setUp(self):
        self.t = Tree()

    def tearDown(self):
        self.t.close()

    def validate(self, text):
        p = self.t.data / "merchant-locations.json"
        if text is None:
            p.unlink()
        else:
            p.write_text(text if isinstance(text, str) else json.dumps(text))
        r = subprocess.run([sys.executable, str(self.t.root / "tools/validate.py")], cwd=self.t.root, capture_output=True, text=True)
        return r.returncode, r.stdout + r.stderr

    def test_empty_file_passes(self):
        code, out = self.validate('{ "groups": {} }\n')
        self.assertEqual(code, 0, out)
        self.assertIn("0 approved location variants in 0 groups", out)

    def test_missing_file_is_an_error(self):
        code, out = self.validate(None)
        self.assertEqual(code, 1, out)
        self.assertIn("merchant-locations.json is missing", out)

    def test_bad_shapes_are_errors(self):
        for bad in ["{ not json", "[]", '{"groups": []}', '{"groups": {}, "extra": 1}', '{}',
                    {"groups": {"CVS": "CVS - Pasadena"}}, {"groups": {"CVS": []}}, {"groups": {"CVS": [3]}},
                    {"groups": {"!!": ["!! - Pasadena"]}}]:
            with self.subTest(bad=bad):
                code, out = self.validate(bad)
                self.assertEqual(code, 1, out)
                self.assertIn("merchant-locations.json", out)

    def test_member_rules(self):
        cases = {
            "not base - suffix": ({"groups": {"CVS": ["CVS Pasadena"]}}, "is not 'CVS - <location>'"),
            "another base": ({"groups": {"CVS": ["Pura - Pasadena"]}}, "is not 'CVS - <location>'"),
            "empty suffix": ({"groups": {"CVS": ["CVS - ..."]}}, "is its group's own name"),
            "equal to its base": ({"groups": {"CVS": ["cvs"]}}, "is its group's own name"),
            "equal to its base, .com": ({"groups": {"CVS": ["CVS.com"]}}, "is its group's own name"),
            "in two groups": ({"groups": {"CVS": ["CVS - Pasadena"], "C.V.S.": ["cvs - pasadena"]}}, "and in group"),
            "twice in one group": ({"groups": {"CVS": ["CVS - Pasadena", "CVS - PASADENA"]}}, "twice"),
            "member is also a group": ({"groups": {"CVS": ["CVS - Pasadena"], "CVS - Pasadena": ["CVS - Pasadena - East"]}},
                                       "is a group name and also a member"),
        }
        for label, (groups, msg) in cases.items():
            with self.subTest(label):
                code, out = self.validate(groups)
                self.assertEqual(code, 1, out)
                self.assertIn(msg, out)

    def test_absent_member_only_warns(self):
        code, out = self.validate({"groups": {"CVS": ["CVS - Pasadena"], "Round Table Pizza": ["Round Table Pizza - Newport Beach"]}})
        self.assertEqual(code, 0, out)
        self.assertIn("note: merchant-locations.json: 'CVS - Pasadena' (group 'CVS') is in no offer now", out)
        self.assertIn("2 approved location variants in 2 groups", out)

    def test_present_member_no_note(self):
        self.t.change_offers(lambda by, d: by["capital-one/pura-vida"].update(merchant="Pura Vida - Santa Monica"))
        code, out = self.validate({"groups": {"Pura Vida": ["Pura Vida - Santa Monica"]}})
        self.assertEqual(code, 0, out)
        self.assertNotIn("in no offer now", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)

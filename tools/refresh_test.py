#!/usr/bin/env python3
"""Checks for tools/refresh.py:  python3 tools/refresh_test.py

Each check runs the tool in a throwaway copy of the repo layout: tools/ (refresh, validate, cuisines,
fold_phone_edits) and site/data/ holding the fixture snapshot (tools/fixtures/offers.json, cuisines.json: 42 offers
copied from offers.json on 2026-10-20) plus the repo's cards.json, bonus-categories.json and card-links.json.
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
        for f in ("cards.json", "bonus-categories.json", "card-links.json"):
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
        p = self.t.csv("Citi Double Cash", lambda rows: rows[:5])  # 4 of 7 offers (Taqueria's 2 rows are 1 offer)
        code, out, rep = self.t.run("report", "Citi Double Cash", [p])
        self.assertFalse(rep["size_check"]["pass"], out)
        self.assertIn("STOP", out)
        before = self.t.read("offers.json")
        code, out, _ = self.t.run("apply", "Citi Double Cash", [p], decisions={})
        self.assertEqual(code, 2, out)
        self.assertEqual(self.t.read("offers.json"), before)
        self.apply_ok("Citi Double Cash", [p], decisions={"owner_approved": ["size_check"]})
        self.assertEqual(self.t.offers()["citi-double-cash/subway"]["status"], "missing")

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
        ends.update({"oribe.com": ends["Oribe Hair Care"], "Splash": ends["Splash Wines"], "Kickin KAsian Encino": ends["Kickin KAsian - Encino"],
                     "Subway - Woodland Hills": ends["Subway"], "Taqueria El Tapatio - Woodland Hills": ends["Taqueria El Tapatio"]})
        def fix(r):
            if r["source_tab"] == "Redeemed":
                return r
            left = (date.fromisoformat(ends[r["merchant"]]) - date(2026, 11, 1)).days
            return dict(r, expiration=f"{left}d left")
        p = self.later_read("Citi Double Cash", "2026-11-01",
                            lambda r: r["source_tab"] == "Redeemed" or ends[{"oribe.com": "Oribe Hair Care", "Splash": "Splash Wines",
                                "Kickin KAsian Encino": "Kickin KAsian - Encino", "Subway - Woodland Hills": "Subway",
                                "Taqueria El Tapatio - Woodland Hills": "Taqueria El Tapatio"}.get(r["merchant"], r["merchant"])] >= "2026-11-01", fix)
        code, out, rep = self.t.run("report", "Citi Double Cash", [p], read_date=None)
        self.assertEqual(rep["missing"], [], out)
        self.assertEqual(sorted(m["id"] for m in rep["expired_absent"]), ["citi-double-cash/bestbuy", "citi-double-cash/splash-wines"], out)
        self.assertEqual((rep["size_check"]["batch"], rep["size_check"]["prior_active"], rep["changes"]["fields"].get("expires", 0)), (5, 5, 0), out)
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
        # Citi Double Cash: 5 of 7 offers marked used after the last full read (2026-10-18); a complete read lists 2.
        used = ("citi-double-cash/taqueria-el-tapatio", "citi-double-cash/oribe-hair-care", "citi-double-cash/lyft",
                "citi-double-cash/kickin-kasian-encino", "citi-double-cash/subway")
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


if __name__ == "__main__":
    unittest.main(verbosity=2)

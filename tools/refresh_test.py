#!/usr/bin/env python3
"""Checks for tools/refresh.py:  python3 tools/refresh_test.py

Each check runs the tool in a throwaway copy of the repo layout: tools/ (refresh, validate, cuisines,
fold_phone_edits) and site/data/ holding the fixture snapshot (tools/fixtures/offers.json, cuisines.json: 45 offers
copied from offers.json on 2026-10-20) plus the repo's cards.json, bonus-categories.json and card-links.json, and
an empty merchant-locations.json of its own (checks that need groups write theirs).
The fixture CSVs (tools/fixtures/*.csv) are in each issuer's real column format and reproduce the snapshot when
read on 2026-10-25 (Citi countdowns and Chase end timestamps are set for that date). Checks change a copy of a
CSV or of the snapshot, run report / apply, and compare. The repo's own data is never touched.
"""
import csv, io, json, os, re, shutil, subprocess, sys, tempfile, unittest
from contextlib import redirect_stdout
from itertools import product
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
        for f in ("refresh.py", "validate.py", "cuisines.py", "fold_phone_edits.py", "coupon_promotions.py", "chase_terms.py"):
            shutil.copy(REPO / "tools" / f, self.root / "tools" / f)
        for f in ("offers.json", "cuisines.json"):
            shutil.copy(FIX / f, data / f)
        for f in ("cards.json", "bonus-categories.json", "card-links.json"):
            shutil.copy(REPO / "site/data" / f, data / f)
        self.data = data
        self.companions = {}
        self.write_json("merchant-locations.json", {"groups": {}})  # its own, whatever groups are deployed
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
        if card == "Capital One":
            # Keep the small historical fixture and write it in the supported inventory format for matching tests.
            kinds = {"carousel-item": "carousel_card", "top-offer": "hero"}
            rows = [dict(extraction_date=READ, layout_variant="current_layout", tile_kind=kinds.get(r["tile_kind"], r["tile_kind"]),
                         merchant=r["merchant"], domain=r["merchant_tld"], reward=r["bonus"], channel=r["channel"],
                         offer_type=r["offer_types"], offer_type_basis="Encoded tile offer-type labels",
                         activation_status="") for r in rows]
            return self.inventory(rows, name or CSVS[card])
        p = self.root / (name or CSVS[card])
        with open(p, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            for r in rows:
                w.writerow({c: r.get(c, "") for c in cols})
        return p

    def inventory(self, rows, name="inventory.csv"):
        grid_kinds = {"standard", "carousel_card", "hero", "showcase", "promoted_affiliate"}
        grid_size = 0
        positioned = []
        for row in rows:
            if row["layout_variant"] == "current_layout" and row["tile_kind"] in grid_kinds:
                grid_size += 1
                positioned.append({"grid_position": str(grid_size), **row})
            else:
                positioned.append({"grid_position": "", **row})
        p = self.root / name
        with p.open("w", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=list(dict.fromkeys(k for row in positioned for k in row)))
            writer.writeheader()
            writer.writerows(positioned)
        companion = self.root / (p.stem + "-companion.json")
        companion.write_text(json.dumps(self.coupon_capture(rows[0]["extraction_date"], grid_size)))
        self.companions[p] = companion
        return p

    @staticmethod
    def coupon_capture(day, grid_size, *, complete=True, panels=(), listings=()):
        return {"schema_version": 1, "capture_date": day, "capture_timezone": "America/Los_Angeles",
                "verified_coupon_offers": list(panels), "listing_only_promotions": list(listings),
                "source": {"platform": "Capital One Offers", "surface": "Unfiltered main offer feed",
                           "inventory_scan": {"available_feed_exhausted": True, "loaded_grid_entries": grid_size,
                                              "coupon_scan_complete": complete}}}

    def run(self, mode, card, paths, read_date=READ, decisions=None, extra=(), dec_date=None, auto_coupon=True):
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
        if auto_coupon and len(paths) == 1 and paths[0] in self.companions and "--coupons" not in extra:
            args += ["--coupons", str(self.companions[paths[0]])]
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
                        if card == "Capital One":
                            b["redemption"] = {"method": "via_shop_link", "evidence": "offer_type"}
                        if i in {"chase-freedom-flex/at-home", "chase-freedom-flex/away"}:
                            b["channel"] = "in_store_and_online"
                        chase_hosts = {
                            "chase-freedom/whisker": "Whisker.com",
                            "chase-freedom-flex/babbel": "babbel.com",
                            "chase-freedom-flex/carparts-com": "CarParts.com",
                        }
                        if i in chase_hosts:
                            b["fine_print"] = b["fine_print"].replace(chase_hosts[i], "the issuer-specified site")
                    self.assertEqual(o, b, i)
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

    def test_capital_one_inventory_redemption(self):
        with (FIX / "capital_one.csv").open(newline="") as stream:
            old_rows = list(csv.DictReader(stream))
        rows = [{
            "extraction_date": READ, "layout_variant": "current_layout", "tile_kind": "standard",
            "merchant": r["merchant"], "domain": r["merchant_tld"] or r["merchant"].lower().replace(" ", "-") + ".com",
            "reward": r["bonus"], "channel": r["channel"], "offer_type": "affiliate",
            "offer_type_basis": "Encoded tile offer-type labels", "activation_status": "",
            "promotional_text": "PRIVATE_PROMO_TEST_SENTINEL",
        } for r in old_rows]
        by_name = {r["merchant"].lower(): r for r in rows}
        ebay = by_name["ebay"]
        ebay["offer_type"] = "affiliate|coupon"
        loop = by_name["loop-mobile.com"]
        loop.update(offer_type="cardLinked", channel="In-App")
        for row in rows:
            if row["merchant"] == "CVS":
                row.update(offer_type="affiliate|cardLinked")
            if row["merchant"] == "Pura Vida":
                row.update(offer_type_basis="")
        rows += [
            dict(loop, tile_kind="added_to_card", offer_type="", offer_type_basis="", activation_status="Activated"),
            dict(ebay, layout_variant="mobile_layout_mirror", reward="70% back", offer_type="cardLinked"),
            dict(ebay, tile_kind="future_preview", reward="80% back"),
            dict(ebay, tile_kind="issuer_bonus_banner", reward="90% back"),
        ]
        p = self.write_inventory(rows)
        decisions = {"owner_approved": ["incomplete_coupon_scan"]}
        carhartt = by_name["carhartt"]["domain"]
        self.t.change_offers(lambda by, _: by["capital-one/carhartt"].update(merchant="Carhartt (workwear)", aliases=[carhartt]))
        before = self.t.offers()
        output, report = self.apply_ok("Capital One", [p], read_date=None, decisions=decisions)
        after = self.t.offers()
        self.assertEqual(report["read_date"], READ)
        self.assertEqual(before.keys(), after.keys())
        self.assertEqual(after["capital-one/carhartt"]["merchant"], "Carhartt (workwear)")
        self.assertEqual(after["capital-one/ebay"]["redemption"], {"method": "via_shop_link", "evidence": "offer_type"})
        self.assertEqual(after["capital-one/ebay"]["activation"], "none_shown")
        self.assertEqual(after["capital-one/ebay"]["minimum_spend"], before["capital-one/ebay"]["minimum_spend"])
        self.assertEqual(after["capital-one/cvs"]["redemption"]["method"], "mixed")
        self.assertEqual(after["capital-one/pura-vida"]["redemption"], {"method": "unknown", "evidence": "not_shown"})
        self.assertEqual((after["capital-one/loop-mobile"]["redemption"]["method"], after["capital-one/loop-mobile"]["channel"],
                          after["capital-one/loop-mobile"]["activation"]), ("card_linked", "in_app", "already_activated"))
        self.assertNotIn("PRIVATE_PROMO_TEST_SENTINEL", output + self.t.read("offers.json"))

        # A pending phone edit still wins over the issuer's observed activation.
        # A same-capture replay of the app placement preserves explicit online-or-app eligibility.
        self.t.change_offers(lambda by, _: by["capital-one/loop-mobile"].update(
            channel="online_and_app", channel_terms={
                "channel": "online_and_app", "domain": loop["domain"], "method": "card_linked", "read_date": READ, "note": "App or web."
            }))
        self.t.write_json("phone-edits.json", {"capital-one/loop-mobile": {"activation": "needs_activation"}})
        edits = self.t.read("phone-edits.json")
        self.apply_ok("Capital One", [p], read_date=None, decisions=decisions)
        self.assertEqual(self.t.read("phone-edits.json"), edits)
        self.assertEqual(self.t.offers()["capital-one/loop-mobile"]["activation"], "already_activated")
        self.assertEqual(self.t.offers()["capital-one/loop-mobile"]["channel"], "online_and_app")

    def seven_eleven_inventory(self):
        offer_id, previous_read, later_read = "capital-one/7-eleven", "2026-11-23", "2026-11-24"
        eligibility = "Order through 7Now or 7-Eleven. Physical in-store and fuel purchases are excluded."
        historical_activation = "Capital One shows Activated under Added to Card. The selected card was not shown."
        saved = {
            "id": offer_id, "card": "Capital One", "merchant": "7-Eleven", "category": "Groceries & Food Delivery",
            "bonus": "10% back", "expires": None, "expires_text": None, "activation": "already_activated",
            "redemption": {"method": "card_linked", "evidence": "offer_type"}, "channel": "online_and_app",
            "channel_terms": {"channel": "online_and_app", "domain": "7-eleven.com", "method": "card_linked", "read_date": previous_read,
                              "note": eligibility},
            "spend_cap": None, "minimum_spend": None, "fine_print": None,
            "other_details": [historical_activation], "last_read": previous_read,
            "first_seen": "2026-11-10", "status": "active", "status_since": "2026-11-10",
        }
        inventory_row = {
            "extraction_date": later_read, "layout_variant": "current_layout", "tile_kind": "standard",
            "merchant": "7-Eleven", "domain": "7-eleven.com", "reward": "10% back", "channel": "In-App",
            "offer_type": "cardLinked", "offer_type_basis": "Encoded tile offer-type labels", "activation_status": "",
        }
        snapshot = self.t.load()
        snapshot["offers"] = [o for o in snapshot["offers"] if o["card"] != "Capital One"] + [saved]
        snapshot["batches"].append({"card": "Capital One", "read_date": previous_read, "offers_found": 1})
        self.t.write_json("offers.json", snapshot)
        return snapshot, saved, inventory_row

    def write_inventory(self, rows):
        return self.t.inventory(rows)

    def main_grid_control(self, row):
        # A real grid listing alongside a standalone Added to Card placement.
        cvs = json.loads((FIX / "offers.json").read_text())
        offer = next(o for o in cvs["offers"] if o["id"] == "capital-one/cvs")
        self.t.change_offers(lambda _, data: data["offers"].append(offer))
        return dict(row, merchant=offer["merchant"], reward=offer["bonus"], domain="cvs.com")

    def test_capital_one_inventory_refresh_rechecks_activation(self):
        snapshot, saved, inventory_row = self.seven_eleven_inventory()
        offer_id, later_read = saved["id"], inventory_row["extraction_date"]
        activated = dict(inventory_row, tile_kind="added_to_card", activation_status="Activated")
        nonactivated = dict(inventory_row, activation_status="Not activated")
        cases = (
            ("no current evidence", [inventory_row], "none_shown", False, None),
            ("conflicting evidence", [nonactivated, activated], "none_shown", True, None),
            ("explicit nonactivation", [nonactivated, dict(inventory_row, activation_status="Needs activation")],
             "needs_activation", False, None),
            ("explicit activation with an unknown label on another placement",
             [dict(inventory_row, activation_status="Unknown"), activated], "already_activated", False, None),
            ("pending activation edit", [inventory_row], "already_activated", False, "needs_activation"),
        )
        for case, rows, expected, conflicting, pending in cases:
            with self.subTest(case=case):
                self.t.write_json("offers.json", snapshot)
                self.t.write_json("phone-edits.json", {offer_id: {"activation": pending}} if pending else {})
                edits = self.t.read("phone-edits.json")
                p = self.write_inventory(rows)
                _, report = self.apply_ok("Capital One", [p], read_date=None, dec_date=later_read)
                self.assertEqual(report["read_date"], later_read)
                self.assertEqual(any("conflicting activation labels" in flag for flag in report["flags"]), conflicting)
                offer = self.t.offers()[offer_id]
                self.assertEqual(offer["activation"], expected)
                self.assertEqual(offer["redemption"], saved["redemption"])
                self.assertEqual(offer["bonus"], saved["bonus"])
                self.assertEqual(offer["first_seen"], saved["first_seen"])
                self.assertEqual(offer["last_read"], later_read)
                self.assertEqual(offer["channel"], "online_and_app")
                self.assertEqual(offer["channel_terms"], saved["channel_terms"])
                self.assertNotIn(saved["other_details"][0], offer["other_details"])
                self.assertEqual(self.t.read("phone-edits.json"), edits)

    def test_capital_one_standalone_added_placement_stays_active(self):
        _, saved, row = self.seven_eleven_inventory()
        added = dict(row, tile_kind="added_to_card", activation_status="Activated", offer_type="", offer_type_basis="")
        p = self.write_inventory([self.main_grid_control(row), added])
        self.t.write_json("phone-edits.json", {saved["id"]: {"activation": "needs_activation"}})
        pending = self.t.read("phone-edits.json")
        _, report = self.apply_ok("Capital One", [p], read_date=row["extraction_date"])
        self.assertEqual((report["offers_in_batch"], report["new"], report["missing"]), (2, [], []))
        actual = self.t.offers()[saved["id"]]
        self.assertEqual((actual["status"], actual["bonus"], actual["activation"], actual["channel"]),
                         ("active", "10% back", "already_activated", "online_and_app"))
        self.assertEqual(actual["redemption"], {"method": "card_linked", "evidence": "activation_status"})
        self.assertEqual(self.t.read("phone-edits.json"), pending)

    def test_capital_one_competing_added_placement_needs_reconciliation(self):
        _, saved, row = self.seven_eleven_inventory()
        added = dict(row, tile_kind="added_to_card", activation_status="Activated", offer_type="", offer_type_basis="")
        for grid in ([dict(row, reward="12% back")], [dict(row, merchant="7Now")], [dict(row, merchant="7Now"), row]):
            with self.subTest(grid=grid):
                p = self.write_inventory([*grid, added])
                code, output, report = self.t.run("report", "Capital One", [p], read_date=row["extraction_date"])
                self.assertEqual(code, 0, output)
                self.assertEqual(report["offers_in_batch"], 2)
                self.assertIn(added["reward"], report["inventory_issues"][0])
                self.assertIn(grid[0]["merchant"] + " | " + grid[0]["reward"], report["inventory_issues"][0])
                before = self.t.read("offers.json")
                self.assertEqual(self.t.run("apply", "Capital One", [p], read_date=row["extraction_date"], decisions={})[0], 2)
                self.assertEqual(self.t.read("offers.json"), before)

        # The two distinct rewards must be confirmed before adding a new variant.
        p = self.write_inventory([dict(row, reward="12% back"), added])
        _, _, report = self.t.run("report", "Capital One", [p], read_date=row["extraction_date"])
        separate = dict(report["distinct_rewards"][0], confirm=True)
        _, report = self.apply_ok("Capital One", [p], read_date=row["extraction_date"], decisions={
            "distinct_rewards": [separate], "owner_approved": ["new_share"],
        })
        self.assertEqual([o["bonus"] for o in report["new"]], ["12% back"])
        # Established reward-specific identities reconcile on later runs.
        _, report = self.apply_ok("Capital One", [p], read_date=row["extraction_date"])
        self.assertEqual((report["new"], report["missing"]), ([], []))
        self.assertEqual(self.t.offers()[saved["id"]]["activation"], "already_activated")
        self.assertEqual(self.t.offers()["capital-one/7-eleven-2"]["activation"], "none_shown")

    def test_capital_one_ambiguous_standalone_added_identity_requires_a_pair(self):
        snapshot, saved, row = self.seven_eleven_inventory()
        snapshot["offers"].append(dict(saved, id="capital-one/7-eleven-2"))
        self.t.write_json("offers.json", snapshot)
        p = self.write_inventory([self.main_grid_control(row), dict(row, tile_kind="added_to_card", activation_status="Activated")])
        code, output, report = self.t.run("report", "Capital One", [p], read_date=row["extraction_date"])
        self.assertEqual(code, 0, output)
        self.assertEqual({p["saved"] for p in report["proposals"]}, {saved["id"], "capital-one/7-eleven-2"})
        self.assertIn("ambiguous saved offers", report["inventory_issues"][0])
        before = self.t.read("offers.json")
        self.assertEqual(self.t.run("apply", "Capital One", [p], read_date=row["extraction_date"], decisions={})[0], 2)
        self.assertEqual(self.t.read("offers.json"), before)
        pair = {"saved": saved["id"], "file": saved["merchant"], "bonus": saved["bonus"], "accept": True}
        _, report = self.apply_ok("Capital One", [p], read_date=row["extraction_date"],
                                  decisions={"pairs": [pair], "owner_approved": ["size_check"]})
        self.assertEqual(report["new"], [])
        self.assertEqual(self.t.offers()[saved["id"]]["status"], "active")

    def test_capital_one_channel_terms_follow_evidence(self):
        snapshot, saved, row = self.seven_eleven_inventory()
        p = self.write_inventory([row, dict(row, channel="In-Store")])
        _, report = self.apply_ok("Capital One", [p], read_date=row["extraction_date"])
        actual = self.t.offers()[saved["id"]]
        self.assertEqual(actual["channel"], "none_shown")
        self.assertEqual(actual["channel_terms"], dict(saved["channel_terms"], conflicted=True))
        self.assertTrue(any("contradicts verified channel terms" in flag for flag in report["flags"]))

        # The uncertainty survives the next dated listing. It needs a fresh detail read to restore confidence.
        later = dict(row, extraction_date="2026-11-25")
        self.apply_ok("Capital One", [self.write_inventory([later])], read_date=later["extraction_date"])
        self.assertEqual(self.t.offers()[saved["id"]]["channel"], "none_shown")
        self.assertTrue(self.t.offers()[saved["id"]]["channel_terms"]["conflicted"])

        # A listing without route metadata gives no contradictory evidence about the original method.
        self.t.write_json("offers.json", snapshot)
        self.apply_ok("Capital One", [self.write_inventory([dict(row, offer_type="", offer_type_basis="")])],
                      read_date=row["extraction_date"])
        self.assertEqual(self.t.offers()[saved["id"]]["channel_terms"], saved["channel_terms"])

        for change, channel in (({"reward": "12% back"}, "in_app"),
                                ({"reward": "12% back", "channel": ""}, "none_shown"),
                                ({"offer_type": "affiliate", "channel": "Online"}, "online"),
                                ({"domain": "example.com"}, "in_app")):
            with self.subTest(change=change):
                self.t.write_json("offers.json", snapshot)
                _, report = self.apply_ok("Capital One", [self.write_inventory([dict(row, **change)])],
                                          read_date=row["extraction_date"])
                actual = self.t.offers()[saved["id"]]
                self.assertEqual(actual["channel"], channel)
                self.assertIsNone(actual["channel_terms"])
                self.assertNotIn(saved["channel_terms"]["note"], actual["other_details"])
                self.assertTrue(any("verified channel terms need a fresh read" in flag for flag in report["flags"]))

    def test_capital_one_pending_edit_blocks_repricing(self):
        _, saved, row = self.seven_eleven_inventory()
        self.t.write_json("phone-edits.json", {saved["id"]: {"activation": "needs_activation"}})
        p = self.write_inventory([self.main_grid_control(row),
                                  dict(row, reward="12% back", tile_kind="added_to_card", activation_status="Activated")])
        before, pending = (self.t.read(f) for f in ("offers.json", "phone-edits.json"))
        code, output, report = self.t.run("report", "Capital One", [p], read_date=row["extraction_date"])
        self.assertEqual(code, 0, output)
        self.assertIn("pending activation edit must be resolved before repricing", report["inventory_issues"][0])
        self.assertEqual(self.t.run("apply", "Capital One", [p], read_date=row["extraction_date"], decisions={})[0], 2)
        self.assertEqual((self.t.read("offers.json"), self.t.read("phone-edits.json")), (before, pending))

    def test_capital_one_legacy_inventory_is_refused_before_mutation(self):
        self.t.change_offers(lambda by, _: by["capital-one/cvs"].update(
            activation="already_activated", redemption={"method": "card_linked", "evidence": "offer_type"}))
        files = ("offers.json", "phone-edits.json", "cuisines.json", "merchant-locations.json")
        before = [self.t.read(f) for f in files]
        for mode in ("report", "apply"):
            code, output, _ = self.t.run(mode, "Capital One", [FIX / "capital_one.csv"],
                                         read_date="2026-11-24", decisions={})
            self.assertEqual(code, 2, output)
            self.assertIn("legacy Capital One CSV is retired", output)
            self.assertIn("including the Added to Card placements", output)
            self.assertEqual([self.t.read(f) for f in files], before)

    def coupon_inventory(self, day, reward="10% back", candidate=True):
        return dict(extraction_date=day, layout_variant="current_layout", tile_kind="standard", merchant="7-Eleven",
                    domain="7-eleven.com", reward=reward, channel="In-App", offer_type="cardLinked|coupon" if candidate else "cardLinked",
                    offer_type_basis="Encoded tile offer-type labels", activation_status="", grid_position="1",
                    badge="EXCLUSIVE COUPON" if candidate else "")

    def coupon_evidence(self, row, *, value=20, cap=None, through="2026-12-05", complete=True, include=True, grid_size=1):
        records = [{
            "evidence_status": "verified_detail_panel", "capture_date": row["extraction_date"],
            "merchant": {"name": row["merchant"], "domain": row["domain"]},
            "cashback": {"listing_text_exact": row["reward"], "text_exact": row["reward"]},
            "evidence": {"listing": {"source": "standard"},
                         "detail_panel": {"coupon_details_read": True, "expanded_cashback_terms_read": True}},
            "coupon": {
                "discount": {"kind": "percentage_off", "advertised_value": value, "up_to": False},
                "expiration": {"observations": [{"iso_date": through}]},
                "minimum_purchase": {"status": "not_stated"},
                "discount_cap": {"status": "stated", "amount": cap, "currency": "USD"},
                "conditions": ["Keep the item in its original packaging."],
                "additional_conditions_summary": ["Selected styles only.", "Details include PRIVATE-COUPON-SENTINEL.",
                                                  "Use code OMITTHIS123."],
                "code": {"value": "PRIVATE-COUPON-SENTINEL"},
            },
            "stacking": {"outcome_status": "permitted_for_qualifying_purchase_subject_to_terms",
                         "issuer_evidence": {"cashback_based_on_eligible_subtotal_after_coupon": True}},
        }] if include else []
        p = self.t.root / "coupons.json"
        p.write_text(json.dumps(self.t.coupon_capture(row["extraction_date"], grid_size, complete=complete, panels=records)))
        return str(p)

    def test_coupon_replacement_disappearance_and_expiry_leave_rebate_intact(self):
        _, saved, _ = self.seven_eleven_inventory()
        oid = saved["id"]
        self.t.change_offers(lambda by, _: by[oid]["other_details"].append('Promo text reads "PRIVATE-COUPON-SENTINEL"'))
        first = self.coupon_inventory("2026-11-24")
        p = self.write_inventory([first])
        output, report = self.apply_ok("Capital One", [p], read_date=first["extraction_date"],
                                       extra=("--coupons", self.coupon_evidence(first, cap=35)))
        offer = self.t.offers()[oid]
        self.assertTrue(report["coupons"]["complete"])
        self.assertEqual(offer["promotions"][0]["discount_cap"], 35)
        self.assertEqual(offer["promotions"][0]["conditions"], ["Selected styles only."])
        for secret in ("PRIVATE-COUPON-SENTINEL", "OMITTHIS123"):
            self.assertNotIn(secret, output + self.t.read("offers.json") + json.dumps(report))

        later = self.coupon_inventory("2026-11-25")
        p = self.write_inventory([later])
        self.apply_ok("Capital One", [p], read_date=later["extraction_date"],
                      extra=("--coupons", self.coupon_evidence(later, value=10, through="2026-11-24")))
        offer = self.t.offers()[oid]
        self.assertEqual(len(offer["promotions"]), 1)
        self.assertEqual(offer["promotions"][0]["discount"]["value"], 10)
        self.assertNotIn("discount_cap", offer["promotions"][0])
        self.assertLess(offer["promotions"][0]["visible_through"], later["extraction_date"])
        self.assertEqual((offer["status"], offer["bonus"], offer["expires"]), ("active", "10% back", None))

        gone = self.coupon_inventory("2026-11-26", candidate=False)
        p = self.write_inventory([gone])
        _, report = self.apply_ok("Capital One", [p], read_date=gone["extraction_date"],
                                  extra=("--coupons", self.coupon_evidence(gone, include=False)))
        self.assertEqual(report["coupons"]["withdrawn"], 1)
        self.assertNotIn("promotions", self.t.offers()[oid])
        self.assertEqual(self.t.offers()[oid]["status"], "active")

    def test_coupon_incomplete_scan_withholds_unconfirmed_terms(self):
        _, saved, _ = self.seven_eleven_inventory()
        first = self.coupon_inventory("2026-11-24")
        self.apply_ok("Capital One", [self.write_inventory([first])], read_date=first["extraction_date"],
                      extra=("--coupons", self.coupon_evidence(first)))
        later = self.coupon_inventory("2026-11-25")
        p = self.write_inventory([later])
        extra = ("--coupons", self.coupon_evidence(later, include=False))
        before = self.data_bytes()
        code, output, report = self.t.run("report", "Capital One", [p], read_date=later["extraction_date"], extra=extra)
        self.assertEqual(code, 0, output)
        self.assertIn("0 verified, 0 listing only, 1 check issuer", output)
        self.assertIn("1 prior terms withheld", output)
        self.assertEqual(report["stops"][-1]["key"], "incomplete_coupon_scan")
        self.assertEqual(self.t.run("apply", "Capital One", [p], read_date=later["extraction_date"],
                                    decisions={}, extra=extra)[0], 2)
        self.assertEqual(self.data_bytes(), before)
        approval = {"owner_approved": ["incomplete_coupon_scan"]}
        _, report = self.apply_ok("Capital One", [p], read_date=later["extraction_date"], decisions=approval, extra=extra)
        self.assertFalse(report["coupons"]["complete"])
        self.assertEqual((report["coupons"]["withheld"], report["coupons"]["withdrawn"]), (1, 0))
        self.assertEqual(self.t.offers()[saved["id"]]["promotions"], [{
            "source": "unverified_listing", "placement": "standard", "observed_on": "2026-11-25",
            "visible_through": "2026-12-01",
        }])
        partial_panel = self.coupon_inventory("2026-11-26")
        companion = Path(self.coupon_evidence(partial_panel, value=50))
        data = json.loads(companion.read_text())
        del data["verified_coupon_offers"][0]["evidence"]["detail_panel"]["expanded_cashback_terms_read"]
        companion.write_text(json.dumps(data))
        _, report = self.apply_ok("Capital One", [self.write_inventory([partial_panel])],
                                  read_date=partial_panel["extraction_date"], decisions=approval, extra=("--coupons", str(companion)))
        self.assertEqual((report["coupons"]["verified"], report["coupons"]["unverified"]), (0, 1))
        self.assertEqual(report["coupons"]["partial_panels"], 1)
        self.assertNotIn("discount", self.t.offers()[saved["id"]]["promotions"][0])
        next_day = self.coupon_inventory("2026-11-27", candidate=False)
        _, report = self.apply_ok("Capital One", [self.write_inventory([next_day])], read_date=next_day["extraction_date"],
                                  decisions=approval, extra=("--coupons", self.coupon_evidence(next_day, complete=False, include=False)))
        self.assertTrue(report["coupons"]["scan_declared_incomplete"])
        self.assertFalse(report["coupons"]["complete"])
        self.assertEqual((report["coupons"]["withheld"], report["coupons"]["withdrawn"]), (0, 0))
        self.assertNotIn("promotions", self.t.offers()[saved["id"]])

    def test_coupon_repricing_requires_evidence_of_the_new_reward(self):
        _, saved, _ = self.seven_eleven_inventory()
        initial = self.coupon_inventory("2026-11-24")
        self.apply_ok("Capital One", [self.write_inventory([initial])], read_date=initial["extraction_date"],
                      extra=("--coupons", self.coupon_evidence(initial)))
        changed = self.coupon_inventory("2026-11-25", reward="12% back")
        p = self.write_inventory([changed])
        stale = dict(initial, extraction_date=changed["extraction_date"])
        before = self.t.read("offers.json")
        code, _, _ = self.t.run("apply", "Capital One", [p], read_date=changed["extraction_date"], decisions={},
                                 extra=("--coupons", self.coupon_evidence(stale)))
        self.assertEqual(code, 2)
        self.assertEqual(self.t.read("offers.json"), before)
        self.apply_ok("Capital One", [p], read_date=changed["extraction_date"],
                      extra=("--coupons", self.coupon_evidence(changed, value=5)))
        offer = self.t.offers()[saved["id"]]
        self.assertEqual((offer["bonus"], offer["promotions"][0]["discount"]["value"]), ("12% back", 5))

    def test_coupon_ambiguous_placement_or_offer_blocks_apply(self):
        snapshot, saved, _ = self.seven_eleven_inventory()
        row = self.coupon_inventory("2026-11-24")
        for duplicate_placement in (True, False):
            with self.subTest(duplicate_placement=duplicate_placement):
                if not duplicate_placement:
                    snapshot["offers"].append(dict(saved, id="capital-one/7-eleven-2"))
                    self.t.write_json("offers.json", snapshot)
                p = self.write_inventory([row, dict(row, grid_position="2")] if duplicate_placement else [row])
                before = self.t.read("offers.json")
                code, output, _ = self.t.run("apply", "Capital One", [p], read_date=row["extraction_date"],
                                             decisions={"owner_approved": ["incomplete_coupon_scan"]},
                                             extra=("--coupons", self.coupon_evidence(row, grid_size=2 if duplicate_placement else 1)))
                self.assertEqual(code, 2, output)
                self.assertIn("does not match a unique current placement and offer reward", output)
                self.assertEqual(self.t.read("offers.json"), before)

    def data_bytes(self):
        return {p.name: p.read_bytes() for p in self.t.data.glob("*.json")}

    def test_coupon_companion_is_required_even_for_same_day_replay(self):
        self.seven_eleven_inventory()
        row = self.coupon_inventory("2026-11-24")
        p = self.write_inventory([row])
        opts = {"read_date": row["extraction_date"], "extra": ("--coupons", self.coupon_evidence(row))}
        self.apply_ok("Capital One", [p], **opts)
        before = self.data_bytes()
        self.apply_ok("Capital One", [p], **opts)
        self.assertEqual(self.data_bytes(), before)
        for mode in ("report", "apply"):
            code, output, _ = self.t.run(mode, "Capital One", [p], read_date=row["extraction_date"], auto_coupon=False,
                                         decisions={"owner_approved": ["incomplete_coupon_scan"]})
            self.assertEqual(code, 2, output)
            self.assertIn("require --coupons", output)
            self.assertEqual(self.data_bytes(), before)

    def test_coupon_companion_checks_main_inventory_before_planning_snapshot(self):
        _, _, row = self.seven_eleven_inventory()
        day = row["extraction_date"]
        approval = {"owner_approved": ["incomplete_coupon_scan", "size_check", "missing"]}
        before = self.data_bytes()
        companion = self.t.root / "evidence.json"
        cases = (
            (row, {"available_feed_exhausted": False}, {}, "establish exhaustion"),
            (row, {"loaded_grid_entries": 2}, {}, "grid coverage"),
            (dict(row, grid_position=""), {}, {}, "grid coverage"),
            (dict(row, grid_position="2"), {}, {}, "invalid grid positions"),
            (dict(row, merchant="UNREADABLE"), {}, {}, "unreadable current"),
            (row, {"loaded_grid_entries": True}, {}, "positive loaded grid"),
            (row, {"coupon_scan_complete": "false"}, {}, "must be true or false"),
            (row, {}, {"capture_date": "2026-11-23"}, "match the Pacific"),
            (row, {}, {"capture_date": "2026-11-99"}, "match the Pacific"),
            (row, {}, {"capture_timezone": "UTC"}, "match the Pacific"),
        )
        for placement, scan, evidence, message in cases:
            with self.subTest(message=message, scan=scan, evidence=evidence):
                p = self.write_inventory([placement])
                capture = self.t.coupon_capture(day, 1)
                capture["source"]["inventory_scan"].update(scan)
                companion.write_text(json.dumps(dict(capture, **evidence)))
                for mode in ("report", "apply"):
                    code, output, _ = self.t.run(mode, "Capital One", [p], read_date=day, decisions=approval,
                                                 extra=("--coupons", str(companion)))
                    self.assertEqual(code, 2, output)
                    self.assertIn(message, output)
                    self.assertEqual(self.data_bytes(), before)
        _, report = self.apply_ok("Capital One", [self.write_inventory([row])], read_date=day)
        self.assertTrue(report["coupons"]["complete"])

    def test_coupon_partial_scan_approval_cannot_resolve_ambiguous_evidence(self):
        self.seven_eleven_inventory()
        row = self.coupon_inventory("2026-11-24")
        before = self.data_bytes()
        for case in ("duplicate inventory candidate", "duplicate partial panel", "reward conflict"):
            with self.subTest(case=case):
                duplicates = case == "duplicate inventory candidate"
                p = self.write_inventory([row, dict(row, grid_position="2")] if duplicates else [row])
                companion = Path(self.coupon_evidence(row, complete=False, include=not duplicates, grid_size=2 if duplicates else 1))
                data = json.loads(companion.read_text())
                if not duplicates:
                    panel = data["verified_coupon_offers"][0]
                    panel["evidence"]["detail_panel"]["expanded_cashback_terms_read"] = False
                    if case == "duplicate partial panel":
                        data["verified_coupon_offers"].append(panel)
                    else:
                        panel["cashback"]["text_exact"] = "25% back"
                    companion.write_text(json.dumps(data))
                code, output, _ = self.t.run("apply", "Capital One", [p], read_date=row["extraction_date"],
                                             decisions={"owner_approved": ["incomplete_coupon_scan"]},
                                             extra=("--coupons", str(companion)))
                self.assertEqual(code, 2, output)
                self.assertIn("unresolved coupon placement", output)
                self.assertEqual(self.data_bytes(), before)

    def test_coupon_complete_scan_can_include_panel_and_listing_only_for_one_offer(self):
        _, saved, _ = self.seven_eleven_inventory()
        row = self.coupon_inventory("2026-11-24")
        hero = dict(row, tile_kind="hero", grid_position="2", badge="")
        p = self.write_inventory([row, hero])
        companion = Path(self.coupon_evidence(row, grid_size=2))
        capture = json.loads(companion.read_text())
        panel = capture["verified_coupon_offers"][0]
        listing = dict(panel, evidence_status="listing_only", evidence={"listing": {"source": "hero"}})
        capture["listing_only_promotions"].append(listing)
        companion.write_text(json.dumps(capture))
        opts = {"read_date": row["extraction_date"], "extra": ("--coupons", str(companion))}
        _, report = self.apply_ok("Capital One", [p], **opts)
        self.assertTrue(report["coupons"]["complete"])
        self.assertEqual((report["coupons"]["verified"], report["coupons"]["listing"]), (1, 1))
        promotions = self.t.offers()[saved["id"]]["promotions"]
        self.assertEqual([p["source"] for p in promotions], ["verified_panel", "listing_only"])
        self.assertNotIn("conditions", promotions[1])

        capture["source"]["inventory_scan"]["coupon_scan_complete"] = False
        capture["listing_only_promotions"].clear()
        companion.write_text(json.dumps(capture))
        _, report = self.apply_ok("Capital One", [p], decisions={"owner_approved": ["incomplete_coupon_scan"]}, **opts)
        self.assertEqual((report["coupons"]["verified"], report["coupons"]["unverified"], report["coupons"]["withheld"]), (1, 1, 1))
        self.assertEqual(self.t.offers()[saved["id"]]["promotions"][0], promotions[0])
        self.assertNotIn("discount", self.t.offers()[saved["id"]]["promotions"][1])

    def test_coupon_yearless_end_is_fixed_and_conflicting_dates_are_only_freshness(self):
        from datetime import date
        from coupon_promotions import expiration
        read = date(2026, 11, 23)
        yearless = {"observations": [{"month": 11, "day": 27, "weekday": "Friday"}]}
        expiry, through = expiration(yearless, read, None)
        self.assertEqual((expiry["basis"], through), ("estimated", "2026-11-27"))
        _, later = expiration(yearless, date(2027, 11, 22), {"expiry": expiry})
        self.assertEqual(later, "2026-11-27")
        conflicting = {"has_conflict": True, "observations": [{"iso_date": "2027-01-30"},
                                                               {"month": 2, "day": 1, "weekday": "Monday"}]}
        expiry, visible = expiration(conflicting, read, None)
        self.assertEqual((expiry["basis"], expiry["date"], visible), ("conflict", None, "2026-11-29"))

    def test_capital_one_minimum_follows_current_headline(self):
        snapshot, saved, row = self.seven_eleven_inventory()
        oid = saved["id"]
        prior = saved["last_read"]
        saved.update(bonus="Spend $20, earn $10", minimum_spend="20")
        other_issuers = {o["id"]: o for o in snapshot["offers"] if o["card"] != "Capital One"}
        cases = (
            (prior, "Spend $20, earn $10", "active", "20", "20"),
            (prior, "8% back", "active", "20", None),
            (row["extraction_date"], "$12 back", "active", "20", None),
            (row["extraction_date"], "Spend $1,250.50 and get $100 back", "active", "20", "1250.50"),
            (row["extraction_date"], "Spend $45, earn $15", "active", None, "45"),
            (row["extraction_date"], "Up to $20 back", "missing", "20", None),
            (row["extraction_date"], "Spend $20, earn $10", "missing", "20", "20"),
            (row["extraction_date"], "Free gift when you spend $60", "missing", "20", None),
            (row["extraction_date"], "Spend $75, earn up to $20", "active", "20", "75"),
        )
        for day, reward, status, old, expected in cases:
            with self.subTest(day=day, reward=reward, status=status, old=old):
                saved.update(status=status, minimum_spend=old)
                self.t.write_json("offers.json", snapshot)
                p = self.write_inventory([dict(row, extraction_date=day, reward=reward)])
                self.apply_ok("Capital One", [p], read_date=day)
                actual = self.t.offers()[oid]
                self.assertEqual((actual["bonus"], actual["minimum_spend"], actual["status"], actual["first_seen"]),
                                 (reward, expected, "active", saved["first_seen"]))
                self.assertEqual({i: o for i, o in self.t.offers().items() if o["card"] != "Capital One"}, other_issuers)
                before = self.data_bytes()
                self.apply_ok("Capital One", [p], read_date=day)
                self.assertEqual(self.data_bytes(), before)

    def test_capital_one_ambiguous_saved_minimum_requires_per_offer_resolution(self):
        snapshot, saved, row = self.seven_eleven_inventory()
        day, oid = row["extraction_date"], saved["id"]
        saved["minimum_spend"] = "25"
        self.t.write_json("offers.json", snapshot)
        self.apply_ok("Capital One", [self.write_inventory([row])], read_date=day)
        self.assertEqual(self.t.offers()[oid]["minimum_spend"], "25")
        for returning in (False, True):
            with self.subTest(returning=returning):
                saved["status"] = "missing" if returning else "active"
                self.t.write_json("offers.json", snapshot)
                edits = {oid: {"status": "active", "status_since": day}} if returning else {}
                self.t.write_json("phone-edits.json", edits)
                p = self.write_inventory([row if returning else dict(row, reward="$12 back")])
                before = self.data_bytes()
                template = self.t.root / "template.json"
                code, output, report = self.t.run("report", "Capital One", [p], read_date=day,
                                                 extra=("--template", str(template)))
                self.assertEqual(code, 0, output)
                self.assertEqual(report["ambiguous_minimums"], [oid])
                self.assertEqual(json.loads(template.read_text())["clear_minimums"], {oid: None})
                code, output, _ = self.t.run("apply", "Capital One", [p], read_date=day,
                                             decisions={"owner_approved": ["incomplete_coupon_scan"]})
                self.assertEqual(code, 2, output)
                self.assertEqual(self.data_bytes(), before)
                self.apply_ok("Capital One", [p], read_date=day, decisions={"clear_minimums": {oid: True}})
                self.assertIsNone(self.t.offers()[oid]["minimum_spend"])
                self.assertEqual(self.t.load("phone-edits.json"), edits)

    def test_coupon_sanitizer_keeps_code_free_restrictions_and_private_fields_out(self):
        from coupon_promotions import valid_promotion
        _, saved, _ = self.seven_eleven_inventory()
        row = self.coupon_inventory("2026-11-24")
        oid, day = saved["id"], row["extraction_date"]
        legacy = 'Promo text reads "First purchase only with SYNTHLEGACY99. Selected items only."'
        self.t.change_offers(lambda by, _: by[oid]["other_details"].append(legacy))
        p = self.write_inventory([dict(row, raw_text="SYNTHRAW99", promo_code="SYNTHRAW99")])
        companion = Path(self.coupon_evidence(row))
        capture = json.loads(companion.read_text())
        record = capture["verified_coupon_offers"][0]
        record["coupon"]["minimum_purchase"] = {"status": "stated", "amount": 75, "currency": "USD"}
        record["coupon"]["additional_conditions_summary"] = [
            "New customers only with SYNTHWITH99. Cannot combine with other promotions.",
            'Use code "syntheticlower". Online orders only.',
            "Selected items only. //offers.example/private?session=SYNTHLINK99",
            "First order only. offers.example/private?session=SYNTHLINK99",
            "Eligible with 1000 reward points.",
        ]
        record["cashback"]["authenticated_link"] = "https://offers.example/?session=SYNTHLINK99"
        companion.write_text(json.dumps(capture))
        template = self.t.root / "template.json"
        extra = ("--coupons", str(companion))
        code, report_stdout, _ = self.t.run("report", "Capital One", [p], read_date=day, extra=(*extra, "--template", str(template)))
        self.assertEqual(code, 0, report_stdout)
        report_json = (self.t.root / "report.json").read_text()
        apply_stdout, report = self.apply_ok("Capital One", [p], read_date=day, extra=extra)
        self.assertEqual(report["coupons"]["scrubbed_notes"], 1)
        offer = self.t.offers()[oid]
        self.assertIsNone(offer["minimum_spend"])
        promotion = offer["promotions"][0]
        self.assertEqual(promotion["minimum_purchase"], 75)
        self.assertEqual(promotion["conditions"], ["Cannot combine with other promotions.",
                                                   "Online orders only.", "Selected items only.", "First order only.",
                                                   "Eligible with 1000 reward points."])
        self.assertIn('Promo text reads "Selected items only."', offer["other_details"])
        self.assertFalse(valid_promotion(dict(promotion, conditions=["New customers only with SYNTHWITH99."])))
        before = self.data_bytes()
        unsafe = self.write_inventory([dict(row, domain="offers.example/private?session=SYNTHLINK99")])
        code, refusal, _ = self.t.run("report", "Capital One", [unsafe], read_date=day, extra=extra)
        self.assertEqual(code, 2, refusal)
        self.assertIn("unsafe text", refusal)
        self.assertEqual(self.data_bytes(), before)
        public = report_stdout + report_json + apply_stdout + template.read_text() + refusal
        public += "".join(self.t.read(f) for f in before)
        for word in ("SYNTHLEGACY99", "SYNTHRAW99", "SYNTHWITH99", "syntheticlower", "SYNTHLINK99", "PRIVATE-COUPON-SENTINEL"):
            self.assertNotIn(word, public)

    def test_coupon_noun_instructions_stay_out_of_reports_and_public_data(self):
        _, saved, _ = self.seven_eleven_inventory()
        row = self.coupon_inventory("2026-11-24")
        oid, day = saved["id"], row["extraction_date"]
        instructions = [
            "Use coupon ZQSAVE20.", "Apply coupon ZQSAVE20 at checkout.", "Enter coupon ZQSAVE20 at checkout.",
            "Use promo ZQSAVE20.", "Apply promo ZQSAVE20.", "Use voucher ZQSAVE20.", "Enter voucher zqsave20.",
            "Use offer ZQSAVE20.", "Apply discount ZQSAVE20.", "Use coupon zqbigdeal.", "Enter promo zqsave20 in cart.",
            "use the promotional ‘zqbigdeal’.", "Use coupon ZQSYNTH42 at checkout.",
            "New customers use coupon ZQSYNTH42", "Use coupon online-zqsave20.",
            "Use your coupon ZQSYNTHB2 at checkout.",
        ]
        safe_conditions = [
            "Apply before tax.", "Restrictions apply without specific products named.",
            "Members save with USAA.", "Items must be purchased with IKEA Family.",
            "Valid with iPhone15 purchases.", "Apply discount before tax.", "Use the offer online.",
            "Apply promotional pricing at checkout.", "USE COUPON AT CHECKOUT.",
        ]
        tokens = ("zqsave20", "zqbigdeal", "zqsynth42", "zqsynthb2")

        def note(line):
            return f'Promo text reads "{line}"'

        self.t.change_offers(lambda by, _: by[oid]["other_details"].extend(map(note, instructions + safe_conditions)))
        companion = Path(self.coupon_evidence(row))
        capture = json.loads(companion.read_text())
        coupon = capture["verified_coupon_offers"][0]["coupon"]
        coupon["code"] = {}  # The private value was unavailable to the capture.
        coupon["additional_conditions_summary"] = instructions + safe_conditions + [
            "Enter promo zqbigdeal in cart. Selected styles only.",
        ]
        companion.write_text(json.dumps(capture))
        p, template = self.write_inventory([row]), self.t.root / "template.json"
        extra = ("--coupons", str(companion))
        code, report_output, _ = self.t.run("report", "Capital One", [p], read_date=day, extra=(*extra, "--template", str(template)))
        self.assertEqual(code, 0, report_output)
        report_json = (self.t.root / "report.json").read_text()
        apply_output, _ = self.apply_ok("Capital One", [p], read_date=day, extra=extra)
        apply_json = (self.t.root / "report.json").read_text()
        public = report_output + report_json + template.read_text() + apply_output + apply_json + self.t.read("offers.json")
        for token in tokens:
            self.assertNotIn(token, public.casefold())
        saved = self.t.offers()[oid]
        self.assertEqual(saved["other_details"], list(map(note, safe_conditions)))
        self.assertEqual(saved["promotions"][0]["conditions"], safe_conditions + ["Selected styles only."])

        def validate():
            return subprocess.run([sys.executable, "tools/validate.py"], cwd=self.t.root, capture_output=True, text=True)

        clean_data = self.t.load()
        result = validate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        offer = next(o for o in clean_data["offers"] if o["id"] == oid)
        targets = (
            ("panel summary", offer["promotions"][0]["conditions"], "bad public coupon promotion"),
            ("legacy note", offer["other_details"], "unsafe public Capital One promotional note"),
        )
        for field, target, message in targets:
            for line in instructions:
                with self.subTest(line=line, field=field):
                    target.append(note(line) if field == "legacy note" else line)
                    self.t.write_json("offers.json", clean_data)
                    target.pop()
                    result = validate()
                    output = result.stdout + result.stderr
                    self.assertNotEqual(result.returncode, 0, output)
                    self.assertIn(message, output)
                    for token in tokens:
                        self.assertNotIn(token, output.casefold())

    def test_coupon_instruction_privacy_floor_and_modifier_matrix(self):
        from coupon_promotions import legacy_promo_text, public_summary, sanitize, scrub_legacy, valid_promotion

        day = "2026-11-24"
        companion = Path(self.coupon_evidence(self.coupon_inventory(day)))
        record = json.loads(companion.read_text())["verified_coupon_offers"][0]
        coupon = record["coupon"]
        coupon["code"] = {}
        verbs = ("use", "apply", "enter")
        modifiers = ("", "your ", "exclusive current ", "a special limited-time members-only seasonal checkout ")
        nouns = ("coupon", "promo", "promotional", "voucher", "offer", "discount")
        tokens = ("zqsynthb2", '"zqsynthb2"', "‘zqbigdeal’")
        lines = [case(f"{verb} {modifier}{noun} {token} at checkout.")
                 for verb, modifier, noun, token, case in product(verbs, modifiers, nouns, tokens, (str.lower, str.upper))]
        lines += [
            "Use your coupon ZQSAVE20.", "Use this promo ZQSAVE20.", "Use exclusive coupon ZQSAVE20.",
            "Apply exclusive promo zqsave20 at checkout.", "Enter your promo ZQSAVE20 in cart.",
            "Use your discount ZQSAVE20.", "Use your coupon; ZQSYNTHB2 at checkout.",
            "Use coupon ONLINE.", "Apply before tax ZQSYNTHB2.", "Use the offer online ZQSYNTHB2.",
            "Use a (specially issued) one-time offer zqbigdeal.",
        ]
        # The deployed check also blocked long first words even without a coupon noun.
        lines += [f"{verb} promptly zqsynthb2 at checkout." for verb in verbs]

        def note(line):
            return f'Promo text reads "{line}"'

        cases = [(line, "Selected styles only.") for line in lines]
        cases.append(("Use coupon zqsynthb2. Apply before tax.", "Apply before tax. Selected styles only."))
        for line, expected in cases:
            with self.subTest(line=line):
                coupon["additional_conditions_summary"] = [f"{line} Selected styles only."]
                promotion = sanitize(record, day, set(), [])
                self.assertEqual(promotion["conditions"], [expected])
                self.assertFalse(valid_promotion(dict(promotion, conditions=[line])))
                offer = {"other_details": [note(f"{line} Selected styles only.")]}
                self.assertEqual(scrub_legacy(offer, set()), 1)
                self.assertEqual(offer["other_details"], [note(expected)])
                self.assertIsNone(public_summary(legacy_promo_text(note(line)), set()))

        for line in ("Use your coupon at checkout.", "Use this offer before it ends.", "Apply offer to eligible items.",
                     "Apply discount before tax. Restrictions apply without specific products named.",
                     "Review exclusions: Use of promotional codes not provided by Capital One may invalidate your offer.",
                     "Members save with USAA. Items must be purchased with IKEA Family. Valid with iPhone15 purchases."):
            with self.subTest(line=line):
                coupon["additional_conditions_summary"] = [line]
                promotion = sanitize(record, day, set(), [])
                self.assertEqual(promotion["conditions"], [line])
                self.assertTrue(valid_promotion(promotion))
                offer = {"other_details": [note(line)]}
                self.assertEqual(scrub_legacy(offer, set()), 0)
                self.assertEqual(offer["other_details"], [note(line)])
                self.assertEqual(public_summary(legacy_promo_text(note(line)), set()), line)
        self.assertIsNone(public_summary("Use the offer online.", {"online"}))

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
            extra = dict(next(r for r in rows if r["merchant"] == "CVS"), tile_kind="hero")
            return rows + [extra]
        p = self.t.csv("Capital One", fn)
        code, out, rep = self.t.run("report", "Capital One", [p])
        self.assertEqual(rep["offers_in_batch"], 8, out)
        self.apply_ok("Capital One", [p])
        notes = self.t.offers()["capital-one/cvs"]["other_details"]
        self.assertIn("3 tiles listed", notes)
        self.assertNotIn("2 tiles listed", notes)

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
                    r["reward_description"] = r["reward_description"].replace("11/11/2026", "10/31/2026")
            return rows
        self.apply_ok("Chase Freedom Flex", [self.t.csv("Chase Freedom Flex", fn)])
        o = self.t.offers()["chase-freedom-flex/babbel"]
        self.assertEqual((o["expires"], o["expires_text"]), ("2026-10-31", "Offer expires 10/31/2026"))

    def test_chase_current_detail_replaces_conflicting_terms_in_both_formats(self):
        cases = [
            ("Chase Freedom", "Whisker", "bonus_as_shown", "end_timestamp"),
            ("Chase Freedom Flex", "Babbel", "bonus", "offer_end_timestamp"),
        ]
        for card, merchant, bonus_column, timestamp_column in cases:
            with self.subTest(card=card):
                old = next(o for o in self.t.offers().values() if o["card"] == card and o["merchant"] == merchant)
                self.t.change_offers(lambda by, _: by[old["id"]].update(
                    activation="already_activated",
                    fine_print=f"Earn {old['bonus']} on your first two payments when you spend $50 or more. "
                               "Offer valid on first two payments only. Gift cards are excluded.",
                ))

                def rows_with_new_terms(rows):
                    row = next(r for r in rows if r["merchant"] == merchant)
                    row.update({bonus_column: "20% cash back", timestamp_column: "2026-12-01T04:59:59Z",
                                "expiration_text": "Offer expires 11/30/2026.", "channel": "ONLINE",
                                "min_spend": "30", "reward_cap": "0", "added_state": "not added",
                                "reward_description": (
                                    "<b>Earn 20% cash back</b> on your first two payments when you spend $30 or more."
                                    "<br>Limit of $15 per statement credit (up to $30 cash back total)."
                                    "<br>Offer expires 11/30/2026. Offer valid on first two payments only."
                                    "<br>Offer valid online only. Offer only valid on purchases made directly with the merchant."
                                    "<br>Gift cards are excluded. Cash back reward valid only for first time customers."
                                )})
                    return rows

                capture = self.t.csv(card, rows_with_new_terms)
                captured_bytes = capture.read_bytes()
                self.apply_ok(card, [capture])
                saved = self.t.offers()[old["id"]]
                self.assertEqual((saved["bonus"], saved["minimum_spend"], saved["channel"], saved["expires"]),
                                 ("20% cash back", "30", "online", "2026-11-30"))
                self.assertEqual((saved["activation"], saved["first_seen"]), ("already_activated", old["first_seen"]))
                self.assertIsNone(saved["spend_cap"])
                for term in ("$15 per statement credit", "$30 cash back total", "first two payments only",
                             "Gift cards are excluded", "first time customers"):
                    self.assertIn(term, saved["fine_print"])
                self.assertNotIn("<b>", saved["fine_print"])
                self.assertEqual(capture.read_bytes(), captured_bytes)

    def test_chase_abbreviated_copy_retains_independent_eligibility_and_channel(self):
        card = "Chase Freedom Flex"
        sid = "chase-freedom-flex/babbel"
        self.t.change_offers(lambda by, _: by[sid].update(fine_print=(
            "Earn 15% cash back on your Babbel purchase with a $45 cash back maximum. Offer expires 11/11/2026. "
            "Gift cards are excluded. Cash back reward valid only for first time customers. Offer valid online only. "
            "Payment must be made before 11/11/2026."
        )))

        def update(rows):
            row = next(r for r in rows if r["merchant"] == "Babbel")
            row.update(bonus="20% cash back", channel="NONE", reward_cap="35", expiration_text="Offer expires 11/30/2026.",
                       offer_end_timestamp="2026-12-01T04:59:59Z",
                       reward_description="Earn 20% cash back on your Babbel purchase, with a $35 cash back maximum.")
            return rows

        self.apply_ok(card, [self.t.csv(card, update)])
        offer = self.t.offers()[sid]
        self.assertEqual(offer["channel"], "online")
        for condition in ("20% cash back", "$35 cash back maximum", "first time customers", "Gift cards are excluded",
                          "valid online only", "Payment must be made before the offer deadline"):
            self.assertIn(condition, offer["fine_print"])
        for obsolete in ("15% cash back", "$45 cash back maximum", "11/11/2026"):
            self.assertNotIn(obsolete, offer["fine_print"])

    def test_chase_abbreviated_copy_cannot_drop_an_independent_dated_condition(self):
        card = "Chase Freedom Flex"
        before = self.t.read("offers.json")

        def update(rows):
            row = next(r for r in rows if r["merchant"] == "Babbel")
            row.update(offer_end_timestamp="2026-12-01T04:59:59Z", expiration_text="Offer expires 11/30/2026.",
                       reward_description="Earn 15% cash back with a $45 cash back maximum.")
            return rows

        capture = self.t.csv(card, update)
        code, out, report = self.t.run("report", card, [capture])
        self.assertEqual(code, 0, out)
        self.assertIn("prior dated payment condition unresolved", out)
        self.assertTrue(report["blockers"])
        self.assertEqual(self.t.run("apply", card, [capture], decisions={})[0], 2)
        self.assertEqual(self.t.read("offers.json"), before)

    def test_chase_disagreeing_current_fields_block_publication(self):
        card = "Chase Freedom Flex"
        before = self.t.read("offers.json")

        def update(rows):
            row = next(r for r in rows if r["merchant"] == "Babbel")
            row.update(min_spend="30", channel="ONLINE", reward_description=(
                "Earn 25% cash back on your Babbel purchase when you spend $40 or more. Offer valid in-store only."
            ))
            return rows

        capture = self.t.csv(card, update)
        code, out, _ = self.t.run("report", card, [capture])
        self.assertEqual(code, 0, out)
        for conflict in ("current reward headline and description disagree", "cashback minimum evidence disagrees",
                         "current channel evidence disagrees"):
            self.assertIn(conflict, out)
        self.assertEqual(self.t.run("apply", card, [capture], decisions={})[0], 2)
        self.assertEqual(self.t.read("offers.json"), before)

    def chase_review_fixture(self, card="Chase Freedom", *, saved=None, **updates):
        """A fresh synthetic offer, with the same field layout as the selected Chase format."""
        self.t.close()
        self.t = Tree()
        if card == "Chase Freedom":
            sid, merchant, bonus, end = "chase-freedom/whisker", "Whisker", "bonus_as_shown", "end_timestamp"
        else:
            sid, merchant, bonus, end = "chase-freedom-flex/babbel", "Babbel", "bonus", "offer_end_timestamp"
        self.t.change_offers(lambda by, _: by[sid].update(
            bonus="10% cash back", minimum_spend=None, channel="online", fine_print=saved))

        def update(rows):
            row = next(r for r in rows if r["merchant"] == merchant)
            row.update({bonus: "10% cash back", end: "2026-11-24T04:59:59Z", "channel": "ONLINE",
                        "reward_type": "PERCENTAGE", "reward_amount": "10", "min_spend": "0", "reward_cap": "0",
                        "expiration_text": "Offer expires 11/23/2026.",
                        "reward_description": "Earn 10% cash back on your purchase.", **updates})
            return rows

        return sid, self.t.csv(card, update)

    def assert_chase_review_conflict(self, card, capture, message, decisions=None):
        before = self.t.read("offers.json")
        code, text, report = self.t.run("report", card, [capture], decisions=decisions)
        self.assertEqual(code, 0, text)
        self.assertTrue(report["blockers"], text)
        self.assertIn(message, text)
        code, text, _ = self.t.run("apply", card, [capture], decisions=decisions or {})
        self.assertEqual(code, 2, text)
        self.assertIn(message, text)
        self.assertEqual(self.t.read("offers.json"), before)

    def test_chase_review_abbreviated_reward_keeps_unknown_historical_eligibility(self):
        for card in ("Chase Freedom", "Chase Freedom Flex"):
            for qualifier in ("on the Pro model only", "for first-time buyers only", "on your initial payment only",
                              "after three separate purchases", "excluding gift cards"):
                with self.subTest(card=card, qualifier=qualifier):
                    prior = f"Earn 10% cash back {qualifier}."
                    sid, capture = self.chase_review_fixture(card, saved=prior)
                    self.apply_ok(card, [capture])
                    self.assertIn(prior, self.t.offers()[sid]["fine_print"])
            with self.subTest(card=card, qualifier="incompatible replacement"):
                _, capture = self.chase_review_fixture(card, saved="Earn 10% cash back on the Pro model only.",
                                                       reward_description="Earn 10% cash back on the Basic model only.")
                self.assert_chase_review_conflict(card, capture, "prior reward eligibility unresolved")

    def test_chase_review_explicitly_incomplete_detail_keeps_prior_product_restriction(self):
        for card in ("Chase Freedom", "Chase Freedom Flex"):
            footer = "Offer redemption awarded as statement credit on the first qualifying transaction."
            pointer = "Additional eligibility restrictions apply; see full terms."
            for suffix, coverage in ((pointer, "abbreviated"), (f"{footer} {pointer}", "abbreviated"), (footer, "expanded")):
                with self.subTest(card=card, suffix=suffix):
                    sid, capture = self.chase_review_fixture(
                        card, saved="Only the Pro model is eligible.", reward_description=(
                            "Earn 10% cash back on your purchase. Offer expires 11/23/2026. "
                            f"Buy directly with the merchant. Third-party gift cards excluded. {suffix}"
                        ))
                    _, report = self.apply_ok(card, [capture])
                    offer = self.t.offers()[sid]
                    row = next(r for r in report["chase_terms"] if r["offer"].startswith(offer["merchant"]))
                    self.assertEqual(row["coverage"], coverage)
                    self.assertIn("Only the Pro model is eligible.", offer["fine_print"])

    def test_chase_review_private_values_are_absent_from_entire_written_record(self):
        card = "Chase Freedom"
        cases = [
            ("Your coupon: fixture-coupon-value", "fixture-coupon-value"),
            ("Your coupon code is shown below.<br><b>fixture-next-line-value</b>", "fixture-next-line-value"),
            ("Membership ID: fixture-member-value", "fixture-member-value"),
            ("Your access token is fixture-access-value", "fixture-access-value"),
            ("Shop at https://fixture-shop-value.shop.example.com/ref", "fixture-shop-value"),
            ("Shop at fixture-bare-value.shop.example.com", "fixture-bare-value"),
        ]
        for phrase, marker in cases:
            with self.subTest(phrase=phrase):
                sid, capture = self.chase_review_fixture(card, reward_description=(
                    f"<b>Earn 10% cash back on your purchase.</b><br>{phrase}<br>Gift cards are excluded."
                ))
                output, report = self.apply_ok(card, [capture])
                record = self.t.offers()[sid]
                self.assertNotIn(marker, json.dumps(record))
                self.assertNotIn(marker, output + json.dumps(report))
                self.assertIn("Gift cards are excluded.", record["fine_print"])
        marker = "fixture-cross-field-value"
        sid, capture = self.chase_review_fixture(card, reward_description=f"Your coupon: {marker}")
        self.t.change_offers(lambda by, _: by[sid].update(other_details=[marker]))
        self.assert_chase_review_conflict(card, capture, "projected offer records have unsafe public text")

    def test_chase_review_structured_reward_minimum_and_channel_conflicts(self):
        card = "Chase Freedom"
        cases = [
            ({"reward_amount": "20"}, "structured reward and displayed reward disagree"),
            ({"reward_type": "DOLLAR"}, "structured reward and displayed reward disagree"),
            ({"min_spend": "25", "reward_description": "Earn 10% cash back on purchases of at least $75."},
             "current cashback minimum evidence disagrees"),
            ({"reward_description": "Earn 10% cash back on in-store purchases only."},
             "current channel evidence disagrees"),
        ]
        for updates, conflict in cases:
            with self.subTest(updates=updates):
                _, capture = self.chase_review_fixture(card, **updates)
                self.assert_chase_review_conflict(card, capture, conflict)

    def test_chase_review_superseded_cashback_cap_and_distinct_purchase_ceiling(self):
        card = "Chase Freedom"
        sid, capture = self.chase_review_fixture(card, saved="Cash back maximum: $15.", reward_cap="25")
        self.apply_ok(card, [capture])
        offer = self.t.offers()[sid]
        self.assertNotIn("$15", offer["fine_print"])
        self.assertIn("Cash back maximum: $25.", offer["fine_print"])
        self.assertIsNone(offer["spend_cap"])
        sid, capture = self.chase_review_fixture(card, reward_cap="20",
                                                reward_description="Earn 10% cash back on up to $200 in purchases.")
        self.apply_ok(card, [capture])
        offer = self.t.offers()[sid]
        self.assertIn("up to $200 in purchases", offer["fine_print"])
        self.assertIn("Cash back maximum: $20.", offer["fine_print"])
        self.assertIsNone(offer["spend_cap"])
        sid, capture = self.chase_review_fixture(card, reward_cap="60", reward_description=(
            "Earn 10% cash back on your first two purchases, with a $30 cash back maximum. "
            "Limit of $30 per statement credit (up to $60 total cashback)."
        ))
        self.apply_ok(card, [capture])
        offer = self.t.offers()[sid]
        self.assertIn("$30 per statement credit", offer["fine_print"])
        self.assertIn("$60 total cashback", offer["fine_print"])
        _, capture = self.chase_review_fixture(card, reward_cap="25", reward_description=(
            "Earn 10% cash back on your purchase, with a $15 cash back maximum. Cash back maximum: $25."
        ))
        self.assert_chase_review_conflict(card, capture, "structured cashback cap and current description disagree")

    def test_chase_review_expiry_month_name_conflict_and_unparseable_explicit_label(self):
        card = "Chase Freedom"
        for label, conflict in (("Expires November 30, 2026.", "current explicit deadline and timestamp"),
                                ("Expires on November 42, 2026.", "cannot parse the explicit expiration")):
            with self.subTest(label=label):
                _, capture = self.chase_review_fixture(card, expiration_text=label)
                self.assert_chase_review_conflict(card, capture, conflict)
        sid, capture = self.chase_review_fixture(card, expiration_text="Expires Nov. 23, 2026.")
        self.apply_ok(card, [capture])
        self.assertEqual(self.t.offers()[sid]["expires_text"], "Expires Nov. 23, 2026")

    def test_chase_review_malformed_and_open_pairs_cannot_enable_withholding(self):
        card = "Chase Freedom"
        sid, capture = self.chase_review_fixture(card, merchant="Whiskerr", offer_id="FIXTURE:unresolved-pair")
        withhold = {"chase_withhold_new": {"FIXTURE:unresolved-pair": {"merchant": "Whiskerr", "reason": "Synthetic"}}}
        pair = {"saved": sid, "file": "Whiskerr", "bonus": "10% cash back"}
        before = self.t.read("offers.json")
        for accept in ("unresolved", "false", 0, 1, [], {}, None, True):
            with self.subTest(accept=accept):
                decisions = {**withhold, "pairs": [{**pair, "accept": accept}]}
                code, text, _ = self.t.run("apply", card, [capture], decisions=decisions)
                self.assertEqual(code, 2, text)
                self.assertIn("no pending pair" if accept is None or accept is True else "boolean or null", text)
                self.assertEqual(self.t.read("offers.json"), before)
        self.apply_ok(card, [capture], {**withhold, "pairs": [{**pair, "accept": False}]})
        self.assertEqual(self.t.offers()[sid]["status"], "missing")

    def test_chase_prior_reward_clause_does_not_need_an_eligibility_keyword(self):
        for card in ("Chase Freedom", "Chase Freedom Flex"):
            with self.subTest(card=card):
                previous = "Earn 10% back on the Pro model."
                sid, capture = self.chase_review_fixture(card, saved=previous,
                                                         reward_description="Earn 10% back on your purchase.")
                self.apply_ok(card, [capture])
                self.assertIn(previous, self.t.offers()[sid]["fine_print"])

    def test_chase_coupon_continuation_and_unfamiliar_hostname_stay_private(self):
        card = "Chase Freedom"
        for line, marker in (
            ("Your coupon is shown below:<br>fixture-private-coupon", "fixture-private-coupon"),
            ("Shop at fixture-personal-host.merchant.de.", "fixture-personal-host"),
        ):
            with self.subTest(line=line):
                sid, capture = self.chase_review_fixture(card, reward_description=(
                    f"Earn 10% cash back on your purchase.<br>{line}<br>Gift cards are excluded."
                ))
                output, report = self.apply_ok(card, [capture])
                offer = self.t.offers()[sid]
                self.assertNotIn(marker, json.dumps([offer, output, report]))
                self.assertIn("Gift cards are excluded.", offer["fine_print"])

    def test_chase_private_wording_cannot_remove_or_conflate_eligibility(self):
        card = "Chase Freedom"
        for detail, message in (
            ("Offer valid for first-time buyers only with membership ID: fixture-membership.",
             "private text overlaps eligibility"),
            ("Offer valid online only at checkout.merchant.com.<br>Offer not valid online at excluded.merchant.com.",
             "destination restrictions need public evidence"),
            ('Offer valid online only at <a href="https://checkout.merchant.com/">this link</a>.<br>'
             'Offer not valid online at <a href="https://excluded.merchant.com/">this link</a>.',
             "destination restrictions need public evidence"),
            ('Offer valid online only at <a href="https://checkout.merchant.com/">this link</a> '
             'and excluded at other.merchant.de.',
             "destination restrictions need public evidence"),
        ):
            with self.subTest(message=message, detail=detail):
                _, capture = self.chase_review_fixture(card, reward_description=(
                    f"Earn 10% cash back on your purchase.<br>{detail}"
                ))
                self.assert_chase_review_conflict(card, capture, message)

    def test_chase_destination_exclusion_after_hostname_blocks_apply(self):
        card = "Chase Freedom"
        _, capture = self.chase_review_fixture(card, reward_description=(
            "Earn 10% cash back. Offer valid only at shop.example.com. Purchases at outlet.example.com are excluded."
        ))
        before = self.t.read("offers.json")
        code, text, _ = self.t.run("apply", card, [capture], decisions={})
        self.assertEqual(code, 2, text)
        self.assertIn("destination restrictions need public evidence", text)
        self.assertEqual(self.t.read("offers.json"), before)

    def test_chase_only_before_purchase_channel_blocks_disagreement(self):
        card = "Chase Freedom"
        _, capture = self.chase_review_fixture(card, reward_description="Earn 10% cash back only on in-store purchases.")
        self.assert_chase_review_conflict(card, capture, "current channel evidence disagrees")

    def test_chase_online_exclusion_does_not_become_an_affirmative_channel(self):
        card = "Chase Freedom Flex"
        sid, capture = self.chase_review_fixture(card, channel="INSTORE", reward_description=(
            "Earn 10% cash back on your purchase. Offer valid in-store only. Not valid on purchases made online."
        ))
        self.apply_ok(card, [capture])
        offer = self.t.offers()[sid]
        self.assertEqual(offer["channel"], "in_store")
        self.assertIn("Not valid on purchases made online.", offer["fine_print"])

    def test_chase_up_to_cashback_amount_checks_structured_cap(self):
        card = "Chase Freedom"
        _, capture = self.chase_review_fixture(card, reward_cap="25",
                                             reward_description="Earn 10% cash back on your purchase, up to $15 cash back.")
        self.assert_chase_review_conflict(card, capture, "structured cashback cap and current description disagree")

    def test_chase_colon_expiration_label_cannot_bypass_timestamp_check(self):
        card = "Chase Freedom"
        for label, message in (
            ("Expiration date: November 30, 2026", "current explicit deadline and timestamp"),
            ("Expiration date: November 42, 2026", "cannot parse the explicit expiration"),
        ):
            with self.subTest(label=label):
                _, capture = self.chase_review_fixture(card, expiration_text=label)
                self.assert_chase_review_conflict(card, capture, message)
        sid, capture = self.chase_review_fixture(card, expiration_text="Expiration date: November 23, 2026")
        self.apply_ok(card, [capture])
        self.assertEqual(self.t.offers()[sid]["expires"], "2026-11-23")

    def test_chase_gift_promotion_dates_do_not_change_the_offer_deadline(self):
        card = "Chase Freedom Flex"
        sid, capture = self.chase_review_fixture(card, reward_description=(
            "Earn 10% cash back on your purchase. Free gifts valid through 11/19. Offer expires 11/23/2026."
        ))
        self.apply_ok(card, [capture])
        offer = self.t.offers()[sid]
        self.assertEqual(offer["expires"], "2026-11-23")
        self.assertIn("Free gifts valid through 11/19.", offer["fine_print"])

    def test_chase_payment_clause_recognizes_explicit_replacement_after_legacy_line_break_loss(self):
        card = "Chase Freedom Flex"
        sid, capture = self.chase_review_fixture(
            card, saved="Must make first recurring payment by 11/7/2026 Offer valid on first payment only.",
            reward_description="Earn 10% cash back on your purchase. "
                               "Must make first recurring payment by 12/7/2026. Offer valid on first payment only.")
        self.apply_ok(card, [capture])
        text = self.t.offers()[sid]["fine_print"]
        self.assertNotIn("11/7/2026", text)
        self.assertIn("Must make first recurring payment by 12/7/2026.", text)
        self.assertIn("Offer valid on first payment only.", text)

    def test_chase_prior_terms_decision_is_bound_to_capture_and_saved_clauses(self):
        card = "Chase Freedom"
        inputs = {"offer_id": "FIXTURE:prior-review", "saved": "Earn 10% cash back on the Pro model.",
                  "reward_description": "Earn 10% cash back on the Basic model."}
        sid, capture = self.chase_review_fixture(card, **inputs)
        _, _, report = self.t.run("report", card, [capture])
        choice = report["chase_prior_terms"]["FIXTURE:prior-review"]
        self.assertTrue(report["blockers"])
        decision = {"chase_prior_terms": {"FIXTURE:prior-review": {
            **choice, "reason": "The issuer confirms the Basic model replaces the Pro model."}}}
        self.apply_ok(card, [capture], decision)
        self.assertEqual(self.t.offers()[sid]["fine_print"], inputs["reward_description"])

        for changes in ({"reward_description": "Earn 10% cash back on the Starter model."},
                        {"saved": "Earn 10% cash back on the Plus model."}):
            with self.subTest(changes=changes):
                _, capture = self.chase_review_fixture(card, **{**inputs, **changes})
                before = self.t.read("offers.json")
                code, text, _ = self.t.run("apply", card, [capture], decisions=decision)
                self.assertEqual(code, 2, text)
                self.assertIn("prior terms decision does not match current evidence", text)
                self.assertEqual(self.t.read("offers.json"), before)

        for detail, conflict in (
            ("Offer valid in-store only.", "current channel evidence disagrees"),
            ("Offer valid for first-time buyers only with membership ID: fixture-private.", "private text overlaps eligibility"),
        ):
            with self.subTest(conflict=conflict):
                _, capture = self.chase_review_fixture(card, **{**inputs, "reward_description": (
                    f"{inputs['reward_description']} {detail}"
                )})
                _, _, report = self.t.run("report", card, [capture])
                decision["chase_prior_terms"]["FIXTURE:prior-review"] = {
                    **report["chase_prior_terms"]["FIXTURE:prior-review"], "reason": "The issuer confirmed the model change."}
                self.assert_chase_review_conflict(card, capture, conflict, decision)

    def test_chase_deadline_decision_is_bound_to_current_row_evidence(self):
        card = "Chase Freedom"
        timestamp = "2026-12-14T04:59:59Z"

        def update(rows):
            row = next(r for r in rows if r["merchant"] == "Whisker")
            row.update(offer_id="FIXTURE:deadline", end_timestamp=timestamp, expiration_text="Offer expires 11/30/2026.")
            row["reward_description"] = (
                "Earn 10% cash back on your purchase when you spend $499.99 or more. Offer expires 11/30/2026."
                " Payment must be made on or before 11/30/2026. Offer valid one time only. Gift cards are excluded."
                " Offer valid online only. Offer only valid on purchases made directly with the merchant."
            )
            return rows

        capture = self.t.csv(card, update)
        code, out, report = self.t.run("report", card, [capture])
        self.assertEqual(code, 0, out)
        choice = report["chase_deadlines"]["FIXTURE:deadline"]
        self.assertEqual(choice, {"deadline": "2026-11-30", "timestamp": timestamp, "reason": None})
        self.assertEqual(self.t.run("apply", card, [capture], decisions={})[0], 2)
        decisions = {"chase_deadlines": {"FIXTURE:deadline": {**choice, "reason": "Terms confirm the earlier date."}}}
        self.apply_ok(card, [capture], decisions)
        offer = self.t.offers()["chase-freedom/whisker"]
        self.assertEqual((offer["expires"], offer["expires_text"]), ("2026-11-30", "Offer expires 11/30/2026"))
        stale = dict(choice, timestamp="2026-12-15T04:59:59Z", reason="Old decision")
        code, out, _ = self.t.run("apply", card, [capture], decisions={"chase_deadlines": {"FIXTURE:deadline": stale}})
        self.assertEqual(code, 2, out)
        self.assertIn("match the current timestamp", out)

    def test_chase_description_publication_and_ordinary_travel_expiry(self):
        card = "Chase Freedom"

        def add(rows):
            return rows + [dict(rows[0], offer_id="FIXTURE:travel", merchant="Chase Travel", bonus_as_shown="$100 back",
                                channel="ONLINE", min_spend="600", reward_cap="0", end_timestamp="2027-01-01T04:59:59Z",
                                expiration_text="Offer expires 12/31/2026.", reward_description=(
                                    "<b>Get $100 back when you spend $600 or more.</b><br>Offer expires 12/31/2026."
                                    "<br>Offer valid online only at <a href='https://shop.example/hidden?token=ANCHORSECRET'>"
                                    "shop.example</a>. Coupon code required: MOCKSAVE."
                                    "<br>Gift cards are excluded. https://shop.example/private?auth=PATHSECRET."
                                    "<br>Customer ID: X81Z239Q. session_token=MOCKSESSION."
                                    "<script>SCRAPEDTOKEN</script>"
                                ))]

        capture = self.t.csv(card, add)
        out, report = self.apply_ok(card, [capture], {"categories": {"Chase Travel": "Travel"}})
        offer = self.t.offers()["chase-freedom/chase-travel"]
        self.assertEqual(offer["expires_text"], "Offer expires 12/31/2026")
        self.assertEqual(report["flags"], [])
        self.assertIn("Gift cards are excluded", offer["fine_print"])
        self.assertIn("Offer valid online only at the issuer-specified site", offer["fine_print"])
        self.assertIn("promotional coupon required", offer["fine_print"])
        for forbidden in ("MOCKSAVE", "ANCHORSECRET", "PATHSECRET", "X81Z239Q", "MOCKSESSION", "SCRAPEDTOKEN", "<b>"):
            self.assertNotIn(forbidden, out)
            self.assertNotIn(forbidden, offer["fine_print"])

    def test_chase_withheld_new_offer_counts_in_complete_snapshot(self):
        card = "Chase Freedom"

        def add(rows):
            return rows + [dict(rows[0], offer_id="FIXTURE:unresolved", merchant="Example Parent Company",
                                reward_description="Earn $10 cash back on a subscription to Example Subsidiary.")]

        capture = self.t.csv(card, add)
        decisions = {"chase_withhold_new": {"FIXTURE:unresolved": {
            "merchant": "Example Parent Company", "reason": "Qualifying storefront remains unconfirmed."
        }}}
        _, report = self.apply_ok(card, [capture], decisions)
        self.assertEqual(report["chase_withheld"], [{"merchant": "Example Parent Company", "lines": [7]}])
        self.assertEqual((report["offers_in_batch"], report["new"], report["missing"]), (6, [], []))
        self.assertNotIn("chase-freedom/example-parent-company", self.t.offers())
        self.assertEqual(self.t.load()["batches"][-1]["offers_found"], 6)
        code, out, _ = self.t.run("apply", card, [capture], decisions=decisions, extra=("--part",))
        self.assertEqual(code, 2, out)
        self.assertIn("requires a full snapshot", out)

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

    def test_us_bank_corroborated_new_needs_activation(self):
        sid = "us-bank/misfits-market"
        self.t.change_offers(lambda by, _: by[sid].update(activation="already_activated"))
        p = self.t.csv("U.S. Bank", lambda rows: [
            dict(r, activation_state="NEW", is_activated_prop="false") if r["merchant"] == "Misfits Market" else r
            for r in rows])
        self.apply_ok("U.S. Bank", [p])
        self.assertEqual(self.t.offers()[sid]["activation"], "needs_activation")

    def test_us_bank_uncorroborated_new_is_refused(self):
        for model, activated, drop in (("ACTIVATABLE", "true", ()), ("ACTIVATABLE", "", ()),
                                       ("ACTIVATABLE", "false", ("is_activated_prop",)),
                                       ("", "false", ()), ("AUTO_ACTIVATED", "false", ())):
            with self.subTest(model=model, activated=activated, drop=drop):
                p = self.t.csv("U.S. Bank", lambda rows: [
                    dict(r, activation_state="NEW", activation_model=model, is_activated_prop=activated)
                    if r["merchant"] == "Misfits Market" else r for r in rows], drop_cols=drop)
                before = self.data_bytes()
                code, out, _ = self.t.run("apply", "U.S. Bank", [p], decisions={})
                self.assertEqual(code, 2, out)
                self.assertIn("NEW requires activation_model ACTIVATABLE and is_activated_prop false", out)
                self.assertEqual(self.data_bytes(), before)

    def test_us_bank_bonus_days_is_reported_separately(self):
        promo = {"deal_id": "1000405330", "merchant": "Bonus Days", "bonus_as_shown": "Earn 2x cash back",
                 "start_date": "2026-11-20T05:00:00Z", "end_date": "2026-11-28T04:59:59Z",
                 "reward_copy": "Activate qualifying deals as usual.", "promo_text": "Double the listed rewards."}
        p = self.t.csv("U.S. Bank", lambda rows: [promo] + rows)
        out, rep = self.apply_ok("U.S. Bank", [p])
        self.assertEqual((rep["rows"], rep["offers_in_batch"], rep["size_check"]["batch"]), (7, 6, 6))
        self.assertEqual(rep["issuer_promotions"], [promo])
        self.assertIn("Activate qualifying deals as usual.", out)
        self.assertNotIn("us-bank/bonus-days", self.t.offers())
        self.assertEqual(self.t.load()["batches"][-1]["offers_found"], 6)

    def test_us_bank_la_colombe_matches_each_channel_in_reversed_source_order(self):
        def same_expiration(rows):
            return [dict(r, end_date="2026-12-01T04:59:59Z") if r["merchant"] == "La Colombe" else r
                    for r in reversed(rows)]

        self.apply_ok("U.S. Bank", [self.t.csv("U.S. Bank", same_expiration)])
        by = self.t.offers()
        for sid, channel, terms in (("us-bank/la-colombe", "in_store", "in-store only"),
                                    ("us-bank/la-colombe-2", "online", "online only")):
            self.assertEqual(by[sid]["channel"], channel)
            self.assertEqual(by[sid]["expires"], "2026-11-30")
            self.assertIn(terms, by[sid]["fine_print"])

    def test_us_bank_explicit_channel_matches_before_blank(self):
        store_id, online_id = "us-bank/la-colombe", "us-bank/la-colombe-2"
        self.t.write_json("phone-edits.json", {online_id: {"activation": "needs_activation"}})
        edits = self.t.read("phone-edits.json")
        before = self.t.load()
        other_issuers = [o for o in before["offers"] if o["card"] != "U.S. Bank"]
        for reverse in (False, True):
            with self.subTest(reverse=reverse):
                self.t.write_json("offers.json", before)

                def changed(rows):
                    rows[0].update(end_date="2026-12-02T04:59:59Z")
                    rows[1].update(channel="", end_date="2026-12-04T04:59:59Z", activation_state="SERVED")
                    return list(reversed(rows)) if reverse else rows

                p = self.t.csv("U.S. Bank", changed)
                _, report = self.apply_ok("U.S. Bank", [p])
                by = self.t.offers()
                self.assertEqual((by[store_id]["channel"], by[store_id]["expires"]), ("in_store", "2026-12-01"))
                self.assertEqual((by[online_id]["channel"], by[online_id]["expires"]), ("online", "2026-12-03"))
                self.assertEqual(by[online_id]["activation"], "already_activated")
                self.assertEqual(self.t.read("phone-edits.json"), edits)
                self.assertEqual([o for o in by.values() if o["card"] != "U.S. Bank"], other_issuers)
                blank_channels = {row["id"]: row["channel"] for row in report["blank_channels"]}
                self.assertEqual(blank_channels[online_id], "online")
                self.assertEqual((report["new"], report["missing"]), ([], []))

    def test_us_bank_competing_channel_matches_refuse_before_writing(self):
        before = self.data_bytes()
        generic_pair = {"saved": "us-bank/la-colombe", "file": "La Colombe", "bonus": "15% cash back", "accept": True}
        for channel, reverse in product(("", "Online"), (False, True)):
            with self.subTest(channel=channel, reverse=reverse):
                def competing(rows):
                    rows[0].update(channel=channel, end_date="2026-12-02T04:59:59Z")
                    rows[1].update(channel=channel, end_date="2026-12-04T04:59:59Z")
                    return list(reversed(rows)) if reverse else rows

                p = self.t.csv("U.S. Bank", competing)
                for mode in ("report", "apply"):
                    decisions = {"pairs": [generic_pair], "owner_approved": ["missing"]} if mode == "apply" else None
                    code, out, _ = self.t.run(mode, "U.S. Bank", [p], decisions=decisions)
                    self.assertEqual(code, 2, out)
                    self.assertIn("ambiguous U.S. Bank offer identities", out)
                    self.assertEqual(out.count(f"(source channel: {channel.lower() or 'blank'}) has candidates"), 2, out)
                    self.assertIn("us-bank/la-colombe (in_store)", out)
                    self.assertIn("us-bank/la-colombe-2 (online)", out)
                    self.assertEqual(self.data_bytes(), before)

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

    def test_alias_place_counts_when_the_current_name_has_another_base(self):
        # Review 1A J1-J3: the current name shares no base with the file's name, an alias does ("Marketplace by
        # eBay" / "The eBay - LA" with alias "eBay - LA"; the real "The Langham - New York" with alias "Langham
        # Hotels - New York"): the alias decides, so a changed place is proposed, never automatic
        for merchant, alias, new in [("Marketplace by eBay", "eBay - LA", "eBay - La Habra"),
                                     ("The eBay - LA", "eBay - LA", "eBay - La Habra"),
                                     ("The Langham - New York", "Langham Hotels - New York", "Langham Hotels - New York, Fifth Avenue")]:
            with self.subTest(merchant=merchant, new=new):
                t = Tree()
                try:
                    t.change_offers(lambda by, d: by["capital-one/ebay"].update(merchant=merchant, aliases=[alias]))
                    p = t.csv("Capital One", lambda rows: [dict(r, merchant=new) if r["merchant"] == "eBay" else r for r in rows])
                    code, out, rep = t.run("report", "Capital One", [p])
                    self.assertNotIn("capital-one/ebay", [m["id"] for m in rep["paired"]], out)
                    self.assertEqual([(m["saved"], m["file"]) for m in rep["proposals"]], [("capital-one/ebay", new)], out)
                    self.assertIn("never automatic", rep["proposals"][0]["why"], out)
                finally:
                    t.close()

    def test_old_location_alias_does_not_block_two_plain_names(self):
        # Review 1A L1-L3: current "eBay" (alias "eBay - Encino", from an accepted strip) against file "eBay Store" is
        # an ordinary extension again, and an unrelated plain leftover isn't promoted to a location proposal
        for merchant, alias, new, auto in [("eBay", "eBay - Encino", "eBay Store", True), ("eBay Deals Club", "eBay - HB", "eBay Store", False)]:
            with self.subTest(merchant=merchant, new=new):
                t = Tree()
                try:
                    t.change_offers(lambda by, d: by["capital-one/ebay"].update(merchant=merchant, aliases=[alias]))
                    p = t.csv("Capital One", lambda rows: [dict(r, merchant=new) if r["merchant"] == "eBay" else r for r in rows])
                    code, out, rep = t.run("report", "Capital One", [p])
                    self.assertFalse(any("never automatic" in m["why"] for m in rep["proposals"]), out)
                    self.assertEqual(rep["stops"], [], out)
                    if auto:
                        self.assertEqual([(m["id"], m["rule"]) for m in rep["paired"] if m["id"] == "capital-one/ebay"], [("capital-one/ebay", "extends")], out)
                finally:
                    t.close()

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

    def test_us_bank_blank_channel_keeps_saved_channel_and_defaults_new_offer(self):
        self.t.change_offers(lambda by, d: by["us-bank/misfits-market"].update(channel="online"))
        p = self.t.csv("U.S. Bank", lambda rows: rows + [
            dict(next(r for r in rows if r["merchant"] == "Misfits Market"), deal_id="FIXTURE7", merchant="Meal Plan")])
        _, rep = self.apply_ok("U.S. Bank", [p], decisions={"categories": {"Meal Plan": "Groceries & Food Delivery"}})
        self.assertEqual(self.t.offers()["us-bank/misfits-market"]["channel"], "online")
        self.assertEqual(self.t.offers()["us-bank/meal-plan"]["channel"], "none_shown")
        self.assertEqual(rep["blank_channels"], [
            {"id": "us-bank/misfits-market", "merchant": "Misfits Market", "deal_id": "FIXTURE6",
             "saved_channel": "online", "channel": "online"},
            {"id": "us-bank/meal-plan", "merchant": "Meal Plan", "deal_id": "FIXTURE7",
             "saved_channel": None, "channel": "none_shown"},
        ])


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

    def test_alibaba_exception_matches_the_page(self):
        # Step 3A: the page's merchantKey() keeps "Ali Baba" (restaurant) and "Alibaba" (marketplace) apart, so a
        # member on the other spelling is not a location of the group (the page would refuse the whole file).
        for groups in [{"Ali Baba": ["AliBaba - Irvine"]}, {"Alibaba": ["Ali Baba - Irvine"]}]:
            with self.subTest(groups=groups):
                code, out = self.validate({"groups": groups})
                self.assertEqual(code, 1, out)
                self.assertIn("is not '" + next(iter(groups)) + " - <location>'", out)
        code, out = self.validate({"groups": {"Ali Baba": ["ALI BABA - Irvine"], "Alibaba": ["Alibaba.com - US"]}})
        self.assertEqual(code, 0, out)  # two groups, two names; case and .com still ignored within each
        self.assertIn("2 approved location variants in 2 groups", out)

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

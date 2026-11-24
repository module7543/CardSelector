"""Convert Capital One coupon evidence to a public, display-only snapshot."""

import calendar
import json
import re
import unicodedata
from collections import defaultdict
from datetime import date, timedelta


SOURCES = {"verified_panel", "listing_only", "unverified_listing"}
PLACEMENTS = {"standard", "hero", "showcase", "carousel_card", "featured", "daily_featured", "promoted_affiliate"}
GRID_PLACEMENTS = {"standard", "hero", "showcase", "carousel_card", "promoted_affiliate"}
DISCOUNTS = {"percentage_off", "fixed_dollar_off"}
STACKING = {"eligible_subtotal", "eligibility_overlap", "check_issuer", "unknown"}
DATE_BASES = {"confirmed", "estimated", "conflict", "unknown"}
FRESH_DAYS = 7
ESTIMATE_WINDOW = 60

# Generated listing notes can include codes the panel never exposed. Match explicit code
# instructions and compact code-like tokens following common instruction words.
CODE_TOKEN = r"(?:(?=[A-Z0-9_-]*[A-Z])[A-Z0-9][A-Z0-9_-]{3,}|(?=[\w-]*\d)[A-Za-z][A-Za-z0-9_-]{3,})"
CODE_VERB = r"(?:use|enter|apply)"
CODE_QUALIFIER = r"(?:with|using)"
CODE_ACTION = rf"(?:{CODE_VERB}|{CODE_QUALIFIER})"
COUPON_NOUN = r"(?:coupon|promo|promotional|voucher|offer|discount)"
CODE_LABEL = r"(?:the\s+)?(?:(?:promo|coupon|discount)\s+)?code"
OPEN_QUOTE = r"[\"'“‘]"
# A noun in an instruction can introduce a lowercase code. Recognize ordinary continuations
# such as "apply discount before tax" as prose, even when typeset in capitals.
NON_CODE_WORD = (rf"(?i:(?:{COUPON_NOUN}|a|an|the|at|in|on|before|after|during|online|offline|only|once|first|per"
                 r"|for|from|with|without|to|by|as|when|where|while|until|if|unless|automatically|directly"
                 r"|pricing|price|terms|restrictions|details|benefits|eligibility|codes?)(?![\w-]))")
# A bare "with" or "using" can name a card, merchant or product. Require both uppercase
# letters and digits before withholding the ambiguous sentence, unless the value is known.
QUALIFIER_TOKEN = r"(?=[A-Z0-9_-]*[A-Z])(?=[A-Z0-9_-]*[0-9])[A-Z0-9][A-Z0-9_-]{3,}"
CODE_PHRASE = re.compile(
    rf"(?<!\w)(?:(?i:(?:{CODE_ACTION}\s+)?{CODE_LABEL}\s*[:=]\s*){OPEN_QUOTE}?[\w-]+"
    rf"|(?i:{CODE_ACTION}\s+{CODE_LABEL}\s+){OPEN_QUOTE}?[\w-]+"
    rf"|(?P<omit>(?i:{CODE_VERB}\s+(?:the\s+)?{COUPON_NOUN}(?:\s*[:=]\s*|\s+))"
    rf"(?:{OPEN_QUOTE}|(?!{NON_CODE_WORD}))[\w-]+"
    rf"|(?i:{CODE_VERB}\s+){OPEN_QUOTE}?(?!{NON_CODE_WORD}){CODE_TOKEN}"
    rf"|(?i:{CODE_QUALIFIER}\s+){OPEN_QUOTE}?{QUALIFIER_TOKEN}))(?![\w-])[\"'”’]?"
)
CODE_WORD = re.compile(r"\bcode\b", re.I)
# Keep the deployed four-character instruction check. A later coupon noun also makes an
# instruction ambiguous when short modifiers such as "a" or "my" precede it.
REDEMPTION_INSTRUCTION = re.compile(
    rf"\b{CODE_VERB}\s+(?:[A-Z0-9_-]{{4,}}\b"
    rf"|[^.!?]*?\b{COUPON_NOUN}(?:\s*[:=;]\s*|\s+){OPEN_QUOTE}?[\w-]+)", re.I
)
# Exempt complete, code-free clauses so arbitrary text after a familiar word still gets checked.
CODE_FREE_INSTRUCTION = re.compile(
    r"(?:apply\s+(?:discount\s+)?before\s+tax"
    r"|(?:some\s+)?(?:restrictions|exclusions|limitations)\s+(?:may\s+)?apply\s+without\s+specific\s+products\s+named"
    r"|use\s+(?:(?:a|the|this|your)\s+)?(?:coupon\s+at\s+checkout|offer\s+before\s+it\s+ends)"
    r"|apply\s+(?:the\s+)?offer\s+to\s+eligible\s+items"
    r"|use\s+the\s+offer\s+online|apply\s+promotional\s+pricing\s+at\s+checkout"
    r"|(?:review\s+exclusions:\s+)?use\s+of\s+(?:promotional|promo)\s+codes\s+not\s+provided\s+by\s+capital\s+one"
    r"\s+may\s+invalidate\s+your\s+offer)[.!?]?", re.I
)
SENTENCE_BREAK = re.compile(r"(?<=[.!?])\s+")
UNSAFE_TEXT = re.compile(r"[a-z][a-z0-9+.-]*://|www\.|//[\w.-]+[./?]|\b(?:[a-z0-9-]+\.)+[a-z]{2,}[/#?]"
                         r"|[\x00-\x1f]|[\u200b-\u200f\u202a-\u202e\u2060-\u206f]", re.I)
YEARLESS_LABEL = re.compile(rf"(?:(?:{'|'.join(calendar.day_name)}), )?(?:{'|'.join(list(calendar.month_abbr)[1:])}) "
                           r"(?:[1-9]|[12][0-9]|3[01]) \(year unstated\)")
MONTH_LABEL = re.compile(rf"End of (?:{'|'.join(list(calendar.month_name)[1:])}) [0-9]{{1,4}}")


class CouponEvidenceError(ValueError):
    """Use fixed messages so malformed private fields never appear in a report."""


def iso_day(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def positive(value):
    return type(value) in (int, float) and 0 < value <= 1_000_000


def private_codes(records):
    codes = []
    for record in records:
        value = record.get("coupon", {}).get("code", {}).get("value")
        if isinstance(value, str) and value.strip():
            codes.append(unicodedata.normalize("NFKC", value.strip()).casefold())
    return set(codes)


def has_code(text, codes):
    normal = unicodedata.normalize("NFKC", text).casefold()
    return any(re.search(r"(?<![\w])" + re.escape(code) + r"(?![\w])", normal) for code in codes)


def ambiguous_instruction(sentence):
    return REDEMPTION_INSTRUCTION.search(sentence) is not None and CODE_FREE_INSTRUCTION.fullmatch(sentence) is None


def public_summary(line, codes):
    if isinstance(line, str):
        line = line.strip()
        normal = unicodedata.normalize("NFKC", line)
        if 0 < len(line) <= 500 and not (
                UNSAFE_TEXT.search(normal) or CODE_PHRASE.search(normal) or CODE_WORD.search(normal)
                or has_code(normal, codes) or any(ambiguous_instruction(part) for part in SENTENCE_BREAK.split(normal))):
            return line
    return None


def summarized_terms(line, codes):
    if not isinstance(line, str):
        return None
    safe = public_summary(line, codes)
    if safe:
        return safe
    # Preserve independent restrictions and the rest of a term after removing a code instruction.
    normal = unicodedata.normalize("NFKC", line.strip())
    terms = []
    def replace_code(match):
        if re.match(r"(?:with|using)\b", match[0], re.I):
            return "with the specified promotional coupon"
        if re.match(r"(?:use|enter|apply)\b", match[0], re.I):
            return "Apply the promotional coupon"
        return ""

    for part in SENTENCE_BREAK.split(normal):
        # Withholding an ambiguous sentence preserves the meaning of the independent terms.
        if ambiguous_instruction(part) or any(match["omit"] for match in CODE_PHRASE.finditer(part)):
            continue
        redacted = CODE_PHRASE.sub(replace_code, part)
        redacted = re.sub(r"\s+([.!?,;])", r"\1", redacted).strip()
        if re.fullmatch(r"(?:Apply the promotional coupon(?: at checkout| to (?:save|redeem))?)?[.!?;]?", redacted, flags=re.I):
            continue
        if term := public_summary(redacted, codes):
            terms.append(term)
    return public_summary(" ".join(terms), codes)


def scrub_legacy(offer, codes):
    safe, changed = [], 0
    for note in offer.get("other_details", []):
        if note == "Tile label reads 'EXCLUSIVE COUPON'":
            changed += 1
            continue
        if note.startswith("Promo text reads"):
            summary = summarized_terms(legacy_promo_text(note), codes)
            replacement = f'Promo text reads "{summary}"' if summary else None
            if replacement != note:
                changed += 1
                note = replacement
        if note is not None:
            safe.append(note)
    if changed:
        offer["other_details"] = list(dict.fromkeys(safe))
    return changed


def legacy_promo_text(note):
    return note.removeprefix("Promo text reads").strip().strip('"')


def read_evidence(path, read_date, rows):
    if not path:
        raise CouponEvidenceError("Capital One report and apply require --coupons with the same-date companion JSON")
    try:
        with open(path, encoding="utf-8-sig") as stream:
            data = json.load(stream)
        if (type(data["schema_version"]) is not int or data["schema_version"] != 1 or data["capture_date"] != read_date
                or data["capture_timezone"] != "America/Los_Angeles" or data["source"]["platform"] != "Capital One Offers"):
            raise CouponEvidenceError("coupon evidence must use schema version 1 and match the Pacific Capital One inventory date")
        panels = data["verified_coupon_offers"]
        listings = data["listing_only_promotions"]
        if not isinstance(panels, list) or not isinstance(listings, list):
            raise CouponEvidenceError("coupon evidence must contain panel and listing record arrays")
        if any(record["evidence_status"] != "verified_detail_panel" for record in panels) or any(
                record["evidence_status"] != "listing_only" for record in listings):
            raise CouponEvidenceError("coupon evidence status does not match its record array")
        scan = data["source"].get("inventory_scan") or {}
        check_inventory(rows, data["source"].get("surface"), scan)
        complete = scan.get("coupon_scan_complete", True)
        if type(complete) is not bool:
            raise CouponEvidenceError("coupon_scan_complete must be true or false when supplied")
        records = panels + listings
        return records, complete, private_codes(records)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        if isinstance(exc, CouponEvidenceError):
            raise
        raise CouponEvidenceError("could not read the coupon evidence JSON") from None


def check_inventory(rows, surface, scan):
    if surface != "Unfiltered main offer feed" or scan.get("available_feed_exhausted") is not True:
        raise CouponEvidenceError("Capital One inventory must establish exhaustion of the unfiltered main offer feed")
    size = scan.get("loaded_grid_entries")
    if type(size) is not int or size <= 0:
        raise CouponEvidenceError("Capital One inventory requires a positive loaded grid entry count")
    positions = set()
    for _, row in rows:
        kind = row["tile_kind"].strip()
        if row["layout_variant"].strip() != "current_layout" or kind in {"future_preview", "issuer_bonus_banner"}:
            continue
        if not row["merchant"].strip() or row["merchant"].strip().upper() == "UNREADABLE" or not row["reward"].strip():
            raise CouponEvidenceError("Capital One inventory contains an unreadable current offer placement")
        if kind not in PLACEMENTS | {"added_to_card"}:
            raise CouponEvidenceError("Capital One inventory contains an unrecognized current placement kind")
        pos = (row.get("grid_position") or "").strip()
        if kind in GRID_PLACEMENTS and pos:
            if not re.fullmatch(r"[1-9][0-9]*", pos) or len(pos) > len(str(size)) or int(pos) > size:
                raise CouponEvidenceError("Capital One inventory has invalid grid positions")
            positions.add(int(pos))
    if len(positions) != size:
        raise CouponEvidenceError("Capital One inventory grid coverage does not match the companion entry count")


def coupon_key(nkey, bonus_key, merchant, domain, reward, source):
    return (nkey(merchant), domain.strip().lower(), bonus_key(reward), source.strip().lower())


def inventory_candidates(rows, nkey, bonus_key):
    candidates = defaultdict(list)
    for line, row in rows:
        kind = row["tile_kind"].strip()
        if row["layout_variant"].strip() != "current_layout" or kind in {"future_preview", "issuer_bonus_banner", "added_to_card"}:
            continue
        badge = (row.get("badge") or "").strip().upper() == "EXCLUSIVE COUPON"
        coupon_type = any(t.strip().lower() == "coupon" for t in (row.get("offer_type") or "").split("|"))
        if badge or coupon_type:
            key = coupon_key(nkey, bonus_key, row["merchant"], row["domain"], row["reward"], kind)
            candidates[key].append((line, badge))
    return candidates


def expiration(raw, checked, previous):
    observations, candidates, exact_dates = [], [], []
    for item in raw["observations"]:
        exact = iso_day(item.get("iso_date"))
        if exact:
            observations.append(exact.isoformat())
            candidates.append(exact)
            exact_dates.append(exact)
            continue
        month, day, year = item.get("month"), item.get("day"), item.get("year")
        if type(month) is not int or not 1 <= month <= 12:
            continue
        if day is None and type(year) is int and 1 <= year <= 9999:
            observations.append(f"End of {calendar.month_name[month]} {year}")
            continue
        if type(day) is not int or not 1 <= day <= 31:
            continue
        if type(year) is int:
            try:
                exact = date(year, month, day)
            except ValueError:
                continue
            observations.append(exact.isoformat())
            candidates.append(exact)
            exact_dates.append(exact)
            continue
        weekday = item.get("weekday")
        if weekday not in calendar.day_name:
            weekday = None
        label = f"{calendar.month_abbr[month]} {day}"
        observations.append((weekday + ", " if weekday else "") + label + " (year unstated)")
        near = []
        for yr in (checked.year - 1, checked.year, checked.year + 1):
            try:
                near.append(date(yr, month, day))
            except ValueError:
                continue
        if near:
            closest = min(near, key=lambda d: abs(d - checked))
            if abs((closest - checked).days) <= ESTIMATE_WINDOW and calendar.day_name[closest.weekday()] == weekday:
                candidates.append(closest)
    observations = list(dict.fromkeys(observations))
    ends = sorted(set(candidates))
    if raw.get("has_conflict") is True or raw.get("status") == "conflicting_source_dates" or len(ends) > 1:
        basis, end = "conflict", None
    elif len(ends) == 1:
        basis, end = ("confirmed" if exact_dates else "estimated"), ends[0]
    else:
        basis, end = "unknown", None
    # A repeated yearless label on the same promotion cannot roll its inferred year forward.
    old = previous.get("expiry", {}) if previous else {}
    if basis in ("estimated", "unknown") and old.get("basis") == "estimated" and old.get("observations") == observations:
        basis, end = "estimated", iso_day(old["date"])
    freshness = checked + timedelta(days=FRESH_DAYS - 1)
    visible_through = end or min([freshness, *ends])
    return {"basis": basis, "date": end.isoformat() if end else None, "observations": observations}, visible_through.isoformat()


def sanitize(record, read_date, codes, previous):
    coupon = record["coupon"]
    panel = record["evidence_status"] == "verified_detail_panel"
    raw_discount = coupon["discount"]
    kind, value = raw_discount["kind"], raw_discount["advertised_value"]
    if (kind not in DISCOUNTS or not positive(value) or (kind == "percentage_off" and value > 100)
            or (kind == "fixed_dollar_off" and raw_discount.get("currency") != "USD")):
        raise CouponEvidenceError("coupon evidence has an unsupported discount")
    result = {
        "source": "verified_panel" if panel else "listing_only",
        "placement": record["evidence"]["listing"]["source"].strip().lower(),
        "observed_on": read_date,
        "discount": {"kind": kind, "value": value, "up_to": raw_discount["up_to"] is True},
    }
    if panel and raw_discount.get("additional_displayed_tiers"):
        tiers = [tier["advertised_value"] for tier in raw_discount["additional_displayed_tiers"]
                 if tier["kind"] == kind and positive(tier["advertised_value"]) and
                 (kind != "percentage_off" or tier["advertised_value"] <= 100)]
        if tiers:
            result["discount"]["tiers"] = list(dict.fromkeys(tiers))
    original = next((p for p in previous if all(p.get(k) == result[k] for k in ("source", "placement", "discount"))), None)
    result["expiry"], result["visible_through"] = expiration(coupon["expiration"], iso_day(read_date), original)
    if not panel:
        # A listing-only promotion never borrows detail-panel eligibility or stacking terms.
        return result
    minimum, cap = coupon["minimum_purchase"], coupon["discount_cap"]
    threshold = minimum.get("headline_threshold") or {}
    for name, values, status in (("minimum_purchase", minimum, "stated"), ("discount_cap", cap, "stated"),
                                 ("headline_threshold", threshold, None)):
        amount = values.get("amount")
        if (positive(amount) and values.get("currency") == "USD" and
                (values.get("status") == status if status else minimum.get("status") == "threshold_in_headline")):
            result[name] = amount
    if minimum.get("status") == "may_apply_amount_unspecified":
        result["minimum_unspecified"] = True
    # Only explicitly summarized terms enter the public projection.
    for key, field in (("eligibility", "explicit_eligibility_summary"), ("exclusions", "exclusions_summary"),
                       ("conditions", "additional_conditions_summary")):
        lines = coupon.get(field) or []
        if not isinstance(lines, list) or not all(isinstance(line, str) for line in lines):
            raise CouponEvidenceError("coupon summary fields must contain arrays of text")
        safe = [s for line in lines if (s := summarized_terms(line, codes))]
        if safe:
            result[key] = list(dict.fromkeys(safe))
    stacking = record["stacking"]
    evidence = stacking.get("issuer_evidence") or {}
    if evidence.get("cashback_based_on_eligible_subtotal_after_coupon") is True:
        result["stacking"] = {
            "permitted_for_qualifying_purchase_subject_to_terms": "eligible_subtotal",
            "permitted_only_where_coupon_and_cashback_eligibility_overlap": "eligibility_overlap",
            "merchant_other_offer_scope_unresolved": "check_issuer",
        }.get(stacking["outcome_status"], "unknown")
    else:
        result["stacking"] = "unknown"
    if evidence.get("same_open_session_required") is True and evidence.get("within_24_hours_required") is True:
        result["same_session_24h"] = True
    cashback_exclusions = summarized_terms(record["cashback"].get("exclusions_summary_label_exact"), codes)
    if cashback_exclusions and result["stacking"] in {"check_issuer", "eligibility_overlap"}:
        result["cashback_exclusions"] = cashback_exclusions
    if coupon["code"].get("reveal_required") is True:
        result["reveal_at_issuer"] = True
    return result


def reconcile(data, rows, resolved, evidence, read_date, nkey, bonus_key):
    """Attach current evidence to already reconciled inventory records. No identity creation or repricing here."""
    records, scan_complete, codes = evidence
    candidates = inventory_candidates(rows, nkey, bonus_key)
    used, seen_records = set(), set()
    incoming = defaultdict(list)
    issues = []
    counts = {"verified": 0, "listing": 0, "unverified": 0, "unresolved": 0, "scrubbed_notes": 0, "withdrawn": 0,
              "withheld": 0, "partial_panels": 0, "scan_declared_incomplete": not scan_complete, "complete": False}
    try:
        for number, record in enumerate(records, 1):
            m, evidence = record["merchant"], record["evidence"]
            key = coupon_key(nkey, bonus_key, m["name"], m["domain"], record["cashback"]["listing_text_exact"],
                             evidence["listing"]["source"])
            seen = candidates.get(key, [])
            panel = record["evidence_status"] == "verified_detail_panel"
            destinations = resolved.get(key[:3], [])
            if (record["capture_date"] != read_date or not all(key[:3]) or key[-1] not in PLACEMENTS
                    or len(seen) != 1 or len(destinations) != 1 or key in seen_records
                    or (not panel and seen[0][1])):
                issues.append(f"coupon record {number} does not match a unique current placement and offer reward")
                continue
            seen_records.add(key)
            detail = evidence.get("detail_panel") or {}
            detail_reward = bonus_key(record["cashback"].get("text_exact")) if panel else None
            if detail_reward and detail_reward != key[2]:
                issues.append(f"coupon record {number} has a detail-panel cashback reward that conflicts with its listing")
                continue
            if panel and not (
                    detail.get("coupon_details_read") is True
                    and detail.get("expanded_cashback_terms_read") is True
                    and detail_reward):
                # Keep the listing reference, and withhold unconfirmed terms.
                counts["partial_panels"] += 1
                continue
            used.add(key)
            offer = destinations[0]
            incoming[offer["id"]].append(sanitize(record, read_date, codes, offer.get("promotions", [])))
            counts["verified" if panel else "listing"] += 1
    except CouponEvidenceError:
        raise
    except (LookupError, ValueError, TypeError, AttributeError, OverflowError):
        raise CouponEvidenceError("coupon evidence contains invalid placement or terms fields") from None

    for key, placements in candidates.items():
        if key in used:
            continue
        destinations = resolved.get(key[:3], [])
        if not all(key[:3]) or key[-1] not in PLACEMENTS or len(destinations) != 1 or len(placements) != 1:
            counts["unresolved"] += 1
            continue
        offer = destinations[0]
        # This is a current listing reference, not a carried-over coupon discount.
        incoming[offer["id"]].append({
            "source": "unverified_listing", "placement": key[-1], "observed_on": read_date,
            "visible_through": (iso_day(read_date) + timedelta(days=FRESH_DAYS - 1)).isoformat(),
        })
        counts["unverified"] += 1
    if counts["unresolved"]:
        issues.append(f"{counts['unresolved']} current coupon listing(s) lack a unique placement or offer identity")
    counts["complete"] = scan_complete and candidates.keys() == used and not issues
    for offer in data["offers"]:
        if offer["card"] != "Capital One":
            continue
        counts["scrubbed_notes"] += scrub_legacy(offer, codes)
        new = incoming.get(offer["id"]) if offer["status"] == "active" else None
        old = offer.pop("promotions", [])
        confirmed = {(p["source"], p["placement"]) for p in new or []}
        counts["withdrawn" if counts["complete"] else "withheld"] += sum(
            (p["source"], p["placement"]) not in confirmed and (counts["complete"] or p["source"] != "unverified_listing")
            for p in old)
        if new:
            offer["promotions"] = sorted(new, key=lambda p: (p["source"] != "verified_panel", p["placement"]))
    return counts, issues


def valid_promotion(p):
    """Validate the public allowlist without echoing unexpected fields or values."""
    if not isinstance(p, dict):
        return False
    base = {"source", "placement", "observed_on", "visible_through"}
    source = p.get("source")
    observed, through = iso_day(p.get("observed_on")), iso_day(p.get("visible_through"))
    if (not isinstance(source, str) or source not in SOURCES or not isinstance(p.get("placement"), str)
            or p["placement"] not in PLACEMENTS or not observed or not through):
        return False
    if source == "unverified_listing":
        return set(p) == base and timedelta(days=FRESH_DAYS - 1) == through - observed
    core = base | {"discount", "expiry"}
    panel = {"minimum_purchase", "minimum_unspecified", "headline_threshold", "discount_cap",
             "eligibility", "exclusions", "conditions", "stacking", "reveal_at_issuer", "same_session_24h",
             "cashback_exclusions"}
    if not core <= p.keys() or p.keys() - (core | (panel if source == "verified_panel" else set())):
        return False
    d, e = p["discount"], p["expiry"]
    if (not isinstance(d, dict) or not {"kind", "value", "up_to"} <= d.keys()
            or d.keys() - {"kind", "value", "up_to", "tiers"} or not isinstance(d["kind"], str) or d["kind"] not in DISCOUNTS
            or not isinstance(d["up_to"], bool) or not isinstance(d.get("tiers", []), list)):
        return False
    if any(not positive(n) or (d["kind"] == "percentage_off" and n > 100) for n in [d["value"], *d.get("tiers", [])]):
        return False
    if (not isinstance(e, dict) or set(e) != {"basis", "date", "observations"} or not isinstance(e["basis"], str)
            or e["basis"] not in DATE_BASES or not isinstance(e["observations"], list) or any(
                not isinstance(x, str) or not (iso_day(x) or YEARLESS_LABEL.fullmatch(x) or MONTH_LABEL.fullmatch(x))
                for x in e["observations"])):
        return False
    if e["basis"] in {"confirmed", "estimated"}:
        if iso_day(e["date"]) != through:
            return False
    elif e["date"] is not None or through - observed >= timedelta(days=FRESH_DAYS):
        return False
    if source == "listing_only":
        return "tiers" not in d
    if not isinstance(p.get("stacking"), str) or p["stacking"] not in STACKING:
        return False
    return (all(positive(p[k]) for k in ("minimum_purchase", "headline_threshold", "discount_cap") if k in p)
            and all(p[k] is True for k in ("reveal_at_issuer", "minimum_unspecified", "same_session_24h") if k in p)
            and ("cashback_exclusions" not in p or public_summary(p["cashback_exclusions"], set()) is not None)
            and all(isinstance(p[k], list) and all(public_summary(s, set()) is not None for s in p[k])
                    for k in ("eligibility", "conditions", "exclusions") if k in p))

"""Reconcile the terms of a Chase live offer without publishing its private capture."""
import re
import unicodedata
from datetime import date
from decimal import Decimal
from html.parser import HTMLParser

from coupon_promotions import CODE_PHRASE, CODE_WORD, ambiguous_instruction, has_code


class Description(HTMLParser):
    def __init__(self, raw):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.hidden = None
        self.feed(raw)
        self.close()

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "template"}:
            self.hidden = self.hidden or tag
        elif tag in {"br", "p", "li", "div"} and not self.hidden:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag == self.hidden:
            self.hidden = None
        elif tag in {"p", "li", "div"} and not self.hidden:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)

    @property
    def text(self):
        return "".join(self.parts)


MONTHS = {label: i for i, name in enumerate(
    "january february march april may june july august september october november december".split(), 1)
    for label in (name, name[:3])}
MONTHS["sept"] = 9
NAMED_DAY = rf"(?:{'|'.join(MONTHS)})\.?\s+\d{{1,2}}(?:,?\s+\d{{4}})?"
DAY = rf"\d{{1,2}}/\d{{1,2}}(?:/\d{{4}}|/\d{{2}})?|\d{{4}}-\d{{2}}-\d{{2}}|{NAMED_DAY}"
EXPIRY_PREFIX = r"(?:offer\s+)?(?:expir(?:es?|ation(?:\s+date)?\s+is)(?:\s+(?:on|by))?|valid (?:through|until))"
EXPIRY = re.compile(rf"\b{EXPIRY_PREFIX}(?:\s*:\s*|\s+)({DAY})(?![\w/])", re.I)
EXPIRY_LINE = re.compile(rf"{EXPIRY_PREFIX}(?:\s*:\s*|\s+)(?:{DAY})\.?", re.I)
TRAILING_EXPIRY = re.compile(rf"\bOffer expires(?: on| by)?(?:\s*:\s*|\s+)(?:{DAY})\.?$", re.I)
EXPIRY_LABEL = re.compile(rf"^{EXPIRY_PREFIX}(?:[\s:]|$)", re.I)
RELATIVE_EXPIRY = re.compile(r"(?:offer\s+)?expires?\s+(?:today|tomorrow|in \d+ days?)\.?$", re.I)
PAYMENT = re.compile(
    rf"\b(?:payment(?:s)?(?:\s+\w+){{0,5}}\s+(?:by|before|on or before)|"
    rf"(?:must|to)\s+make\s+(?:the\s+)?first\s+(?:recurring\s+)?payment\s+(?:by|before))\s+({DAY})(?![\d/])", re.I
)
STANDARD_PAYMENT = re.compile(rf"Payment must be made ((?:on or )?before) (?:{DAY})\.?", re.I)
REQUIRED_PAYMENT = re.compile(
    rf"\b(?:payment must be made|must make (?:the )?first (?:recurring )?payment)"
    rf"\s+(?:by|before|on or before)\s+({DAY})(?![\d/])", re.I)
DOLLARS = r"\$\s*(\d[\d,]*(?:\.\d+)?)"
MINIMUM = re.compile(
    rf"\b(?:spend(?:ing)?(?:\s+(?:a\s+)?minimum(?:\s+of)?|\s+at\s+least)?|minimum spend(?:\s+of)?"
    rf"|purchases? (?:of )?at least)\s+{DOLLARS}|{DOLLARS}\s+(?:minimum\b|or more\b|or greater\b|\+(?=\W|$))", re.I
)
AMOUNT = r"(\$\s*[\d,]+(?:\.\d+)?|\d+(?:\.\d+)?%)"
REWARD = re.compile(rf"^(?:earn|get)\s+(?:up to\s+)?{AMOUNT}\s+(?:cash\s*)?back\b", re.I)
BONUS = re.compile(rf"^{AMOUNT}\s+(?:cash\s*)?back\b", re.I)
CONDITION = re.compile(
    r"\b(?:offer|purchase|payments?|cash\s*back|statement credits?|subscri\w+|"
    r"gift[ -]cards?|customers?|qualif\w+|exclu\w+|restric\w+|limit\w+|eligib\w+|valid|"
    r"only|must|required|requires?|at least|at most|maximum|minimum)\b", re.I)
CASH_MAX = re.compile(rf"{DOLLARS}\s+cash\s*back\s+(?:maximum|max|total)\b|"
                      rf"\bcash\s*back (?:maximum|max)(?: of|:)?\s+{DOLLARS}", re.I)
CASH_TOTAL = re.compile(rf"{DOLLARS}\s+(?:cash\s*back\s+total|total\s+cash\s*back)\b|\b(?:cash\s*back total:?|total of)\s+{DOLLARS}", re.I)
CREDIT = re.compile(rf"{DOLLARS}\s+(?:per (?:statement )?credit|as a statement credit)\b|"
                    rf"\bstatement credits? (?:of|up to)\s+{DOLLARS}", re.I)
SIMPLE_CAP = re.compile(rf"(?:cash\s*back (?:maximum|max)(?: of|:)?\s+{DOLLARS}|"
                        rf"{DOLLARS}\s+cash\s*back\s+(?:maximum|max|total))\.?", re.I)
CHANNEL = re.compile(
    r"\b(?:offer\s+)?(?:only\s+)?valid\s+(?:only\s+)?(?:on\s+purchases?\s+made\s+)?"
    r"(in[ -]store|online|in[ -]app|at the pump)\b", re.I
)
CHANNEL_RESTRICTION = re.compile(r"\bon\s+(in[ -]store|online|in[ -]app)\s+purchases?\s+only\b", re.I)
SECOND_CHANNEL = re.compile(r"\b(?:and(?:/or)?|or)\s+(online|in[ -]store|in[ -]app)\b", re.I)
CHANNELS = {"in store": "in_store", "online": "online", "at the pump": "pay_at_pump", "in app": "in_app"}
COMBINED = {frozenset(("in_store", "online")): "in_store_and_online",
            frozenset(("in_store", "in_app")): "in_store_and_app",
            frozenset(("online", "in_app")): "online_and_app"}
PART = re.compile(r"\n+|(?<=[.!?])\s+(?=[A-Z0-9$“]|[a-z]+[A-Z])|(?<=[.!?])(?=Offer\b|Please note\b)")
URL = re.compile(r"(?i)(?:[a-z][a-z0-9+.-]*://|//)[^\s<>\"')\]]+|"
                 r"\b(?:[a-z0-9-]+\.)+[a-z]{2,}[/#?][^\s<>\"')\]]*")
HOST = re.compile(r"(?i)\b(?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|us|co|io|ai|tv|now|biz|app|shop|example|test)\b")
PRIVATE = re.compile(
    r"\b(?:bearer\s+[\w.~+/=-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+|"
    r"(?:[a-z0-9_-]*(?:token|secret|session|auth)[a-z0-9_-]*)\s*[:=]\s*[^\s,;]+|"
    r"(?:account|card|member(?:ship)?|customer)[ _-]*(?:number|id)\s*[:=#-]\s*[\w*-]+|"
    r"(?:account|card|member|customer)[ _-]*(?:number|ending(?:\s+in)?|id|last[ _-]?4)\s*[:=#-]?\s*[\w*-]*\d[\w*-]*|"
    r"(?:account|card|member|customer)\s*(?:#|:)[ \t]*[\w*-]*\d[\w*-]*|"
    r"(?:\d[ -]?){13,19}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,})", re.I
)
ACCOUNT_VALUE = re.compile(
    r"\b(?:(?:account|card|member(?:ship)?|customer)[ _-]*(?:number|id)|"
    r"(?:access|auth(?:entication)?|session) token)\s*(?:[:=#-]|\bis\b)\s*([\w.*+/=-]+)", re.I)
CODE_VALUE = re.compile(
    r"\b(?:(?:coupon|promo(?:tional)?|discount|redemption)\s+)?code"
    r"(?:\s+(?:required|is))?\s*(?:[:=]\s*|(?<=\bis)\s+)[\"'“‘]?([\w-]+)"
    r"|\b(?:your )?(?:promo(?:tional)? )?coupon\s*[:=]\s*[\"'“‘]?([\w-]+)", re.I
)
PRIVATE_CONTINUATION = re.compile(
    r"\b(?:(?:your )?(?:coupon|promo(?:tional)?|discount|redemption) code|"
    r"(?:your )?(?:(?:membership|account) id|(?:access|session|authentication) token))\s+"
    r"(?:is\s+)?(?:shown|listed|displayed|provided)\s+below[ \t]*[.:]?[ \t]*\n+\s*([^\n]+)", re.I)
CODE_INSTRUCTION_VALUE = re.compile(
    r"\b(?:use|apply|enter|redeem)\s+(?:the\s+)?(?:[\w-]+\s+){0,2}"
    r"(?:code|coupon)\s+[\"'“‘]?([\w-]+)", re.I)
CODE_INSTRUCTION = re.compile(r"(?<![\w-])(?:use|apply|enter|redeem)\s+\w+", re.I)
CONTROLS = re.compile(r"[\x00-\x08\x0b-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2060-\u206f]")
MARKUP = re.compile(r"<(?:/?[a-z][\w:-]*\b[^<>]*|!--.*?)>", re.I)
ANGLE = re.compile(r"[<>]")

INCOMPLETE_DETAIL = re.compile(
    r"\b(?:additional|other|further)\s+(?:eligibility\s+)?(?:terms|conditions|restrictions|exclusions)\b|"
    r"\b(?:see|refer to|view|read|check)\s+(?:the\s+)?(?:full\s+)?(?:offer\s+)?terms\b", re.I)


def normalized(text):
    return CONTROLS.sub("", unicodedata.normalize("NFKC", text or ""))


def money_groups(pattern, text):
    return {Decimal((a or b).replace(",", "")) for a, b in pattern.findall(text)}


def explicit_days(pattern, text, read_date):
    result = set()
    read = date.fromisoformat(read_date)
    for value in pattern.findall(text or ""):
        try:
            if "/" in value:
                month, day, *year = map(int, value.split("/"))
            elif "-" not in value:
                name, day, *year = value.replace(",", "").split()
                month, day, year = MONTHS[name.lower().rstrip(".")], int(day), list(map(int, year))
            else:
                result.add(date.fromisoformat(value).isoformat())
                continue
            resolved_year = (year[0] + (2000 if year[0] < 100 else 0)) if year else read.year
            parsed = date(resolved_year, month, day)
            if not year and parsed < read:
                parsed = parsed.replace(year=resolved_year + 1)
        except ValueError:
            continue
        result.add(parsed.isoformat())
    return result


def private_codes(raw):
    visible = normalized(Description(raw or "").text)
    continuations = PRIVATE_CONTINUATION.findall(visible)
    visible = PRIVATE_CONTINUATION.sub("", visible)
    values = [a or b for a, b in CODE_VALUE.findall(visible)]
    values.extend(CODE_INSTRUCTION_VALUE.findall(visible))
    values.extend(ACCOUNT_VALUE.findall(visible))
    values.extend(x.strip(" \t.'\"").casefold() for x in continuations if re.fullmatch(r"[\w.-]+[.]?", x.strip()))
    return {value.casefold() for value in values
            if value.casefold() not in {"at", "before", "for", "in", "on", "online", "only", "when", "shown", "listed"}}


def public_parts(raw, codes):
    visible = CONTROLS.sub("", unicodedata.normalize("NFC", Description(raw or "").text))
    if MARKUP.search(visible):
        visible = Description(visible).text
    visible = PRIVATE_CONTINUATION.sub("\nSee the issuer offer for private redemption details.\n", visible)
    for part in PART.split(visible):
        # A hostname can itself be personalized. Keep only the fact that the issuer specified a destination.
        for pattern in (URL, HOST):
            part = pattern.sub(lambda match: "the issuer-specified site" + ("." if match[0].endswith(".") else ""), part)
        part = " ".join(part.split())
        if not part:
            continue
        checked = normalized(part)
        if PRIVATE.search(checked) or ACCOUNT_VALUE.search(checked):
            continue
        part = CODE_VALUE.sub("promotional coupon required", part)
        part = CODE_PHRASE.sub("the promotional coupon", part)
        checked = normalized(part)
        if (CODE_WORD.search(checked) or has_code(checked, codes)
                or (CODE_INSTRUCTION.search(checked) and ambiguous_instruction(checked))):
            yield "Promotional coupon terms apply. See the issuer offer."
        elif not (PRIVATE.search(checked) or ACCOUNT_VALUE.search(checked) or URL.search(checked) or HOST.search(checked)):
            yield part


def unsafe_field(value, codes, *, description=False):
    text = normalized(value)
    hosts = HOST.findall(text)
    return bool(private_codes(value) or PRIVATE.search(text) or ACCOUNT_VALUE.search(text) or URL.search(text)
                or any(description or host.count(".") > 1 for host in hosts)
                or CODE_PHRASE.search(text) or has_code(text, codes) or (MARKUP if description else ANGLE).search(text))


def unsafe_record(offer, codes):
    for field, value in offer.items():
        values = value if isinstance(value, list) else [value]
        if any(isinstance(text, str) and unsafe_field(text, codes, description=field in ("fine_print", "other_details"))
               for text in values):
            return True
    return False


def source_channel(parts):
    evidence = set()
    for part in parts:
        if first := CHANNEL.search(part):
            routes = {CHANNELS[first[1].lower().replace("-", " ")]}
            for second in SECOND_CHANNEL.findall(part[first.end():]):
                routes.add(CHANNELS[second.lower().replace("-", " ")])
            evidence.add(COMBINED.get(frozenset(routes), "conflicting") if len(routes) > 1 else next(iter(routes)))
        for route in CHANNEL_RESTRICTION.findall(part):
            evidence.add(CHANNELS[route.lower().replace("-", " ")])
    return evidence


def expanded_details(parts, read_date):
    """Recognize the issuer's detail layout for reporting, without assuming it omits nothing."""
    return (not any(INCOMPLETE_DETAIL.search(part) for part in parts)
            and any(EXPIRY_LINE.fullmatch(part) and explicit_days(EXPIRY, part, read_date) for part in parts)
            and any(part.startswith("Offer redemption awarded as statement credit") for part in parts))


def cashback_limits(text):
    """Return stated reward ceilings and explicit aggregate ceilings, excluding purchase ceilings."""
    totals = money_groups(CASH_TOTAL, text) if re.search(r"\bcash\s*back\b|\bstatement credits?\b", text, re.I) else set()
    limits = money_groups(CASH_MAX, text) | money_groups(CREDIT, text) | totals
    if re.search(r"\bcash\s*back may be earned\b", text, re.I):
        limits |= {Decimal(x.replace(",", "")) for x in re.findall(rf"{DOLLARS}\s+maximum\b", text, re.I)}
    return limits, totals


def conflicting_cashback_limits(limits, totals, structured):
    if len(totals) == 1:
        total = next(iter(totals))
        return bool((structured and structured != total) or any(amount > total for amount in limits))
    return len(limits) > 1 or bool(structured and limits and limits != {structured})


def reward_amount(match):
    if match:
        return ("$" if match[1].startswith("$") else "%", decimal(match[1].strip("$% ")))
    return None


def reward_scope(part, merchant):
    """Remove only the reward figures and standard single-purchase wording."""
    tail = part[REWARD.match(part).end():]
    tail = re.sub(rf",?\s+when you spend {DOLLARS}(?: or more| or greater)?(?=[,.]|$)", "", tail, flags=re.I)
    tail = re.sub(rf",?\s+with (?:a|an) {DOLLARS}\s+cash\s*back\s+(?:maximum|max|total)\b", "", tail, flags=re.I)
    generic = rf"^\s+on (?:all of )?your (?:{re.escape(merchant)}\s+)?purchases?\b"
    tail = re.sub(generic, "", tail, flags=re.I)
    return " ".join(tail.lower().strip(" ,.").split())


def minimum_values(parts):
    return set().union(*(money_groups(MINIMUM, part) for part in parts
                         if not re.search(r"\bfree shipping\b", part, re.I)))


def structured_reward_issues(headline, kind, amount):
    if not (kind or amount):
        return []
    expected_kind = {"DOLLAR": "$", "PERCENTAGE": "%"}.get(kind)
    expected_amount = decimal(amount) if amount else None
    if (not headline or (kind and expected_kind != headline[0])
            or (amount and expected_amount != headline[1])):
        return ["structured reward and displayed reward disagree"]
    return []


def prior_parts(previous, current, saved, fields, headline, current_rewards, cap, current_caps, read_date, notes, issues):
    result = []
    current_text = " ".join(current)
    old_expiries = explicit_days(EXPIRY, " ".join(previous), read_date)
    known_end = fields.get("expires") or saved.get("expires")
    current_payment_days = explicit_days(PAYMENT, current_text, read_date)
    explicit_channels = source_channel(current)
    merchant = saved["merchant"]
    current_scopes = {reward_scope(part, merchant) for part in current if REWARD.match(part)}
    minimum = decimal(fields.get("minimum_spend"))

    for part in previous:
        if part in current or not CONDITION.search(part):
            continue
        if known_end and TRAILING_EXPIRY.search(part):
            part = TRAILING_EXPIRY.sub("", part).strip()
            if not part or not CONDITION.search(part):
                continue
        elif EXPIRY_LINE.fullmatch(part) and known_end:
            continue
        prior_expiry = explicit_days(EXPIRY, part, read_date)
        if prior_expiry and known_end and prior_expiry != {known_end}:
            issues.append("prior dated eligibility cannot be carried forward")
            continue
        old_days = explicit_days(PAYMENT, part, read_date)
        if old_days and old_days != current_payment_days:
            standard = STANDARD_PAYMENT.fullmatch(part)
            if standard and old_days <= old_expiries and known_end:
                if current_payment_days == {known_end} and any(
                        (term := STANDARD_PAYMENT.fullmatch(p)) and term[1].lower() == standard[1].lower()
                        for p in current):
                    continue
                part = f"Payment must be made {standard[1].lower()} the offer deadline."
            elif old_days == {known_end} and not current_payment_days:
                pass
            elif any(same_payment_condition(part, p, read_date) for p in current):
                continue
            else:
                issues.append("prior dated payment condition unresolved")
                continue

        old_channel = source_channel([part])
        if old_channel and explicit_channels and old_channel != explicit_channels:
            if not re.fullmatch(r"offer (?:only )?valid (?:online|in-store|in-app)(?: only| (?:or|and) online)?\.?", part, re.I):
                issues.append("prior channel qualification unresolved")
            continue

        old_caps = cashback_limits(part)[0]
        conflicting_cap = bool(old_caps and current_caps and not old_caps <= current_caps)
        old_min = minimum_values([part])
        conflicting_minimum = bool(old_min and minimum is not None and minimum not in old_min)
        if match := REWARD.match(part):
            scope = reward_scope(part, merchant)
            current_writes_reward = bool(current_rewards)
            if current_writes_reward and scope == "including taxes and after any discounts" and current_scopes == {""}:
                basis = "Qualifying purchases include taxes and are calculated after any discounts."
                if basis not in current and basis not in result:
                    result.append(basis)
                scope = ""
            if current_writes_reward and (not scope or scope in current_scopes):
                if old_caps and not current_caps and not cap and old_caps != {headline[1] if headline and headline[0] == "$" else None}:
                    issues.append("prior cashback maximum unresolved")
                continue
            if ((headline and reward_amount(match) != headline) or conflicting_cap or conflicting_minimum
                    or (current_writes_reward and current_scopes - {""})):
                issues.append("prior reward eligibility unresolved against the current reward")
                continue
        if conflicting_cap:
            if SIMPLE_CAP.fullmatch(part) and current_caps:
                continue
            if any(same_cashback_condition(part, p) for p in current):
                continue
            issues.append("prior cashback limit or repeatability unresolved")
            continue
        if conflicting_minimum:
            if any(same_minimum_condition(part, p) for p in current):
                continue
            issues.append("prior minimum condition unresolved")
            continue
        if part not in result:
            result.append(part)

    if result:
        notes.append("retained compatible prior eligibility")
    return result


def same_payment_condition(old, current, read_date):
    if not (explicit_days(PAYMENT, old, read_date) and explicit_days(PAYMENT, current, read_date)):
        return False
    return re.sub(DAY, "<date>", old, flags=re.I).lower() == re.sub(DAY, "<date>", current, flags=re.I).lower()


def same_cashback_condition(old, current):
    return bool(cashback_limits(current)[0] and money_template(old) == money_template(current))


def same_minimum_condition(old, current):
    return bool(minimum_values([current]) and money_template(old) == money_template(current))


def money_template(part):
    return re.sub(DOLLARS, "<amount>", part.lower())


def reconcile(raw, saved, fields, bonus, kind, amount, raw_cap, read_date, codes):
    """Reconcile known facts. Coverage never authorizes dropping an unaccounted-for restriction."""
    current = list(public_parts(raw, codes))
    previous = list(public_parts((saved or {}).get("fine_print"), codes))
    expanded = expanded_details(current, read_date)
    source = "expanded" if expanded else "abbreviated" if current else "blank"
    headline = reward_amount(BONUS.match(bonus or (saved or {}).get("bonus", "")))
    issues = structured_reward_issues(headline, kind, amount)
    notes = []

    current_rewards = {reward_amount(match) for p in current if (match := REWARD.match(p))}
    if headline and current_rewards and current_rewards != {headline}:
        issues.append("current reward headline and description disagree")
    current_min = minimum_values(current)
    if len(current_min) > 1 or (current_min and fields.get("minimum_spend") is not None
                              and decimal(fields["minimum_spend"]) not in current_min):
        issues.append("current cashback minimum evidence disagrees")
    elif current_min and fields.get("minimum_spend") is None:
        fields["minimum_spend"] = str(next(iter(current_min)))

    explicit_channels = source_channel(current)
    if "conflicting" in explicit_channels or len(explicit_channels) > 1 or (explicit_channels and fields.get("channel")
                                      and fields["channel"] not in explicit_channels):
        issues.append("current channel evidence disagrees")
    elif explicit_channels:
        fields["channel"] = next(iter(explicit_channels))

    cap = decimal(raw_cap)
    if raw_cap and (cap is None or not cap.is_finite() or cap < 0):
        issues.append("structured cashback cap is invalid")
        cap = None
    current_caps, totals = cashback_limits(" ".join(current))
    if conflicting_cashback_limits(current_caps, totals, cap):
        issues.append("structured cashback cap and current description disagree" if cap
                      else "current cashback limit evidence disagrees")
    elif cap and not current_caps and not (current_rewards == {("$", cap)} and not any(
            re.search(r"\b(?:first (?:two|three)|multiple|statement credits)\b", part, re.I) for part in current)):
        current.append(f"Cash back maximum: ${cap:f}.")
        current_caps = {cap}

    if previous:
        old_min = minimum_values(previous)
        if not old_min and saved.get("minimum_spend") is not None:
            if value := decimal(saved["minimum_spend"]):
                old_min.add(value)
        if fields.get("minimum_spend") is None and old_min:
            if len(old_min) == 1:
                fields["minimum_spend"] = str(next(iter(old_min)))
                notes.append("retained prior minimum without explicit replacement")
            else:
                issues.append("prior cashback minimum unresolved")
        current.extend(prior_parts(previous, current, saved, fields, headline, current_rewards, cap, current_caps,
                                   read_date, notes, issues))

    effective_channel = fields.get("channel") or (saved or {}).get("channel")
    if effective_channel not in (None, "none_shown") and source_channel(current) - {effective_channel}:
        issues.append("projected channel and eligibility text disagree")
    final_min = minimum_values(current)
    if final_min and final_min != {decimal(fields.get("minimum_spend"))}:
        issues.append("projected minimum and eligibility text disagree")
    final_caps, final_totals = cashback_limits(" ".join(current))
    if conflicting_cashback_limits(final_caps, final_totals, cap):
        issues.append("projected cashback cap and eligibility text disagree")
    return " ".join(current) or None, source, list(dict.fromkeys(issues)), notes


def decimal(value):
    try:
        return Decimal(str(value).replace(",", ""))
    except ArithmeticError:
        return None

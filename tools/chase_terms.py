"""Reconcile the terms of a Chase live offer without publishing its private capture."""
import re
import unicodedata
from datetime import date
from decimal import Decimal
from html.parser import HTMLParser
from urllib.parse import urlsplit

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


DAY = r"\d{1,2}/\d{1,2}(?:/\d{4}|/\d{2})?|\d{4}-\d{2}-\d{2}"
EXPIRY = re.compile(
    rf"\b(?:(?:offer\s+)?expir(?:es?|ation(?:\s+date)?\s+is)(?:\s+on)?|offer valid (?:through|until))"
    rf"\s+({DAY})(?![\d/])", re.I)
EXPIRY_LINE = re.compile(rf"(?:offer\s+)?expires?(?:\s+on)?\s+(?:{DAY})\.?", re.I)
PAYMENT = re.compile(
    rf"\b(?:payment(?:s)?(?:\s+\w+){{0,5}}\s+(?:by|before|on or before)|"
    rf"(?:must|to)\s+make\s+(?:the\s+)?first\s+(?:recurring\s+)?payment\s+(?:by|before))\s+({DAY})(?![\d/])", re.I
)
STANDARD_PAYMENT = re.compile(rf"Payments? must be made (?:on or )?before (?:{DAY})\.?", re.I)
REQUIRED_PAYMENT = re.compile(
    rf"\b(?:payment must be made|must make (?:the )?first (?:recurring )?payment)"
    rf"\s+(?:by|before|on or before)\s+({DAY})(?![\d/])", re.I)
DOLLARS = r"\$\s*(\d[\d,]*(?:\.\d+)?)"
MINIMUM = re.compile(
    rf"\b(?:spend(?:ing)?(?:\s+(?:a\s+)?minimum(?:\s+of)?|\s+at\s+least)?|minimum spend(?:\s+of)?)"
    rf"\s+{DOLLARS}|{DOLLARS}\s+(?:minimum\b|or more\b|or greater\b|\+(?=\W|$))", re.I
)
AMOUNT = r"(\$\s*[\d,]+(?:\.\d+)?|\d+(?:\.\d+)?%)"
REWARD = re.compile(rf"^(?:earn|get)\s+(?:up to\s+)?{AMOUNT}\s+(?:cash\s*)?back\b", re.I)
BONUS = re.compile(rf"^{AMOUNT}\s+(?:cash\s*)?back\b", re.I)
HEADLINE_SCOPE = re.compile(
    r"\b(?:first(?:\s+(?:two|three|\d+))?\s+(?:recurring\s+|subscription\s+)?payments?"
    r"|new customers?|first[ -]time customers?|subscri\w+|one[ -]time|multiple purchases)\b", re.I)
CONDITION = re.compile(
    r"\b(?:offer|purchase|payments?|cash\s*back|statement credits?|subscri\w+|"
    r"gift[ -]cards?|customers?|qualif\w+|exclu\w+|restric\w+|limit\w+|eligib\w+|valid)\b", re.I)
CAP = re.compile(rf"{DOLLARS}\s+(?:cash\s*back\s+)?(?:maximum|max|total)\b|"
                 rf"\b(?:maximum(?:\s+of)?|up to|limit of|total of|cash\s*back maximum:)\s+{DOLLARS}", re.I)
CHANNEL = re.compile(
    r"\b(?:offer\s+)?(?:only\s+)?valid\s+(?:only\s+)?(?:on\s+purchases?\s+made\s+)?"
    r"(in[ -]store|online|in[ -]app|at the pump)\b", re.I
)
SECOND_CHANNEL = re.compile(r"\b(?:and(?:/or)?|or)\s+(online|in[ -]store|in[ -]app)\b", re.I)
CHANNELS = {"in store": "in_store", "online": "online", "at the pump": "pay_at_pump", "in app": "in_app"}
COMBINED = {frozenset(("in_store", "online")): "in_store_and_online",
            frozenset(("in_store", "in_app")): "in_store_and_app",
            frozenset(("online", "in_app")): "online_and_app"}
PART = re.compile(r"\n+|(?<=[.!?])\s+(?=[A-Z0-9$“])|(?<=[.!?])(?=Offer\b|Please note\b)")
URL = re.compile(r"(?i)(?:[a-z][a-z0-9+.-]*://|//)[^\s<>\"')\]]+|"
                 r"\b(?:[a-z0-9-]+\.)+[a-z]{2,}[/#?][^\s<>\"')\]]*")
PRIVATE = re.compile(
    r"\b(?:bearer\s+[\w.~+/=-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+|"
    r"(?:[a-z0-9_-]*(?:token|secret|session|auth)[a-z0-9_-]*)\s*[:=]\s*[^\s,;]+|"
    r"(?:account|card|member|customer)[ _-]*(?:number|id)\s*[:=#-]\s*[\w*-]+|"
    r"(?:account|card|member|customer)[ _-]*(?:number|ending(?:\s+in)?|id|last[ _-]?4)\s*[:=#-]?\s*[\w*-]*\d[\w*-]*|"
    r"(?:account|card|member|customer)\s*(?:#|:)[ \t]*[\w*-]*\d[\w*-]*|"
    r"(?:\d[ -]?){13,19}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,})", re.I
)
CODE_VALUE = re.compile(
    r"\b(?:(?:coupon|promo(?:tional)?|discount|redemption)\s+)?code"
    r"(?:\s+(?:required|is))?\s*(?:[:=]\s*|(?<=\bis)\s+)[\"'“‘]?([\w-]+)", re.I
)
CODE_INSTRUCTION_VALUE = re.compile(
    r"\b(?:use|apply|enter|redeem)\s+(?:the\s+)?(?:[\w-]+\s+){0,2}"
    r"(?:code|coupon)\s+[\"'“‘]?([\w-]+)", re.I)
CODE_INSTRUCTION = re.compile(r"(?<![\w-])(?:use|apply|enter|redeem)\s+\w+", re.I)
CONTROLS = re.compile(r"[\x00-\x08\x0b-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2060-\u206f]")
MARKUP = re.compile(r"<(?:/?[a-z][\w:-]*\b[^<>]*|!--.*?)>", re.I)


def normalized(text):
    return CONTROLS.sub("", unicodedata.normalize("NFKC", text or ""))


def money_groups(pattern, text):
    return {Decimal((a or b).replace(",", "")) for a, b in pattern.findall(text)}


def explicit_days(pattern, text, read_date):
    result = set()
    for value in pattern.findall(text or ""):
        try:
            if "-" in value:
                day = date.fromisoformat(value)
            else:
                month, day, *year = map(int, value.split("/"))
                read = date.fromisoformat(read_date)
                year = (year[0] + (2000 if year[0] < 100 else 0)) if year else read.year
                day = date(year, month, day)
                if value.count("/") == 1 and day < read:
                    day = day.replace(year=year + 1)
        except ValueError:
            continue
        result.add(day.isoformat())
    return result


def public_url(match):
    """Keep a merchant hostname when the text included a shopping link."""
    value = match[0]
    suffix = "." if value.endswith(".") else ""
    try:
        url = value.rstrip(".")
        if url.startswith("//"):
            url = "https:" + url
        elif "://" not in url:
            url = "https://" + url
        parsed = urlsplit(url)
        host = parsed.hostname or ""
    except ValueError:
        return "the issuer link" + suffix
    if (parsed.scheme not in {"http", "https"} or parsed.username or parsed.password
            or re.search(r"(?:^|\.)(?:chase\.com|chaseoffers\.com|acct[-\d]|account[-\d]|user[-\d])", host, re.I)
            or not re.fullmatch(r"(?:[a-z0-9-]{1,24}\.)+[a-z]{2,24}", host, re.I)):
        return "the issuer link" + suffix
    return host + suffix


def private_codes(raw):
    visible = normalized(Description(raw or "").text)
    labels = CODE_VALUE.findall(visible)
    instructions = CODE_INSTRUCTION_VALUE.findall(visible)
    return {value.casefold() for value in labels + instructions
            if value.casefold() not in {"at", "before", "for", "in", "on", "online", "only", "when"}}


def public_parts(raw, codes):
    visible = CONTROLS.sub("", unicodedata.normalize("NFC", Description(raw or "").text))
    if MARKUP.search(visible):
        visible = Description(visible).text
    visible = URL.sub(public_url, visible)
    for part in PART.split(visible):
        part = " ".join(part.split())
        if not part:
            continue
        part = PRIVATE.sub("[withheld]", part)
        part = CODE_VALUE.sub("promotional coupon required", part)
        part = CODE_PHRASE.sub("the promotional coupon", part)
        checked = normalized(part)
        if (CODE_WORD.search(checked) or has_code(checked, codes)
                or (CODE_INSTRUCTION.search(checked) and ambiguous_instruction(checked))):
            # Preserve the presence of a coupon condition when its private wording cannot be published.
            yield "Promotional coupon terms apply. See the issuer offer."
        elif PRIVATE.search(checked) or URL.search(checked):
            yield "See the issuer offer for account-specific terms."
        else:
            yield part


def unsafe_field(value, codes):
    text = normalized(value)
    return bool(private_codes(value) or PRIVATE.search(text) or URL.search(text)
                or CODE_PHRASE.search(text) or has_code(text, codes) or re.search(r"[<>]", text))


def source_channel(parts):
    evidence = set()
    for part in parts:
        if first := CHANNEL.search(part):
            routes = {CHANNELS[first[1].lower().replace("-", " ")]}
            for second in SECOND_CHANNEL.findall(part[first.end():]):
                routes.add(CHANNELS[second.lower().replace("-", " ")])
            evidence.add(COMBINED.get(frozenset(routes), "conflicting") if len(routes) > 1 else next(iter(routes)))
    return evidence


def comprehensive(parts, read_date):
    text = " ".join(parts).lower()
    # Issuer detail boilerplate, a dated term, and independent restrictions distinguish
    # the expanded description from short tiles that may say only "valid online".
    qualifiers = [r"valid .*?one time only", r"directly with", r"third-party",
                  r"gift.cards?", r"qualifying transaction", r"first .*?payments? only"]
    return bool(explicit_days(EXPIRY, text, read_date) and
                sum(bool(re.search(phrase, text)) for phrase in qualifiers) >= 3)


def reward_amount(match):
    if match:
        return ("$" if match[1].startswith("$") else "%", decimal(match[1].strip("$% ")))
    return None


def reconcile(raw, saved, fields, bonus, raw_cap, read_date, codes):
    """Return public text, source coverage, and material conflicts or qualifications."""
    current = list(public_parts(raw, codes))
    previous = list(public_parts((saved or {}).get("fine_print"), codes))
    full = comprehensive(current, read_date)
    issues, notes = [], []
    source = "comprehensive" if full else "abbreviated" if current else "blank"
    old_text, current_text = " ".join(previous), " ".join(current)
    headline = reward_amount(BONUS.match(bonus or (saved or {}).get("bonus", "")))
    current_rewards = {reward_amount(REWARD.match(p)) for p in current if REWARD.match(p)}
    if headline and current_rewards and current_rewards != {headline}:
        issues.append("current reward headline and description disagree")
    current_min = set().union(*(money_groups(MINIMUM, p) for p in current
                                if not re.search(r"\bfree shipping\b", p, re.I)))
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
    if not full and not explicit_channels and saved and fields.get("channel") and fields["channel"] != saved["channel"]:
        old_channels = source_channel(previous)
        if old_channels and fields["channel"] not in old_channels:
            issues.append("abbreviated copy cannot resolve the changed channel restriction")

    cap = decimal(raw_cap)
    current_caps = money_groups(CAP, current_text)
    if cap and not current_caps and not re.search(r"\blimit of\s+\d+\s+statement credits\b", current_text, re.I):
        # A flat, one-payment reward already states its maximum.
        if not re.search(rf"(?i)\b(?:earn|get)\s+\$\s*{re.escape(raw_cap)}(?:\.0+)?\s+(?:cash\s*)?back\b", current_text):
            current.append(f"Cash back maximum: ${cap:f}.")
    elif cap and current_caps and cap not in current_caps:
        issues.append("structured cashback cap and current description disagree")

    if not full and previous:
        old_min = set().union(*(money_groups(MINIMUM, p) for p in previous
                                if not re.search(r"\bfree shipping\b", p, re.I)))
        if not old_min and saved.get("minimum_spend") is not None:
            if value := decimal(saved["minimum_spend"]):
                old_min.add(value)
        if fields.get("minimum_spend") is None and old_min:
            if len(old_min) == 1:
                fields["minimum_spend"] = str(next(iter(old_min)))
                notes.append("retained prior minimum because current copy is abbreviated")
            else:
                issues.append("abbreviated copy leaves the prior cashback minimum unresolved")
        old_expiries = explicit_days(EXPIRY, old_text, read_date)
        known_end = fields.get("expires")
        current_payment_days = explicit_days(PAYMENT, current_text, read_date)
        scopes = {m.lower() for m in HEADLINE_SCOPE.findall(current_text)}
        for part in previous:
            if CONDITION.search(part):
                if EXPIRY_LINE.fullmatch(part) and known_end:
                    continue
                part_expiries = explicit_days(EXPIRY, part, read_date)
                if part_expiries and known_end and part_expiries != {known_end}:
                    issues.append("abbreviated copy leaves a prior dated eligibility condition unresolved")
                    continue
                old_days = explicit_days(PAYMENT, part, read_date)
                if old_days and old_days != current_payment_days:
                    if STANDARD_PAYMENT.fullmatch(part) and old_days <= old_expiries and known_end:
                        part = "Payment must be made by the offer deadline."
                    elif old_days == {known_end} and not current_payment_days:
                        pass
                    elif current_payment_days and REQUIRED_PAYMENT.search(part) and REQUIRED_PAYMENT.search(current_text):
                        continue
                    else:
                        issues.append("abbreviated copy leaves a prior dated payment condition unresolved")
                        continue
                old_channel = source_channel([part])
                if old_channel and explicit_channels and old_channel != explicit_channels:
                    if not re.fullmatch(r"offer (?:only )?valid (?:online|in-store|in-app)(?: only| (?:or|and) online)?\.?", part, re.I):
                        issues.append("abbreviated copy leaves a prior channel qualification unresolved")
                    continue
                if REWARD.search(part):
                    old_reward = reward_amount(REWARD.match(part))
                    if not current_rewards and headline and old_reward != headline:
                        issues.append("abbreviated copy does not replace the prior reward eligibility")
                        continue
                    if current_rewards:
                        other = {m.lower() for p in previous if p != part and not REWARD.search(p)
                                 for m in HEADLINE_SCOPE.findall(p)}
                        if {m.lower() for m in HEADLINE_SCOPE.findall(part)} - scopes - other:
                            issues.append("abbreviated copy leaves prior reward eligibility unresolved")
                        if money_groups(CAP, part) and not current_caps and not cap:
                            issues.append("abbreviated copy leaves a prior cashback maximum unresolved")
                        continue
                if money_groups(CAP, part) and current_caps and not money_groups(CAP, part) <= current_caps:
                    issues.append("abbreviated copy leaves a prior cashback limit unresolved")
                    continue
                if money_groups(MINIMUM, part) and fields.get("minimum_spend") is not None and (
                        decimal(fields["minimum_spend"]) not in money_groups(MINIMUM, part)):
                    issues.append("abbreviated copy leaves a prior minimum condition unresolved")
                    continue
                if part not in current:
                    current.append(part)
        if current and previous:
            notes.append("retained compatible prior eligibility from abbreviated detail evidence")
    effective_channel = fields.get("channel") or (saved or {}).get("channel")
    if effective_channel not in (None, "none_shown"):
        if source_channel(current) - {effective_channel}:
            issues.append("projected channel and eligibility text disagree")
    return " ".join(current) or None, source, list(dict.fromkeys(issues)), notes


def decimal(value):
    try:
        return Decimal(str(value).replace(",", ""))
    except ArithmeticError:
        return None

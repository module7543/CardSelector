# Offer record (locked)

Data file: `site/data/offers.json` = `{ "categories": [...], "batches": [...], "offers": [...] }`. This file is public; never put account numbers or last-4 digits in it.

## Offer

| Field | Type | Notes |
|---|---|---|
| `id` | string | `<card-slug>/<merchant-slug>`; the match key. A second tier from the same merchant on the same card gets `-2`, `-3`... |
| `card` | string | Nickname only, e.g. `Chase Freedom Flex`. |
| `merchant` | string | Verbatim from the screenshot. |
| `aliases` | string[] (optional) | Other names the search also matches: the name an offer had before a rename, or an alternate spelling. Omit the field when there are none (never an empty list). The page searches `merchant` and `aliases` only, never `other_details`, with the same case / accent / punctuation-insensitive partial match, and shows the aliases as "Also known as" in the details. An alias must not repeat the merchant name (ignoring case and punctuation) or another alias. Whenever an offer's `merchant` is renamed, put the old name here, not in `other_details`. |
| `category` | string | Exactly one entry of the top-level `categories` list (see Categories below). Inferred from the merchant name, not on the screenshot. |
| `bonus` | string | Verbatim. A bonus starting with "Save" ("Save 25%", "Save $5", "Save Now") is a discount, not a reward: the phone page ranks it below every cash-back/earn offer and leaves it out of the percent / dollar / rate sorts. |
| `expires` | `YYYY-MM-DD` or null | If the year is missing, use the next upcoming occurrence of that date. When a source gives an exact timestamp (U.S. Bank live-page file), use its Eastern-time date. |
| `expires_text` | string or null | Expiration wording exactly as shown. |
| `activation` | `needs_activation` \| `already_activated` \| `auto_enrolled` \| `via_shop_link` \| `none_shown` | `auto_enrolled`: the card shows the offer as linked automatically, nothing to do (badge "Auto-enrolled"). `via_shop_link`: the reward is earned only by buying through the card's "Shop now" link (badge "Via shop link"). |
| `channel` | `in_store` \| `online` \| `pay_at_pump` \| `in_store_and_online` \| `in_store_and_app` \| `none_shown` | Where the offer applies, as shown on the tile. `none_shown` when the screen says nothing (Chase offers whose file channel is `NONE`). The phone page shows a badge: In-store / Online / Pay at pump / In-store & online / In-store & in-app; `none_shown` has no badge. The page's "In store or online" filter keeps `none_shown` offers under both choices, labeled "channel not shown". |
| `spend_cap` | string or null | Verbatim. A cap on how much spend earns the bonus (the page labels it "Spending cap"), not a cap on the cash back; a maximum cash back amount belongs in `fine_print` / the reward text. |
| `minimum_spend` | string or null | Verbatim. |
| `fine_print` | string or null | Verbatim. |
| `other_details` | string[] | Anything visible that fits no other field. Empty list if none. |
| `last_read` | `YYYY-MM-DD` | Date of the latest batch that confirmed this offer. |
| `first_seen` | `YYYY-MM-DD` | Read date of the batch that first added the offer to the app. Set once, for a new id only; never changed after (refreshes, renames, a return from `missing` and edits all keep it). |
| `status` | `active` \| `missing` \| `expired` \| `used` | |
| `status_since` | `YYYY-MM-DD` | Date the status last changed. |

Fields not shown on the screenshot are `null`; never guess. Flag anything unclear when reading.

## Categories

The fixed list lives in `offers.json` under `categories` (the page builds its buttons from it, `tools/validate.py` checks against it):

Dining · Groceries & Food Delivery · Clothing & Jewelry · Beauty & Personal Care · Health, Fitness & Vision · Home & Garden · Electronics & Software · Travel · Auto & Gas · Streaming & Entertainment · Pets & Baby · Marketplaces & Department Stores · Services & Utilities

- Every offer has exactly one category; there is no "Other". Assign it when the offer is saved.
- Categorize by what the merchant mainly sells. The same merchant has the same category on every card (the validator enforces this); reuse the category already saved for that merchant.
- Merchant is unclear from its name: ask the owner, listing the unsure ones, rather than guessing silently. Only a deliberate change to the list itself needs the owner's approval, and then `categories` and this section change together.
- Placements decided with the owner: grocery stores, wine/alcohol and meal kits are Groceries & Food Delivery; restaurants and catering are Dining; sporting equipment (golf), fitness gear, supplements and eyewear are Health, Fitness & Vision, while athletic apparel and shoes (Lululemon, Brooks, NOBULL) are Clothing & Jewelry; DIRECTV/DISH are Streaming & Entertainment; Sam's Club, Funko, Faire are Marketplaces & Department Stores; phone, internet, legal, printing, pest control, memberships, news and learning subscriptions are Services & Utilities; EV charging is Auto & Gas; eSIMs, ride-share and car rental are Travel.

## Cuisines (Dining only)

File: `site/data/cuisines.json` = `{ "cuisines": [...], "merchants": { "<merchant name>": entry }, "to_classify": [...] }`. Keyed by merchant name, not a field on each offer. One cuisine per merchant.

**Fixed list** (21, in button order; changes need the owner's approval, and then the file's `cuisines` and this section change together):

Persian & Mediterranean · Mexican · Latin American · Italian & Pizza · French & European · Chinese · Japanese & Sushi · Korean · Southeast Asian · Indian & South Asian · Asian Fusion & Poke · American · Breakfast & Brunch · Steak & Seafood · Healthy, Vegan & Salads · Cafés, Coffee & Tea · Bakeries & Desserts · Bars, Pubs, Wine Bars & Breweries · Other Cuisines · Gift Cards & Dining Services · Unclassified

- Persian & Mediterranean covers Persian, Middle Eastern, Armenian, Lebanese, Turkish, Israeli, Greek and generic Mediterranean. Mexican is its own cuisine; Latin American is the rest (Peruvian, Salvadoran, Cuban, Brazilian, Caribbean). French & European includes Spanish tapas, German, Eastern European. American includes New American, Californian, diners, burgers, sandwiches, chicken, BBQ, Southern. Bars, Pubs, Wine Bars & Breweries includes sports, cocktail and dive bars, gastropubs, taprooms, distilleries, lounges, clubs, music venues. Other Cuisines = a known cuisine with no button of its own (Hawaiian, Ethiopian); its `detail` names it. Gift Cards & Dining Services = restaurant gift cards, catering and booking services, event venues.
- **Tie-breaks:** a specific non-American cuisine beats a place type ("Italian wine bar" -> Italian & Pizza). Breakfast & Brunch beats American. A place type (Bars, Cafés, Bakeries) applies only when that is what the place mainly is.
- **Blends** of two specific cuisines: take the cuisine named first, confidence `Unsure`, and list the blends for the owner.
- **Never guess:** a merchant that cannot be placed is `Unclassified`.

**Entry fields:**

| Field | Type | Notes |
|---|---|---|
| `cuisine` | string | One entry of `cuisines`. |
| `confidence` | `Confirmed` \| `Likely` \| `Unsure`, or null | `Confirmed`: the specific place was identified. `Likely`: good but indirect evidence. `Unsure`: a best guess. null only for `Unclassified`. |
| `detail` | string (optional) | The specific cuisine the evidence names ("Persian", "Lebanese", "Mediterranean"). Never inferred from dish names alone. Omit when none. |
| `evidence` | string | One line, what was found (or for `Unclassified`, what was tried). |
| `source` | string or null | Where it was found, as given (shortened links stay shortened; never completed or invented). |
| `checked` | `YYYY-MM-DD` | Date the evidence was checked. |
| `locked` | boolean | `true` = verified by the owner: never re-checked or overwritten. |

- **Matching:** an entry applies to a **Dining** offer whose `merchant` or any alias equals the entry's name, ignoring case, accents and punctuation (the page's search normalisation). Offers in other categories never match ("Ali Baba" the restaurant is not Capital One's "Alibaba"). The same merchant on several cards shares one entry.
- **`to_classify`:** active Dining merchants with no entry, not yet looked up. `Unclassified` entries were looked up and could not be placed. The page shows both under the Unclassified button. `tools/cuisines.py sync` rebuilds `to_classify` from `offers.json` and never edits entries (except moving an entry to a renamed merchant with `--rename`).
- **Kept:** an entry stays when its merchant leaves the data, so a returning merchant keeps its cuisine. Once tagged, a merchant is never re-classified by a refresh; `Unclassified` entries are not retried unless the owner asks.
- **Search** reads `merchant`, `aliases` and the cuisine `detail` (from the start of a word, ranked below name matches), never the cuisine label: typing "persian" finds the entries whose detail is Persian. The cuisine buttons browse by label.
- `tools/validate.py` checks the fields, the fixed list, that no two entries share a name, that every active Dining merchant is either tagged or on `to_classify` (never both), and that `to_classify` holds only untagged active Dining merchants.

## Batch

`{ "card": "Chase Freedom Flex", "read_date": "YYYY-MM-DD", "offers_found": 12 }`

`read_date` is the date the owner read the issuer page, in the owner's local time (US Pacific), not the UTC date of the import or commit. The page's "Offer freshness" panel shows each card's newest `read_date` as its last full read, so a batch entry is added only at "batch complete".

## Rules

- **New batch, per card:** match on `id`. New id -> add as `active`. Existing id -> update every field except `id` and `first_seen`, set `last_read`. Offer was `missing` or `expired` and is back -> `active`. Offer was `used` and is in the batch -> stays `used`.
- **Multi-part batches:** save each part as it arrives, setting `last_read` to the batch date, but do not mark anything missing and do not add a `batches` entry until you say "batch complete".
- **Missing from batch (at "batch complete"):** an `active` offer of that card whose `last_read` is older than the batch date becomes `missing` (hidden, listed under "recently expired"). An already `used` offer that is absent is left alone.
- **Expired:** any non-`used` offer whose `expires` is before today becomes `expired`.
- **Used:** "I used the X offer on my Y card" -> `status: used`, `status_since: today`.
- **Pending phone edits:** phone saves of used / restore / activation wait in `site/data/phone-edits.json` until the nightly Fold phone edits workflow writes them into `offers.json`. Sessions never fold: rules that depend on status or activation read `offers.json` plus pending edits, and cleanup skips offers with a pending edit (details in `CLAUDE.md`, Pending phone edits).
- **Cleanup (run on every update):** delete `expired` and `used` offers 30 days after `expires`; delete `missing` offers 30 days after `status_since`. Offers with no `expires` are cleaned up by `status_since` instead.
- **Batch file without offer ids (Capital One refresh):** match on normalized merchant name + normalized bonus (keep `%` and `$` in the bonus), after pairing leftover rows that are only naming differences. A paired offer keeps its `id`, `category` and every `other_details` note, takes the file's `merchant` name (unless that is a bare lowercase domain) and adds the old name to `aliases` (skipped when the two names differ only in case or punctuation). Rows with the same merchant and bonus are one offer; `other_details` gets `N tiles listed`. Fields the file leaves blank or marks "none shown" never overwrite a saved value. Saved `active` offers with no row become `missing`. Details in `CLAUDE.md` under Capital One.
- **Batch file with deal ids but the app has none (U.S. Bank refresh):** same matching as the Capital One refresh above (normalized merchant name + normalized bonus, after pairing leftover naming differences). Differences: a paired truncated name takes the file's full name and the old name is **not** added to `aliases`; `expires` comes from the file's exact end date in Eastern time; `minimum_spend` is the file's `min_spend` (`0.2` = none -> `null`); `fine_print` is filled from the reward text only where empty. Details in `CLAUDE.md` under U.S. Bank.
- **Batch file with offer ids but the app has none (Chase Freedom Flex and Chase Freedom refreshes, "method B"):** Chase is now read from a complete live-page CSV with exact end dates, instead of list-view screenshots. The Freedom Flex and the Chase Freedom are separate reads (one CSV per card). Matching is the same as the U.S. Bank refresh (normalized merchant name + normalized bonus, after pairing leftover naming differences; a paired truncated name takes the file's full name, old name **not** added to `aliases`, `Name truncated on screen` note removed). `expires` is the file's end timestamp in Eastern time; `expires_text` is the file's text without the trailing period (null if none); `channel` comes from the file (`NONE` never overwrites); `minimum_spend` is `min_spend` unless 0; `spend_cap` stays `null`; `fine_print` is filled from `reward_description` only where empty; saved `activation` is never changed (the file's `added_state` is not an activation state); the `Tagged New` note follows the file's `new_badge`. The Chase Freedom file names its columns differently (`bonus_as_shown`, `end_timestamp`, `new_badge` `yes`/`no`) and carries `card_last4`, which is never stored. Details in `CLAUDE.md` under Chase Freedom Flex and Chase Freedom.
- **Citi batch file (Citi Double Cash, first import 2026-10-18):** Citi keeps one offer list per card, picked with a card selector on its Merchant Offers page, so each Citi card is a separate read and CSV. One offer per `offer_id`; `Redeemed` rows are history, skipped, and never mark anything `used`. Expiry is a countdown tile (`12d left`): `expires` = read date + N days (an estimate), `expires_text` = the tile text. The tiles show no channel, minimum, cap or fine print (`none_shown` / `null`; channel never inferred from the id). Id families: `RN-` restaurants (names often carry a location), `RKT-` online shops (names mostly bare domains), others UUIDs. A restaurant name with a location keeps the app's spelling of the full name if that already exists; otherwise the location is stripped to `other_details` (`Location listed: ...`), and same base name + same bonus collapse to one offer (`N locations listed`), unless their expirations differ. A domain name matches a saved merchant ignoring the domain ending, case and punctuation, and then takes the app's name with the domain in `aliases`. Citi Custom Cash (first import 2026-10-18) follows the same rules with its own CSV and records; the two Citi cards share most offers but enroll separately. Details in `CLAUDE.md` under Citi Double Cash and Citi Custom Cash.
- **Search shows only `active`.** "Recently unavailable" shows `missing` and `expired`.
- **Everyday default and headline:** the owner's U.S. Bank Smartly card (4% on everything, `bonus-categories.json`, `everyday: true`) is the default. The page's "Use:" headline names the best card for what is shown: the highest rate among matching category bonuses and Smartly 4% (rules in CLAUDE.md, Phone page). Merchant offers are on top of that card earning.
- **Per-card rules** in `CLAUDE.md` override these defaults for that card (e.g. Chase Freedom Flex treats every batch as a full snapshot and has a size check before marking offers missing).

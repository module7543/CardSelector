// The phone page: search, filters, bonus rows and (when signed in) phone edits through store.js.
(function () {
  "use strict";
  var MAX_SHOWN = 60;
  var PAGE = 100; // rows added per "Show more" tap when a card or category is picked
  var main = document.getElementById("main");
  var countEl = document.getElementById("count");
  var foot = document.getElementById("foot");
  var fsum = document.getElementById("fsum");
  var flist = document.getElementById("flist");
  var input = document.getElementById("q");
  var catsEl = document.getElementById("cats");
  var cardsEl = document.getElementById("cards");
  var sortEl = document.getElementById("sort");
  var cuisFilter = document.getElementById("cuis-filter");
  var cuisEl = document.getElementById("cuis");
  var bstrip = document.getElementById("bstrip");
  var useEl = document.getElementById("use");
  var ftoggle = document.getElementById("ftoggle");
  var filtersEl = document.getElementById("filters");
  var chansEl = document.getElementById("chans");
  var bsum = document.getElementById("bsum");
  var blist = document.getElementById("blist");
  var bonus = null; // data/bonus-categories.json once loaded (keyword lists pre-normalised)
  var data = null;
  var cuisines = null; // data/cuisines.json once loaded: { cuisines: [...], merchants: { name: entry } }
  var cuisineIndex = {}; // compact merchant name -> entry
  var cuisine = null; // null = all cuisines; only used while Dining is picked
  var cardLinks = {}; // card nickname -> { url }, from data/card-links.json; a missing entry means no icon
  var category = null; // null = All
  var card = null; // null = All cards
  var openIds = {}; // "<list>:<merchant identity>" -> true while that merchant container is open (kept across redraws)
  var SORT_KEY = "cardselector.sort";
  // [value, option label, description shown under the select (null = the label says it all)].
  var SORTS = [
    ["best", "Best offer (% first, then $)", "Ranked by what you would likely earn: a percent offer plus what its card earns at that store (“10% · 15% with Freedom”), biggest first, then “Up to” percents the same way, then flat-dollar rewards, then “Up to $” rewards. Discounts (“Save …”) last. Totals assume the offer is activated or added, and are likely, not certain: how the store codes the purchase decides a category rate. When a search names 1 to 3 stores as a whole word (“shell”: Shell, not Shelly), those stores come first."],
    ["percent", "Highest percent back", "Biggest % back first, then “Up to” percents. Offers with no percent go after them."],
    ["dollar", "Highest dollar reward", "Biggest dollar reward first, whatever spend it needs, then “Up to $” amounts. Offers with no dollar amount go after them."],
    ["rate", "Best rate (reward ÷ spend)", "Reward as a share of the spend: “Spend $20, earn $10” is 50%. Percent offers count as their percent, “Up to” percents after the rest. Offers with no spend stated go after them."],
    ["az", "A to Z", null], ["za", "Z to A", null],
    ["newest", "Newest added", "Offers that first appeared here most recently come first."],
    ["oldest", "Oldest added", "Offers that have been here longest come first."],
    ["expiring", "Expiring soonest", "Nearest end date first. Offers with no end date go after them."]
  ];
  var sortMode = "best";
  // Where the offer can be used: "any", "store" or "online". none_shown offers stay under both.
  var CHANNEL_KEY = "cardselector.channel";
  var CHANNELS = [["any", "Any"], ["store", "In store"], ["online", "Online"]];
  var CHANNEL_OK = {
    store: ["in_store", "in_store_and_online", "in_store_and_app", "pay_at_pump"],
    online: ["online", "in_store_and_online", "in_store_and_app"]
  };
  var chanMode = "any";
  // Whether an offer is kept under a channel choice ("any", "store", "online"); none_shown stays under both.
  function chanIn(mode, o) {
    if (mode === "any") return true;
    var c = o.channel || "none_shown";
    return c === "none_shown" || CHANNEL_OK[mode].indexOf(c) !== -1;
  }
  function chanOk(o) { return chanIn(chanMode, o); }
  // Known online, for the online shopping category rate: the offer's channel is "online" (online only). The Online
  // choice also keeps in_store_and_online and in_store_and_app offers (usable when paying online or in an app), but
  // they don't show the merchant is an online store; none_shown is "channel not shown", never known online.
  function knownOnline(o) { return o.channel === "online"; }
  // Online shopping (a category rate for online purchases) counts at a merchant through its offers only when every
  // offer the Online choice keeps there is known online (online only). One none_shown, in_store_and_online or
  // in_store_and_app offer blocks it; offers that work only in store don't, since they aren't for an online purchase.
  function onlineByOffers(offers) {
    var on = offers.filter(function (o) { return chanIn("online", o); });
    return on.length > 0 && on.every(knownOnline);
  }
  // What blocks it: { unknown: offers with no channel shown, both: offers that also work in store or in an app }.
  function onlineBlockers(offers) {
    var on = offers.filter(function (o) { return chanIn("online", o) && !knownOnline(o); });
    var unknown = on.filter(function (o) { return (o.channel || "none_shown") === "none_shown"; }).length;
    return { unknown: unknown, both: on.length - unknown };
  }
  function chanName(mode) { return mode === "store" ? "In store" : mode === "online" ? "Online" : "Any"; }

  // Activation: "any", "ready" (nothing to do first) or "needs". Shop-link offers stay under Any only,
  // because they need the issuer's "Shop now" link rather than an activation tap.
  var ACT_KEY = "cardselector.activation";
  var ACTS = [["any", "Any"], ["ready", "Ready now"], ["needs", "Needs activation"]];
  var ACT_OK = {
    ready: ["already_activated", "auto_enrolled", "none_shown"],
    needs: ["needs_activation", "add_to_card"]
  };
  var actMode = "any";
  // Capital One offers are saved as none_shown, but each must be added to one card first (cards.json offer
  // list activation "add_to_card"), so they count as needing activation and read "Add to card".
  function actOf(o) {
    var a = o.activation || "none_shown";
    return a === "none_shown" && addToCard(o.card) ? "add_to_card" : a;
  }
  function addToCard(c) {
    var l = cardsRaw && cardsRaw.offer_lists && cardsRaw.offer_lists[c];
    return !!l && l.activation === "add_to_card";
  }
  // Signed in only. usedMode: the "Used (N)" filter lists used offers, newest used first. keep: offers whose
  // status was changed on this page (offer id -> status_since before the change); they stay where they are,
  // dimmed while used, until the search or a filter changes (viewSig). shownBefore: rows shown in this view,
  // so a redraw after a save doesn't fold the list back to its first page.
  var usedMode = false, keep = {}, viewSig = "", shownBefore = 0;
  function kept(o) { return editing() && Object.prototype.hasOwnProperty.call(keep, o.id); }
  // What changed: a mode of the main page listing what each card's latest full read added (New) or took away
  // (Gone). null when off; else { tab: "new" | "gone", from: the freshness row's card (focus goes back to it),
  // saved: the search, filters, sort and scroll from before entering, put back on leaving }.
  var wc = null;

  function actIn(mode, o) { return mode === "any" || ACT_OK[mode].indexOf(actOf(o)) !== -1; }
  function actOk(o) { return actIn(actMode, o); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // "Estée Lauder" -> "estee lauder"; punctuation becomes a space.
  function spaced(s) {
    return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, " ").trim();
  }
  function compact(s) { return spaced(s).replace(/ /g, ""); }
  // Same-merchant key: "Amazon" and "Amazon.com" count as one merchant. Named exception (tools/validate.py's
  // CATEGORY_EXCEPTIONS): Alibaba (the marketplace) and Ali Baba (a restaurant) are two businesses, so names that
  // compact to "alibaba" keep their word breaks ("alibaba" / "ali_baba"); case, accents and punctuation are still ignored.
  var NAME_EXCEPTIONS = { alibaba: 1 };
  function merchantKey(s) {
    var sp = spaced(s.replace(/\.(com|net|org)\b/gi, "")), k = sp.replace(/ /g, "");
    return NAME_EXCEPTIONS[k] ? sp.replace(/ /g, "_") : k;
  }
  // A name as compared with what was typed (the "At <merchant>" / "Dining at <merchant>" leads): compact(), as in
  // Step 2, so "jackery" is not "jackery.com"; only the named exception keeps its word breaks ("alibaba" is not "Ali Baba").
  function typedForm(s) { var c = compact(s); return NAME_EXCEPTIONS[c] ? merchantKey(s) : c; }

  function todayISO() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
  // "Dec 14"; the year only when it isn't this year ("Jan 3, 2027").
  function fmtDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    if (!m) return iso || "";
    var opts = { month: "short", day: "numeric" };
    if (+m[1] !== new Date().getFullYear()) opts.year = "numeric";
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-US", opts);
  }

  // Display copy only (the data stays verbatim): one spelling of "cash back" ("Cashback", "Cash back" mid-
  // sentence -> "cash back"; Citi's "5% Back" -> "5% back") and no ".00" on whole dollars ("$10.00" -> "$10").
  function tidy(s) {
    if (!s) return s;
    return String(s)
      .replace(/\bcash[\s-]?back\b/gi, function (m, at, all) {
        return /(^\s*|[.!?]\s+)$/.test(all.slice(0, at)) ? "Cash back" : "cash back";
      })
      .replace(/(\d%|\$\s?\d[\d,.]*) Back\b/g, "$1 back")
      .replace(/(\$\s?\d[\d,]*)\.00\b/g, "$1");
  }

  // Best-offer rank of a bonus: [tier, amount], higher first. Tiers: definite percent / "Nx" (5), "Up to" percent (4),
  // flat dollar (3), "Up to $" (2), anything else (1), then discounts. Percents outrank dollars (they can't be
  // compared exactly without knowing the spend); within a tier, bigger is better.
  function bonusRank(text) {
    var s = (text || "").toLowerCase(), m, up = isUpTo(s);
    // "Save 25%" / "Save $5" / "Save Now" are discounts, not rewards: they rank below every reward,
    // percent discounts above dollar ones, and a bare "Save Now" last.
    if (isDiscount(s)) {
      if ((m = /(\d+(?:\.\d+)?)\s*%/.exec(s))) return [0.6, +m[1]];
      if ((m = /\$\s*(\d+(?:\.\d+)?)/.exec(s))) return [0.4, +m[1]];
      return [0, 0];
    }
    if ((m = /(\d+(?:\.\d+)?)\s*%/.exec(s)) || (m = /(\d+(?:\.\d+)?)\s*x\b/.exec(s))) return [up ? 4 : 5, +m[1]];
    // "Spend $20, earn $10": the reward is the second amount.
    if ((m = /earn\s*\$\s*(\d+(?:\.\d+)?)/.exec(s)) || (m = /\$\s*(\d+(?:\.\d+)?)/.exec(s))) return [up ? 2 : 3, +m[1]];
    return [1, 0];
  }
  function isDiscount(lower) { return /^\s*save\b/.test(lower); }
  function isUpTo(lower) { return /^\s*up to\b/.test(lower); }
  function rankOf(o) { return o._rank || (o._rank = bonusRank(o.bonus)); }
  function byBonusDesc(a, b) {
    var x = rankOf(a), y = rankOf(b);
    return (y[0] - x[0]) || (y[1] - x[1]) || byMerchant(a, b);
  }

  // Numbers behind the sort options, parsed once per offer. null = the offer has no such value.
  //   percent: "25% back", "Up to 25% back" -> 25
  //   dollar:  "Spend $20, earn $10" -> 10, "$16 back" -> 16, "Up to $45 back" -> 45
  //   rate:    reward as a percent of spend: "Spend $20, earn $10" -> 50; percent offers use their percent
  //   upTo:    the bonus starts "Up to" (ranked after the definite amounts in the percent, dollar and rate sorts)
  function metrics(o) {
    if (o._m) return o._m;
    var s = (o.bonus || "").toLowerCase(), m, pct = null, dollar = null, rate = null;
    if (isDiscount(s)) return (o._m = { percent: null, dollar: null, rate: null, upTo: false }); // a discount is not a reward
    if ((m = /(\d+(?:\.\d+)?)\s*%/.exec(s))) pct = +m[1];
    if ((m = /earn\s*\$\s*(\d+(?:\.\d+)?)/.exec(s)) || (pct === null && (m = /\$\s*(\d+(?:\.\d+)?)/.exec(s)))) dollar = +m[1];
    var sp = /spend\s*\$\s*(\d+(?:\.\d+)?)/.exec(s);
    if (pct !== null) rate = pct;
    else if (dollar !== null && sp && +sp[1] > 0) rate = dollar / +sp[1] * 100;
    return (o._m = { percent: pct, dollar: dollar, rate: rate, upTo: isUpTo(s) });
  }

  var collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  // Raw-string fallback keeps names the collator treats as equal ("Revo" / "Rēvo") in a fixed order.
  function byMerchant(a, b) {
    return collator.compare(a.merchant, b.merchant) ||
           (a.merchant < b.merchant ? -1 : a.merchant > b.merchant ? 1 : 0) || collator.compare(a.card, b.card);
  }

  // Whole-word form of a name or query: like spaced(), but apostrophes are dropped first, so "Charley's" and
  // "Charleys" are the same word ("charleys"), not "charley s".
  function wordForm(s) { return spaced(s.replace(/['\u2018\u2019\u02bc`\u00b4]/g, "")); }
  // Two words are the same whole word when equal or (unless strict) one is the other plus a trailing "s"
  // (charley / charleys).
  function sameWord(a, b, strict) { return !!a && !!b && (a === b || (!strict && (a === b + "s" || b === a + "s"))); }
  // The query in whole-word form: { words, c } (c = the words written together).
  function wholeQuery(query) {
    var s = wordForm(query || "");
    return { words: s ? s.split(" ") : [], c: s.replace(/ /g, "") };
  }
  // A name (as nameKeys gives it) matches the query as whole words: every typed word is a word of the name, or the
  // query is some run of its words written together ("mcdonalds"). Apostrophes are ignored and a trailing "s" on
  // either side is allowed ("charley" hits Charley's and Charleys), nothing looser: "shell" matches Shell, not
  // Shelly or Bombshell. strict = exact words only (apostrophes still ignored, no "s" rule).
  // Shared by the Best offer sort and the headline.
  function wholeWordName(n, q, strict) {
    var ws = n.w.split(" ");
    if (q.words.length && q.words.every(function (w) { return ws.some(function (x) { return sameWord(w, x, strict); }); })) return true;
    for (var i = 0; i < ws.length; i++) {
      for (var j = i, acc = ""; j < ws.length && acc.length < q.c.length; j++) { acc += ws[j]; if (sameWord(acc, q.c, strict)) return true; }
    }
    return false;
  }
  // Which whole-word hits pick the merchants, shared by the headline and the Best offer grouping. count(strict)
  // gives how many merchants hit. "loose" (with the "s" rule) when that is 1 to 3; when it is more than 3 but the
  // exact-word hits alone are 1 to 3, "strict" ("book": Book Outlet, not every "Books" store); otherwise null.
  function wholeLevel(count) {
    var n = count(false);
    if (n >= 1 && n <= 3) return "loose";
    if (n > 3) { var m = count(true); if (m >= 1 && m <= 3) return "strict"; }
    return null;
  }

  // Best offer: like byBonusDesc, but a percent offer ("10%", "Up to 20%") ranks within its tier by its total
  // (offer + what its card earns there, offerTotal). Dollar offers and discounts keep their own amounts.
  function bestKey(o, today) {
    var r = rankOf(o), t = (r[0] === 5 || r[0] === 4) ? offerTotal(o, today) : null;
    return t ? [r[0], t.total] : r;
  }
  function byTotalDesc(today) {
    return function (a, b) {
      var x = bestKey(a, today), y = bestKey(b, today);
      return (y[0] - x[0]) || (y[1] - x[1]) || byMerchant(a, b);
    };
  }

  // Merchant identity, one rule for the headline, Top offer, Best offer grouping and search: the full name as
  // merchantKey() gives it, so "KitchenAid - Major Appliances" and "KitchenAid - Countertop Appliances" are two
  // merchants. Nothing groups because of " - ", aliases or a shared word. Only an owner-approved location variant
  // listed in data/merchant-locations.json joins its group (locations: merchantKey(member) -> the group).
  var locations = Object.create(null), groupNames = Object.create(null); // groupNames: group key -> its name
  // Reads merchant-locations.json ({ "groups": { "<base>": ["<base> - <location>", ...] } }). Anything missing or
  // not in that shape, a member listed twice or also a group name, or one that isn't "<base> - <suffix>": no
  // location merges at all (tools/validate.py refuses such a file before it can deploy).
  function useLocations(j) {
    var map = Object.create(null), bases = Object.create(null), names = Object.create(null);
    var okay = !!j && typeof j === "object" && !Array.isArray(j) && !!j.groups && typeof j.groups === "object" && !Array.isArray(j.groups);
    if (okay) okay = Object.keys(j.groups).every(function (name) {
      var key = merchantKey(name), list = j.groups[name];
      bases[key] = 1;
      names[key] = name;
      return !!key && Array.isArray(list) && list.length > 0 && list.every(function (m) {
        var k = typeof m === "string" ? merchantKey(m) : "", suffix = k ? locationOfBase(m, key) : null;
        if (!k || k === key || k in map || !suffix) return false;
        map[k] = { name: name, key: key, suffix: suffix, n: { c: compact(name), s: spaced(name), w: wordForm(name) } };
        return true;
      });
    }) && !Object.keys(map).some(function (k) { return k in bases; });
    locations = okay ? map : Object.create(null);
    groupNames = okay ? names : Object.create(null);
    window.__locations = Object.keys(locations).length; // tools/offline_test.js, tools/sort_test.js
  }
  // "<base> - <suffix>": some " - " in the member splits it into the base (same merchantKey) and a non-empty
  // suffix (tools/validate.py checks the file with the same rule). Returns the suffix ("Newport Beach"), or null.
  function locationOfBase(member, key) {
    var re = /\s+-\s+/g, m;
    while ((m = re.exec(member))) {
      var suffix = member.slice(m.index + m[0].length).trim();
      if (merchantKey(member.slice(0, m.index)) === key && compact(suffix)) return suffix;
    }
    return null;
  }
  function ownKey(o) { return o._mk !== undefined ? o._mk : (o._mk = merchantKey(o.merchant)); }
  function locationOf(o) { return locations[ownKey(o)] || null; }
  function containerKey(o) { var g = locationOf(o); return g ? g.key : ownKey(o); }
  function containerName(o) { var g = locationOf(o); return g ? g.name : o.merchant; }
  // The location tag of an approved member's row ("Newport Beach" for "Round Table Pizza - Newport Beach"), from
  // the offer's own name (else the name as the locations file lists it); null for every other offer, whatever its name.
  function locationTag(o) {
    var g = locationOf(o);
    return g ? locationOfBase(o.merchant, g.key) || g.suffix : null;
  }
  // The offer's names (merchant, aliases) plus its group's name when it is an approved location, for rate matching.
  function containerNames(o) {
    var g = locationOf(o), names = nameKeys(o);
    return g && !names.some(function (n) { return n.c === g.n.c; }) ? names.concat([g.n]) : names;
  }

  // The one comparator for a sort mode, used for every list of offers (search, filters, Recently unavailable;
  // Show more pages through the same sorted list). Offers lacking the sorted value go after the rest, in Best
  // offer order; ties break by merchant A to Z, then card. Best offer: when the search's whole-word matches
  // (merchant name or alias) among `pool` (the live matches the headline reads) are 1 to 3 merchants (wholeLevel), and it is
  // not a cuisine search, those offers come first; otherwise it is plain reward order.
  function comparator(mode, query, pool) {
    var val, dir = -1, upTo = mode === "percent" || mode === "dollar" || mode === "rate";
    if (mode === "best") {
      var wq = wholeQuery(query);
      var byTotal = byTotalDesc(todayISO());
      if (!compact(query || "") || !pool || pool.viaCuisine) return byTotal;
      var missBy = function (strict) {
        var memo = {};
        return function (o) {
          if (!(o.id in memo)) memo[o.id] = containerNames(o).some(function (n) { return wholeWordName(n, wq, strict); }) ? 0 : 1;
          return memo[o.id];
        };
      };
      var miss = { loose: missBy(false), strict: missBy(true) };
      var level = wholeLevel(function (strict) {
        var keys = {}, n = 0, m = miss[strict ? "strict" : "loose"];
        pool.forEach(function (o) { if (!m(o) && !keys[containerKey(o)]) { keys[containerKey(o)] = 1; n++; } });
        return n;
      });
      if (!level) return byTotal;
      var mx = miss[level];
      return function (a, b) { return (mx(a) - mx(b)) || byTotal(a, b); };
    }
    if (mode === "percent" || mode === "dollar" || mode === "rate") val = function (o) { return metrics(o)[mode]; };
    else if (mode === "newest") val = function (o) { return o.first_seen || null; };
    else if (mode === "oldest") { val = function (o) { return o.first_seen || null; }; dir = 1; }
    else if (mode === "expiring") { val = function (o) { return o.expires || null; }; dir = 1; }
    else if (mode === "az") return function (a, b) { return byMerchant(a, b) || byBonusDesc(a, b); };
    else if (mode === "za") return function (a, b) { return byMerchant(b, a) || byBonusDesc(a, b); };
    else return byBonusDesc;
    return function (a, b) {
      var x = val(a), y = val(b);
      if (x === null || y === null) return x === y ? byBonusDesc(a, b) : (x === null ? 1 : -1);
      // Highest percent / dollar / Best rate: definite amounts above every "Up to" amount.
      if (upTo && metrics(a).upTo !== metrics(b).upTo) return metrics(a).upTo ? 1 : -1;
      return x === y ? byMerchant(a, b) : (x < y ? -dir : dir);
    };
  }

  function isLive(o, today) {
    return o.status === "active" && !(o.expires && o.expires < today);
  }

  // Offers hidden from search: absent from the latest batch, expired, or past their date ("Recently
  // unavailable"). Used offers are not among them: signed in, they are under the Used filter.
  function isGone(o, today) {
    return o.status === "missing" || o.status === "expired" ||
           (o.status === "active" && !!o.expires && o.expires < today);
  }

  // ---- What changed rules (one place, so every count matches the rows it opens) ----
  // Each card's latest read (its newest batches entry) and previous read (its newest entry with an earlier
  // read_date; null on a card's first read). Worked out once per offers file.
  var readsOf = null, readsBy = {};
  function reads() {
    if (readsOf === data) return readsBy;
    var dates = Object.create(null);
    (data.batches || []).forEach(function (b) {
      if (parseDay(b.read_date) === null) return;
      var d = dates[b.card] || (dates[b.card] = []);
      if (d.indexOf(b.read_date) === -1) d.push(b.read_date);
    });
    readsBy = Object.create(null);
    Object.keys(dates).forEach(function (c) {
      var d = dates[c].sort();
      readsBy[c] = { latest: d[d.length - 1], prev: d.length > 1 ? d[d.length - 2] : null };
    });
    readsOf = data;
    return readsBy;
  }
  function readOf(c) { return reads()[c] || null; }
  // Added by the latest read (not on a first read), whatever its status now.
  function addedByRead(o) { var r = readOf(o.card); return !!r && !!r.prev && o.first_seen === r.latest; }
  // New: added by the latest read and live by the page's rule (active, not used, not past its end date).
  function isNew(o, today) { return addedByRead(o) && isLive(o, today); }
  // Gone: missing or expired since the latest read (a first read takes nothing away).
  function isDropped(o) {
    var r = readOf(o.card);
    return !!r && !!r.prev && (o.status === "missing" || o.status === "expired") && o.status_since === r.latest;
  }
  // Which group a gone offer is in: "pulled" (was to end after the read), "ended" (ended by it) or "dropped" (no end date).
  function droppedKind(o) {
    if (!o.expires) return "dropped";
    return o.expires > readOf(o.card).latest ? "pulled" : "ended";
  }
  function droppedLabel(o) {
    var k = droppedKind(o);
    return k === "pulled" ? "Was to end " + fmtDate(o.expires) : k === "ended" ? "Ended " + fmtDate(o.expires) :
      "Dropped " + fmtDate(readOf(o.card).latest);
  }
  // New and gone counts per card: { card: { n, g } }.
  function changeCounts(today) {
    var out = Object.create(null);
    data.offers.forEach(function (o) {
      var c = out[o.card] || (out[o.card] = { n: 0, g: 0 });
      if (isNew(o, today)) c.n++;
      else if (isDropped(o)) c.g++;
    });
    return out;
  }
  // Same merchant across cards: the merchant identity (containerKey: the full name, or an approved location's group,
  // so a location and its group are one merchant; aliases never count; Alibaba and Ali Baba apart, merchantKey).
  // The other cards with a live offer at a gone offer's merchant, A to Z. The index is rebuilt on each render.
  var liveNames = null;
  function stillOn(o) {
    if (!liveNames) {
      var today = todayISO();
      liveNames = Object.create(null);
      data.offers.forEach(function (x) {
        if (!isLive(x, today)) return;
        var l = liveNames[containerKey(x)] || (liveNames[containerKey(x)] = []);
        if (l.indexOf(x.card) === -1) l.push(x.card);
      });
    }
    return (liveNames[containerKey(o)] || []).filter(function (c) { return c !== o.card; }).sort(collator.compare);
  }

  // The merchant name first, then its aliases (earlier or alternate names); each normalised once and kept on the offer.
  function nameKeys(o) {
    if (!o._names) {
      o._names = [o.merchant].concat(o.aliases || []).map(function (n) { return { c: compact(n), s: spaced(n), w: wordForm(n) }; });
    }
    return o._names;
  }

  // Cuisine entry for a Dining offer, matched on its merchant name or any alias (ignoring case and
  // punctuation). Other categories never get one ("Ali Baba" the restaurant is not "Alibaba" the marketplace).
  function cuisineOf(o) {
    if (o.category !== "Dining" || !cuisines) return null;
    if (o._cu === undefined) {
      o._cu = null;
      var names = nameKeys(o);
      for (var i = 0; i < names.length && !o._cu; i++) o._cu = cuisineIndex[names[i].c] || null;
      o._cd = o._cu && o._cu.detail ? " " + spaced(o._cu.detail) : null;
    }
    return o._cu;
  }
  // Button label for a Dining offer: its cuisine, or Unclassified when it has none yet.
  function cuisineLabel(o) {
    var e = cuisineOf(o);
    return e ? e.cuisine : "Unclassified";
  }

  // Matches the merchant name, any alias, or the cuisine detail ("persian"); other_details and the
  // cuisine label are never searched (the cuisine buttons browse by label).
  // Word order does not matter: "table round" finds Round Table. Each typed word must appear in the
  // same name (or, for the cuisine detail, start one of its words); such matches rank below an in-order match.
  function search(query, keep) {
    var qc = compact(query), qs = spaced(query);
    var words = qs ? qs.split(" ") : [], multi = words.length > 1;
    var groups = {};
    data.offers.forEach(function (o) {
      if (!keep(o)) return;
      var names = nameKeys(o), rank = 4;
      for (var i = 0; i < names.length; i++) {
        var at = names[i].c.indexOf(qc), r;
        if (at !== -1) r = at === 0 ? 0 : (" " + names[i].s).indexOf(" " + qs) !== -1 ? 1 : 2;
        else if (multi && words.every(function (w) { return names[i].c.indexOf(w) !== -1; })) r = 2.5;
        else continue;
        if (r < rank) rank = r;
      }
      // Detail matches from the start of a word only, and rank below every name match.
      if (rank === 4 && qs && cuisineOf(o) && o._cd && (o._cd.indexOf(" " + qs) !== -1 ||
          (multi && words.every(function (w) { return o._cd.indexOf(" " + w) !== -1; })))) rank = 3;
      if (rank === 4) return;
      var key = containerKey(o);
      var g = groups[key] || (groups[key] = { rank: rank, name: names[0].s, offers: [] });
      g.rank = Math.min(g.rank, rank);
      g.offers.push(o);
    });
    var list = Object.keys(groups).map(function (k) { return groups[k]; })
      .sort(function (a, b) { return (a.rank - b.rank) || a.name.localeCompare(b.name); });
    var out = list.reduce(function (acc, g) { return acc.concat(g.offers.sort(byBonusDesc)); }, []);
    // This name-match order feeds the headline; result lists are re-sorted with comparator().
    out.viaCuisine = list.some(function (g) { return g.rank === 3; }); // a cuisine search ("persian")
    return out;
  }

  function activation(o) {
    if (actOf(o) === "add_to_card") return ["Add to card", "needs"];
    if (o.activation === "needs_activation") return ["Needs activation", "needs"];
    if (o.activation === "already_activated") return ["Already activated", "done"];
    if (o.activation === "auto_enrolled") return ["Auto-enrolled", "done"];
    if (o.activation === "via_shop_link") return ["Via shop link", "needs"];
    return ["Activation not listed", ""];
  }

  function channel(o) {
    if (o.channel === "in_store") return "In-store";
    if (o.channel === "online") return "Online";
    if (o.channel === "pay_at_pump") return "Pay at pump";
    if (o.channel === "in_store_and_online") return "In-store & online";
    if (o.channel === "in_store_and_app") return "In-store & in-app";
    return null;
  }

  function field(dl, label, value, cls) {
    dl.appendChild(el("dt", null, label));
    dl.appendChild(el("dd", cls || null, value));
  }

  // Maximum reward stated in the fine print, only from clear wordings: "with a $25 cash back maximum",
  // "until the $50 maximum is reached", "maximum $1.50", "up to $100 cash back total", "with a $50 cash back
  // total", "up to $30 as a statement credit". Two different amounts (a per-credit max plus a total) or
  // anything else: none. A flat bonus that already shows the same amount gets none either.
  var MAX_PATTERNS = [
    /\$\s?(\d[\d,]*(?:\.\d+)?)\s+(?:cash\s?back\s+)?maximum\b/gi,
    /\bmaximum(?:\s+(?:reward|cash\s?back))?\s+(?:of\s+)?\$\s?(\d[\d,]*(?:\.\d+)?)/gi,
    /\bup to \$\s?(\d[\d,]*(?:\.\d+)?)\s+(?:(?:in\s+)?cash\s?back\s+)?total\b/gi,
    /\btotal of \$\s?(\d[\d,]*(?:\.\d+)?)/gi,
    /\bwith an? \$\s?(\d[\d,]*(?:\.\d+)?)\s+cash\s?back total\b/gi,
    /\bup to \$\s?(\d[\d,]*(?:\.\d+)?)\s+as a statement credit\b/gi
  ];
  function maxReward(o) {
    if (o._max !== undefined) return o._max;
    o._max = null;
    var f = o.fine_print || "", found = [];
    MAX_PATTERNS.forEach(function (re) {
      re.lastIndex = 0;
      var m;
      while ((m = re.exec(f))) { var v = m[1].replace(/,/g, ""); if (found.indexOf(v) === -1) found.push(v); }
    });
    if (found.length !== 1) return o._max;
    var shown = (o.bonus || "").replace(/,/g, "").match(/\$\s?\d+(?:\.\d+)?/g) || [];
    if (shown.some(function (d) { return +d.replace(/[$\s]/g, "") === +found[0]; })) return o._max;
    return (o._max = tidy("$" + found[0]));
  }

  // Purchase conditions first (expiry, cap, channel, fine print), then what the offer is, then the cuisine
  // evidence folded away. Card, bonus and activation are already on the row, so they are not repeated (a
  // recently unavailable row shows no activation, so its details keep it). Empty fields share one muted line.
  function renderDetails(o, gone) {
    var box = el("div", "details");
    box.appendChild(offerLinks(o));
    offerEdits(o).forEach(function (r) { box.appendChild(r); });
    var dl = el("dl"), missing = [];
    var add = function (label, value, miss, cls) {
      if (value) field(dl, label, value, cls); else missing.push(miss);
    };
    // A clean date ("Dec 14"); Citi's dates are worked out from a "12d left" countdown, so they say so.
    var exp = o.expires
      ? fmtDate(o.expires) + (estimatedEnd(o) ? " (estimate)" : "")
      : o.expires_text;
    add("Expires", exp, "expiry");
    add("Spending cap", tidy(o.spend_cap), "spending cap");
    add("Max reward", maxReward(o), "max reward");
    add("Channel", channel(o), "channel");
    // Some cards store the minimum as a bare number ("20").
    add("Minimum spend", tidy(/^\d+(\.\d+)?$/.test(o.minimum_spend || "") ? "$" + o.minimum_spend : o.minimum_spend), "minimum spend");
    add("Fine print", tidy(o.fine_print), "fine print", "fine");
    // Signed in, an activation switch at the top already shows the status next to its control.
    if (gone && !hasActControl(o)) field(dl, "Activation", activation(o)[0]);
    if (dl.children.length) box.appendChild(dl);
    var dl2 = el("dl");
    // A shared offer list names its cards and says it is one list ("Quicksilver / Discover it (Capital One offers, shared)").
    if (rowCard(o.card) !== o.card) field(dl2, "Cards", rowCard(o.card) + " (" + o.card + " offers, shared)");
    field(dl2, "Category", o.category);
    if (o.aliases && o.aliases.length) field(dl2, "Also known as", o.aliases.join(", "));
    // Issuer tags, conditions and "Used on" stay in view; notes on how the screen was read go to Source notes.
    var shown = (o.other_details || []).filter(function (t) { return !isSourceNote(t); });
    var src = (o.other_details || []).filter(isSourceNote);
    if (shown.length) {
      dl2.appendChild(el("dt", null, "Other details"));
      var dd = el("dd"), ul = el("ul");
      shown.forEach(function (t) { ul.appendChild(el("li", null, tidy(t))); });
      dd.appendChild(ul);
      dl2.appendChild(dd);
    }
    field(dl2, "Last read", fmtDate(o.last_read));
    box.appendChild(dl2);
    // "Not shown: expiry, spending cap, fine print. No other details."
    var none = [];
    if (missing.length) none.push("Not shown: " + missing.join(", ") + ".");
    if (!shown.length) none.push("No other details.");
    if (none.length) box.appendChild(el("p", "dnone", none.join(" ")));
    if (o.category === "Dining" && cuisines) {
      var ce = cuisineOf(o);
      var label = ce ? ce.cuisine + (ce.detail ? " (" + ce.detail + ")" : "") +
        (ce.confidence ? ", " + ce.confidence : "") : "Not classified yet";
      if (ce) {
        var cd = el("details", "cuisdet");
        cd.appendChild(el("summary", null, "Cuisine: " + label));
        cd.appendChild(el("p", null, ce.evidence + (ce.source ? " Source: " + ce.source + "." : "") +
          " Checked " + fmtDate(ce.checked) + "."));
        box.appendChild(cd);
      } else {
        box.appendChild(el("p", "dnone", "Cuisine: " + label + "."));
      }
    }
    if (src.length) {
      var sd = el("details", "cuisdet srcdet");
      sd.appendChild(el("summary", null, "Source notes (" + src.length + ")"));
      var sul = el("ul");
      src.forEach(function (t) { sul.appendChild(el("li", null, tidy(t))); });
      sd.appendChild(sul);
      box.appendChild(sd);
    }
    return box;
  }

  // Notes on how the issuer's screen was read at import ("Logo clipped", "3 tiles listed", "Tile label reads
  // 'BONUS'", promo banners). "Used on <card>", issuer tags ("Tagged New") and conditions (locations, "Logo shows
  // 'Subscription Only'") are not source notes.
  var SOURCE_NOTE = /^(Logo clipped|\d+ tiles listed|Tile label reads |Promo text reads |Name truncated on screen|Title on screen|Headline:|Also shown |Top-offer tile |Seen on the |Listed twice)/;
  function isSourceNote(t) { return SOURCE_NOTE.test(t); }

  function droppedText(o) {
    if (o.status === "used") {
      var on = (o.other_details || []).filter(function (t) { return /^Used on /.test(t); })[0];
      return "Used " + fmtDate(o.status_since) + (on ? " (" + on.replace(/^Used /, "") + ")" : "");
    }
    return o.status === "missing"
      ? "Dropped off " + fmtDate(o.status_since)
      : "Expired " + fmtDate(o.expires || o.status_since);
  }

  // An open row's links: a Google search for the offer's own merchant name (a location row searches its location)
  // and the card's offers page (card-links.json), both in a new tab.
  function offerLinks(o) {
    var box = el("div", "olinks");
    var link = el("a", "glink");
    link.href = googleUrl(o.merchant);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", "Search Google for " + o.merchant + " (opens in a new tab)");
    link.title = "Search Google for " + o.merchant;
    link.appendChild(extIcon());
    link.appendChild(el("span", null, "Search Google"));
    box.appendChild(link);
    var cl = cardLink(o.card);
    if (cl) box.appendChild(cl);
    return box;
  }

  // Google search for the merchant as displayed, minus a trailing "..." / "…" from truncated names.
  function googleUrl(name) {
    var q = name.replace(/\s*(?:\.{3}|…)+\s*$/, "").trim() || name;
    return "https://www.google.com/search?q=" + encodeURIComponent(q)
      .replace(/[!'()*]/g, function (c) { return "%" + c.charCodeAt(0).toString(16).toUpperCase(); });
  }

  var SVG_NS = "http://www.w3.org/2000/svg";

  // Issuer of a card name or an offer-list key ("Freedom", "Capital One", "Smartly / Cash+"), for its color dot:
  // "chase", "usb", "boa", "citi", "cap1", or null (no dot).
  var ISSUERS = {
    "Freedom": "chase", "Freedom Flex": "chase",
    "Smartly": "usb", "Cash+": "usb", "U.S. Bank": "usb", "Smartly / Cash+": "usb",
    "Unlimited Cash": "boa", "Customized Cash": "boa", "Bank of America": "boa", "Customized Cash / Unlimited Cash": "boa",
    "Double Cash": "citi", "Citi Custom Cash": "citi", "Costco Visa": "citi",
    "Quicksilver": "cap1", "Discover it": "cap1", "Capital One": "cap1", "Quicksilver / Discover it": "cap1"
  };
  function issuerOf(name) {
    if (typeof name !== "string") return null;
    if (Object.prototype.hasOwnProperty.call(ISSUERS, name)) return ISSUERS[name];
    if (/^Chase(?:\s|$)/.test(name)) return "chase";
    if (/^Citi(?:\s|$)/.test(name)) return "citi";
    return null;
  }
  window.__issuerOf = issuerOf; // for tools/sort_test.js
  // The page's copy of an offer by id (offers.json with pending edits and remembered saves), for the tests.
  window.__offerOf = function (id) { return data && data.offers.filter(function (o) { return o.id === id; })[0] || null; };
  // The dot for a card name, or null when its issuer is unknown.
  function issuerDot(name) {
    var k = issuerOf(name);
    if (!k) return null;
    var d = el("span", "idot i-" + k);
    d.setAttribute("aria-hidden", "true");
    return d;
  }
  // Puts the card's dot first inside `node` (no dot for an unknown issuer); returns `node`.
  function withDot(node, name) {
    var d = issuerDot(name);
    if (d) node.insertBefore(d, node.firstChild);
    return node;
  }

  // A bold headline total led by the dot of the card it names first ("● Freedom Flex 5% or Freedom 5%").
  function useStrong(node, text, cardName) {
    var d = issuerDot(cardName);
    if (d) node.appendChild(d);
    node.appendChild(el("strong", null, text));
  }
  // The "Likely" tag that ends the headline when a named total has a category rate (the full sentence is for
  // screen readers).
  function likelyTag() {
    var t = el("span", "likely", "Likely");
    t.appendChild(el("span", "sr", ", not certain: how the merchant codes the purchase decides it."));
    return t;
  }

  // Small stroked icons for the offer meta line (aria-hidden, no fill): check (done), shop (in-store), globe (online),
  // clock (ends soon).
  function metaIcon(kind) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "bico");
    svg.setAttribute("viewBox", "0 0 12 12");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    var add = function (tag, attrs) {
      var n = document.createElementNS(SVG_NS, tag);
      for (var k in attrs) n.setAttribute(k, attrs[k]);
      svg.appendChild(n);
    };
    if (kind === "check") {
      svg.setAttribute("stroke-width", "1.8");
      add("path", { d: "M2 6.5l2.5 2.5L10 3.5" });
    } else if (kind === "shop") {
      svg.setAttribute("stroke-width", "1.4");
      add("path", { d: "M2 5l1-3h6l1 3M2 5v5h8V5M2 5h8M5 10V7h2v3" });
    } else if (kind === "clock") {
      svg.setAttribute("stroke-width", "1.3");
      add("circle", { cx: "6", cy: "6", r: "4.5" });
      add("path", { d: "M6 3.5V6l1.8 1.2" });
    } else {
      svg.setAttribute("stroke-width", "1.3");
      add("circle", { cx: "6", cy: "6", r: "4.5" });
      add("path", { d: "M1.5 6h9M6 1.5c1.6 1.7 1.6 7.3 0 9M6 1.5c-1.6 1.7-1.6 7.3 0 9" });
    }
    return svg;
  }

  function extIcon() {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "ext");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "3");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M14 3h7v7M21 3l-9 9M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5");
    svg.appendChild(path);
    return svg;
  }

  function cardIcon() {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "cardico");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    var rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", "2"); rect.setAttribute("y", "5");
    rect.setAttribute("width", "20"); rect.setAttribute("height", "14"); rect.setAttribute("rx", "2");
    var stripe = document.createElementNS(SVG_NS, "path");
    stripe.setAttribute("d", "M2 10h20M6 15h4");
    svg.appendChild(rect);
    svg.appendChild(stripe);
    return svg;
  }

  // Link to the card's own offers page, or null when card-links.json has no (https) address for it.
  function cardLink(card) {
    var entry = Object.prototype.hasOwnProperty.call(cardLinks, card) ? cardLinks[card] : null;
    var url = entry && typeof entry.url === "string" ? entry.url : "";
    if (!/^https?:\/\//i.test(url)) return null;
    var a = el("a", "cardlink");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.setAttribute("aria-label", "Open issuer offers for " + card + " (opens in a new tab)");
    a.title = "Open issuer offers";
    a.appendChild(cardIcon());
    a.appendChild(el("span", null, "Issuer offers"));
    return a;
  }

  // The cards an offer pays on, named: "Quicksilver / Discover it" for a shared Capital One offer (cards.json
  // row_name); single-card lists keep their name ("Chase Freedom Flex").
  function rowCard(c) {
    var l = cardsRaw && cardsRaw.offer_lists && cardsRaw.offer_lists[c];
    return l && l.row_name ? l.row_name : c;
  }

  // Citi dates come from a "12d left" countdown, so they are estimates (the details say "(estimate)").
  function estimatedEnd(o) { return /^Citi /.test(o.card) && /\bleft\b/.test(o.expires_text || ""); }

  // "Ends today" / "Ends tomorrow" / "Ends in N days" for an active offer ending within 7 days (local date), else
  // null; on an estimated Citi date "Ends about today" / "Ends about tomorrow" / "Ends in about N days".
  function endsSoonText(o) {
    if (o.status !== "active") return null;
    var end = parseDay(o.expires), today = parseDay(todayISO());
    if (end === null || today === null) return null;
    var n = end - today;
    if (n < 0 || n > 7) return null;
    var about = estimatedEnd(o) ? "about " : "";
    return n === 0 ? "Ends " + about + "today" : n === 1 ? "Ends " + about + "tomorrow" : "Ends in " + about + n + " days";
  }

  // ---- Merchant containers: every result list shows one container per merchant (containerKey: the full name, or an
  // approved location's group), each offer still its own row with its own terms and controls. ----

  // The containers of a sorted list of offers, in its order: a container holds its offers in that order and ranks by
  // its first (best) one, so rows and containers both follow the list's comparator. A to Z / Z to A (mode "az" /
  // "za") rank containers by their own name instead. [{ key, name, rows }].
  function containersOf(list, mode) {
    var by = Object.create(null), out = [];
    list.forEach(function (o) {
      var k = containerKey(o), c = by[k];
      if (!c) { c = by[k] = { key: k, rows: [], at: out.length }; out.push(c); }
      c.rows.push(o);
    });
    out.forEach(function (c) { c.name = mcName(c.rows, c.key); });
    if (mode === "az" || mode === "za") {
      var dir = mode === "az" ? 1 : -1;
      out.sort(function (a, b) {
        return dir * (collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) || a.at - b.at;
      });
    }
    return out;
  }
  // The name a container shows: an approved group's name (whichever of its rows comes first, the base or a member),
  // else the spelling most of its rows use ("Amazon" over "Amazon.com"; a tie takes the first A to Z).
  function mcName(rows, key) {
    if (groupNames[key]) return groupNames[key];
    var n = {};
    rows.forEach(function (o) { n[o.merchant] = (n[o.merchant] || 0) + 1; });
    return Object.keys(n).sort(function (a, b) { return (n[b] - n[a]) || collator.compare(a, b) || (a < b ? -1 : 1); })[0];
  }
  // The header's cuisine or category: the one cuisine all its rows share (Dining), else the one category they share;
  // null when they don't agree (no merchant-level label is made up).
  function mcMeta(rows) {
    var one = function (f) {
      var v = rows.map(f);
      return v.every(function (x) { return x && x === v[0]; }) ? v[0] : null;
    };
    var cu = rows.every(function (o) { return o.category === "Dining"; }) ? one(function (o) {
      var e = cuisineOf(o);
      return e && e.cuisine !== "Unclassified" ? e.detail || e.cuisine : null;
    }) : null;
    return cu || one(function (o) { return o.category; });
  }

  // What a row's status says: "Ready" (with a check), "Activate", "Add to card" or "Shop link", and its style.
  function statusOf(o) {
    var a = actOf(o);
    if (a === "needs_activation") return ["Activate", "needs"];
    if (a === "add_to_card") return ["Add to card", "needs"];
    if (a === "via_shop_link") return ["Shop link", "needs"];
    if (a === "already_activated" || a === "auto_enrolled") return ["Ready", "done"];
    return ["Activation not listed", ""];
  }
  // The big number on the right: the row total for a percent offer (offerTotal, as the Best offer sort ranks it),
  // else the offer's own amount; sub: "on $20+" for a dollar offer with a minimum.
  function bigOf(o, tot) {
    var v = offerValue(o);
    if (v.kind === "pct") return { big: (v.upTo ? "up to " : "") + pct(tot ? tot.total : v.pct) + "%" };
    if (v.kind === "dollar") return { big: (v.upTo ? "up to " : "") + money(v.amt), sub: v.min ? "on " + money(v.min) + "+" : null };
    return { big: tidy(o.bonus) };
  }
  // The breakdown under the card: the raw merchant offer plus what the card adds there ("15% Chase offer + 5% dining";
  // "10% U.S. Bank offer + 4% Smartly"; a shared offer list names its card: "+ 5.25% online shopping with Customized
  // Cash"). A top-category rate (Citi Custom Cash's planned category) is marked: "+ 5% dining (conditional)".
  // Nothing is added when the card adds nothing; other offers keep their own wording ("Spend $20, earn $10 ·
  // Capital One offer").
  function breakdownOf(o, tot) {
    var L = cardsCfg && cardsCfg.lists[o.card], lab = (L && L.label) || o.card + " offer", v = offerValue(o);
    if (v.kind !== "pct") return tidy(o.bonus) + " · " + lab;
    var s = (v.upTo ? "Up to " : "") + pct(v.pct) + "% " + lab;
    if (tot && tot.rate > 0) {
      var shared = (L && L.cards.length > 1) || / \/ /.test(rowCard(o.card));
      s += " + " + pct(tot.rate) + "% " + (tot.label ? tot.label + (shared ? " with " + tot.C.name : "") : tot.C.name) + (tot.cond ? " (conditional)" : "");
    }
    return s;
  }
  // The terms line, in order: channel ("Channel not shown" when none is), end date (or "Ends in N days" within a
  // week), max reward, spending cap, minimum spend (a dollar offer's is on the right already), Shop now link.
  function termsOf(o, gone) {
    var t = [], ch = channel(o);
    t.push(ch ? { text: ch, cls: "chan" } : { text: "Channel not shown", cls: "nochan" });
    var soon = gone ? null : endsSoonText(o);
    if (soon) t.push({ text: soon, cls: "soon" });
    else if (o.expires && !gone) t.push({ text: "Ends " + (estimatedEnd(o) ? "about " : "") + fmtDate(o.expires) });
    var mx = maxReward(o);
    if (mx) t.push({ text: "Max " + mx });
    if (o.spend_cap) t.push({ text: "Spending cap " + tidy(o.spend_cap), cls: "long" });
    var v = offerValue(o);
    if (o.minimum_spend && !(v.kind === "dollar" && v.min)) {
      var num = /^\d+(\.\d+)?$/.test(o.minimum_spend);
      t.push({ text: "Min " + tidy(num ? "$" + o.minimum_spend : o.minimum_spend), cls: num ? null : "long" });
    }
    if (o.activation === "via_shop_link") t.push({ text: "Shop now link only" });
    return t;
  }

  // One offer row inside a merchant container. The row itself is not a tap target: the container header expands
  // every row (setOpen), each showing its own details, controls and links. goneLabel: on the What changed Gone
  // list, the label shown in place of "Dropped off ..." ("Was to end Nov 25").
  function renderOffer(o, id, gone, goneLabel) {
    var today = todayISO();
    var li = el("li", gone ? "offer gone" : "offer");
    li.setAttribute("data-oid", o.id); // the day redraw finds the row again by it (focus)
    var row = el("div", "orow"), left = el("div", "oleft"), right = el("div", "oright");
    var cl = el("div", "ocard");
    cl.appendChild(withDot(el("span", "mcard", rowCard(o.card)), o.card));
    // Outside What changed, an offer its card's latest read added gets a "New" pill after the card name.
    if (!gone && !wc && isNew(o, today)) cl.appendChild(el("span", "newtag", "New"));
    var lt = locationTag(o);
    if (lt) cl.appendChild(el("span", "loctag", lt));
    left.appendChild(cl);
    // What it likely earns with its card (offerTotal); a recently unavailable row shows the offer alone, as before.
    var tot = gone ? null : offerTotal(o, today);
    left.appendChild(el("div", "obreak", breakdownOf(o, tot)));
    var terms = el("div", "oterms");
    termsOf(o, gone).forEach(function (t, i) {
      if (i) terms.appendChild(el("span", "tsep", " · "));
      var s = el("span", t.cls || null, t.text);
      if (t.cls === "soon") s.insertBefore(metaIcon("clock"), s.firstChild);
      terms.appendChild(s);
    });
    left.appendChild(terms);
    // Gone list: the other cards that still have a live offer at this merchant ("Still on ● Bank of America and ● Capital One").
    var still = goneLabel ? stillOn(o) : [];
    if (still.length) {
      var so = el("div", "stillon", "Still on ");
      still.forEach(function (c, i) {
        if (i) so.appendChild(document.createTextNode(i === still.length - 1 ? " and " : ", "));
        so.appendChild(withDot(el("span", "socard", c), c));
      });
      left.appendChild(so);
    }
    var b = bigOf(o, tot);
    right.appendChild(el("div", "obig", b.big));
    if (b.sub) right.appendChild(el("div", "omin", b.sub));
    if (gone) right.appendChild(el("div", "ostat dropped", goneLabel || droppedText(o)));
    else {
      var st = statusOf(o), sp = el("div", "ostat " + st[1], st[0]);
      if (st[1] === "done") sp.insertBefore(metaIcon("check"), sp.firstChild);
      right.appendChild(sp);
    }
    row.appendChild(left);
    row.appendChild(right);
    li.appendChild(row);
    // The details are built the first time the container opens, so long lists stay cheap to draw.
    var det = null;
    var setOpen = function (open) {
      if (open && !det) {
        det = renderDetails(o, gone);
        det.id = id;
        li.appendChild(det);
      }
      if (det) det.hidden = !open;
      // While the details show the activation switch, the row's status steps aside (shown once).
      li.classList.toggle("actctl", open && hasActControl(o));
      return det ? det.id : null;
    };
    return { li: li, setOpen: setOpen };
  }

  // One merchant container: a header (name, cuisine or category, offer count, chevron) that expands and collapses,
  // over every row it holds. The rows always show; opening adds each row's details, controls and links. key: where
  // the open state is kept across redraws (the list it is in, then the merchant).
  function renderContainer(c, key, idPrefix, label) {
    var today = todayISO();
    var rows = c.rows.map(function (o, i) { return renderOffer(o, idPrefix + "-" + i, !isLive(o, today), label ? label(o) : null); });
    var li = el("li", "mc" + (rows.every(function (r) { return r.li.classList.contains("gone"); }) ? " gone" : ""));
    li.setAttribute("data-ck", key);
    var head = el("button", "mchead");
    head.type = "button";
    head.setAttribute("aria-expanded", "false");
    var txt = el("span", "mctext");
    txt.appendChild(el("span", "mcname", c.name));
    var meta = mcMeta(c.rows), n = c.rows.length;
    txt.appendChild(el("span", "mcsub", (meta ? meta + " · " : "") + n + (n === 1 ? " offer" : " offers")));
    head.appendChild(txt);
    var chev = el("span", "chev", "▾");
    chev.setAttribute("aria-hidden", "true");
    head.appendChild(chev);
    li.appendChild(head);
    var ul = el("ul", "mcrows");
    rows.forEach(function (r) { ul.appendChild(r.li); });
    li.appendChild(ul);
    var setOpen = function (open) {
      openIds[key] = open;
      head.setAttribute("aria-expanded", String(open));
      var ids = rows.map(function (r) { return r.setOpen(open); }).filter(Boolean);
      if (ids.length) head.setAttribute("aria-controls", ids.join(" "));
    };
    head.addEventListener("click", function () { setOpen(head.getAttribute("aria-expanded") !== "true"); });
    if (openIds[key]) setOpen(true);
    return li;
  }

  // "Recently unavailable" group (dropped off or expired, never used): open under a search, collapsed when browsing
  // with no query. Merchant containers like the results (the first 60), each row keeping its own status.
  function renderExpired(list, open) {
    if (!list.length) return null;
    var d = el("details", "expired");
    d.open = open;
    d.appendChild(el("summary", null, "Recently unavailable (" + list.length + ")"));
    var ul = el("ul", "results"), cs = containersOf(list, sortMode);
    cs.slice(0, MAX_SHOWN).forEach(function (c, i) { ul.appendChild(renderContainer(c, "x:" + c.key, "x" + i)); });
    d.appendChild(ul);
    if (cs.length > MAX_SHOWN) {
      d.appendChild(el("p", "note", "Showing the first " + MAX_SHOWN + " merchants. Search to narrow."));
    }
    return d;
  }

  // One button per card found in the offers (first-seen order), so new cards appear on their own.
  function renderCards() {
    cardsEl.textContent = "";
    var names = [];
    data.offers.forEach(function (o) { if (names.indexOf(o.card) === -1) names.push(o.card); });
    [null].concat(names).forEach(function (c) {
      var b = el("button", "cat cardbtn", c || "All cards");
      if (c) withDot(b, c);
      b.type = "button";
      b.setAttribute("aria-pressed", String(c === card));
      b.addEventListener("click", function () {
        card = c;
        renderCards();
        renderCuisines();
        render();
      });
      cardsEl.appendChild(b);
    });
  }

  function renderCats() {
    catsEl.textContent = "";
    [null].concat(data.categories || []).forEach(function (c) {
      var b = el("button", "cat", c || "All");
      b.type = "button";
      b.setAttribute("aria-pressed", String(c === category));
      b.addEventListener("click", function () {
        category = c;
        if (c !== "Dining") cuisine = null;
        renderCats();
        renderCuisines();
        render();
      });
      catsEl.appendChild(b);
    });
  }

  // Second row under Dining: one button per cuisine that has live offers matching the search on the picked
  // card, in the fixed list order (Unclassified last), each with its offer count. A picked cuisine stays picked
  // when a search, card or channel change leaves it empty (it shows 0) so the choice isn't lost.
  function renderCuisines() {
    cuisEl.textContent = "";
    cuisFilter.hidden = !(category === "Dining" && cuisines);
    if (cuisFilter.hidden) return;
    var today = todayISO(), counts = {}, base = {};
    // In What changed the chips count the New or Gone list instead of every live offer.
    var listed = !wc ? function (o) { return isLive(o, today); } : wc.tab === "new" ? function (o) { return isNew(o, today); } : isDropped;
    var keep = function (o) {
      return o.category === "Dining" && (card === null || o.card === card) && chanOk(o) && actOk(o) && listed(o);
    };
    var tally = function (into) { return function (o) { var l = cuisineLabel(o); into[l] = (into[l] || 0) + 1; }; };
    data.offers.forEach(function (o) { if (keep(o)) tally(base)(o); });
    if (compact(input.value) !== "") search(input.value, keep).forEach(tally(counts)); else counts = base;
    var list = (cuisines.cuisines || []).filter(function (c) { return counts[c] || c === cuisine; });
    [null].concat(list).forEach(function (c) {
      var b = el("button", "cat cuisbtn", c || "All cuisines");
      if (c) b.appendChild(el("span", "n", " " + (counts[c] || 0)));
      b.type = "button";
      b.setAttribute("aria-pressed", String(c === cuisine));
      b.addEventListener("click", function () {
        cuisine = c;
        renderCuisines();
        render();
      });
      cuisEl.appendChild(b);
    });
  }

  // The count line's head and channel parts, from the same channel rules as the list (chanIn), over the offers it
  // holds (list) and the matches the choice hides (hidden). noun: " offer", " new offer"; scope: " in Dining, ready
  // now"; hint: the "(showing N, keep typing to narrow)" note. In store / Online: "3 offers shown for Online ·
  // 2 channel not shown", "1 offer shown for In store · 3 online only hidden". Any: what the offers are, "4 offers ·
  // 3 online only · 1 in store only". none_shown is always "channel not shown".
  function countLine(list, hidden, noun, scope, hint) {
    var parts = [], n = list.length;
    var add = function (k, w) { if (k) parts.push(k + " " + w); };
    var cnt = function (f) { return list.filter(f).length; };
    var none = cnt(function (o) { return (o.channel || "none_shown") === "none_shown"; });
    if (n || (chanMode !== "any" && hidden)) parts.push(n + noun + (n === 1 ? "" : "s") +
      (chanMode !== "any" ? " shown for " + chanName(chanMode) : "") + scope + hint);
    if (chanMode === "any") {
      add(cnt(function (o) { return o.channel === "online"; }), "online only");
      add(cnt(function (o) { return o.channel === "in_store" || o.channel === "pay_at_pump"; }), "in store only");
      add(cnt(function (o) { return o.channel === "in_store_and_online"; }), "in store & online");
      add(cnt(function (o) { return o.channel === "in_store_and_app"; }), "in store & app");
      add(none, "channel not shown");
    } else {
      add(none, "channel not shown");
      // Hidden: In store hides online-only offers; Online hides in-store-only ones (pay at the pump included).
      add(hidden, (chanMode === "store" ? "online only" : "in store only") + " hidden");
    }
    return parts;
  }

  // "In store or online" buttons; the choice is remembered on this phone like the sort.
  function renderChans() {
    chansEl.textContent = "";
    CHANNELS.forEach(function (c) {
      var b = el("button", "cat", c[1]);
      b.type = "button";
      b.setAttribute("aria-pressed", String(c[0] === chanMode));
      b.addEventListener("click", function () { setChan(c[0]); });
      chansEl.appendChild(b);
    });
  }
  // One channel setting for the Filters row and the answer card's selector (cardselector.channel). refocus: put
  // focus back on the answer card's selector segment for the new value (the tapped control is drawn again).
  function setChan(mode, refocus) {
    chanMode = mode;
    if (!wc) try { localStorage.setItem(CHANNEL_KEY, chanMode); } catch (e) {} // nothing picked in What changed is kept
    renderChans();
    renderCuisines();
    render();
    if (refocus) {
      var b = useEl.querySelector(".chansel button[data-ch=\"" + mode + "\"]");
      if (b) b.focus({ preventScroll: true });
    }
  }

  // "Activation" buttons with how many of the current matches each keeps, and a note on shop-link offers.
  // counts: { any, ready, needs, shop }.
  var actsEl = document.getElementById("acts"), actNote = document.getElementById("acts-note");
  function renderActs(counts) {
    actsEl.textContent = "";
    ACTS.forEach(function (a) {
      var b = el("button", "cat", a[1]);
      if (counts) b.appendChild(el("span", "n", " " + counts[a[0]]));
      b.type = "button";
      b.setAttribute("aria-pressed", String(a[0] === actMode));
      b.disabled = usedMode && editing() && !wc; // the Used list ignores Activation
      b.addEventListener("click", function () {
        actMode = a[0];
        if (!wc) try { localStorage.setItem(ACT_KEY, actMode); } catch (e) {}
        renderCuisines();
        render();
      });
      actsEl.appendChild(b);
    });
    var shop = counts ? counts.shop : 0;
    actNote.hidden = !shop;
    actNote.textContent = shop ? shop + (shop === 1 ? " offer pays" : " offers pay") +
      " only through the card's Shop now link, so " + (shop === 1 ? "it shows" : "they show") + " under Any only." : "";
  }
  function actCounts(list) {
    var c = { any: list.length, ready: 0, needs: 0, shop: 0 };
    list.forEach(function (o) {
      var a = actOf(o);
      if (ACT_OK.ready.indexOf(a) !== -1) c.ready++;
      else if (ACT_OK.needs.indexOf(a) !== -1) c.needs++;
      else if (a === "via_shop_link") c.shop++;
    });
    return c;
  }

  // Signed in: the "Used (N)" button, N = used offers matching the search, card and category (n null: hidden).
  var usedFilter = document.getElementById("used-filter"), usedEl = document.getElementById("used");
  function renderUsed(n) {
    usedFilter.hidden = n === null;
    usedEl.textContent = "";
    if (n === null) return;
    var b = el("button", "cat", "Used");
    b.appendChild(el("span", "n", " (" + n + ")"));
    b.type = "button";
    b.setAttribute("aria-pressed", String(usedMode));
    b.addEventListener("click", function () {
      usedMode = !usedMode;
      render();
    });
    usedEl.appendChild(b);
  }

  // "Filters: Dining, Chase Freedom" on the phone's Filters button.
  function renderFilterSummary() {
    var on = [];
    if (category !== null) on.push(category + (category === "Dining" && cuisine !== null ? ": " + cuisine : ""));
    if (card !== null) on.push(card);
    var usedOn = usedMode && editing() && !wc; // the Used list ignores In store / Online and Activation (What changed ignores Used)
    if (chanMode !== "any" && !usedOn) on.push(chanMode === "store" ? "In store" : "Online");
    if (actMode !== "any" && !usedOn) on.push(actMode === "ready" ? "Ready now" : "Needs activation");
    if (usedOn) on.push("Used");
    if (sortMode !== "best") on.push(SORTS.filter(function (o) { return o[0] === sortMode; })[0][1]);
    ftoggle.textContent = "";
    var t = el("span", "fsumm", "Filters" + (on.length ? ": " : ""));
    if (on.length) t.appendChild(el("span", "on", on.join(", ")));
    ftoggle.appendChild(t);
  }
  ftoggle.addEventListener("click", function () {
    var open = !filtersEl.classList.contains("open");
    filtersEl.classList.toggle("open", open);
    ftoggle.setAttribute("aria-expanded", String(open));
  });

  // ---- Bonus categories (data/bonus-categories.json) ----
  // An entry is shown only between its start and end dates (standing ones have none).
  function bonusLive(e, today) { return (!e.start || e.start <= today) && (!e.end || e.end >= today); }
  function rangeText(a, b) {
    var x = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a), y = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b);
    var d = function (m, yr) {
      return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, yr ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" });
    };
    return d(x, x[1] !== y[1]) + " – " + d(y, true);
  }
  function normKw(k) { return { kw: k, c: compact(k), s: spaced(k) }; }
  // A keyword hits when the query is the keyword, starts with it as a whole word, is the start of one of
  // its words (4+ characters), or sits inside it (5+ characters, for "wholefoods").
  function kwHit(k, qc, qs) {
    if (qc === k.c || qs.indexOf(k.s + " ") === 0) return true;
    if (qc.length >= 4 && (" " + k.s).indexOf(" " + qs) !== -1) return true;
    return qc.length >= 5 && k.c.indexOf(qc) !== -1;
  }
  // full_name keywords ("Costco Gas") count only once every word is typed: "costco ga" hits, "costco" does not.
  function fullHit(k, qs) {
    if (qs.indexOf(k.s) === 0) return qs.length === k.s.length || qs.charAt(k.s.length) === " ";
    return k.s.indexOf(qs) === 0 && qs.split(" ").length >= k.s.split(" ").length;
  }
  function excludedName(o, list) {
    if (!list || !list.ex.length) return false;
    return nameKeys(o).some(function (n) { return list.ex.some(function (x) { return n.c.indexOf(x.c) !== -1; }); });
  }

  // Which bonus topics ("dining", "grocery stores") hit, one row per topic listing every card that pays it;
  // the card filter keeps only that card's entries. src "query": what the search hits (within the picked
  // category); src "button": what the picked category button shows. The two are drawn as separate groups.
  // A card whose bonus excludes everything that matched (bakeries for Discover it) is left out of the row's
  // card list; its note stays.
  function bonusRows(query, today, src) {
    var none = []; none.hints = [];
    if (!bonus) return none;
    var byQuery = src === "query";
    var qc = byQuery ? compact(query) : "", qs = byQuery ? spaced(query) : "", hasQ = qc.length >= 3;
    var words = qs ? qs.split(" ") : [];
    var entries = bonus.entries.filter(function (e) {
      return e.search && !e.everyday && bonusLive(e, today) && (card === null || e.app_card === card);
    });
    if (!entries.length || (byQuery ? qc.length < 2 : category === null)) return none;
    // Live offers whose name starts with the query, or has a word starting with it (each typed word, in any order).
    // Dining offers whose cuisine detail matches the same way ("persian") count too, as they do in the results;
    // those are kept in byCuisine so the row doesn't lead with one merchant's name.
    var matched = null, byCuisine = [];
    var wordHit = function (w) {
      return w.indexOf(" " + qs) !== -1 || (words.length > 1 && words.every(function (x) { return w.indexOf(" " + x) !== -1; }));
    };
    var offersHit = function () {
      if (matched) return matched;
      matched = [];
      if (!hasQ) return matched;
      data.offers.forEach(function (o) {
        if ((category !== null && o.category !== category) || !isLive(o, today)) return;
        if (nameKeys(o).some(function (n) { return n.c.indexOf(qc) === 0 || wordHit(" " + n.s); })) matched.push(o);
        else if (cuisineOf(o) && o._cd && wordHit(o._cd)) { matched.push(o); byCuisine.push(o); }
      });
      return matched;
    };
    var topics = {}, order = [];
    entries.forEach(function (e) {
      e.match.forEach(function (g) {
        var list = g._list;
        var cats = g.app_categories || [], hit = false, plain = false, notes = [], names = [], viaCuisine = false;
        var chOnly = false, kwAny = false; // online shopping: matched through online-only offers / a keyword
        var mncHit = false; // a matched keyword may not count for this group
        // weak: keywords hit only because the query starts with them ("costco" in "costco gas").
        var strong = !byQuery, weak = [], strongKws = [];
        var caveat = function (label) { if (g.caveat_cuisines && g.caveat_cuisines[label]) { notes.push(g.caveat_cuisines[label]); return true; } return false; };
        if (!byQuery) {
          // Category button: button_categories when set, else the mapped app categories (Dining).
          if ((g.button_categories || cats).indexOf(category) === -1) return;
          hit = true;
          if (g.button_note) notes.push(g.button_note);
          if (g.caveat_cuisines) Object.keys(g.caveat_cuisines).forEach(function (c) { if (cuisine === null || cuisine === c) caveat(c); });
          // A picked cuisine this card excludes (Bakeries & Desserts) leaves nothing it pays on.
          plain = !(cuisine !== null && g.caveat_cuisines && g.caveat_cuisines[cuisine]);
        } else {
          // Typing an excluded name in full ("target", "uber eats") blocks the topic; a prefix ("uber") does not.
          if (list && list.ex.some(function (k) { return qc === k.c || qs.indexOf(k.s + " ") === 0; })) return;
          if (hasQ && (cats.length || g.channel)) {
            offersHit().forEach(function (o) {
              if (excludedName(o, list)) return;
              // A mapped app category, or (online shopping) an online-only offer.
              var byCat = cats.indexOf(o.category) !== -1 &&
                !(o.category === "Dining" && (g.exclude_cuisines || []).indexOf(cuisineLabel(o)) !== -1);
              var byCh = !!g.channel && (g.channel === "online" ? knownOnline(o) : o.channel === g.channel);
              if (!byCat && !byCh) return;
              if (!byCat) chOnly = true;
              hit = strong = true;
              names.push(o.merchant);
              if (byCuisine.indexOf(o) !== -1) viaCuisine = true;
              if (byCh || !(o.category === "Dining" && caveat(cuisineLabel(o)))) plain = true;
            });
          }
          if (list) {
            list.kws.forEach(function (k) {
              // Short names ("BP", "76") count only when typed in full.
              if (k.full ? !fullHit(k, qs) : hasQ ? !kwHit(k, qc, qs) : qc !== k.c) return;
              hit = plain = kwAny = true;
              names.push(k.kw);
              if (!k.full && qc !== k.c && qs.indexOf(k.s + " ") === 0) weak.push(k.s);
              else { strong = true; strongKws.push(k.s); }
              if (list.may_not_count[k.kw]) { notes.push(k.kw + " may not count: " + list.may_not_count[k.kw] + "."); mncHit = true; }
            });
          }
        }
        if (!hit) return;
        (g.notes || []).forEach(function (n) { notes.push(n); });
        var t = topics[g.name];
        if (!t) { t = topics[g.name] = { name: g.name, items: [], out: [], notes: [], names: [], seen: {}, cuisine: false }; order.push(t); }
        if (viaCuisine) t.cuisine = true;
        if (chOnly) t.chOnly = true;
        if (mncHit) t.mnc = true;
        if (kwAny && g.channel) t.chKw = true;
        if (g.channel === "online") {
          // Online shopping: counts for an online purchase through a keyword (a known online store), else only when
          // every matched offer an online purchase could use is known online (onlineByOffers); unknown: how many of
          // those show no channel.
          t.online = true;
          if (!t.chKw && byQuery) {
            var mo = offersHit().filter(function (o) { return !excludedName(o, list); });
            t.onlineOk = onlineByOffers(mo);
            t.block = onlineBlockers(mo);
          }
          if (t.chKw) { t.onlineOk = true; t.block = { unknown: 0, both: 0 }; }
        }
        if (strong) t.strong = true;
        t.weak = (t.weak || []).concat(weak);
        t.strongKws = (t.strongKws || []).concat(strongKws);
        if (plain) {
          t.out = t.out.filter(function (x) { return x !== e; });
          if (!t.items.some(function (it) { return it.e === e; })) t.items.push({ e: e, g: g });
        } else if (!t.items.some(function (it) { return it.e === e; }) && t.out.indexOf(e) === -1) t.out.push(e);
        names.forEach(function (n) { var k = merchantKey(n); if (!t.seen[k]) { t.seen[k] = 1; t.names.push(n); } });
        notes.forEach(function (n) { if (t.notes.indexOf(n) === -1) t.notes.push(n); });
      });
    });
    // A topic hit only through a shorter keyword gives way to one that matched the longer name typed:
    // "costco gas" shows the Costco gas row, not the warehouse row that "costco" alone would.
    order = order.filter(function (t) {
      if (t.strong || !t.weak.length) return true;
      return !t.weak.every(function (w) {
        return order.some(function (u) {
          return u !== t && u.strongKws.some(function (k) { return k.indexOf(w + " ") === 0; });
        });
      });
    });
    // The merchant to lead with when what matched is not the query itself ("amazon" -> Amazonia Bowl).
    // A cuisine search ("persian") names a kind of food, not a merchant, so it gets no lead.
    order.forEach(function (t) {
      t.lead = null;
      if (!byQuery || !t.names.length || t.cuisine) return;
      var same = t.names.some(function (n) { return typedForm(n) === typedForm(query) || merchantKey(n) === merchantKey(query); });
      if (!same) t.lead = t.names[0] + (t.names.length > 1 ? " and " + (t.names.length - 1) + " more" : "");
    });
    // The everyday card (Smartly 4%) joins every row that has a bonus card, at its rank; bonus cards below it
    // are marked, and a row where every bonus card is below it is muted (kept for reference).
    var ev = everyday(today);
    order.forEach(function (t) {
      t.muted = false;
      if (!ev || !t.items.length) return;
      t.items.forEach(function (it) { it.below = it.g._rate < ev.rate; });
      t.muted = t.items.every(function (it) { return it.below; });
      t.items.push({ e: ev, g: { _rate: ev.rate }, everyday: true });
    });
    // Category button only: eligible top-category picks that are not the planned focus become grey hints.
    order.hints = [];
    if (!byQuery) entries.forEach(function (e) {
      if (!e.eligible) return;
      var names = e.eligible.filter(function (it) {
        return it.name !== e.planned && (it.button_categories || it.app_categories || []).indexOf(category) !== -1;
      }).map(function (it) { return it.name; });
      if (names.length) order.hints.push({ entry: e, names: names });
    });
    return order;
  }

  // The everyday card (Smartly): live, and in scope of the card filter (app_card "U.S. Bank").
  function everyday(today) {
    if (!bonus) return null;
    return bonus.entries.filter(function (e) {
      return e.everyday && bonusLive(e, today) && (card === null || e.app_card === card);
    })[0] || null;
  }

  // "Use: <card> <rate>": the highest rate among the green rows' cards and the everyday card. A card that is
  // not activated, or was dropped from a row by an exclusion, does not count; Citi Custom Cash is in a row only
  // for its planned category. Ties name every tied card, the everyday card first.
  // Does a bonus row's topic count for the channel choice? Online shopping is for online purchases only: never in
  // store, and online (or under Any) only when its rule passed. answered: the merchants the answer card names (1 to
  // 3), when it names any; then the rule is theirs (onlineByOffers on each one's offers), so the card and its Card
  // rates here never disagree. Every other topic counts.
  function topicCounts(t, mode, answered) {
    if (!t.online) return true;
    return mode !== "store" && onlineOkFor(t, answered);
  }
  function onlineOkFor(t, answered) {
    if (t.chKw || !answered) return !!t.onlineOk;
    return answered.some(function (G) { return onlineByOffers(G.offers); });
  }
  // Why online shopping wasn't counted (Card rates here, "Not counted").
  // noAt: leave out where (the line already names the merchant).
  function notCountedWhy(t, mode, answered, noAt) {
    if (mode === "store") return "online purchases only";
    // 2 or 3 merchants: one reason each ("channel not shown on 1 offer at X · 1 offer at Y also works in store …").
    if (answered && answered.length > 1 && !noAt) return answered.map(function (G) { return notCountedWhy(t, mode, [G]); }).join(" · ");
    var at = noAt ? "" : answered ? " at " + answered.map(function (G) { return G.name; }).join(" and ") : " here";
    var b = answered ? onlineBlockers([].concat.apply([], answered.map(function (G) { return G.offers; }))) : t.block || { unknown: 0, both: 0 };
    var n = b.unknown, m = b.both;
    var offers = function (k) { return k + (k === 1 ? " offer" : " offers"); };
    return n ? "channel not shown on " + offers(n) + at :
      m ? offers(m) + at + (m === 1 ? " also works" : " also work") + " in store or in an app" :
      "no offer" + at + " is online only";
  }
  // A top-category card (Citi Custom Cash): its rate is conditional (only if that category is the actual top one
  // this cycle), so it never leads an answer and never counts as ready.
  function isConditional(e) { return !!e && e.kind === "top_category"; }
  // "only if restaurants is your actual top eligible category this cycle" (the CardSelector focus is only an assumption).
  function condWhy(e) { return "only if " + e.planned + " is your actual top eligible category this cycle"; }
  // "+1 pt", "+10 pts", "+1.25 pts": how much a better line adds over Ready now.
  function gainText(d) { var x = Math.round(d * 100) / 100; return "+" + pct(x) + (x === 1 ? " pt" : " pts"); }

  // mode: the channel choice this answer is for ("any" when no offer is in scope, so a remembered choice never
  // changes an answer whose card shows no selector).
  function headline(rows, today, mode) {
    var ev = everyday(today), cands = [], offs = [], conds = [];
    rows.forEach(function (t) {
      var counts = topicCounts(t, mode);
      t.items.forEach(function (it) {
        if (it.everyday || !counts) return;
        if (isConditional(it.e)) { conds.push({ e: it.e, g: it.g, rate: it.g._rate, t: t }); return; }
        if (it.e.activation === "not_confirmed") { offs.push({ e: it.e, g: it.g, rate: it.g._rate, t: t }); return; }
        cands.push({ e: it.e, g: it.g, rate: it.g._rate, t: t });
      });
    });
    if (ev) cands.push({ e: ev, g: null, rate: ev.rate, t: null, everyday: true });
    if (!cands.length) return null;
    var top = Math.max.apply(null, cands.map(function (c) { return c.rate; }));
    var wins = [], seen = [];
    cands.filter(function (c) { return c.rate === top; })
      .sort(function (a, b) { return (b.everyday ? 1 : 0) - (a.everyday ? 1 : 0); })
      .forEach(function (c) { if (seen.indexOf(c.e) === -1) { seen.push(c.e); wins.push(c); } });
    // Name the merchant when what matched is not what was typed ("Use at Amazonia Bowl").
    // When only the everyday card wins, lead only if no row matched the typed name itself ("costco").
    var src = wins.filter(function (c) { return c.t; })[0];
    var lead = src ? src.t.lead : rows.length && rows.every(function (t) { return t.lead; }) ? rows[0].lead : null;
    // Smartly wins a tie (it pays cash; Costco Visa pays an annual certificate spent at Costco): the tied
    // cards go in a note after it, "Smartly 4% (Costco Visa also 4%, 5% at Costco gas)".
    var also = null, evWin = wins.filter(function (c) { return c.everyday; })[0];
    if (evWin && wins.length > 1) {
      also = wins.filter(function (c) { return !c.everyday; }).map(function (c) {
        return c.e.card + " also " + pct(c.rate) + "%" + (c.g.rate_note ? ", " + c.g.rate_note : "");
      }).join("; ");
      wins = [evWin];
    }
    // At most two cards named; the rest as "+2 more at 5%" (the rows below keep the full list).
    var more = wins.length - 2;
    wins = wins.slice(0, 2);
    var notes = [], likely = false;
    wins.forEach(function (c) {
      var n = [];
      if (c.everyday) {
        if (c.e.headline_note) n.push(c.e.headline_note);
        // A note a matched group keeps for this card (Costco: "it's a Visa, so it works in Costco warehouses").
        rows.forEach(function (t) {
          t.items.forEach(function (it) {
            var hn = it.g.headline_notes && it.g.headline_notes[c.e.card];
            if (hn && n.indexOf(hn) === -1) n.unshift(hn);
          });
        });
      } else {
        likely = true;
        if (c.e.likely_note) n.push(c.e.likely_note.replace(/^likely,\s*/, ""));
        if (c.g.rate_note) n.push(c.g.rate_note);
      }
      if (n.length) notes.push(c.e.card + ": " + n.join("; ") + ".");
      var bn = c.e._boost ? boostNote(boostCard(c.e)) : null;
      if (bn) notes.push(bn);
    });
    // An online shopping rate says "online"; when it matched through online-only offers (not a known online
    // store), the best rate at the register follows: " · in store: Smartly 4%".
    var online = function (c) { return !!(c.g && c.g.channel === "online"); };
    var names = wins.map(function (c) { return c.e.card + " " + pct(c.rate) + "%" + (online(c) ? " online" : ""); });
    var text = names.join(" or ");
    var extra = (more > 0 ? ", +" + more + " more ready at " + pct(top) + "%" : "") + (also ? " (" + also + ")" : "");
    // Under In store or Online the answer is already for that channel: no "online" word, no in-store fallback.
    if (mode === "online") names = wins.map(function (c) { return c.e.card + " " + pct(c.rate) + "%"; });
    text = names.join(" or ");
    if (mode === "any" && wins.some(function (c) { return online(c) && c.t && c.t.chOnly && !c.t.chKw; })) {
      // Only rates with no "may not count" doubt, as in the per-merchant "else" fallback.
      var shop = cands.filter(function (c) { return !online(c) && !(c.t && c.t.mnc); });
      var stop = shop.length ? Math.max.apply(null, shop.map(function (c) { return c.rate; })) : null;
      if (stop !== null && stop < top) {
        var sw = shop.filter(function (c) { return c.rate === stop; })
          .sort(function (a, b) { return (b.everyday ? 1 : 0) - (a.everyday ? 1 : 0); });
        sw = sw[0].everyday ? [sw[0]] : sw.slice(0, 2);
        extra += " · in store: " + sw.map(function (c) { return c.e.card + " " + pct(c.rate) + "%"; }).join(" or ");
      }
    }
    // After activating: a bonus not activated yet, only when it beats the best ready rate ("+1 pt").
    var after = null;
    if (offs.length) {
      var atop = Math.max.apply(null, offs.map(function (c) { return c.rate; }));
      if (atop > top) {
        var aw = [];
        offs.filter(function (c) { return c.rate === atop; }).forEach(function (c) { if (!aw.some(function (x) { return x.e === c.e; })) aw.push(c); });
        var by = aw.map(function (c) { return c.e.activate_by; }).filter(Boolean).sort()[0];
        after = { text: aw.slice(0, 2).map(function (c) { return c.e.card + " " + pct(c.rate) + "%"; }).join(" or "), first: aw[0].e.card,
          extra: (aw.length > 2 ? ", +" + (aw.length - 2) + " more at " + pct(atop) + "%" : "") + " (" + aw[0].t.name + (by ? ", activate by " + fmtDate(by) : "") + ")",
          gain: gainText(atop - top), rate: atop };
      }
    }
    // Citi Custom Cash: its own conditional line; "strong" when it would beat the ready answer.
    var cond = null;
    if (conds.length) {
      var cb = conds.reduce(function (a, c) { return c.rate > a.rate ? c : a; });
      cond = { e: cb.e, rate: cb.rate, strong: cb.rate > top, gain: cb.rate > top ? gainText(cb.rate - top) : null };
    }
    return { lead: lead, text: text, extra: extra, likely: likely, notes: notes, top: top, first: wins[0].e.card, after: after, cond: cond };
  }
  // No ready card at all (a card filter whose bonus is conditional): the conditional line alone.
  function condOnly(rows, mode) {
    var best = null;
    rows.forEach(function (t) {
      if (!topicCounts(t, mode)) return;
      t.items.forEach(function (it) {
        if (!it.everyday && isConditional(it.e) && (!best || it.g._rate > best.rate)) best = { e: it.e, rate: it.g._rate };
      });
    });
    return best;
  }
  // "Citi Custom Cash 5% · conditional · only if restaurants is your actual top eligible category this cycle · +1 pt"
  // when it beats the ready answer (strong), else the short muted "Citi Custom Cash 5% only if ...".
  // c: { e (the entry), rate, strong, gain, detail (the offer part, or null), act }.
  function condLine(c) {
    var d = el("div", c.strong ? "usecond strong" : "usenote usecond");
    if (c.strong) {
      useStrong(d, c.e.card + " " + pct(c.rate) + "%", c.e.card);
      d.appendChild(el("span", "useextra", (c.detail ? " (" + c.detail + ")" : "") + " · conditional · " + condWhy(c.e) +
        (c.act ? " · " + c.act : "")));
      if (c.gain) d.appendChild(el("span", "usegain", c.gain));
    } else {
      d.textContent = c.e.card + " " + pct(c.rate) + "%" + (c.detail ? " (" + c.detail + ")" : "") + " " + condWhy(c.e) + (c.act ? ", " + c.act : "") + ".";
    }
    return d;
  }

  // ctx: { query, hits (every live match in scope, before the Activation filter), any (the same whatever the channel
  // choice: the answer filters by channel itself), groups (the bonus rows, for Card rates here) }. A search matching
  // 1 to 3 merchants gets the per-merchant totals; anything else gets the category headline below.
  function renderHeadline(rows, today, show, ctx) {
    useEl.textContent = "";
    useEl.hidden = !show || !bonus;
    if (useEl.hidden) return;
    var anyHits = ctx ? ctx.any || ctx.hits || [] : [];
    // With no offer in scope there is no selector, and the remembered channel changes nothing (Netflix stays online).
    var mode = anyHits.length ? chanMode : "any";
    var ans = ctx ? renderMerchantHeadline(ctx.query, ctx.hits || anyHits, anyHits, today) : null;
    if (ans) { ratesBox(ctx.groups || [], today, ans.mode, ans.groups); return; }
    // Nothing matched: no offer, no bonus keyword. Say so, and name the everyday card.
    var ev = everyday(today);
    if (ctx && ev && compact(ctx.query) !== "" && !anyHits.length && !rows.length) {
      var nm = el("div", "usehead");
      nm.appendChild(document.createTextNode("No match. Your default: "));
      useStrong(nm, ev.card + " " + pct(ev.rate) + "%", ev.card);
      nm.appendChild(document.createTextNode("."));
      useEl.appendChild(nm);
      return;
    }
    // The selector only when there are offers for it to filter (none for a keyword or category alone: Chipotle).
    if (anyHits.length) useEl.appendChild(chanSel());
    var h = headline(rows, today, mode);
    var head = el("div", "usehead");
    if (h) {
      head.appendChild(document.createTextNode("Use" + (h.lead ? " at " + h.lead : "") + ": "));
      useStrong(head, h.text, h.first);
      if (h.extra) head.appendChild(el("span", "useextra", h.extra));
    } else {
      // A bonus covers this but isn't activated yet (it doesn't count as a winner): say so, not "no match".
      var off = [];
      rows.forEach(function (t) {
        if (!topicCounts(t, mode)) return;
        t.items.forEach(function (it) {
          if (!it.everyday && !isConditional(it.e) && it.e.activation === "not_confirmed" && !off.some(function (x) { return x.e === it.e; })) off.push(it);
        });
      });
      var co = condOnly(rows, mode);
      if (off.length) {
        head.appendChild(document.createTextNode("Bonus here needs activation: "));
        useStrong(head, off.map(function (it) { return it.e.card + " " + pct(it.g._rate) + "%"; }).join(", "), off[0].e.card);
        useEl.appendChild(head);
        off.forEach(function (it) {
          useEl.appendChild(el("div", "usenote", it.e.card + ": not activated" +
            (it.e.activate_by ? ", activate by " + fmtDate(it.e.activate_by) : "") + "."));
        });
        if (co) useEl.appendChild(condLine({ e: co.e, rate: co.rate, strong: false }));
        useEl.appendChild(el("div", "usesub", "Merchant offers add on top of the card's normal earning. Check the offers below."));
        if (ctx) ratesBox(ctx.groups || [], today, mode);
        return;
      }
      if (co) {
        // Only a conditional rate (the card filter on Citi Custom Cash): never shown as the answer, only as itself.
        useEl.appendChild(condLine({ e: co.e, rate: co.rate, strong: true }));
        useEl.appendChild(el("div", "usesub", "Merchant offers add on top of the card's normal earning. Check the offers below."));
        if (ctx) ratesBox(ctx.groups || [], today, mode);
        return;
      }
      head.textContent = "No " + (card || "card") + " bonus category matches here.";
    }
    useEl.appendChild(head);
    var lastHead = head;
    if (h && h.after) {
      var ad = el("div", "usehead");
      ad.appendChild(document.createTextNode("After activating: "));
      useStrong(ad, h.after.text, h.after.first);
      ad.appendChild(el("span", "useextra", h.after.extra));
      ad.appendChild(el("span", "usegain", h.after.gain));
      useEl.appendChild(ad);
      lastHead = ad;
    }
    if (h && (h.likely || h.after)) lastHead.appendChild(likelyTag());
    if (h && h.cond) useEl.appendChild(condLine(h.cond));
    if (h) h.notes.forEach(function (n) { useEl.appendChild(el("div", "usenote", n)); });
    // Broad matches: the best offer total among them, when it beats the line above.
    var tp = ctx ? topOffer(ctx.hits, today) : null;
    if (tp && tp.total > (h ? h.top : 0)) {
      useEl.appendChild(el("div", "usenote usetop", "Top offer: " + tp.M.name + " " + pct(tp.total) + "% with " + tp.C.name +
        (tp.online ? ", online" : "") + (tp.ready ? "" : tp.add ? ", add to " + tp.C.name : ", after activating") +
        // Inside the answer card: a conditional rate or an offer with no channel shown is never worded as certain.
        (tp.cond ? ", conditional: " + condWhy(tp.cond) : "") + (tp.unknown && mode !== "any" ? ", channel not shown" : "") + "."));
    }
    useEl.appendChild(el("div", "usesub", "Merchant offers add on top of the card's normal earning. Check the offers below."));
    if (ctx) ratesBox(ctx.groups || [], today, mode);
  }

  // "Card rates here": the bonus rows for what matched, folded into one disclosure at the bottom of the answer card,
  // closed until opened (kept open across redraws of the same search and filters, ratesKey). The summary lists the
  // topics that count for the channel choice with their best rate ("dining 5% · online shopping 5.25% online only"
  // under Any); open, the rows as before (each card, its status, Matched, Likely, caveats), then "Not counted"
  // for an online shopping rate the channel rule leaves out. groups: [{ label, rows }] as renderBonusRows takes.
  var ratesOpen = false, ratesKey = "";
  function ratesBox(groups, today, mode, answered) {
    var kept = [], left = [], parts = [], mixed = [], ev = everyday(today), belowAll = true;
    groups.forEach(function (grp) {
      var rows = [];
      grp.rows.forEach(function (t) {
        if (topicCounts(t, mode, answered)) {
          rows.push(t);
          var top = topicTop(t, today);
          if (top) {
            parts.push({ t: t.name + " " + top.text + (t.online && mode === "any" ? " online only" : ""), below: top.below });
            if (!top.below) belowAll = false;
          }
          // 2 or 3 merchants with different verdicts: the ones online shopping doesn't count at, by name.
          if (t.online && !t.chKw && answered && answered.length > 1) answered.forEach(function (G) {
            if (!onlineByOffers(G.offers)) mixed.push({ t: t, G: G });
          });
        } else left.push(t);
      });
      rows.hints = grp.rows.hints || [];
      kept.push({ label: grp.label, rows: rows });
    });
    var anyRows = kept.some(function (g) { return g.rows.length || g.rows.hints.length; });
    if (!anyRows && !left.length && !mixed.length) return;
    // "below Smartly 4%" once at the end when every rate listed is under it ("costco"), else on each that is.
    var one = parts.length > 1 && belowAll && ev;
    parts = parts.map(function (p) {
      if (!p.below || one) return p.t;
      var b = "below " + ev.card + " " + pct(ev.rate) + "%";
      return /\)$/.test(p.t) ? p.t.replace(/\)$/, ", " + b + ")") : p.t + " (" + b + ")";
    })
      .concat(one ? ["all below " + ev.card + " " + pct(ev.rate) + "%"] : []);
    var d = el("details", "rates");
    d.open = ratesOpen;
    d.addEventListener("toggle", function () { ratesOpen = d.open; });
    var sum = el("summary", "ratessum");
    sum.appendChild(el("span", "ratesh", "Card rates here"));
    if (parts.length) sum.appendChild(el("span", "ratesl", " · " + parts.filter(function (p, i) { return parts.indexOf(p) === i; }).join(" · ")));
    d.appendChild(sum);
    if (anyRows) d.appendChild(renderBonusRows(kept));
    if (left.length || mixed.length) {
      var nc = el("div", "ratesnc");
      nc.appendChild(el("div", "ratesnch", "Not counted"));
      mixed.forEach(function (x) {
        nc.appendChild(el("div", "bnote", cap(x.t.name) + " at " + x.G.name + ": " + notCountedWhy(x.t, mode, [x.G], true) + "."));
      });
      left.forEach(function (t) {
        var cs = t.items.filter(function (it) { return !it.everyday; }).map(function (it) { return it.e.card + " " + pct(it.g._rate) + "%"; });
        var why = notCountedWhy(t, mode, answered);
        nc.appendChild(el("div", "bnote", cap(t.name) + (cs.length ? " (" + cs.join(", ") + ")" : "") + ": " + why + "."));
      });
      d.appendChild(nc);
    }
    useEl.appendChild(d);
  }
  // A row's best rate for the summary: what a usable card pays ("5%"), then a higher rate that isn't usable yet
  // ("3.5% (5% not activated)", "3% (5% conditional)") and "below Smartly 4%" when the usable rate is under the
  // everyday rate; with no usable card, the best rate marked "not activated" or "conditional"; nothing with no card.
  function topicTop(t, today) {
    var cards = t.items.filter(function (it) { return !it.everyday; });
    if (!cards.length) return null;
    var tag = function (it) { return pct(it.g._rate) + "% " + (isConditional(it.e) ? "conditional" : "not activated"); };
    var use = cards.filter(function (it) { return !isConditional(it.e) && it.e.activation !== "not_confirmed"; });
    var other = cards.filter(function (it) { return use.indexOf(it) === -1; });
    var hi = other.length ? other.reduce(function (a, it) { return it.g._rate > a.g._rate ? it : a; }) : null;
    if (!use.length) return { text: tag(hi), below: false };
    var top = Math.max.apply(null, use.map(function (it) { return it.g._rate; })), ev = everyday(today);
    return { text: pct(top) + "%" + (hi && hi.g._rate > top ? " (" + tag(hi) + ")" : ""), below: !!ev && top < ev.rate };
  }

  // ---- Merchant totals for the "Use:" headline (data/cards.json) ----
  // A card's total at a merchant = what the card earns there (base rate, a standing category such as Freedom
  // Flex's 3% dining, or a live bonus category that replaces it) + a percent merchant offer on that card.
  // Dollar offers are never folded into a percent: they show as "+$10 on $20+". Discounts ("Save 20%") go in
  // an "Also:" note. Each offer list pays on the cards cards.json names (U.S. Bank: Smartly only; Capital One:
  // whichever of Quicksilver / Discover it earns more, and never ready, because the offer must be added to one
  // card; Bank of America: the better of Unlimited Cash / Customized Cash, stored activation state).
  var cardsRaw = null, cardsCfg = null;

  function prepCards() {
    if (cardsCfg || !cardsRaw || !bonus) return;
    bonus.entries.forEach(function (e) { prepEntry(e, bonus); }); // now with the Preferred Rewards boost
    var j = cardsRaw, by = {};
    j.cards.forEach(function (c) {
      by[c.name] = c;
      (c.standing || []).forEach(function (g) {
        var kws = [], ex = [], mnc = {};
        if (g.list && bonus.keyword_lists[g.list]) {
          var bl = bonus.keyword_lists[g.list];
          kws = kws.concat(bl.kws); ex = ex.concat(bl.ex); mnc = bl.may_not_count;
        }
        if (g.keywords) kws = kws.concat(g.keywords.map(normKw));
        g._list = kws.length ? { kws: kws, ex: ex, may_not_count: mnc } : null;
        g._rate = boosted(g.rate, c.name);
      });
    });
    var lists = {};
    Object.keys(j.offer_lists || {}).forEach(function (k) {
      var l = j.offer_lists[k];
      lists[k] = { cards: l.cards.map(function (n) { return by[n]; }).filter(Boolean), activation: l.activation, label: l.label };
    });
    cardsCfg = { cards: j.cards, lists: lists, by: by };
  }

  // Rates show at most two decimals, trailing zeros dropped: 2.625 -> "2.63", 5.25 -> "5.25", 3.50 -> "3.5".
  function pct(x) { return String(Math.round(x * 100) / 100); }

  // Bank of America Preferred Rewards (cards.json preferred_rewards): the tier's percent multiplies every rate on
  // its cards (75%: 1.5% -> 2.625%) through "until", then then_percent. BankAmeriDeals offer amounts are not boosted.
  function boostPct(name) {
    var p = cardsRaw && cardsRaw.preferred_rewards;
    if (!p || !name || (p.cards || []).indexOf(name) === -1) return 0;
    return todayISO() <= p.until ? p.percent : (p.then_percent || 0);
  }
  function boosted(rate, name) { var b = boostPct(name); return b ? rate * (1 + b / 100) : rate; }
  // The cards.json card behind a bonus entry (Customized Cash), for its boost.
  function boostCard(e) {
    var c = cardsRaw && cardsRaw.cards.filter(function (x) { return x.bonus_card === e.card; })[0];
    return c ? c.name : null;
  }
  // "Customized Cash: rates include the 75% Preferred Rewards boost (50% after Dec 15)."
  function boostNote(name) {
    var p = cardsRaw && cardsRaw.preferred_rewards, b = boostPct(name);
    if (!b) return null;
    return name + ": rates include the " + b + "% Preferred Rewards boost" +
      (todayISO() <= p.until && p.then_percent !== p.percent ? " (" + p.then_percent + "% after " + fmtDate(p.until) + ")" : "") + ".";
  }
  function money(x) { return "$" + (Math.round(x) === x ? String(x) : x.toFixed(2)); }

  // A keyword fits a merchant name when it is the name or the name starts with it as whole words
  // ("CVS" fits "CVS Pharmacy"); full_name keywords ("Costco Gas") only when equal.
  function nameKwHit(k, n) { return k.full ? n.s === k.s : (n.c === k.c || n.s.indexOf(k.s + " ") === 0); }

  // Does a rate group (bonus match group or a card's standing group) apply at merchant M? Online shopping fits
  // through a keyword from its lists (Amazon, Netflix: true) or because every offer at M is online-only
  // ("channel": the merchant may have stores where it doesn't apply). inStore: buying at the register, where an
  // online shopping group never applies.
  function groupFits(g, M, inStore) {
    if (g.channel === "online" && inStore) return false;
    var fit = groupFitsBy(g, M);
    return fit ? true : g.channel === "online" && M.online ? "channel" : false;
  }
  function groupFitsBy(g, M) {
    // A Quick Pick (topicMerchant): a type of purchase, not a merchant. The group fits when it pays on that
    // topic (its name, the topic of a Custom Cash eligible category or a Customized Cash choice).
    if (M.topic) return g.name === M.topic;
    var list = g._list || null;
    if (list && list.ex.length && M.names.some(function (n) { return list.ex.some(function (x) { return n.c.indexOf(x.c) !== -1; }); })) return false;
    var cats = g.app_categories || [];
    // What the merchant is (a restaurant) comes from all its offers, whatever the channel choice left (M.all).
    var byCat = cats.length && (M.all || M.offers).some(function (o) {
      if (cats.indexOf(o.category) === -1) return false;
      if (o.category !== "Dining") return true;
      var l = cuisineLabel(o);
      // Excluded cuisines (gift cards) and caveat cuisines (bakeries for Discover it / Costco Visa) don't count.
      return (g.exclude_cuisines || []).indexOf(l) === -1 && !(g.caveat_cuisines && g.caveat_cuisines[l]);
    });
    if (byCat) return true;
    return !!list && M.names.some(function (n) { return list.kws.some(function (k) { return nameKwHit(k, n); }); });
  }
  // A keyword the group's list says may not count ("Shipt" for grocery stores) that names merchant M, or null.
  function mayNotCount(g, M) {
    var list = g._list;
    if (!list || !list.may_not_count) return null;
    var k = list.kws.filter(function (k) {
      return list.may_not_count[k.kw] && M.names.some(function (n) { return nameKwHit(k, n); });
    })[0];
    return k ? k.kw : null;
  }

  // What card C earns at M with no merchant offer: { ready: {rate, label, cat, e, g}, after: same or null }.
  // after = a quarterly rate that isn't activated yet (it beats the ready rate once activated).
  // online: the rate needs an online purchase (online shopping); viaChannel: it fits only because M's offers are
  // online-only (not a keyword), so M may have stores. inStore: what the card earns at the register.
  // sure: leave out rates whose keyword list says the merchant may not count (Shipt for grocery stores).
  // split (the answer card): a top-category rate (Citi Custom Cash's planned 5%) is conditional, so it goes in cond
  // instead of ready; without split (Best offer totals, Top offer) it counts as before.
  function rateAt(C, M, today, inStore, sure, split) {
    var key = C.name + (inStore ? "|store" : "") + (sure ? "|sure" : "") + (split ? "|split" : "");
    if (M.rates[key]) return M.rates[key];
    var ready = { rate: boosted(C.base_rate, C.name), label: null, cat: false }, after = null, cond = null;
    var rec = function (g, fit, extra) {
      var r = { rate: g._rate, label: g.name, cat: true, g: g, mnc: mayNotCount(g, M),
        online: g.channel === "online", viaChannel: fit === "channel" };
      Object.keys(extra || {}).forEach(function (k) { r[k] = extra[k]; });
      return r;
    };
    (C.standing || []).forEach(function (g) {
      var fit = g._rate > ready.rate && groupFits(g, M, inStore);
      if (fit && !(sure && mayNotCount(g, M))) ready = rec(g, fit);
    });
    if (C.bonus_card && bonus) bonus.entries.forEach(function (e) {
      if (e.card !== C.bonus_card || e.everyday || !bonusLive(e, today)) return;
      e.match.forEach(function (g) {
        var fit = groupFits(g, M, inStore);
        if (!fit || (sure && mayNotCount(g, M))) return;
        var r = rec(g, fit, { e: e });
        if (split && isConditional(e)) { if (!cond || r.rate > cond.rate) cond = r; }
        else if (e.activation === "not_confirmed") { if (!after || r.rate > after.rate) after = r; }
        else if (r.rate > ready.rate) ready = r;
      });
    });
    if (after && after.rate <= ready.rate) after = null;
    if (cond && cond.rate <= ready.rate) cond = null;
    return (M.rates[key] = { ready: ready, after: after, cond: cond });
  }

  // "25% back" -> pct; "Spend $20, earn $10" -> +$10 on $20+; "Save 20%" -> discount.
  function offerValue(o) {
    var s = (o.bonus || "").toLowerCase(), m = metrics(o), up = /^\s*up to\b/.test(s);
    if (isDiscount(s)) return { kind: "discount" };
    if (m.percent !== null) return { kind: "pct", pct: m.percent, upTo: up };
    if (m.dollar !== null) {
      var sp = /spend\s*\$\s*(\d+(?:\.\d+)?)/.exec(s);
      var min = sp ? +sp[1] : /^\d+(\.\d+)?$/.test(o.minimum_spend || "") && +o.minimum_spend > 0 ? +o.minimum_spend : null;
      return { kind: "dollar", amt: m.dollar, min: min, upTo: up };
    }
    return { kind: "other" };
  }

  // Best offer total for a percent offer: the offer plus what its card earns at that store, assuming the offer
  // is activated or added. The offer list's card that earns most there (Quicksilver or Discover it, Unlimited
  // or Customized Cash; U.S. Bank is Smartly), with the headline's rates (rateAt: activated quarterly bonuses,
  // Custom Cash focus, Customized Cash choice, Preferred Rewards boost), but only rates that surely count: no
  // "may not count" rate, and an online-only rate (Customized Cash online shopping) only for an online-only
  // offer. { total, pct, rate, C, upTo }, or null (not a percent offer, or cards.json not loaded). Cached (see render).
  var totalCache = {}, totalSig = "";
  function offerTotal(o, today) {
    if (o.id in totalCache) return totalCache[o.id];
    var res = null, v = offerValue(o), L = cardsCfg && cardsCfg.lists[o.card];
    if (v.kind === "pct" && L && L.cards.length) {
      var M = { names: containerNames(o), offers: [o], online: o.channel === "online", rates: {} }, best = null;
      L.cards.forEach(function (C) {
        var r = rateAt(C, M, today, o.channel !== "online", true).ready;
        // cond: the rate is a top-category one (Citi Custom Cash's planned category, isConditional), shown as such.
        if (!best || r.rate > best.rate) best = { C: C, rate: r.rate, label: r.label, cond: !!r.e && isConditional(r.e) };
      });
      res = { total: v.pct + best.rate, pct: v.pct, rate: best.rate, C: best.C, label: best.label, cond: best.cond, upTo: v.upTo };
    }
    return (totalCache[o.id] = res);
  }

  // The payment cards in scope of the card filter (Costco Visa has no offer list, so only with no filter).
  function payCards() {
    if (!cardsCfg) return [];
    if (card === null) return cardsCfg.cards;
    var l = cardsCfg.lists[card];
    return l ? l.cards : [];
  }

  // Merchants among the matches, by merchant identity (containerKey: the full name, or an approved location's group), plus typed bonus keywords that no offer
  // carries ("shell" -> Shell). Whole-word matches win: when any merchant or keyword matches every typed word as a
  // whole word ("round table", "table round", "bp"), only those make the headline; partial matches (Shelly,
  // Bombshell Sportswear for "shell") stay in the results. When a name equals what was typed, keywords that only
  // contain it drop out ("amazon" -> Amazon, not Amazon Prime Video). With no whole-word match, the closest
  // name matches (name or a word starting with the query) are kept, as before.
  function merchantGroups(hits, query) {
    var qc = compact(query), qs = spaced(query), by = {}, order = [];
    var wq = wholeQuery(query);
    var nameRank = function (n) { return n.c.indexOf(qc) === 0 ? 0 : (" " + n.s).indexOf(" " + qs) !== -1 ? 1 : 2; };
    var whole = function (n) { return wholeWordName(n, wq); };
    var strictWhole = function (n) { return wholeWordName(n, wq, true); };
    var exact = function (n) { return n.c === qc; };
    hits.forEach(function (o) {
      var k = containerKey(o);
      var g = by[k];
      if (!g) { g = by[k] = { key: k, name: containerName(o), offers: [], names: [], seen: {}, rank: 9, rates: {} }; order.push(g); }
      g.offers.push(o);
      nameKeys(o).forEach(function (n) { g.rank = Math.min(g.rank, nameRank(n)); });
      // The group's name (an approved location's base) counts as a name of the merchant, as its own names do.
      containerNames(o).forEach(function (n) { if (!g.seen[n.c]) { g.seen[n.c] = 1; g.names.push(n); } });
    });
    order.forEach(function (g) { g.whole = g.names.some(whole); g.strict = g.names.some(strictWhole); g.exact = g.names.some(exact); });
    // Typed bonus keywords (gas stations, grocery stores, online stores...) with no offer of their own.
    var kws = [];
    if (order.length && qc.length >= 3 && bonus) {
      var hitsKw = [];
      var scan = function (g) {
        var l = g._list;
        if (!l || l.ex.some(function (k) { return qc === k.c || qs.indexOf(k.s + " ") === 0; })) return;
        l.kws.forEach(function (k) {
          if (k.full ? !fullHit(k, qs) : !kwHit(k, qc, qs)) return;
          if (!hitsKw.some(function (h) { return h.k.c === k.c; })) hitsKw.push({ k: k, weak: !k.full && qc !== k.c && qs.indexOf(k.s + " ") === 0 });
        });
      };
      var tday = todayISO();
      bonus.entries.forEach(function (e) { if (bonusLive(e, tday)) e.match.forEach(scan); });
      cardsCfg.cards.forEach(function (c) { (c.standing || []).forEach(scan); });
      hitsKw.forEach(function (h) {
        if (h.weak && hitsKw.some(function (x) { return x !== h && x.k.s.indexOf(h.k.s + " ") === 0; })) return;
        var k = merchantKey(h.k.kw), n = { c: h.k.c, s: h.k.s, w: wordForm(h.k.kw) };
        if (by[k]) return;
        kws.push(by[k] = { key: k, name: h.k.kw, offers: [], names: [n], seen: {}, rank: 0, rates: {}, virtual: true,
          whole: whole(n), strict: strictWhole(n), exact: exact(n) });
      });
    }
    // More than 3 merchants with the "s" rule but 1 to 3 with exact words: the exact-word ones (wholeLevel).
    var wk = wholeLevel(function (strict) { return order.filter(function (g) { return strict ? g.strict : g.whole; }).length; }) === "strict" ? "strict" : "whole";
    if (order.some(function (g) { return g[wk]; }) || kws.some(function (g) { return g[wk]; })) {
      order = order.filter(function (g) { return g[wk]; });
      kws = kws.filter(function (g) { return g[wk]; });
      if (order.concat(kws).some(function (g) { return g.exact; })) kws = kws.filter(function (g) { return g.exact; });
    } else if (order.some(function (g) { return g.rank <= 1; })) {
      order = order.filter(function (g) { return g.rank <= 1; });
    }
    kws.forEach(function (g) { if (order.length < 3) order.unshift(g); });
    return order;
  }

  // One merchant as an answer for one channel choice ("any", "store", "online"): the offers that choice keeps
  // (filtered before anything is worked out), all its offers for what the merchant is (M.all: a restaurant's dining
  // rate), and whether online shopping counts through its offers (onlineByOffers: one test for Any and Online,
  // never in store).
  function viewOf(G, ch) {
    return { key: G.key, name: G.name, names: G.names, all: G.offers, virtual: G.virtual, ch: ch, inStore: ch === "store",
      offers: ch === "any" ? G.offers : G.offers.filter(function (o) { return chanIn(ch, o); }),
      online: ch !== "store" && onlineByOffers(G.offers), rates: {} };
  }

  // Candidates at one merchant (one channel view): ready (nothing to do), after (activate / add to a card / shop
  // link), deals (dollar offers), discounts, up to, and cond (a conditional top-category rate: Citi Custom Cash).
  function merchantTotals(M, today) {
    var cards = payCards(), ready = [], after = [], deals = [], discounts = [], upto = [], conds = [];
    var at = function (C, inStore) { return rateAt(C, M, today, inStore === undefined ? M.inStore : inStore, false, true); };
    var actText = function (state, C, needs) {
      return state === "add" ? "add to " + C.name : state === "shop" ? "via the Shop now link" : needs && state === "needs" ? "after activating" : null;
    };
    cards.forEach(function (C) {
      var r = at(C);
      ready.push({ C: C, total: r.ready.rate, base: r.ready });
      if (r.after) after.push({ C: C, total: r.after.rate, base: r.after, act: "activate " + pct(r.after.rate) + "% " + r.after.label });
      if (r.cond) conds.push({ C: C, total: r.cond.rate, base: r.cond });
    });
    M.offers.forEach(function (o) {
      var L = cardsCfg.lists[o.card];
      if (!L) return;
      var cs = L.cards.filter(function (c) { return cards.indexOf(c) !== -1; });
      if (!cs.length) return;
      var v = offerValue(o);
      if (v.kind === "other") return;
      var a = actOf(o);
      var state = L.activation === "add_to_card" ? "add" : a === "needs_activation" ? "needs" : a === "via_shop_link" ? "shop" : "ready";
      if (v.kind === "discount") { discounts.push({ o: o, L: L, state: state }); return; }
      // The card in the list that earns most here (ready rates only: a conditional rate never picks the card).
      var C = cs.reduce(function (x, c) { return at(c).ready.rate > at(x).ready.rate ? c : x; });
      var base = at(C).ready;
      var cand = { C: C, base: base, o: o, v: v, L: L, state: state, act: actText(state, C) };
      // "Up to 20% back" never wins a line on its full rate: it gets its own "Up to:" line, below definite rates.
      if (v.kind === "pct") {
        cand.total = base.rate + v.pct;
        (v.upTo ? upto : state === "ready" ? ready : after).push(cand);
        // The same offer with a card's conditional rate (a Citi Custom Cash offer at a restaurant): conditional too.
        if (!v.upTo) cs.forEach(function (c) {
          var rc = at(c).cond;
          if (rc) conds.push({ C: c, total: rc.rate + v.pct, base: rc, o: o, v: v, L: L, state: state, act: actText(state, c, true) });
        });
      } else { cand.value = v.min ? v.amt / v.min * 100 + base.rate : null; deals.push(cand); }
    });
    // The sure fallback for a hedged Ready now line: the best ready total with no "may not count" doubt.
    var sure = pick(ready.filter(function (c) { return !c.base.mnc; }));
    // Any only (a picked channel already answers for it): at the register, card rates without online shopping, plus
    // ready percent offers that work in store; like the "else" fallback, only totals with no "may not count" doubt.
    var store = null;
    if (M.ch === "any") {
      var st = cards.map(function (C) { var b = at(C, true).ready; return { C: C, total: b.rate, base: b }; });
      ready.forEach(function (c) {
        if (!c.o || c.o.channel === "online" || c.v.upTo) return;
        var b = at(c.C, true).ready;
        st.push({ C: c.C, total: b.rate + c.v.pct, base: b, o: c.o, v: c.v, L: c.L, state: c.state });
      });
      store = pick(st.filter(function (c) { return !c.base.mnc; }));
    }
    return { ready: pick(ready), after: pick(after), deals: deals, discounts: discounts, upto: pick(upto), sure: sure, store: store, cond: pick(conds) };
  }

  // Highest total first; Smartly wins a tie it is in, then candidates with nothing to do; one per card.
  function pick(list) {
    if (!list.length) return null;
    var top = Math.max.apply(null, list.map(function (c) { return c.total; }));
    var seen = [], wins = [];
    list.map(function (c, i) { return { c: c, i: i }; }).filter(function (w) { return w.c.total === top; })
      .sort(function (a, b) {
        return ((b.c.C.name === "Smartly") - (a.c.C.name === "Smartly")) || ((a.c.act ? 1 : 0) - (b.c.act ? 1 : 0)) ||
          ((b.c.o ? 1 : 0) - (a.c.o ? 1 : 0)) || (cardsCfg.cards.indexOf(a.c.C) - cardsCfg.cards.indexOf(b.c.C)) || a.i - b.i;
      })
      .forEach(function (w) { if (seen.indexOf(w.c.C) === -1) { seen.push(w.c.C); wins.push(w.c); } });
    return { total: top, wins: wins };
  }

  // One short condition, in this order: max reward ("first $60"), minimum ("on $20+"), channel, ends soon. M (the
  // merchant view): a channel the line already says isn't a condition ("online" on an "online" total or under
  // Online, "in store" under In store), so the next one in the order ("ends Nov 9") is used instead.
  function offerNote(c, today, M) {
    var o = c.o;
    if (!o) return null;
    var mx = maxReward(o);
    if (mx && c.v.kind === "pct" && c.v.pct > 0) return "first " + money(Math.round(+mx.replace(/[$,]/g, "") / c.v.pct * 100));
    if (c.v.kind === "pct" && /^\d+(\.\d+)?$/.test(o.minimum_spend || "") && +o.minimum_spend > 0) return "on " + money(+o.minimum_spend) + "+";
    var ch = { in_store: "in store", online: "online", pay_at_pump: "at the pump", in_store_and_app: "in store & app" }[o.channel];
    var said = M && ((ch === "online" && (needsOnline(c) || M.ch === "online")) || (ch === "in store" && M.ch === "store"));
    if (ch && !said) return ch;
    if (o.expires) {
      var days = (parseDay(o.expires) - parseDay(today));
      if (days >= 0 && days <= 7) return "ends " + fmtDate(o.expires);
    }
    return null;
  }

  // "Freedom Flex 15% or Freedom 15%" + "(5% dining + 10% Chase offer, first $60)".
  // A total that needs an online purchase says so: "Customized Cash 5.25% online" (online shopping rate, or an
  // online-only offer), except once Online is picked (the answer is for an online purchase already).
  function needsOnline(c) { return !!(c.base && c.base.online) || !!(c.o && c.o.channel === "online"); }
  // A line built on an offer with no channel ends "channel not shown" once a channel is picked (In store or
  // Online), so it is never read as known in store or online.
  function unknownCh(c, M) { return M.ch !== "any" && !!c.o && (c.o.channel || "none_shown") === "none_shown"; }
  function winText(p, today, M, isReady) {
    var w = p.wins, first = w[0], names, extra = [];
    var smartlyTie = first.C.name === "Smartly" && w.length > 1;
    var onl = function (c) { return M.ch !== "online" && needsOnline(c) ? " online" : ""; };
    names = (smartlyTie ? [first] : w.slice(0, 2)).map(function (c) { return c.C.name + " " + pct(c.total) + "%" + onl(c); }).join(" or ");
    var more = smartlyTie ? 0 : w.length - 2;
    var b = first.base, parts = [];
    if (first.o) {
      parts.push(pct(b.rate) + "%" + (b.label ? " " + b.label : ""));
      parts.push((first.v.upTo ? "up to " : "") + pct(first.v.pct) + "% " + first.L.label);
      extra.push(parts.join(" + "));
    } else if (b.label && !b.online) extra.push(b.label);
    // The rows keep the full "may not count" note; the line gets a short hedge.
    var mnc = w.slice(0, smartlyTie ? 1 : 2).filter(function (c) { return c.base.mnc; })[0];
    if (mnc) extra.push("may not count for " + M.name);
    if (first.act) extra.push(first.act);
    // The channel the answer is already for isn't repeated ("online" under Online, "in store" under In store).
    var n = offerNote(first, today, M);
    if (n) extra.push(n);
    var cns = unknownCh(first, M);
    if (cns) extra.push("channel not shown");
    if (smartlyTie) w.slice(1).forEach(function (c) {
      extra.push(c.C.name + " also " + pct(c.total) + "%" + (c.base.g && c.base.g.rate_note ? ", " + c.base.g.rate_note : ""));
    });
    // "+N more ready" counts only cards that pay now (a conditional rate is never among them).
    // note: the one short condition, kept on the compact rows too.
    return { mnc: !!mnc, cns: cns, note: n, names: names, first: first.C.name,
      more: more > 0 ? ", +" + more + " more " + (isReady ? "ready " : "") + "at " + pct(p.total) + "%" : "",
      extra: extra.length ? " (" + extra.join(", ") + ")" : "", named: smartlyTie ? [first] : w.slice(0, 2) };
  }

  // { names: "Discover it +$15 on $40+" (bold, like the other lines' card and rate), extra: " (plus 5% ...)" }.
  function dealText(d, M) {
    var v = d.v;
    return {
      first: d.C.name,
      names: d.C.name + " +" + (v.upTo ? "up to " : "") + money(v.amt) + (v.min ? " on " + money(v.min) + "+" : "") +
        (d.o.channel === "online" && M.ch !== "online" ? " online" : ""),
      extra: " (plus " + pct(d.base.rate) + "%" + (d.base.label ? " " + d.base.label : "") +
        (d.base.mnc ? ", may not count for " + d.base.mnc : "") + ", " +
        (d.act || (d.state === "needs" ? "needs activation" : "ready now")) + (unknownCh(d, M) ? ", channel not shown" : "") + ")",
      cns: unknownCh(d, M)
    };
  }

  // The lines for one merchant view: Ready now, then at most one of After activating, Best deal or Up to, plus
  // Also (discounts) and the conditional Citi Custom Cash line. value: the best definite result (ready, after or
  // best deal; never Up to or a conditional rate), to compare channels; sig: what the lines recommend.
  function merchantLines(M, today) {
    var t = merchantTotals(M, today), out = { lines: [], named: [], also: [], cond: null };
    if (!t.ready) return null;
    var r = winText(t.ready, today, M, true);
    // "(entertainment, may not count for StubHub) · else Smartly 4%" when the winner is in doubt.
    var orElse = "";
    if (r.mnc && t.sure && t.sure.total < t.ready.total) orElse = " · else " + t.sure.wins[0].C.name + " " + pct(t.sure.total) + "%";
    // Any only: a winner that needs an online purchase, matched through online-only offers rather than a known
    // online store (Target, Levain have shops): " · in store: Smartly 4%".
    var store = "", w0 = t.ready.wins[0];
    if (t.store && needsOnline(w0) && !(w0.base.online && !w0.base.viaChannel) && t.store.total < t.ready.total) {
      var sw = t.store.wins, sTie = sw[0].C.name === "Smartly";
      store = " · in store: " + (sTie ? [sw[0]] : sw.slice(0, 2)).map(function (c) { return c.C.name + " " + pct(c.total) + "%"; }).join(" or ");
      out.named = out.named.concat(sTie ? [sw[0]] : sw.slice(0, 2));
    }
    out.lines.push({ label: "Ready now", first: r.first, text: r.names, extra: r.more + r.extra + orElse + store, short: r.names, mnc: r.mnc,
      orElse: orElse, store: store, cns: r.cns, note: r.note, value: t.ready.total });
    out.named = out.named.concat(r.named);
    var best = t.ready.total, aft = t.after && t.after.total > best ? t.after : null;
    var deal = null;
    t.deals.forEach(function (d) { if (d.value !== null && (!deal || d.value > deal.value)) deal = d; });
    if (deal && deal.value > Math.max(best, aft ? aft.total : 0)) {
      var dt = dealText(deal, M);
      out.lines.push({ label: "Best deal", first: dt.first, text: dt.names, extra: dt.extra, short: dt.names, cns: dt.cns, value: deal.value,
        clabel: "best deal" + (deal.act ? ", " + deal.act : deal.state === "needs" ? ", after activating" : "") });
      out.named.push(deal);
    } else if (aft) {
      // Activation is promoted only when it beats what is ready now (a tie isn't worth a step): "+1 pt".
      var a = winText(aft, today, M);
      // Compact rows keep the kind of step: a Capital One add or a BofA Shop now link is not an activation.
      var aAct = aft.wins[0].act;
      out.lines.push({ label: "After activating", first: a.first, text: a.names, extra: a.more + a.extra, short: a.names, mnc: a.mnc,
        cns: a.cns, note: a.note, gain: gainText(aft.total - best), value: aft.total,
        clabel: aAct && /^(add to |via the Shop now)/.test(aAct) ? aAct : "after activating" });
      out.named = out.named.concat(a.named);
    } else if (t.upto && t.upto.total > best) {
      // Only when no definite second line: "Up to: Quicksilver 21.5% (1.5% + up to 20% Capital One offer, ...)".
      var u = winText(t.upto, today, M);
      out.lines.push({ label: "Up to", first: u.first, text: u.names, extra: u.more + u.extra, short: u.names.replace(/ (\d[\d.]*%)/g, " up to $1"),
        bare: true, cns: u.cns, note: u.note, value: null });
      out.named = out.named.concat(u.named);
    }
    t.discounts.forEach(function (x) {
      var ch = { in_store: "in store", online: "online" }[x.o.channel];
      if ((ch === "in store" && M.ch === "store") || (ch === "online" && M.ch === "online")) ch = null;
      if (unknownCh(x, M)) ch = "channel not shown";
      out.also.push(tidy(x.o.bonus) + (x.state === "shop" ? " via the Shop now link" : x.state === "needs" ? " after activating" : "") +
        " (" + x.L.label.replace(/ offer$/, "") + (ch ? ", " + ch : "") + ")");
    });
    // Citi Custom Cash: its own line, never Ready now; "strong" (a separate alternative with its gain) when it
    // would beat the ready answer.
    if (t.cond) {
      var c0 = t.cond.wins[0];
      out.cond = { e: c0.base.e, rate: t.cond.total, strong: t.cond.total > best, gain: t.cond.total > best ? gainText(t.cond.total - best) : null,
        detail: c0.o ? pct(c0.base.rate) + "% " + c0.base.label + " + " + pct(c0.v.pct) + "% " + c0.L.label : null,
        act: [c0.act, unknownCh(c0, M) ? "channel not shown" : null].filter(Boolean).join(", ") || null };
    }
    out.value = Math.max.apply(null, out.lines.map(function (l) { return l.value === null ? -Infinity : l.value; }));
    out.sig = out.lines.map(function (l) { return l.label + ":" + l.text; }).join("|");
    // The picks behind Ready now and After activating, for the Quick Picks (quickPick).
    out.ready = t.ready;
    out.after = out.lines.some(function (l) { return l.label === "After activating"; }) ? aft : null;
    return out;
  }
  // The line with the best definite result (Ready now on a tie).
  function bestLine(L) {
    return L.lines.reduce(function (a, l) { return l.value !== null && l.value > a.value ? l : a; }, L.lines[0]);
  }

  // The three-way channel selector on the answer card (one setting with the Filters row: cardselector.channel).
  // Tapping a segment picks it; tapping the picked one does nothing.
  function chanSel() {
    var g = el("div", "chansel");
    g.setAttribute("role", "group");
    g.setAttribute("aria-label", "Where you're paying");
    CHANNELS.forEach(function (c) {
      var b = el("button", null, c[1]);
      b.type = "button";
      b.setAttribute("data-ch", c[0]);
      b.setAttribute("aria-pressed", String(c[0] === chanMode));
      b.addEventListener("click", function () { if (chanMode !== c[0]) setChan(c[0], true); });
      g.appendChild(b);
    });
    return g;
  }
  // Compact lines, as for 2 or 3 merchants: "Smartly 19% ready now · Freedom Flex 20% after activating +1 pt".
  // withNote (the channel rows): each line keeps its one short condition, as its full line does.
  function compactLines(d, lines, noGain, withNote) {
    lines.forEach(function (ln, i) {
      if (i) d.appendChild(document.createTextNode(" · "));
      useStrong(d, ln.short, ln.first);
      if (!ln.bare) d.appendChild(el("span", "useextra", " " + (ln.clabel || ln.label.toLowerCase())));
      // The line's one short condition, as on its full line ("first $60", "on $20+", "ends Nov 9"), and "channel not shown".
      var cs = [withNote ? ln.note : null, ln.cns ? "channel not shown" : null, ln.mnc ? "may not count" : null].filter(Boolean);
      if (cs.length) d.appendChild(el("span", "useextra", " (" + cs.join(", ") + ")"));
      if (ln.gain && !noGain) d.appendChild(el("span", "usegain", ln.gain));
      if (ln.mnc && ln.orElse) d.appendChild(el("span", "useextra", ln.orElse));
      if (ln.store) d.appendChild(el("span", "useextra", ln.store));
    });
  }
  // One channel's answer as a button that picks that channel: the In store and Online rows under Any, or (alt) the
  // other channel's better result under In store or Online ("Online: Discover it +$10 on $20+ best deal").
  function chanRow(ch, L, alt) {
    var b = el("button", alt ? "usechan usealt" : "usehead usechan");
    b.type = "button";
    b.setAttribute("data-ch", ch);
    b.appendChild(el("span", "usechn", chanName(ch) + ": "));
    compactLines(b, alt ? [bestLine(L)] : L.lines, alt, true);
    b.appendChild(el("span", "sr-only", " (shows the " + chanName(ch).toLowerCase() + " answer)"));
    b.addEventListener("click", function () { setChan(ch, true); });
    return b;
  }

  // Per-merchant headline when the matches are 1 to 3 merchants (not a cuisine search). hits: the live matches the
  // channel choice keeps (they pick the merchants, as the list below shows them); when it keeps none, every channel's
  // (anyHits), so a merchant with offers only in the other channel still gets its answer and the other channel's line.
  // Each merchant then gets all its offers back, and each answer filters them by the channel first (viewOf).
  // Returns { groups, mode } (the merchants answered and the channel they were answered for), or null when it
  // doesn't apply, so the category headline is drawn.
  function renderMerchantHeadline(query, hits, anyHits, today) {
    // (Like main, a match through a cuisine detail doesn't stop the merchant answer: "taco" still answers Taco
    // Bell. The same in every channel.)
    if (!cardsCfg || compact(query) === "" || !anyHits || !anyHits.length) return null;
    // One merchant across every channel (its In store and Online rows, its other-channel line) stays the merchant
    // under each channel; otherwise the channel's own matches pick them ("book" in store: what the list shows).
    var groups = merchantGroups(anyHits, query);
    if (groups.length !== 1 && hits && hits.length && hits !== anyHits) groups = merchantGroups(hits, query);
    if (!groups.length || groups.length > 3) return null;
    groups.forEach(function (G) {
      G.offers = anyHits.filter(function (o) { return containerKey(o) === G.key; });
      if (!G.offers.length) return; // a typed keyword with no offer at all ("shell")
      G.virtual = false; // a keyword merchant whose offers are all in the other channel is a real merchant
      G.names = []; G.seen = {};
      G.offers.forEach(function (o) { containerNames(o).forEach(function (n) { if (!G.seen[n.c]) { G.seen[n.c] = 1; G.names.push(n); } }); });
    });
    // With no offer at all there is no selector and the channel changes nothing ("netflix": any). With the selector
    // showing, every merchant answered follows it, a typed keyword with no offer of its own ("amazon") too.
    var withOffers = groups.some(function (G) { return G.offers.length; });
    var chOf = function () { return withOffers ? chanMode : "any"; };
    var per = groups.map(function (G) { return { M: G, L: merchantLines(viewOf(G, chOf(G)), today) }; }).filter(function (x) { return x.L; });
    if (!per.length) return null;
    var named = [], likely = false, notes = [], last = null;
    if (withOffers) useEl.appendChild(chanSel());
    var condNote = null;
    if (per.length === 1) {
      var G = per[0].M, L = per[0].L, rowsBy = null, alt = null;
      if (typedForm(G.name) !== typedForm(query)) useEl.appendChild(el("div", "useat", "At " + G.name));
      if (G.offers.length && chanMode === "any") {
        // Any: In store and Online answered apart when they recommend different things; one answer when the same.
        var S = merchantLines(viewOf(G, "store"), today), O = merchantLines(viewOf(G, "online"), today);
        if (S && O && S.sig !== O.sig) rowsBy = [["store", S], ["online", O]];
      } else if (G.offers.length) {
        // In store or Online: the other channel only when its best definite result is better.
        var other = chanMode === "store" ? "online" : "store", OL = merchantLines(viewOf(G, other), today);
        if (OL && OL.value > L.value + 1e-9) alt = [other, OL];
      }
      if (rowsBy) {
        // Each row carries its own "Likely" when a category rate is in its own totals.
        rowsBy.forEach(function (x) {
          var b = chanRow(x[0], x[1]);
          if (x[1].named.some(function (c) { return c.base && c.base.cat; })) b.insertBefore(likelyTag(), b.lastChild);
          useEl.appendChild(b);
          named = named.concat(x[1].named);
        });
      } else {
        L.lines.forEach(function (ln) {
          var d = el("div", "usehead");
          d.appendChild(document.createTextNode(ln.label + ": "));
          useStrong(d, ln.text, ln.first);
          if (ln.extra) d.appendChild(el("span", "useextra", ln.extra));
          if (ln.gain) d.appendChild(el("span", "usegain", ln.gain));
          useEl.appendChild(d);
          last = d;
        });
        named = L.named;
      }
      if (L.cond) useEl.appendChild(condLine(L.cond));
      if (alt) useEl.appendChild(chanRow(alt[0], alt[1], true));
      L.also.forEach(function (a) { notes.push("Also: " + a + "."); });
    } else {
      per.forEach(function (x) {
        var d = el("div", "usehead usem");
        d.appendChild(el("span", "usemname", x.M.name + ": "));
        compactLines(d, x.L.lines);
        // Citi Custom Cash beating that merchant's ready answer: named on its line as conditional.
        if (x.L.cond && x.L.cond.strong) {
          d.appendChild(document.createTextNode(" · "));
          useStrong(d, x.L.cond.e.card + " " + pct(x.L.cond.rate) + "%", x.L.cond.e.card);
          d.appendChild(el("span", "useextra", " conditional"));
        }
        if (x.L.cond) condNote = x.L.cond.e;
        useEl.appendChild(d);
        last = d;
        named = named.concat(x.L.named);
      });
    }
    // The hedge whenever a category rate (quarterly, standing 3%...) is in a named total (the channel rows have their own).
    named.forEach(function (c) {
      if (c.base && c.base.cat && last) likely = true;
      var n = c.base && c.base.e && !isConditional(c.base.e) && c.base.e.likely_note;
      if (n) { n = c.C.name + ": " + n.replace(/^likely,\s*/, "") + "."; if (notes.indexOf(n) === -1) notes.push(n); }
      var bn = c.C && boostNote(c.C.name);
      if (bn && notes.indexOf(bn) === -1) notes.push(bn);
    });
    if (condNote) notes.push(condNote.card + ": " + condWhy(condNote) + ".");
    if (likely && last) last.appendChild(likelyTag());
    notes.forEach(function (n) { useEl.appendChild(el("div", "usenote", n)); });
    return { groups: per.map(function (x) { return x.M; }), mode: withOffers ? chanMode : "any" };
  }

  // Broad searches and category buttons: the best percent total among the matching offers, as a hint under
  // the category headline ("Top offer: Round Table Pizza 15% with Freedom Flex, after activating").
  function topOffer(hits, today) {
    if (!cardsCfg || !hits || !hits.length || hits.length > 2500) return null;
    var cards = payCards(), best = null, by = {};
    hits.forEach(function (o) {
      var L = cardsCfg.lists[o.card];
      if (!L) return;
      var v = offerValue(o);
      if (v.kind !== "pct" || v.upTo) return;
      var k = containerKey(o);
      var M = by[k] || (by[k] = { name: containerName(o), offers: [], names: [], rates: {}, online: false });
      M.offers.push(o);
      containerNames(o).forEach(function (n) { M.names.push(n); });
      M.online = M.offers.every(function (x) { return x.channel === "online"; });
    });
    hits.forEach(function (o) {
      var L = cardsCfg.lists[o.card];
      if (!L) return;
      var v = offerValue(o);
      if (v.kind !== "pct" || v.upTo) return;
      var M = by[containerKey(o)];
      L.cards.forEach(function (C) {
        if (cards.indexOf(C) === -1) return;
        var rb = rateAt(C, M, today).ready, total = rb.rate + v.pct;
        var a = actOf(o), ready = L.activation !== "add_to_card" && a !== "needs_activation" && a !== "via_shop_link";
        if (!best || total > best.total || (total === best.total && ready && !best.ready)) {
          best = { total: total, C: C, M: M, ready: ready, add: L.activation === "add_to_card", online: !!rb.online || o.channel === "online",
            cond: rb.e && isConditional(rb.e) ? rb.e : null, unknown: (o.channel || "none_shown") === "none_shown" };
        }
      });
    });
    return best;
  }

  function bonusStatus(e, g) {
    var parts = [];
    if (e.likely_note) parts.push(e.likely_note);
    if (g && g.rate_note) parts.push(g.rate_note);
    if (e.everyday) parts.push("everyday rate");
    if (e._boost) parts.push("incl. " + e._boost + "% Preferred Rewards");
    if (e.activation === "not_confirmed") parts.push("not activated");
    else if (e.activation === "activated") parts.push("activated");
    return parts.length ? " (" + parts.join(", ") + ")" : "";
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // The tag icon that leads a bonus row (aria-hidden).
  function tagIcon() {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "btag");
    svg.setAttribute("viewBox", "0 0 12 12");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M1.5 1.5h4.2l4.8 4.8-4.2 4.2-4.8-4.8z");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.4");
    path.setAttribute("stroke-linejoin", "round");
    var dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", "4"); dot.setAttribute("cy", "4"); dot.setAttribute("r", "0.9");
    dot.setAttribute("fill", "currentColor");
    svg.appendChild(path);
    svg.appendChild(dot);
    return svg;
  }

  // A closed bonus row's one line: as many whole entries as fit, then "+N" for the rest (the entries left out
  // and the ones below the everyday rate, never shown on the line). Refitted whenever the line's width changes.
  var lineFit = typeof ResizeObserver === "function" ? new ResizeObserver(function (list) {
    list.forEach(function (r) { fitLine(r.target); });
  }) : null;
  window.addEventListener("resize", function () {
    if (lineFit) return;
    Array.prototype.forEach.call(document.querySelectorAll(".bline"), fitLine);
  });
  function fitLine(line) {
    var w = line.clientWidth;
    if (!w || line._w === w) return; // hidden (row open) or already fitted at this width
    line._w = w;
    var ents = Array.prototype.slice.call(line.querySelectorAll(".bent"));
    var more = line.querySelector(".bplus"), extra = +line.getAttribute("data-below") || 0;
    var right = line.getBoundingClientRect().right - (parseFloat(getComputedStyle(line).paddingRight) || 0);
    for (var k = ents.length; k >= 0; k--) {
      ents.forEach(function (e, i) { e.classList.toggle("bout", i >= k); });
      var n = ents.length - k + extra;
      more.classList.toggle("bout", !n);
      more.firstChild.textContent = "+" + n;
      more.lastChild.textContent = ", and " + n + " more";
      var lastShown = n ? more : ents[k - 1];
      if (!lastShown || lastShown.getBoundingClientRect().right <= right + 0.5) return;
    }
  }

  // One card entry: dot, name, rate, then (open list only) its status wording. warn (closed line only): a "⚠"
  // before the name and a hidden ", not activated" after the rate.
  function bonusEntry(tag, cls, it, status, warn) {
    var e = el(tag, cls);
    var d = issuerDot(it.e.card);
    if (d) e.appendChild(d);
    if (warn) e.appendChild(el("span", "bwarnmk", "⚠")).setAttribute("aria-hidden", "true");
    e.appendChild(el("span", "bcn", it.e.card));
    e.appendChild(document.createTextNode(" "));
    e.appendChild(el("span", "brate", pct(it.g._rate) + "%"));
    if (warn) e.appendChild(el("span", "sr-only", ", not activated"));
    if (status) e.appendChild(document.createTextNode(status));
    return e;
  }

  // A row per bonus topic, closed by default: the summary leads with "5% on gas", "On dining" or "Dining at
  // Amazonia Bowl" (when what matched is not what was typed) over a one-line list of the cards and rates; open,
  // every card with its status ("(activated)", "(below Smartly 4%)"), highest rate first, then the notes.
  // Rows with no card and the Custom Cash focus hints stay plain.
  // groups: [{ label: "For “starbucks”" or null, rows }].
  function renderBonusRows(groups) {
    var box = el("div", "bonusrows");
    groups.forEach(function (grp) {
      var rows = grp.rows;
      if (!rows.length && !(rows.hints || []).length) return;
      if (grp.label) box.appendChild(el("div", "bgroup", grp.label));
      rows.forEach(function (t) {
        var items = byRateDesc(t.items, function (it) { return it.g._rate; });
        var rates = [];
        items.forEach(function (it) { if (rates.indexOf(it.g._rate) === -1) rates.push(it.g._rate); });
        var same = rates.length === 1;
        var cls = t.muted || !items.length ? "bonusrow muted" : "bonusrow";
        var notes = [];
        // What triggered the row (a search only; the Dining button names none), so a stray match is easy to spot.
        if (t.names.length) notes.push("Matched: " + t.names.slice(0, 3).join(", ") +
          (t.names.length > 3 ? " and " + (t.names.length - 3) + " more" : ""));
        if (items.length) notes.push("Likely, not certain: how the merchant codes the purchase decides it.");
        notes = notes.concat(t.notes);
        if (!items.length) {
          var plain = el("div", cls);
          plain.appendChild(el("div", "bhead", cap(t.name) + (t.lead ? " at " + t.lead : "")));
          plain.appendChild(el("div", null, "no card bonus is likely here (see note below)."));
          notes.forEach(function (n) { plain.appendChild(el("div", "bnote", n)); });
          box.appendChild(plain);
          return;
        }
        var row = el("details", cls);
        row.setAttribute("data-topic", (grp.label || "") + "|" + t.name); // the day redraw reopens it by it when its lead changed
        var sum = el("summary", "bsum");
        var l1 = el("span", "bl1");
        l1.appendChild(tagIcon());
        l1.appendChild(el("span", "bhead", t.lead ? cap(t.name) + " at " + t.lead : (same ? pct(rates[0]) + "% on " : "On ") + t.name));
        var chev = el("span", "bchev");
        chev.setAttribute("aria-hidden", "true");
        l1.appendChild(chev);
        sum.appendChild(l1);
        var ev = items.filter(function (it) { return it.everyday; })[0];
        // Closed: the entries at or above the everyday rate on one line; "+N" counts the rest.
        var line = el("span", "bline"), below = 0;
        items.forEach(function (it) {
          if (it.below && ev) { below++; return; }
          var e = bonusEntry("span", "bent", it, null, it.e.activation === "not_confirmed");
          if (line.firstChild) e.insertBefore(el("span", "sr-only", ", "), e.firstChild);
          line.appendChild(e);
        });
        var more = el("span", "bplus");
        more.appendChild(el("span", null, "")).setAttribute("aria-hidden", "true");
        more.appendChild(el("span", "sr-only", ""));
        line.appendChild(more);
        line.setAttribute("data-below", String(below));
        sum.appendChild(line);
        // Closed: the row's caveats on one truncated line (open, they show in full under the entries).
        if (t.notes.length) sum.appendChild(el("span", "bcav", t.notes.join(" ")));
        row.appendChild(sum);
        // Open: one entry per line, then the notes.
        var body = el("div", "bbody"), ul = el("ul", "blist");
        items.forEach(function (it) {
          var st = bonusStatus(it.e, it.g) + (it.below && ev ? " (below " + ev.e.card + " " + pct(ev.g._rate) + "%)" : "");
          ul.appendChild(bonusEntry("li", it.below ? "bbelow" : null, it, st));
        });
        body.appendChild(ul);
        notes.forEach(function (n) { body.appendChild(el("div", "bnote", n)); });
        row.appendChild(body);
        if (lineFit) lineFit.observe(line);
        else setTimeout(function () { fitLine(line); }, 0);
        box.appendChild(row);
      });
      // "Citi Custom Cash 5% here only if select travel or select transit is your actual top eligible category this
      // cycle (not your CardSelector focus)": the focus is only CardSelector's assumption, never a Citi setting.
      (rows.hints || []).forEach(function (h) {
        box.appendChild(el("div", "bonusrow hint", h.entry.card + " " + pct(h.entry.rate) + "% here only if " +
          h.names.join(" or ") + " is your actual top eligible category this cycle (not your CardSelector focus)"));
      });
    });
    return box;
  }

  // Stable sort, highest rate first (ties keep file order).
  function byRateDesc(arr, rate) {
    return arr.map(function (x, i) { return { x: x, i: i }; })
      .sort(function (a, b) { return rate(b.x) - rate(a.x) || a.i - b.i; })
      .map(function (w) { return w.x; });
  }

  // The one-line summary of a card's groups, highest rate first: "5% grocery, dining, Red Cross",
  // "5% Costco gas, 4% gas & EV, 3% dining & travel, 2% Costco". Long topic names get a short form here only
  // (the rows keep the full names).
  var SHORT_TOPIC = { "gas stations": "gas", "EV charging": "EV", "Costco warehouse and Costco.com": "Costco",
    "grocery stores": "grocery", "American Red Cross donations": "Red Cross" };
  function rateSummary(e) {
    var by = {}, rates = [];
    e.match.forEach(function (g) {
      var n = SHORT_TOPIC[g.name] || g.name;
      if (!(g._rate in by)) { by[g._rate] = []; rates.push(g._rate); }
      if (by[g._rate].indexOf(n) === -1) by[g._rate].push(n);
    });
    return rates.sort(function (a, b) { return b - a; }).map(function (r) {
      return [r, by[r].length === 2 ? by[r].join(" & ") : by[r].join(", ")];
    });
  }

  // The strip: every live entry; tap the summary to expand (collapsed by default on every screen).
  // Each entry is one line, card and rates first ("Freedom: 5% grocery, dining, Red Cross"); its activation
  // status and controls stay visible under it, and the issuer wording, dates, caps and notes go behind
  // "More details".
  function renderStrip() {
    blist.textContent = "";
    var today = todayISO();
    stripDay = today; // a render() alone doesn't redraw the strip, so the day redraw checks this too
    var live = bonus ? bonus.entries.filter(function (e) { return bonusLive(e, today); }) : [];
    bstrip.hidden = !live.length;
    if (!live.length) return;
    var pending = live.filter(function (e) { return e.activation === "not_confirmed"; }).length;
    bsum.textContent = "";
    bsum.appendChild(document.createTextNode("Bonus categories"));
    if (pending) bsum.appendChild(el("span", "bwarn", "⚠ " + pending + " not activated"));
    var ev = live.filter(function (e) { return e.everyday; })[0];
    var ed = editing();
    live.forEach(function (e) {
      var li = el("li"), head = el("div"), more = [];
      li.setAttribute("data-eid", e.id); // the day redraw finds the entry again by it (More details, focus)
      li.appendChild(head);
      head.appendChild(withDot(el("span", "bcard", e.card + ": "), e.card));
      var rate = function (r) { head.appendChild(el("span", "brate", pct(r) + "%")); };
      if (e.everyday) {
        // "Smartly: Everyday 4% · first $10,000 per billing cycle, some categories 2%" (its usual everyday rate).
        head.appendChild(document.createTextNode("Everyday "));
        rate(e.rate);
        if (e.strip_note) head.appendChild(document.createTextNode(" · " + e.strip_note));
        more.push(cap(e.categories_text));
      } else if (e.eligible) {
        // "5% on top category, CardSelector focus: restaurants" (signed in, the picker below shows it). The focus is
        // CardSelector's assumption only; it elects nothing at Citi.
        rate(e.rate);
        head.appendChild(document.createTextNode(" on top category" + (e.planned && !ed ? ", CardSelector focus: " + e.planned : "")));
        more.push(cap(e.categories_text.replace(/^on\s+/, "")) + ".");
      } else {
        // "5% grocery, dining, Red Cross"; "5.25% online shopping, 3.5% grocery & wholesale clubs".
        rateSummary(e).forEach(function (r, i) {
          if (i) head.appendChild(document.createTextNode(", "));
          rate(r[0]);
          head.appendChild(document.createTextNode(" " + r[1]));
        });
        if (e.choices) {
          // Base rates here; the boost note follows.
          more.push(pct(e.rate) + "% " + e.categories_text + " (choice now: " + e.choice + "), before any Preferred Rewards boost.");
          more.push("Choices: " + e.choices_text);
        } else more.push(e.rate !== null ? pct(e.rate) + "% " + e.categories_text + "." : cap(e.categories_text) + ".");
      }
      if (e.start && e.end) more.push(rangeText(e.start, e.end) + ".");
      if (!e.everyday) more.push(cap(e.cap_text) + ".");
      if (e.strip_note && !e.everyday) more.push(cap(e.strip_note) + ".");
      var bn = e._boost ? boostNote(boostCard(e)) : null;
      if (bn) more.push(bn);
      if (e.eligible) more.push("Eligible: " + e.eligible.map(function (it) {
        // Other live entries paying on the same topic, highest rate first; a lower rate is shown.
        var also = [];
        live.forEach(function (o) {
          if (o === e) return;
          var g = o.match.filter(function (g) { return g.name === (it.topic || it.name); })[0];
          if (g) also.push({ name: o.short || o.card, rate: g._rate });
        });
        also = byRateDesc(also, function (a) { return a.rate; }).map(function (a) {
          return a.name + (a.rate < e.rate ? " " + pct(a.rate) + "%" : "");
        });
        return it.name + (also.length ? " (also " + also.join(", ") + ")" : "");
      }).join(", "));
      // The everyday card is not listed under every category; one note instead.
      if (e.eligible && ev && ev.rate < e.rate) more.push(ev.card + "'s usual everyday rate is " + pct(ev.rate) + "%, so only a " + pct(e.rate) + "% " + e.card + " result normally beats it.");
      if (e.activation === "not_needed") more.push("No activation needed.");
      // Activation: the control follows the status ("⚠ Not activated … [Mark activated]", "Activated Undo").
      if (e.activation === "not_confirmed" || e.activation === "activated") {
        var st = el("div", "bstat");
        if (e.activation === "not_confirmed") {
          var by = e.activate_by ? "activate by " + fmtDate(e.activate_by) : "";
          var note = e.activation_note ? e.activation_note : "";
          if (ed && e.activate_by) {
            // Signed in: the button sits on the warning line, the deadline follows it.
            st.appendChild(el("span", "bwarn", "⚠ Not activated"));
            st.appendChild(editBtn("Mark activated", { type: "bonus.activation", id: e.id, from: "not_confirmed", to: "activated" }, "edfill"));
            st.appendChild(el("span", "bmeta bby", cap(by) + "." + (note ? " " + note + "." : "")));
          } else {
            st.appendChild(el("span", "bwarn", "⚠ Not activated" + (by ? ", " + by : "") + (note ? ". " + note : "")));
          }
        } else {
          st.appendChild(el("span", "bok", "Activated"));
          if (ed && e.activate_by) st.appendChild(editBtn("Undo", { type: "bonus.activation", id: e.id, from: "activated", to: "not_confirmed" }, "edlink"));
        }
        li.appendChild(st);
      }
      if (ed && e.eligible && e.planned) li.appendChild(focusPicker(e, "planned"));
      if (ed && e.choices && e.choice) {
        li.appendChild(focusPicker(e, "choice"));
        li.appendChild(el("div", "bmeta bchoice", "Change it at Bank of America first, then here."));
      }
      if (more.length) {
        var d = el("details", "bmore");
        d.appendChild(el("summary", null, "More details"));
        more.forEach(function (t) { d.appendChild(el("p", null, t)); });
        li.appendChild(d);
      }
      blist.appendChild(li);
    });
  }

  // ---- Quick picks (home screen): the card to use for a type of purchase, with no merchant offer ----
  // Always the same six issuer-style topics: [tile label, the topic name the bonus and card rate groups use].
  // Each is answered by the answer card's own rules: merchantLines on a topic instead of a merchant (rateAt,
  // pick, After activating only when it beats Ready now, Citi Custom Cash conditional), so the two can't drift.
  var QUICK_PICKS = [["Dining", "dining"], ["Grocery stores", "grocery stores"], ["Online shopping", "online shopping"],
    ["Gas stations", "gas stations"], ["Entertainment", "entertainment"], ["Utilities", "utilities"]];
  var QP_NOTE_MAX = 80; // a longer sourced note is left off, so the tile stays compact
  var qpEl = document.getElementById("qp");

  // A type of purchase as a merchant with no offers and no name, bought under Any (groupFitsBy matches it by topic).
  function topicMerchant(topic) {
    return { key: "topic:" + topic, name: topic, names: [], all: [], offers: [], topic: topic, ch: "any", inStore: false, online: false, rates: {} };
  }
  // "Q4 · through Dec 31" for a dated bonus (a calendar quarter gets its name), "Through Nov 30" otherwise; null
  // for an undated rate (standing, everyday).
  function datedLabel(e) {
    if (!e || !e.start || !e.end) return null;
    var s = /^(\d{4})-(\d{2})-01$/.exec(e.start), q = s && (+s[2] - 1) % 3 === 0 ? (+s[2] + 2) / 3 : 0;
    var last = q ? s[1] + "-" + ("0" + q * 3).slice(-2) + "-" + (q === 1 || q === 4 ? "31" : "30") : null;
    return (last === e.end ? "Q" + q + " · through " : "Through ") + tileDate(e.end);
  }
  // A date that stays on one line in a tile ("Dec 15").
  function tileDate(iso) { return fmtDate(iso).replace(/ /g, " "); }
  // "Incl. 75% Preferred Rewards (50% after Dec 15)": the boost in the leading rate r, worded as the bonus rows
  // ("incl. 75% Preferred Rewards") and the boost note ("50% after Dec 15") word it. The percent is the one the
  // rate was worked out with (a bonus group's rate is boosted when the file is readied), so the note always
  // matches the rate shown.
  function boostShort(name, r) {
    var p = cardsRaw && cardsRaw.preferred_rewards, b = r && r.e ? r.e._boost : boostPct(name);
    if (!b) return null;
    return "Incl. " + b + "% Preferred Rewards" + (b === p.percent && todayISO() <= p.until && p.then_percent !== p.percent ?
      " (" + p.then_percent + "% after " + tileDate(p.until) + ")" : "");
  }
  // At most one short note, only from the data: the leading card's Preferred Rewards boost, its rate group's
  // rate_note or button_note, else a tied card as the answer card's tie note words it ("Costco Visa also 4%, 5% at
  // Costco gas"). Nothing else is written; with none, the tile has no note. Smartly's own caveat is on the Everyday tile.
  function quickNote(p) {
    var lead = p.wins[0], g = lead.base.g, notes = [boostShort(lead.C.name, lead.base), g && g.rate_note, g && g.button_note];
    p.wins.slice(1).forEach(function (c) {
      if (c.base.g && c.base.g.rate_note) notes.push(c.C.name + " also " + pct(c.total) + "%, " + c.base.g.rate_note);
    });
    return notes.filter(function (n) { return n && n.length <= QP_NOTE_MAX; })[0] || null;
  }
  // One topic's answer: the best ready rate and its leading card (Smartly wins a tie it is in, then cards.json
  // order), how many other cards are ready at that rate, the dated label of a dated winning rate, a bonus not yet
  // activated only when it beats the ready rate, Citi Custom Cash only when its conditional rate would beat it
  // (never ready, never counted), and the note.
  function quickPick(topic, today) {
    var L = merchantLines(topicMerchant(topic), today);
    if (!L) return null;
    var p = L.ready, lead = p.wins[0];
    var aLine = L.lines.filter(function (l) { return l.label === "After activating"; })[0];
    return {
      rate: p.total, card: lead.C.name, more: p.wins.length - 1, cat: !!lead.base.cat, dated: datedLabel(lead.base.e),
      after: L.after ? { card: L.after.wins[0].C.name, rate: L.after.total, gain: aLine.gain } : null,
      cond: L.cond && L.cond.strong ? L.cond : null, note: quickNote(p)
    };
  }
  // The section under the search box on the home screen (no search, category or card picked; not What changed or
  // the Used list): a heading, the six tiles in a two-column grid, then the full-width Everyday default tile.
  // Tiles are information only for now (no tap action).
  function renderQuickPicks(show, today) {
    qpEl.textContent = "";
    qpEl.hidden = !(show && bonus && cardsCfg && payCards().length);
    if (qpEl.hidden) return;
    var picks = QUICK_PICKS.map(function (q) { return { label: q[0], p: quickPick(q[1], today) }; });
    var head = el("div", "qphead");
    head.appendChild(el("h2", "qph", "Quick picks · no offer needed")).id = "qp-h";
    // One "Likely" for the section when a category rate leads any tile (merchant coding decides it).
    if (picks.some(function (x) { return x.p && x.p.cat; })) head.appendChild(likelyTag());
    qpEl.appendChild(head);
    var ul = el("ul", "qpgrid");
    picks.forEach(function (x) {
      var p = x.p, li = el("li", "qpt");
      li.setAttribute("data-topic", x.label);
      li.appendChild(el("div", "qpn", x.label));
      if (!p) { ul.appendChild(li); return; }
      var w = el("div", "qpw");
      w.appendChild(el("span", "qpr", pct(p.rate) + "%"));
      w.appendChild(withDot(el("span", "qpc", p.card), p.card));
      li.appendChild(w);
      if (p.more) li.appendChild(el("div", "qpm", "+" + p.more + " more ready"));
      if (p.dated) li.appendChild(el("div", "qpm qpd", p.dated));
      if (p.after) {
        var a = el("div", "qpx qpa", "After activating: " + p.after.card + " " + pct(p.after.rate) + "%");
        a.appendChild(el("span", "usegain", p.after.gain));
        li.appendChild(a);
      }
      if (p.cond) {
        var c = el("div", "qpx qpcond", p.cond.e.card + " " + pct(p.cond.rate) + "% · conditional");
        c.appendChild(el("span", "sr-only", ", " + condWhy(p.cond.e)));
        c.appendChild(el("span", "usegain", p.cond.gain));
        li.appendChild(c);
      }
      if (p.note) li.appendChild(el("div", "qpnote", p.note));
      ul.appendChild(li);
    });
    qpEl.appendChild(ul);
    // "Everyday default · Smartly 4%" with its caveat from the data ("First $10,000 per billing cycle, then 2%; ...").
    var ev = everyday(today);
    if (ev) {
      var e = el("div", "qpt qpe"), t = el("div", "qpw");
      t.appendChild(el("span", "qpn", "Everyday default · "));
      t.appendChild(withDot(el("span", "qpc", ev.card + " " + pct(ev.rate) + "%"), ev.card));
      e.appendChild(t);
      var en = ev.headline_note || ev.strip_note;
      if (en) e.appendChild(el("div", "qpnote", cap(en)));
      qpEl.appendChild(e);
    }
  }

  // Results in pages of merchant containers ("Show N more merchants"), never splitting one: the page sizes count
  // containers. A redraw in the same view (after a save) shows as many containers as before. sections: [{ list:
  // sorted offers, node: a heading or null, label(o): the row's gone label or null, key }], each grouped into
  // containers on its own (What changed's Gone groups never merge across), a heading put in as its first container
  // shows. mode: the sort, for A to Z / Z to A container order (containersOf). setCount(live offers shown, rows
  // shown), when given, is told what the shown containers hold.
  function pagedList(sections, pageSize, today, prefix, setCount, mode) {
    var items = [];
    sections.forEach(function (sec) {
      var cs = containersOf(sec.list, mode);
      cs.forEach(function (c, i) { items.push({ c: c, sec: sec, head: i === 0 ? sec.node : null }); });
    });
    var ul = null, more = el("button", "more");
    more.type = "button";
    main.appendChild(more);
    var next = 0, liveShown = 0, rowsShown = 0;
    var showMore = function (n) {
      var end = Math.min(next + n, items.length);
      for (; next < end; next++) {
        var it = items[next], k = it.sec.key ? prefix + "-" + it.sec.key : prefix;
        if (it.head) { main.insertBefore(it.head, more); ul = null; }
        if (!ul) { ul = el("ul", "results"); main.insertBefore(ul, more); }
        it.c.rows.forEach(function (o) { rowsShown++; if (isLive(o, today)) liveShown++; });
        ul.appendChild(renderContainer(it.c, k + ":" + it.c.key, k + next, it.sec.label));
      }
      shownBefore = next;
      more.hidden = next >= items.length;
      var left = items.length - next;
      more.textContent = "Show " + Math.min(pageSize, left) + " more merchant" + (Math.min(pageSize, left) === 1 ? "" : "s") + " (" + left + " left)";
      if (setCount) setCount(liveShown, rowsShown);
    };
    more.addEventListener("click", function () { showMore(pageSize); });
    showMore(Math.max(pageSize, shownBefore));
  }

  // The Used filter (signed in): every used offer matching the search, card and category, newest used first
  // (status_since; the sort menu doesn't apply). No headline, bonus rows or Recently unavailable. An offer
  // restored here stays in its place until the search or a filter changes. where: " in Dining on U.S. Bank".
  function renderUsedList(query, today, inUsedScope, where) {
    renderActs(null);
    renderHeadline([], today, false);
    var list = search(query, function (o) { return inUsedScope(o) && (o.status === "used" || kept(o)); });
    var since = function (o) { return kept(o) ? keep[o.id] : o.status_since || ""; };
    list.sort(function (a, b) { var x = since(a), y = since(b); return x === y ? byMerchant(a, b) : (x < y ? 1 : -1); });
    countEl.textContent = ""; // the Used button shows the count
    if (list.length) return pagedList([{ list: list }], PAGE, today, "u", null, null);
    var p = el("p", "empty", "No used offers" + where);
    if (compact(query) !== "") {
      p.appendChild(document.createTextNode(" match "));
      p.appendChild(el("strong", null, "“" + query.trim() + "”"));
    }
    p.appendChild(document.createTextNode("."));
    main.appendChild(p);
  }

  // ---- What changed (a mode of the main page) ----
  // The New or Gone list of the picked card (All cards: each card against its own latest read), through the same
  // search, filters, sort and Show more as the main list. No headline, bonus rows or Recently unavailable.
  // inAnyChan: the scope without the In store / Online choice (for the count it hides).
  function renderWcList(query, today, inScope, inAnyChan, scope, narrowed) {
    renderHeadline([], today, false);
    // New keeps an offer marked used in this view in its place (dimmed) until the search or a filter changes, as
    // the main list does; the counts are the New rule's.
    var newAll = search(query, function (o) { return inScope(o) && (isNew(o, today) || (o.status === "used" && kept(o) && addedByRead(o))); });
    var goneAll = search(query, function (o) { return inScope(o) && isDropped(o); });
    var nNew = newAll.filter(function (o) { return actOk(o) && isNew(o, today); }).length;
    var nGone = goneAll.filter(actOk).length;
    renderWcTabs(nNew, nGone);
    var isNewTab = wc.tab === "new", all = isNewTab ? newAll : goneAll;
    renderActs(actCounts(isNewTab ? all.filter(function (o) { return isNew(o, today); }) : all));
    var list = actMode === "any" ? all : all.filter(actOk);
    var n = isNewTab ? nNew : nGone;
    // The count line, with the main list's hints: "(showing N, keep typing to narrow)" while a plain search
    // shows part of the list, and how many the In store / Online choice hides.
    var inTab = isNewTab ? function (o) { return isNew(o, today); } : isDropped;
    var chanHidden = chanMode === "any" ? 0 : search(query, function (o) { return !chanOk(o) && actOk(o) && inAnyChan(o) && inTab(o); }).length;
    // shown: the New rows (an offer marked used here doesn't count) or the Gone rows on the page so far.
    var counted = isNewTab ? list.filter(function (o) { return isNew(o, today); }) : list;
    var setCount = function (liveShown, rowsShown) {
      var shown = isNewTab ? liveShown : rowsShown;
      countEl.textContent = countLine(counted, chanHidden, isNewTab ? " new offer" : " gone offer", scope,
        !narrowed && n > shown ? " (showing " + shown + ", keep typing to narrow)" : "").join(" · ");
    };
    setCount(n, n);
    if (!list.length) {
      var chw = chanMode !== "any" ? (chanMode === "store" ? ", in store" : ", online") : "";
      var actw = actMode !== "any" ? (actMode === "ready" ? ", ready now" : ", needs activation") : "";
      var p = el("p", "empty", "No " + (isNewTab ? "new" : "gone") + " offers" +
        (scope.slice(0, scope.length - actw.length) + chw + actw).replace(/^,/, ""));
      if (compact(query) !== "") {
        p.appendChild(document.createTextNode(" match "));
        p.appendChild(el("strong", null, "“" + query.trim() + "”"));
      }
      p.appendChild(document.createTextNode("."));
      main.appendChild(p);
      return;
    }
    var cmp = comparator(sortMode, query, all);
    if (isNewTab) return pagedList([{ list: list.sort(cmp) }], narrowed ? PAGE : MAX_SHOWN, today, "wn", setCount, sortMode);
    // Gone: "Pulled early N" then "Ended N" when any gone offer has an end date (offers with none, on All cards,
    // follow under "Dropped N"); the sort applies inside each group, and each group has its own merchant containers
    // (an offer never leaves its group to join another's container). N counts offers. A group the search and
    // filters leave empty has no heading. No end dates at all: no headings.
    var by = { pulled: [], ended: [], dropped: [] };
    list.forEach(function (o) { by[droppedKind(o)].push(o); });
    var keys = by.pulled.length || by.ended.length ? ["pulled", "ended", "dropped"].filter(function (k) { return by[k].length; }) : [];
    var NAMES = { pulled: "Pulled early", ended: "Ended", dropped: "Dropped" };
    var sections = keys.map(function (k) {
      var h = el("h3", "wcgroup", NAMES[k] + " ");
      h.appendChild(el("span", "n", String(by[k].length)));
      return { list: by[k].sort(cmp), node: h, label: droppedLabel, key: k };
    });
    if (!keys.length) sections = [{ list: list.sort(cmp), label: droppedLabel }];
    pagedList(sections, narrowed ? PAGE : MAX_SHOWN, today, "wg", setCount, sortMode);
  }

  // The panel under the search box: back arrow, the card ("All cards"), the reads compared, then New and Gone.
  var wcEl = document.getElementById("wc"), wcName = document.getElementById("wcname"), wcSub = document.getElementById("wcsub");
  var wcTabs = document.getElementById("wctabs");
  function renderWcPanel() {
    wcEl.hidden = !wc;
    wrapEl.classList.toggle("wcon", !!wc);
    if (!wc) return;
    wcName.textContent = "";
    wcName.appendChild(withDot(el("span", null, card || "All cards"), card));
    var r = card === null ? null : readOf(card);
    wcSub.textContent = card === null ? "Each card's latest read" : !r ? "No full read yet" :
      "Read " + fmtDate(r.latest) + (r.prev ? " · compared with " + fmtDate(r.prev) : " · first read");
  }
  function renderWcTabs(nNew, nGone) {
    wcTabs.textContent = "";
    [["new", "New", nNew], ["gone", "Gone", nGone]].forEach(function (t) {
      var b = el("button", "cat cardbtn wctab", t[1]);
      b.appendChild(el("span", "n", " " + t[2]));
      b.type = "button";
      b.setAttribute("aria-pressed", String(wc.tab === t[0]));
      b.addEventListener("click", function () {
        if (wc.tab === t[0]) return;
        wc.tab = t[0];
        renderCuisines();
        render();
      });
      wcTabs.appendChild(b);
    });
  }
  // Entering from a freshness row: that card, its New list (Gone when it added nothing), no search or other
  // filter, so the buttons show the row's numbers. One history entry, so the phone's back button leaves.
  function enterWc(c, tab) {
    if (!wc) {
      var ex = main.querySelector("details.expired");
      // The view as it was (pages shown, rows kept in place, Recently unavailable open or closed) comes back too.
      wc = { saved: { q: input.value, category: category, card: card, cuisine: cuisine, chan: chanMode, act: actMode,
        sort: sortMode, used: usedMode, y: window.scrollY, view: viewSig, shown: shownBefore, keep: keep, exOpen: ex ? ex.open : null },
        token: String(Date.now()) + Math.random() };
      try { history.pushState({ cardselectorWc: wc.token }, ""); } catch (e) {}
    }
    wc.tab = tab;
    wc.from = c;
    input.value = "";
    category = null; cuisine = null; chanMode = "any"; actMode = "any"; card = c;
    renderChans(); renderCats(); renderCards(); renderCuisines(); render();
    window.scrollTo(0, 0);
    document.getElementById("wcback").focus({ preventScroll: true });
  }
  // Leaving puts back the search, filters, sort and scroll from before entering.
  function leaveWc() {
    if (!wc) return;
    var s = wc.saved, from = wc.from;
    wc = null;
    input.value = s.q;
    category = s.category; card = s.card; cuisine = s.cuisine; chanMode = s.chan; actMode = s.act; usedMode = s.used;
    if (card !== null && !data.offers.some(function (o) { return o.card === card; })) card = null; // gone with new data
    if (category !== null && (data.categories || []).indexOf(category) === -1) category = null;
    sortMode = s.sort;
    sortEl.value = sortMode;
    showSortHelp();
    viewSig = s.view; shownBefore = s.shown; keep = s.keep; // the same view again: its pages and in-place rows stay
    renderChans(); renderCats(); renderCards(); renderCuisines(); render();
    var ex = main.querySelector("details.expired");
    if (ex && s.exOpen !== null) ex.open = s.exOpen;
    var row = Array.prototype.filter.call(flist.querySelectorAll(".fhead"), function (b) { return b.dataset.card === from; })[0];
    if (row) row.focus({ preventScroll: true });
    window.scrollTo(0, s.y);
  }
  // The entry pushed on entering carries this visit's token; any other entry (the one before, or an old forward one) leaves.
  function onWcEntry(st) { return !!wc && !!st && st.cardselectorWc === wc.token; }
  // The back arrow leaves at once, then steps back over the pushed entry (that popstate finds the mode off, and a
  // second tap finds nothing to do, so a quick double tap can't leave the site).
  document.getElementById("wcback").addEventListener("click", function () {
    if (!wc) return;
    var back = onWcEntry(history.state);
    leaveWc();
    if (back) history.back();
  });
  window.addEventListener("popstate", function (e) {
    if (wc && !onWcEntry(e.state)) leaveWc();
  });
  // A reload starts outside the mode. Reloaded on the entry pushed on entering, step back over it (the same page, so
  // nothing loads again), so the phone's back button needs one press, not two, to leave.
  try { if (history.state && history.state.cardselectorWc) history.back(); } catch (e) {}

  function render() {
    // Best offer totals stay cached until something behind a card rate changes (date, activation, focus, choice).
    var sig = todayISO() + (cardsCfg ? 1 : 0) + JSON.stringify(bonus ? bonus.entries.map(function (e) {
      return [e.activation, e.planned, e.choice];
    }) : null);
    if (sig !== totalSig) { totalCache = {}; totalSig = sig; }
    var query = input.value;
    var today = todayISO();
    lastDay = today; // the date this render used (the day redraw compares it)
    window.__renders = (window.__renders || 0) + 1; // for the tests
    main.textContent = "";
    liveNames = null; // the Still on index follows the offers as they are now
    if (lineFit) lineFit.disconnect(); // the old bonus rows are gone
    var hasQuery = compact(query) !== "";
    var filtered = category !== null || card !== null;
    var usedOn = usedMode && editing() && !wc; // What changed ignores the Used filter
    // A new search or filter ends the in-place rows and the extra pages of the last view.
    var view = JSON.stringify([query, category, card, cuisine, chanMode, actMode, sortMode, usedOn, wc && wc.tab]);
    if (view !== viewSig) { keep = {}; viewSig = view; shownBefore = 0; }
    // Card rates here stays as opened while the search and filters stay (a channel change or a save keeps it).
    var rk = JSON.stringify([query, category, card, cuisine, !!wc]);
    if (rk !== ratesKey) { ratesOpen = false; ratesKey = rk; }
    // Any filter picked (In store / Online, Activation too) lists the offers it keeps, in pages.
    var narrowed = filtered || chanMode !== "any" || actMode !== "any";
    var cuis = category === "Dining" ? cuisine : null;
    var inScope = function (o) {
      return (category === null || o.category === category) && (card === null || o.card === card) &&
        (cuis === null || cuisineLabel(o) === cuis) && chanOk(o);
    };
    var inCat = function (o) { return inScope(o) && actOk(o); };
    // The answer card works per channel itself, so it reads every channel (the same scope otherwise).
    var inAnyChan = function (o) {
      return (category === null || o.category === category) && (card === null || o.card === card) &&
        (cuis === null || cuisineLabel(o) === cuis);
    };
    // The Used filter keeps only the search, card and category (with its cuisine).
    var inUsedScope = function (o) {
      return (category === null || o.category === category) && (card === null || o.card === card) &&
        (cuis === null || cuisineLabel(o) === cuis);
    };
    // "in Dining", "on U.S. Bank", "in Dining on U.S. Bank", "in Dining: Persian & Mediterranean", ", ready now"
    // (the channel choice has its own words on the count line: countLine).
    var scope = (category !== null ? " in " + category + (cuis !== null ? ": " + cuis : "") : "") +
      (card !== null ? " on " + card : "") +
      (actMode !== "any" ? (actMode === "ready" ? ", ready now" : ", needs activation") : "");
    renderFilterSummary();
    renderUsed(editing() && !wc ? search(query, function (o) { return o.status === "used" && inUsedScope(o); }).length : null);
    // The Used list ignores In store / Online and Activation: their rows are greyed out and can't be changed.
    [chansEl, actsEl].forEach(function (g) {
      g.parentNode.classList.toggle("off", usedOn);
      Array.prototype.forEach.call(g.querySelectorAll("button"), function (b) { b.disabled = usedOn; });
    });
    renderWcPanel();
    renderFreshness(); // its New and Gone counts follow saves and new data
    // Quick picks: the home screen only (a search, category or card answers in the answer card instead).
    renderQuickPicks(!wc && !usedOn && !hasQuery && category === null && card === null, today);
    if (wc) return renderWcList(query, today, inScope, inUsedScope, scope, narrowed);
    if (usedOn) return renderUsedList(query, today, inUsedScope,
      (category !== null ? " in " + category + (cuis !== null ? ": " + cuis : "") : "") + (card !== null ? " on " + card : ""));
    var gone = search(query, function (o) { return inCat(o) && isGone(o, today); });
    // One comparator for every list, with or without a search or filters (set again below once the live
    // matches are known, for the Best offer whole-word grouping).
    var cmp = comparator(sortMode, query);

    if (!hasQuery && !narrowed) {
      var liveList = data.offers.filter(function (o) { return isLive(o, today) && chanOk(o); });
      var live = data.offers.filter(function (o) { return isLive(o, today); }).length;
      renderActs(actCounts(liveList));
      countEl.textContent = "";
      renderHeadline([], today, false);
      main.appendChild(el("p", "hint", "Type part of a store name to see which cards have a bonus there, " +
        "or pick a category or card. " + live + " active offers loaded."));
    } else {
      // Every match in scope, then the Activation choice (its buttons count what each choice keeps). Offers
      // marked used in this view stay in the list (dimmed), and in the sort's pool, so nothing moves.
      var hits = search(query, function (o) { return inScope(o) && (isLive(o, today) || (o.status === "used" && kept(o))); });
      var allHits = hits.filter(function (o) { return isLive(o, today); }); // the headline ignores the Activation filter
      // The answer card's merchants and offers, whatever the channel choice (it filters them per channel itself).
      var anyHits = chanMode === "any" ? allHits : search(query, function (o) { return inAnyChan(o) && isLive(o, today); });
      cmp = comparator(sortMode, query, hits);
      renderActs(actCounts(allHits));
      if (actMode !== "any") hits = hits.filter(actOk);
      var liveCount = hits.filter(function (o) { return isLive(o, today); }).length;
      // How many live matches the In store / Online choice is hiding (shown on the count line).
      var chanHidden = chanMode === "any" ? 0 : search(query, function (o) {
        return !chanOk(o) && actOk(o) && isLive(o, today) && (category === null || o.category === category) &&
          (card === null || o.card === card) && (cuis === null || cuisineLabel(o) === cuis);
      }).length;
      // Sorted as a copy: the headline (allHits) keeps the search's own name-match order.
      hits = hits.slice().sort(cmp);
      // The count line; a search with no filter adds a narrowing hint while not everything is shown.
      var listLive = hits.filter(function (o) { return isLive(o, today); });
      var setCount = function (shown) {
        var parts = countLine(listLive, chanHidden, " offer", scope, !narrowed && liveCount > shown ? " (showing " + shown + ", keep typing to narrow)" : "");
        if (gone.length) parts.push(gone.length + " recently unavailable");
        countEl.textContent = parts.join(" · ");
      };
      setCount(Math.min(hits.length, MAX_SHOWN));
      // Bonus rows: from the search and from the category button, labelled apart when both are active.
      var qRows = bonusRows(query, today, "query"), bRows = bonusRows(query, today, "button");
      var both = hasQuery && category !== null;
      // The headline follows the search group when there is a search, else the category button's rows. A topic
      // the search already shows is not repeated under the button. The rows go in the card's "Card rates here".
      var headRows = hasQuery ? qRows : bRows;
      if (both) {
        var shownTopics = qRows.map(function (t) { return t.name; });
        var keepHints = bRows.hints;
        bRows = bRows.filter(function (t) { return shownTopics.indexOf(t.name) === -1; });
        bRows.hints = keepHints;
      }
      var anyBonus = qRows.length || bRows.length || bRows.hints.length;
      renderHeadline(headRows, today, hasQuery || filtered, { query: query, hits: allHits, any: anyHits, groups: [
        { label: both ? "For “" + query.trim() + "”" : null, rows: qRows },
        { label: both ? "For " + category : null, rows: bRows }
      ] });
      if (!hits.length && anyBonus) {
        main.appendChild(el("p", "empty", "No merchant offers. Card rates above may apply."));
      } else if (!hits.length) {
        var p = el("p", "empty");
        p.appendChild(document.createTextNode("No active offers"));
        if (category !== null) {
          p.appendChild(document.createTextNode(" in "));
          p.appendChild(el("strong", null, category + (cuis !== null ? ": " + cuis : "")));
        }
        if (card !== null) {
          p.appendChild(document.createTextNode(" on "));
          p.appendChild(el("strong", null, card));
        }
        if (chanMode !== "any") p.appendChild(document.createTextNode(chanMode === "store" ? " in store" : " online"));
        p.appendChild(document.createTextNode(hasQuery ? " match " : ""));
        if (hasQuery) p.appendChild(el("strong", null, "“" + query.trim() + "”"));
        p.appendChild(document.createTextNode("."));
        main.appendChild(p);
      } else {
        pagedList([{ list: hits }], narrowed ? PAGE : MAX_SHOWN, today, "d", setCount, sortMode);
      }
    }
    gone.sort(cmp);
    var ex = renderExpired(gone, hasQuery);
    if (ex) main.appendChild(ex);
  }

  // ---- Offer freshness (footer): age since each card's last complete read, by calendar days on the device's local date.
  var FRESH_BANDS = [
    { max: 7, key: "fresh", label: "Fresh" },
    { max: 14, key: "aging", label: "Aging" },
    { max: 30, key: "soon", label: "Refresh soon" },
    { max: Infinity, key: "old", label: "Needs refresh" }
  ];
  var FRESH_UNKNOWN = { key: "unknown", label: "Unknown" };
  var freshPinned = {}; // card -> true while a row's date is opened by a click or tap
  var freshSig = "", freshTimer = 0;

  // Days since 1970-01-01 for a calendar date. Date.UTC on the y/m/d parts is exact (no time zone, no DST).
  function dayNumber(y, m, d) { return Date.UTC(y, m - 1, d) / 86400000; }
  function localToday() { var n = new Date(); return dayNumber(n.getFullYear(), n.getMonth() + 1, n.getDate()); }
  // YYYY-MM-DD -> day number, or null when missing or not a real calendar date (2026-02-30).
  function parseDay(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof iso === "string" ? iso : "");
    if (!m) return null;
    var t = Date.UTC(+m[1], +m[2] - 1, +m[3]), c = new Date(t);
    return c.getUTCFullYear() === +m[1] && c.getUTCMonth() === +m[2] - 1 && c.getUTCDate() === +m[3] ? t / 86400000 : null;
  }
  function fmtLong(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  }
  function ageText(n) { return n === 0 ? "Today" : n === 1 ? "Yesterday" : n + " days ago"; }
  function freshBand(age) {
    if (age === null) return FRESH_UNKNOWN;
    for (var i = 0; i < FRESH_BANDS.length; i++) if (age <= FRESH_BANDS[i].max) return FRESH_BANDS[i];
  }

  // One entry per card in the data: its newest batches entry (a batch is logged only when a read is complete).
  function freshRows(today) {
    var last = {};
    data.offers.forEach(function (o) { if (!(o.card in last)) last[o.card] = null; });
    data.batches.forEach(function (b) {
      var n = parseDay(b.read_date);
      if (!(b.card in last)) last[b.card] = null;
      if (n !== null && (last[b.card] === null || n > parseDay(last[b.card]))) last[b.card] = b.read_date;
    });
    return Object.keys(last).map(function (c) {
      var n = last[c] === null ? null : parseDay(last[c]);
      var age = n === null ? null : today - n;
      if (age !== null && age < 0) age = null; // a date in the future can't be vouched for
      return { card: c, iso: last[c], age: age, band: freshBand(age), future: n !== null && today - n < 0 };
    }).sort(function (a, b) {
      // Unknown first (it needs the most attention), then oldest, then A to Z.
      var x = a.age === null ? Infinity : a.age, y = b.age === null ? Infinity : b.age;
      return x !== y ? (x < y ? 1 : -1) : a.card.localeCompare(b.card, undefined, { sensitivity: "base" });
    });
  }

  function keyboardFocused(btn) {
    try { return btn.matches(":focus-visible"); } catch (e) { return true; }
  }
  // The age line adds what the latest read changed: "Yesterday · +32 new · 21 gone" (a zero part left out, "no
  // changes" when both are, "first read" on a card's first read). A row with changes opens What changed for that
  // card (chevron); the others show the date while the mouse is over the row, a keyboard has focus in it, or a
  // click/tap opened it.
  function freshRow(r, ch) {
    var li = el("li", "frow"), btn = el("button", "fhead"), det = el("p", "fdetail");
    var id = "fdet-" + compact(r.card), rd = readOf(r.card);
    var changed = !!rd && !!rd.prev && !!ch && (ch.n > 0 || ch.g > 0);
    btn.type = "button";
    btn.dataset.card = r.card;
    btn.appendChild(withDot(el("span", "fname", r.card), r.card));
    btn.appendChild(document.createTextNode(" "));
    btn.appendChild(el("span", "fstatus s-" + r.band.key, r.band.label));
    btn.appendChild(document.createTextNode(" "));
    var age = el("span", "fage", r.age === null ? "Unknown" : ageText(r.age));
    if (rd && !rd.prev) age.appendChild(document.createTextNode(" · first read"));
    else if (rd && !changed) age.appendChild(document.createTextNode(" · no changes"));
    else if (changed) {
      if (ch.n) { age.appendChild(document.createTextNode(" · ")); age.appendChild(el("span", "fnew", "+" + ch.n + " new")); }
      if (ch.g) age.appendChild(document.createTextNode(" · " + ch.g + " gone"));
    }
    btn.appendChild(age);
    li.appendChild(btn);
    if (changed) {
      btn.className = "fhead fgo";
      var chev = el("span", "fchev");
      chev.setAttribute("aria-hidden", "true");
      btn.appendChild(chev);
      btn.appendChild(el("span", "sr-only", ", what changed"));
      btn.addEventListener("click", function () { enterWc(r.card, ch.n ? "new" : "gone"); });
      return li;
    }
    btn.setAttribute("aria-controls", id);
    det.id = id;
    det.textContent = "Last full read: " + (r.age === null
      ? (r.future ? "Unknown (date is in the future)" : "Unknown") : fmtLong(r.iso));
    li.appendChild(det);
    var hover = false, focus = false;
    var sync = function () {
      var show = hover || focus || !!freshPinned[r.card];
      det.hidden = !show;
      btn.setAttribute("aria-expanded", show ? "true" : "false");
    };
    // Touch has no hover: a tap is only a click, so the compatibility hover can't keep the date stuck open.
    li.addEventListener("pointerenter", function (e) { if (e.pointerType !== "touch") { hover = true; sync(); } });
    li.addEventListener("pointerleave", function () { hover = false; sync(); });
    btn.addEventListener("focus", function () { focus = keyboardFocused(btn); sync(); });
    btn.addEventListener("blur", function () { focus = false; sync(); });
    btn.addEventListener("click", function () { freshPinned[r.card] = !freshPinned[r.card]; sync(); });
    sync();
    return li;
  }

  function renderFreshness(force) {
    if (!data) return;
    var today = localToday(), rows = freshRows(today), ch = changeCounts(todayISO());
    var sig = today + "|" + rows.map(function (r) { var c = ch[r.card]; return r.card + "=" + r.iso + (c ? "+" + c.n + "-" + c.g : ""); }).join(",");
    if (!force && sig === freshSig) return;
    freshSig = sig;
    var focused = document.activeElement && document.activeElement.classList &&
      document.activeElement.classList.contains("fhead") ? document.activeElement.dataset.card : null;

    var oldest = rows.filter(function (r) { return r.age !== null; })[0];
    var unknown = rows.filter(function (r) { return r.age === null; }).length;
    // The indicator is the oldest known update; an unknown date outranks Fresh (it can't be vouched for).
    var band = oldest ? oldest.band : FRESH_UNKNOWN;
    if (unknown && (band.key === "fresh")) band = FRESH_UNKNOWN;
    fsum.textContent = "";
    var stext = el("span", "fsumtext");
    stext.appendChild(el("span", "ftitle", "Offer freshness"));
    stext.appendChild(el("span", "fsumage", " · Oldest update: " + (oldest ? ageText(oldest.age) : "Unknown") +
      (unknown && oldest ? " · " + unknown + (unknown === 1 ? " date unknown" : " dates unknown") : "")));
    fsum.appendChild(stext);
    var chip = el("span", "fchip s-" + band.key);
    chip.appendChild(el("span", "fdot"));
    chip.lastChild.setAttribute("aria-hidden", "true");
    chip.appendChild(el("span", "sr-only", band.label));
    fsum.appendChild(chip);

    flist.textContent = "";
    rows.forEach(function (r) { flist.appendChild(freshRow(r, ch[r.card])); });
    foot.hidden = !rows.length;
    if (focused) {
      var again = flist.querySelectorAll(".fhead");
      for (var i = 0; i < again.length; i++) if (again[i].dataset.card === focused) again[i].focus();
    }
  }

  // Re-check at local midnight; a sleeping tab or phone also re-checks when it comes back.
  function scheduleFreshness() {
    clearTimeout(freshTimer);
    var n = new Date(), next = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, 0, 0, 0, 500);
    freshTimer = setTimeout(function () { renderFreshness(); scheduleFreshness(); checkDay(); }, Math.max(1000, next - n));
  }
  function refreshFreshness() { renderFreshness(); scheduleFreshness(); }
  function comeBackDay() { refreshFreshness(); checkDay(); }
  document.addEventListener("visibilitychange", function () { if (!document.hidden) comeBackDay(); });
  window.addEventListener("pageshow", comeBackDay);
  window.addEventListener("focus", comeBackDay);

  // ---- A new local day (midnight, or the tab coming back the next day): offers that ended yesterday leave the
  // list, the Ends badges, the bonus strip and the headline follow today. Never during a save or while an edit
  // control has focus (then dayPending, redrawn when the save ends or the focus leaves). Everything the owner
  // has open or picked stays, and focus and scroll stay where they are.
  var lastDay = null, stripDay = null, dayPending = false, tapping = false, tapTimer = 0;
  function dayBlocked() {
    if (saving || tapping) return true;
    var f = document.activeElement;
    return !!f && (main.contains(f) || blist.contains(f)) && f.matches("select, .edsm, .edfill, .edlink");
  }
  function checkDay() {
    var t = todayISO();
    // (No strip drawn yet, e.g. its file didn't load: only the results count.)
    if (!data || lastDay === null || (!dayPending && t === lastDay && (stripDay === null || t === stripDay))) return;
    if (dayBlocked()) { dayPending = true; return; }
    dayPending = false;
    dayRedraw();
  }
  // An edit control losing focus may let a held redraw go.
  document.addEventListener("focusout", function () {
    if (dayPending) setTimeout(function () { if (dayPending) checkDay(); }, 0);
  });
  // Nor while a tap is in progress: a redraw between its press and its click would replace the tapped button (on
  // iOS a tapped button never takes focus, so the focus check alone doesn't hold it). Let go just after the click;
  // a press that ends with no click (a scroll) lets go a moment later.
  function tapEnd(ms) {
    clearTimeout(tapTimer);
    tapTimer = setTimeout(function () { tapping = false; if (dayPending) checkDay(); }, ms);
  }
  document.addEventListener("pointerdown", function () { tapping = true; clearTimeout(tapTimer); }, true);
  document.addEventListener("pointerup", function () { tapEnd(700); }, true);
  document.addEventListener("pointercancel", function () { tapEnd(0); }, true);
  document.addEventListener("click", function () { if (tapping) tapEnd(0); }, true);
  // A press cut off by the page going away (no pointerup or pointercancel) must not hold the redraw for good.
  function tapGone() { clearTimeout(tapTimer); tapping = false; }
  document.addEventListener("visibilitychange", function () { if (document.hidden) tapGone(); });
  window.addEventListener("pagehide", tapGone);
  // Where focus is, as something that can be found again after the redraw: the offer row, bonus row or strip
  // entry it sits in (else its container), and its kind, text and place among its kind there.
  function focusSpot() {
    var f = document.activeElement;
    if (!f || f === document.body || f === input) return null;
    var row = f.closest("[data-oid], [data-ck], [data-eid], details.bonusrow"), home = f.closest("[id]");
    var at = !row ? { id: home && home.id } : row.hasAttribute("data-oid") ? { oid: row.getAttribute("data-oid") } :
      row.hasAttribute("data-ck") ? { ck: row.getAttribute("data-ck") } :
      row.hasAttribute("data-eid") ? { eid: row.getAttribute("data-eid") } : { lead: row.querySelector(".bhead").textContent, topic: row.getAttribute("data-topic") };
    var kin = function (scope) {
      return Array.prototype.filter.call(scope.querySelectorAll(f.tagName), function (x) { return x.className === f.className; });
    };
    var scope = row || home || document;
    return { el: f, at: at, kin: kin, i: kin(scope).indexOf(f), text: f.textContent };
  }
  function findSpot(s) {
    var scope = s.at.oid ? main.querySelector("[data-oid=\"" + CSS.escape(s.at.oid) + "\"]") :
      s.at.ck ? main.querySelector("[data-ck=\"" + CSS.escape(s.at.ck) + "\"]") :
      s.at.eid ? blist.querySelector("[data-eid=\"" + CSS.escape(s.at.eid) + "\"]") :
      s.at.lead != null ? Array.prototype.filter.call(useEl.querySelectorAll("details.bonusrow"), function (d) {
        return d.querySelector(".bhead").textContent === s.at.lead;
      })[0] || Array.prototype.filter.call(useEl.querySelectorAll("details.bonusrow"), function (d) {
        return d.getAttribute("data-topic") === s.at.topic;
      })[0] : s.at.id ? document.getElementById(s.at.id) : document;
    if (!scope) return null;
    var list = s.kin(scope);
    return list.filter(function (x) { return x.textContent === s.text; })[0] || list[s.i] || null;
  }
  function dayRedraw() {
    var y = window.scrollY, spot = focusSpot();
    // What render() and renderStrip() would draw closed again: Recently unavailable, the open bonus rows (by
    // lead, else by topic when the lead changed: "Dining at <merchant>" names what matched), the strip's open
    // "More details" and an unsaved Focus or Choice pick (by entry).
    var ex = main.querySelector("details.expired"), exOpen = ex ? ex.open : null;
    var rowsOpen = Array.prototype.map.call(useEl.querySelectorAll("details.bonusrow[open]"), function (d) {
      return { lead: d.querySelector(".bhead").textContent, topic: d.getAttribute("data-topic") };
    });
    var moreOpen = Array.prototype.map.call(blist.querySelectorAll("li[data-eid] > details.bmore[open]"), function (d) { return d.parentNode.getAttribute("data-eid"); });
    // An unsaved pick shows its Save; a picker that only shows an older stored value (redrawn before a save of it
    // ended) has none and takes the stored value.
    var picks = Array.prototype.filter.call(blist.querySelectorAll(".bfocus select"), function (sel) {
      var b = sel.parentNode.querySelector("button");
      return b && !b.hidden;
    }).map(function (sel) { return [sel.id, sel.value]; });
    totalCache = {}; totalSig = ""; // Best offer totals, worked out again for today
    renderCats(); renderCards(); renderStrip(); renderCuisines(); render();
    var ex2 = main.querySelector("details.expired");
    if (ex2 && exOpen !== null) ex2.open = exOpen;
    var rowsNow = Array.prototype.slice.call(useEl.querySelectorAll("details.bonusrow"));
    rowsOpen.forEach(function (r) {
      var d = rowsNow.filter(function (x) { return x.querySelector(".bhead").textContent === r.lead; })[0] ||
        rowsNow.filter(function (x) { return x.getAttribute("data-topic") === r.topic; })[0];
      if (d) d.open = true;
    });
    moreOpen.forEach(function (id) {
      var d = blist.querySelector("li[data-eid=\"" + CSS.escape(id) + "\"] > details.bmore");
      if (d) d.open = true;
    });
    picks.forEach(function (p) {
      var sel = document.getElementById(p[0]);
      if (sel && sel.value !== p[1] && Array.prototype.some.call(sel.options, function (op) { return op.value === p[1]; })) {
        sel.value = p[1];
        sel.dispatchEvent(new Event("change")); // shows its Save
      }
    });
    if (spot && !spot.el.isConnected) {
      var f = findSpot(spot);
      if (f) f.focus({ preventScroll: true });
    }
    window.scrollTo(0, y);
  }

  // The sticky search box casts a shadow once the page is scrolled (one check per frame).
  var searchBar = document.querySelector(".searchbar"), shadowQueued = false;
  function syncShadow() { shadowQueued = false; searchBar.classList.toggle("scrolled", window.scrollY > 0); }
  window.addEventListener("scroll", function () {
    if (!shadowQueued) { shadowQueued = true; requestAnimationFrame(syncShadow); }
  }, { passive: true });
  syncShadow();

  // Once a new search settles (no typing for a moment), bring the "Use:" line and the start of the results
  // up under the sticky search box. Scrolling never moves focus, so the keyboard stays up.
  var settleTimer = 0, settledQuery = "";
  function settleScroll() {
    var q = compact(input.value);
    if (!q || q === settledQuery || document.activeElement !== input) return;
    settledQuery = q;
    var bar = document.querySelector(".searchbar");
    var target = wc ? wcEl : useEl.hidden ? countEl : useEl; // in What changed, its panel (New / Gone stay in view)
    var y = window.scrollY + target.getBoundingClientRect().top - bar.getBoundingClientRect().height - 4;
    if (Math.abs(window.scrollY - y) > 2) window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
  }
  input.addEventListener("input", function () {
    renderCuisines();
    render();
    clearTimeout(settleTimer);
    if (compact(input.value) === "") settledQuery = "";
    settleTimer = setTimeout(settleScroll, 700);
  });

  // Remember the last choice on this phone; storage can be blocked, so every access is guarded.
  try {
    var saved = localStorage.getItem(SORT_KEY);
    if (SORTS.some(function (o) { return o[0] === saved; })) sortMode = saved;
  } catch (e) {}
  try {
    var savedChan = localStorage.getItem(CHANNEL_KEY);
    if (CHANNELS.some(function (c) { return c[0] === savedChan; })) chanMode = savedChan;
  } catch (e) {}
  try {
    var savedAct = localStorage.getItem(ACT_KEY);
    if (ACTS.some(function (a) { return a[0] === savedAct; })) actMode = savedAct;
  } catch (e) {}
  renderChans();
  renderActs(null);
  var sortHelp = document.getElementById("sort-help");
  function showSortHelp() {
    var d = SORTS.filter(function (o) { return o[0] === sortMode; })[0][2];
    sortHelp.textContent = d || "";
    sortHelp.hidden = !d;
  }
  SORTS.forEach(function (o) { sortEl.appendChild(new Option(o[1], o[0])); });
  sortEl.value = sortMode;
  showSortHelp();
  sortEl.addEventListener("change", function () {
    sortMode = sortEl.value;
    showSortHelp();
    if (!wc) try { localStorage.setItem(SORT_KEY, sortMode); } catch (e) {}
    render();
  });

  // The data files, each read by one function, used on the first load and again when a newer saved copy is
  // swapped in (swapIn below). loaded: the text of each file as the page has it, to tell what a swap changes.
  var DATA_FILES = ["data/offers.json", "data/phone-edits.json", "data/bonus-categories.json", "data/cuisines.json",
                    "data/cards.json", "data/card-links.json", "data/merchant-locations.json"];
  // May be missing from a saved set made before the file existed (or by a worker that predates it): no location
  // merges until the next complete set brings it.
  var OPTIONAL = ["data/merchant-locations.json"];
  var loaded = {};
  function parsed(text) { try { return JSON.parse(text); } catch (e) { return undefined; } }

  // Card links are optional: if the file is missing or broken, the page just shows no card icons.
  function useLinks(j) {
    cardLinks = j && typeof j === "object" && !Array.isArray(j) ? j : {};
  }
  // Cuisines are optional too and never hold up the first render: if they arrive after the offers,
  // the page redraws once with the cuisine row, badges and detail search.
  function useCuisines(j) {
    if (!j || typeof j.merchants !== "object" || !Array.isArray(j.cuisines)) return false;
    cuisineIndex = {};
    Object.keys(j.merchants).forEach(function (n) { cuisineIndex[compact(n)] = j.merchants[n]; });
    cuisines = j;
    if (data) data.offers.forEach(function (o) { o._cu = undefined; });
    window.__cuisinesReady = true;
    return true;
  }
  // Bonus categories are optional and never hold up the first render either. Remembered saves (recent.js) go on
  // the entries before they are readied, so a focus or choice saved but not yet live is the one matched.
  function useBonus(j) {
    if (!j || !Array.isArray(j.entries) || typeof j.keyword_lists !== "object") return false;
    Object.keys(j.keyword_lists).forEach(function (k) {
      var l = j.keyword_lists[k];
      l.kws = (l.keywords || []).map(normKw);
      if (l.full_name) l.kws.forEach(function (k) { k.full = true; });
      l.ex = (l.exclude || []).map(normKw);
      l.may_not_count = l.may_not_count || {};
    });
    if (window.CardRecent) CardRecent.apply("bonus", j.entries);
    j.entries.forEach(function (e) { prepEntry(e, j); });
    bonus = j;
    cardsCfg = null;
    prepCards();
    window.__bonusReady = true;
    return true;
  }
  // Card base rates and offer lists for the per-merchant headline; optional, never holds up the first render.
  function useCards(j) {
    if (!j || !Array.isArray(j.cards) || typeof j.offer_lists !== "object") return false;
    cardsRaw = j;
    cardsCfg = null;
    prepCards();
    window.__cardsReady = true;
    return true;
  }
  // Pending phone edits (data/phone-edits.json, see edits.js) go on the offers before they are shown, then the
  // remembered saves. A missing file means no edits; anything else that isn't an object is a load error.
  function editsOf(item) {
    if (item.status === 404) return {};
    var j = item.ok ? parsed(item.text) : undefined;
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("phone-edits.json");
    return j;
  }
  function useOffers(text, edits, j) {
    j = j || JSON.parse(text);
    if (!j || !Array.isArray(j.offers)) throw new Error("offers.json");
    if (CardStore.setOffersBase) CardStore.setOffersBase(text); // the copy phone saves are checked against
    if (CardEdits.applyEdits) CardEdits.applyEdits(j.offers, edits);
    if (window.CardRecent) CardRecent.apply("offers", j.offers);
    data = j;
  }

  function fetchText(path) {
    return fetch(path, { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); });
  }
  [["data/cuisines.json", useCuisines, function () { renderCuisines(); render(); }],
   ["data/bonus-categories.json", useBonus, function () { render(); }],
   ["data/cards.json", useCards, function () { renderCuisines(); render(); }] // activation counts read the offer lists too
  ].forEach(function (f) {
    fetchText(f[0]).then(function (t) {
      // A newer copy swapped in while this was loading already has this file.
      if (f[0] in loaded) return;
      if (!f[1](parsed(t))) return;
      loaded[f[0]] = t;
      if (f[0] !== "data/cuisines.json" && bonus) renderStrip(); // Preferred Rewards rates
      if (data) f[2]();
    }).catch(function () {});
  });

  // Readies one bonus entry for matching; run again after a phone edit changes its focus or choice, and once
  // cards.json arrives (for the Preferred Rewards boost).
  function prepEntry(e, j) {
    // Chosen-category cards (Customized Cash): the current choice, at the entry's rate, joins the fixed groups.
    if (e.choices) {
      if (!e._fixed) e._fixed = e.match || [];
      var ch = e.choices.filter(function (x) { return x.name === e.choice; })[0], cg = null;
      if (ch) {
        cg = {};
        Object.keys(ch).forEach(function (k) { cg[k] = ch[k]; });
        cg.name = ch.topic || ch.name;
      }
      e.match = (cg ? [cg] : []).concat(e._fixed);
    }
    e.match = e.eligible ? [] : e.match || [];
    // Top-category cards (Citi Custom Cash) match only the planned eligible category.
    if (e.eligible && e.planned) {
      var it = e.eligible.filter(function (x) { return x.name === e.planned; })[0];
      if (it) {
        var g = {};
        Object.keys(it).forEach(function (k) { g[k] = it[k]; });
        g.name = it.topic || it.name;
        e.match = [g];
        e.likely_note = "conditional, " + condWhy(e);
      }
    }
    if (e.rate === undefined) e.rate = null;
    // Each group pays its own rate (Costco Visa) or the entry's; "list" may name several keyword lists.
    // Bank of America rates include the Preferred Rewards boost.
    var bc = boostCard(e);
    e._boost = boostPct(bc);
    e.match.forEach(function (g) {
      g._rate = boosted(typeof g.rate === "number" ? g.rate : e.rate, bc);
      var names = g.list == null ? [] : [].concat(g.list), ls = names.map(function (n) { return j.keyword_lists[n]; }).filter(Boolean);
      if (!ls.length) { g._list = null; return; }
      g._list = ls.length === 1 ? ls[0] : {
        kws: [].concat.apply([], ls.map(function (l) { return l.kws; })),
        ex: [].concat.apply([], ls.map(function (l) { return l.ex; })),
        may_not_count: ls.reduce(function (acc, l) { Object.keys(l.may_not_count).forEach(function (k) { acc[k] = l.may_not_count[k]; }); return acc; }, {})
      };
    });
  }

  // ---- Phone edits (edit mode). Every button calls runSave(change); store.js does the saving and is the
  // only part that knows where the data lives. What a change does to a record is in edits.js.
  var savebar = document.getElementById("savebar");
  var savemsg = document.getElementById("savemsg");
  var savebtns = document.getElementById("savebtns");
  var wrapEl = document.querySelector(".wrap");
  var editDet = document.getElementById("editmode");
  var editSum = document.getElementById("editsum");
  var editBody = document.getElementById("editbody");
  var signinForm = document.getElementById("signin");
  var signinErr = document.getElementById("signin-err");
  var saving = false, pollTimer = 0, pollRun = 0;

  function editing() { return !!(window.CardStore && window.CardStore.canEdit()); }
  // Signed in, offers needing or having activation get a switch in their details (see offerEdits).
  function hasActControl(o) {
    return editing() && (o.activation === "needs_activation" || o.activation === "already_activated");
  }

  function editBtn(text, change, cls) {
    var b = el("button", cls || "edsm", text);
    b.type = "button";
    b.disabled = saving;
    b.addEventListener("click", function () { runSave(change); });
    return b;
  }

  // Controls at the top of an offer's details, each next to the status it changes: mark used (on which
  // card, where the issuer stands for two; a used offer's "Restore offer"), and the activation switch ("Needs activation
  // [Mark activated]", "Already activated Undo"). Activation values other than these two have no control.
  function offerEdits(o) {
    if (!editing()) return [];
    var rows = [];
    if (hasActControl(o)) {
      var act = el("div", "edrow");
      if (o.activation === "needs_activation") {
        act.appendChild(el("span", "bwarn", "Needs activation"));
        act.appendChild(editBtn("Mark activated", { type: "offer.activation", id: o.id, from: "needs_activation", to: "already_activated" }, "edfill"));
      } else {
        act.appendChild(el("span", "bok", "Already activated"));
        act.appendChild(editBtn("Mark not activated", { type: "offer.activation", id: o.id, from: "already_activated", to: "needs_activation" }, "edlink"));
      }
      rows.push(act);
    }
    var used = el("div", "edrow");
    // A used row (kept in place, or under the Used filter) is restored from its own details.
    if (o.status === "used") used.appendChild(editBtn("Restore offer", { type: "offer.status", id: o.id, from: "used", to: "active" }, "edsm"));
    else if (isLive(o, todayISO())) {
      (CardEdits.USED_ON[o.card] || [null]).forEach(function (c) {
        var ch = { type: "offer.status", id: o.id, from: o.status, to: "used" };
        if (c) ch.usedOn = c;
        used.appendChild(editBtn(c ? "Used on " + c : "Mark used", ch));
      });
    }
    if (used.children.length) rows.push(used);
    return rows;
  }

  // Custom Cash, "CardSelector focus: [restaurants ▾]" (field "planned": CardSelector's assumption only, nothing
  // changes at Citi), and Customized Cash choice, "Choice: [online shopping ▾]" (field "choice": a real Bank of
  // America setting, changed there first); a small Save appears only once the value changes.
  function focusPicker(e, field) {
    var row = el("div", "bfocus");
    var id = field + "-" + compact(e.id), now = e[field];
    var lab = el("label", "bmeta", field === "planned" ? "CardSelector focus:" : "Choice:");
    lab.htmlFor = id;
    row.appendChild(lab);
    var sel = el("select");
    sel.id = id;
    sel.disabled = saving;
    (field === "planned" ? e.eligible : e.choices).forEach(function (it) { sel.appendChild(new Option(it.name, it.name, false, it.name === now)); });
    row.appendChild(sel);
    var b = el("button", "edsm", "Save");
    b.type = "button";
    b.hidden = true;
    b.disabled = saving;
    sel.addEventListener("change", function () { b.hidden = sel.value === now; });
    b.addEventListener("click", function () {
      if (sel.value !== now) runSave({ type: field === "planned" ? "bonus.planned" : "bonus.choice", id: e.id, from: now, to: sel.value });
    });
    row.appendChild(b);
    return row;
  }

  function bar(kind, live) {
    savebar.className = "savebar " + kind + (live ? " live" : "");
    savebar.hidden = false;
    wrapEl.classList.add("barpad");
  }
  // buttons: [[label, action], ...] as inline text links after a "·"; a close (×) is always added. live: the
  // change is on the site, so the bar shrinks to a small faded pill. what: the change, for screen readers
  // and a long press (the visible line stays short: "Saved · Deploying · Undo").
  function showBar(kind, text, buttons, link, live, what) {
    bar(kind, live);
    savemsg.textContent = text;
    savebar.title = what || "";
    if (what) savemsg.appendChild(el("span", "sr-only", " (" + what + ")"));
    if (link) {
      savemsg.appendChild(document.createTextNode(" "));
      var a = el("a", null, "Details");
      a.href = link; a.target = "_blank"; a.rel = "noopener noreferrer";
      savemsg.appendChild(a);
    }
    savebtns.textContent = "";
    (buttons || []).concat([["×", closeBar]]).forEach(function (bt, i) {
      var x = bt[1] === closeBar;
      if (!i && !x) savebtns.appendChild(el("span", "savesep", "·"));
      var b = el("button", x ? "edlink xbtn" : "edlink", bt[0]);
      b.type = "button";
      if (x) b.setAttribute("aria-label", "Close");
      b.addEventListener("click", bt[1]);
      savebtns.appendChild(b);
    });
  }
  function closeBar() {
    savebar.hidden = true;
    wrapEl.classList.remove("barpad");
    clearTimeout(pollTimer); pollRun++;
  }

  // Puts the record as the save left it (or as it is now, after a conflict) into the page's copy.
  function syncRecord(change, rec) {
    if (!rec) return;
    if (CardEdits.fileOf(change) === "offers") {
      var o = data && data.offers.filter(function (x) { return x.id === change.id; })[0];
      if (o) Object.keys(rec).forEach(function (k) { o[k] = rec[k]; });
    } else {
      var e = bonus && bonus.entries.filter(function (x) { return x.id === change.id; })[0];
      if (e) {
        e.activation = rec.activation;
        if (e.planned !== rec.planned || e.choice !== rec.choice) { e.planned = rec.planned; e.choice = rec.choice; prepEntry(e, bonus); }
      }
    }
  }
  function redraw() {
    // A new day held back by the save: the full day redraw instead (once).
    if (dayPending && !dayBlocked()) { dayPending = false; dayRedraw(); return; }
    renderStrip();
    if (data) { renderCuisines(); render(); }
  }

  // The fields a remembered save compares (recent.js), from the page's record just before the save.
  function snapshot(rec) {
    if (!rec) return null;
    var c = {};
    Object.keys(rec).forEach(function (k) { c[k] = rec[k]; });
    c.other_details = (rec.other_details || []).slice();
    return c;
  }

  function runSave(change, retried) {
    if (saving) return;
    saving = true;
    clearTimeout(pollTimer); pollRun++;
    var rec = CardEdits.findRecord({ offers: data, bonus: bonus }, change);
    var before = snapshot(rec);
    // An offer marked used or restored stays where it is until the search or a filter changes.
    if (change.type === "offer.status" && rec && !Object.prototype.hasOwnProperty.call(keep, change.id)) keep[change.id] = rec.status_since || "";
    showBar("busy", "Saving…", [], null, false, CardEdits.summary(change, rec));
    savebtns.textContent = "";
    redraw(); // disables the edit buttons while saving
    CardStore.save(change).then(function (res) {
      // "Wait a minute, reload": the page's offers.json is behind main. Check the site at once (the whole set,
      // not trusting the copy); when that brings a newer offers.json, swap it in and retry once.
      if (res.status !== "error" || res.kind !== "reload" || retried || !window.CardCopy || !CardCopy.enabled) return res;
      var had = loaded["data/offers.json"];
      return CardCopy.check({ force: true }).then(function (r) {
        if (r) showOffline(r);
        if (!r || !r.set) return res;
        return (swapping || Promise.resolve()).then(function () { return swapIn(true); }).then(function () {
          if (loaded["data/offers.json"] === had) return res; // the site is still behind
          saving = false;
          runSave(change, true);
          return null;
        });
      }).catch(function () { return res; });
    }).then(function (res) {
      if (!res) return; // retried
      saving = false;
      if (res.status === "saved") {
        if (window.CardRecent) CardRecent.remember(change, before, res.record, res.commit);
        syncRecord(change, res.record);
        redraw();
        var undo = [["Undo", function () { runSave(res.undo); }]];
        showBar("ok", "Saved · Deploying", undo, null, false, res.message);
        pollLive(res, undo);
      } else if (res.status === "conflict") {
        if (window.CardRecent) CardRecent.forget(change);
        syncRecord(change, res.record);
        redraw();
        var again = {};
        Object.keys(change).forEach(function (k) { again[k] = change[k]; });
        again.from = res.now;
        delete again.status_since;
        showBar("warn", res.message + " The page now shows the latest. Retry to make your change anyway.",
          [["Retry", function () { runSave(again); }]]);
      } else if (res.status === "done") {
        syncRecord(change, res.record);
        redraw();
        showBar("ok", res.message, []);
      } else {
        redraw();
        var retry = res.kind === "network" || res.kind === "busy" ? [["Retry", function () { runSave(change); }]] : [];
        showBar("err", "Not saved: " + res.message, retry);
      }
      // A newer copy that arrived during the save goes in now.
      if (swapPending) { swapPending = false; swapSoon(); }
    });
  }

  // Follows the saved change until it is live (or the deploy fails), about every 8 seconds for up to 10 minutes.
  function pollLive(saved, undo) {
    var run = ++pollRun, tries = 0;
    var tick = function () {
      CardStore.liveStatus(saved).then(function (st) {
        if (run !== pollRun) return;
        // The footer's "Last deploy" shows the same run as the bar, from this one answer (a second request
        // could come back with an older, cached run).
        if (st.state === "live" || st.state === "failed") { depRun++; drawDeploy(depEl, st); }
        if (st.state === "live") return showBar("ok", "Live", undo, null, true, saved.message);
        if (st.state === "failed") return showBar("err", "Saved: " + saved.message + ". " + st.message, undo, st.url);
        if (st.state === "unknown") return showBar("ok", "Saved: " + saved.message + ". " + st.message, undo);
        if (++tries >= 75) return showBar("warn", "Saved: " + saved.message + ". The deploy is taking unusually long.", undo, st.url);
        pollTimer = setTimeout(tick, 8000);
      });
    };
    pollTimer = setTimeout(tick, 5000);
  }

  // Footer "Edit mode": the sign-in form when signed out (username + password, so a password manager
  // can fill it; only the password is used), or the signed-in note, Sign out and the last deploy.
  function renderEditMode() {
    var on = editing();
    editSum.textContent = "";
    editSum.appendChild(document.createTextNode("Edit mode"));
    editSum.appendChild(el("span", on ? "edon" : "edoff", on ? "On" : "Off"));
    editBody.textContent = "";
    if (!on) {
      depEl = null;
      signinForm.querySelector("input[type=password]").value = "";
      signinErr.textContent = "";
      editBody.appendChild(signinForm);
      return;
    }
    editBody.appendChild(el("p", "fnote", "Editing is on in this browser. Edit buttons are in each offer’s details and in the bonus categories list. Used offers show under the Used filter, where they can be restored."));
    depEl = el("p", "fnote", "Checking the last deploy…");
    editBody.appendChild(depEl);
    var out = el("button", "edbtn", "Sign out");
    out.type = "button";
    out.addEventListener("click", function () { CardStore.signOut(); usedMode = false; closeBar(); renderEditMode(); redraw(); });
    editBody.appendChild(out);
    showDeploy();
  }
  // "Last deploy: live (…)": read on sign-in; after a save, drawn from that save's own deploy status (pollLive).
  var depEl = null, depRun = 0;
  function showDeploy() {
    var dep = depEl, run = ++depRun;
    if (!dep || !editing()) return;
    CardStore.lastDeploy().then(function (d) {
      if (run !== depRun || dep !== depEl) return;
      drawDeploy(dep, d);
    });
  }
  function drawDeploy(dep, d) {
    if (!dep) return;
    dep.className = "fnote";
    dep.textContent = "";
    if (!d) { dep.textContent = "Last deploy: unavailable"; return; }
    var when = d.date ? " (" + new Date(d.date).toLocaleString() + ")" : "";
    dep.textContent = d.state === "live" ? "Last deploy: live" + when + "." :
      d.state === "failed" ? "⚠ Last deploy failed" + when + ". The live site is behind the saved data. Tell Claude. " :
      "Last deploy: in progress" + when + ".";
    if (d.state === "failed") { dep.className = "fnote edwarn"; }
    if (d.url) {
      var a = el("a", null, "Details");
      a.href = d.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      dep.appendChild(document.createTextNode(" "));
      dep.appendChild(a);
    }
  }
  signinForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var btn = signinForm.querySelector("button");
    btn.disabled = true;
    signinErr.textContent = "Signing in…";
    CardStore.signIn(signinForm.querySelector("input[type=password]").value).then(function (r) {
      btn.disabled = false;
      if (!r.ok) { signinErr.textContent = r.message; return; }
      // Taking the form out of the page after a successful sign-in is what tells the browser's password
      // manager the login worked, so it offers to save it.
      signinForm.remove();
      renderEditMode();
      redraw();
    });
  });
  renderEditMode();

  // The first load: offers.json, phone-edits.json, card-links.json and merchant-locations.json from one saved set
  // (or all from the network), so offers and pending edits always belong to the same deploy and the first render
  // already groups approved locations. A missing or broken locations file means no location merges.
  CardCopy.fetchTogether(["data/offers.json", "data/phone-edits.json", "data/card-links.json", "data/merchant-locations.json"], { optional: OPTIONAL })
    .then(function (res) {
      var o = res.items[0];
      if (!o.ok) throw new Error(o.status);
      var edits = editsOf(res.items[1]);
      useOffers(o.text, edits);
      loaded["data/offers.json"] = o.text;
      loaded["data/phone-edits.json"] = res.items[1].ok ? res.items[1].text : null;
      if (res.items[2].ok) { useLinks(parsed(res.items[2].text)); loaded["data/card-links.json"] = res.items[2].text; }
      useLocations(res.items[3].ok ? parsed(res.items[3].text) : null);
      loaded["data/merchant-locations.json"] = res.items[3].ok ? res.items[3].text : null;
      dataSet = res.set;
      renderCats(); renderCards(); renderCuisines(); render(); refreshFreshness();
      startCopy();
    })
    .catch(function () {
      main.textContent = "";
      main.appendChild(el("p", "empty", "Couldn’t load the offer list. Check your connection and reload."));
      startCopy();
    });

  // ---- The saved copy (sw.js, js/copy.js): checks for a newer deploy on every open and whenever the page comes
  // back on screen (at most once per 30 seconds). New data is swapped in right away (never during a save: then
  // when it ends); new page code reloads the page the next time it comes back on screen, only with an empty
  // search box and no save running.
  var offlineEl = document.getElementById("offline");
  var dataSet = null; // the saved set the page's data came from (null: from the network)
  var reloadPending = false, swapPending = false, swapping = null;

  function startCopy() {
    if (!window.CardCopy || !CardCopy.enabled) return;
    var registering;
    try { registering = navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }); } catch (e) { registering = Promise.reject(e); }
    CardCopy.start(registering);
    copyCheck({});
  }
  function clock(ms) {
    var d = new Date(ms), h = d.getHours(), m = d.getMinutes();
    return (h % 12 || 12) + ":" + (m < 10 ? "0" : "") + m + " " + (h < 12 ? "am" : "pm");
  }
  function showOffline(r) {
    if (!r) return;
    if (r.offline && r.savedAt) {
      var d = new Date(r.savedAt), p = function (n) { return String(n).padStart(2, "0"); };
      offlineEl.textContent = "Offline · saved copy from " + fmtDate(d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate())) + ", " + clock(r.savedAt);
      offlineEl.hidden = false;
    } else offlineEl.hidden = true;
  }
  function copyCheck(opts) {
    var p = CardCopy.check(opts).then(function (r) {
      if (!r) return r;
      showOffline(r);
      if (r.code) reloadPending = true;
      return (r.set && r.set !== dataSet ? swapSoon() : Promise.resolve()).then(function () {
        // Only now, with the check and its swap done, look for a newer sw.js (a tab that only comes back on screen
        // is never loaded again, so it would otherwise never get one, the off switch included). Asking during a
        // swap left the new worker stuck in Chromium and hung every later open.
        if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
          navigator.serviceWorker.getRegistration().then(function (g) { if (g) g.update().catch(function () {}); }, function () {});
        }
        return r;
      });
    });
    window.__copyLast = p; // for tools/offline_test.js
    return p;
  }
  window.__copyCheck = function (opts) { return copyCheck(opts || {}); }; // tools/offline_test.js, without the 30 s wait
  function swapSoon() {
    if (!data) return Promise.resolve(false);
    if (saving) { swapPending = true; return Promise.resolve(false); }
    if (!swapping) swapping = swapIn().then(function (x) { swapping = null; return x; }, function () { swapping = null; return false; });
    return swapping;
  }
  // Reads every data file from the current saved set (Cache Storage, not through the worker) and, when any differs
  // from what the page shows, puts the new set in place: offers with their pending edits and the remembered saves,
  // bonus categories, cuisines, cards, card links and location groups. The search, filters, sort, Used filter, scroll position and open details stay.
  // duringSave: called by the save itself (a refused save, item "reload" in runSave), so a save in progress
  // doesn't hold it back.
  function swapIn(duringSave) {
    return CardCopy.readSet(DATA_FILES, { optional: OPTIONAL }).then(function (res) {
      if (!res || !res.set || !res.items.every(function (it) { return it.ok || OPTIONAL.indexOf(it.path) !== -1; })) return false;
      var t = {};
      // An optional file the set lacks (saved before it existed) is unknown, not empty: keep what the page has.
      res.items.forEach(function (it) { t[it.path] = it.ok ? it.text : loaded[it.path] === undefined ? null : loaded[it.path]; });
      if (DATA_FILES.every(function (p) { return t[p] === loaded[p]; })) { dataSet = res.set; return false; }
      if (saving && !duringSave) { swapPending = true; return false; } // a save started while the files were read
      var j = {};
      for (var i = 0; i < DATA_FILES.length; i++) {
        j[DATA_FILES[i]] = t[DATA_FILES[i]] === null ? null : parsed(t[DATA_FILES[i]]);
        if (j[DATA_FILES[i]] === undefined && OPTIONAL.indexOf(DATA_FILES[i]) === -1) return false;
      }
      var edits = editsOf({ status: 200, ok: true, text: t["data/phone-edits.json"] });
      var y = window.scrollY;
      // Only what changed is put in again (an unchanged bonus file keeps the strip as it is, open details and
      // an unsaved Focus or Choice pick included; its remembered saves were checked when it loaded).
      var changed = function (p) { return t[p] !== loaded[p]; };
      var offersNew = changed("data/offers.json") || changed("data/phone-edits.json");
      var stripNew = changed("data/bonus-categories.json") || changed("data/cards.json");
      if (offersNew) useOffers(t["data/offers.json"], edits, j["data/offers.json"]);
      if (changed("data/card-links.json")) useLinks(j["data/card-links.json"]);
      if (changed("data/cuisines.json") || offersNew) useCuisines(j["data/cuisines.json"]);
      if (changed("data/cards.json")) useCards(j["data/cards.json"]);
      if (changed("data/bonus-categories.json")) useBonus(j["data/bonus-categories.json"]);
      // Location groups decide which offers are one merchant: the results and headline are drawn again below.
      if (changed("data/merchant-locations.json")) useLocations(j["data/merchant-locations.json"]);
      loaded = t;
      dataSet = res.set;
      totalCache = {}; totalSig = ""; // Best offer totals, worked out again from the new rates
      if (category !== null && (data.categories || []).indexOf(category) === -1) category = null;
      if (card !== null && !data.offers.some(function (o) { return o.card === card; })) card = null;
      renderCats(); renderCards(); if (stripNew) renderStrip(); renderCuisines(); render(); refreshFreshness();
      window.scrollTo(0, y);
      window.__swaps = (window.__swaps || 0) + 1;
      return true;
    });
  }
  // Nothing the owner picked would be lost by a reload: an empty search box (any typed character counts, not
  // only letters and digits), no save running or save bar showing (the "Live" pill aside), not in What changed, no category, card,
  // cuisine or Used filter, no open details, Filters panel, bonus strip or Edit mode panel, and no form field in
  // use other than the empty search box.
  function idle() {
    var f = document.activeElement;
    return !saving && !wc && input.value.trim() === "" && category === null && card === null && cuisine === null && !usedMode &&
      // a save bar still showing (Deploying with Undo, an error with Retry); the small "Live" pill doesn't block
      (savebar.hidden || savebar.classList.contains("live")) &&
      !main.querySelector("button.mchead[aria-expanded=true]") && !filtersEl.classList.contains("open") &&
      !bstrip.open && !editDet.open && // an unsaved Focus / Choice pick, a half-typed password
      // The search box is autofocused on every open, so it counts as idle while focused (it must be empty, above);
      // any other field in use blocks the reload.
      !(f && f !== input && /^(INPUT|SELECT|TEXTAREA)$/.test(f.tagName));
  }
  function comeBack() {
    if (document.visibilityState === "hidden") return;
    if (reloadPending && idle()) { location.reload(); return; }
    copyCheck({ throttle: true });
  }
  document.addEventListener("visibilitychange", comeBack);
  window.addEventListener("pageshow", function (e) { if (e.persisted) comeBack(); });
})();

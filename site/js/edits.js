// Phone edits: what each change does to the data. It knows nothing about where the data is kept
// (store.js does that), so a different storage backend can reuse these rules unchanged.
//
// A change names the record, the value the owner saw ("from") and the value wanted ("to"). apply()
// checks "from" against the current data first, so a change made elsewhere in the meantime is
// reported as a conflict instead of being overwritten.
//   { type: "offer.status",     id, from: "active", to: "used", usedOn: "Smartly" }
//   { type: "offer.status",     id, from: "used",   to: "active" }            (undo)
//   { type: "offer.activation", id, from: "needs_activation", to: "already_activated" }
//   { type: "bonus.activation", id, from: "not_confirmed",    to: "activated" }
//   { type: "bonus.planned",    id, from: "restaurants",      to: "gas stations" }
//   { type: "bonus.choice",     id, from: "online shopping",  to: "dining" }
// Optional on offer.status: status_since, to restore the exact earlier date when undoing right away.
(function (root) {
  "use strict";

  // Cards that stand for two of the owner's cards: marking used says which one (CLAUDE.md, "Marking used").
  var USED_ON = {
    "Capital One": ["Quicksilver", "Discover it"],
    "U.S. Bank": ["Cash+", "Smartly"],
    "Bank of America": ["Customized Cash Rewards", "Unlimited Cash Rewards"]
  };
  var OFFER_ACTIVATION = ["needs_activation", "already_activated"];
  var BONUS_ACTIVATION = ["not_confirmed", "activated"];
  var USED_NOTE = /^Used on /;

  var LABELS = {
    active: "active", used: "used", missing: "dropped off", expired: "expired",
    needs_activation: "needs activation", already_activated: "activated",
    auto_enrolled: "auto-enrolled", via_shop_link: "via shop link", none_shown: "activation not listed",
    not_confirmed: "not activated", activated: "activated", not_needed: "no activation needed"
  };
  function label(v) { return LABELS[v] || String(v); }

  // Which data set a change touches: "offers" (offers.json) or "bonus" (bonus-categories.json).
  function fileOf(change) { return /^bonus\./.test(change.type) ? "bonus" : "offers"; }

  function findRecord(files, change) {
    var f = files[fileOf(change)];
    var list = f && (fileOf(change) === "bonus" ? f.entries : f.offers);
    if (!Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i++) if (list[i].id === change.id) return list[i];
    return null;
  }

  function nameOf(rec, change) {
    if (!rec) return change.id;
    return fileOf(change) === "bonus" ? rec.card : rec.merchant + " (" + rec.card + ")";
  }

  // The field a change reads and writes.
  function fieldOf(change) {
    return { "offer.status": "status", "offer.activation": "activation",
             "bonus.activation": "activation", "bonus.planned": "planned", "bonus.choice": "choice" }[change.type];
  }

  // Short text for the commit message and the save bar.
  function summary(change, rec) {
    var n = nameOf(rec, change);
    switch (change.type) {
      case "offer.status":
        if (change.to === "used") return "Mark used: " + n + (change.usedOn ? " on " + change.usedOn : "");
        return "Undo used: " + n;
      case "offer.activation":
        return (change.to === "already_activated" ? "Mark activated: " : "Mark not activated: ") + n;
      case "bonus.activation":
        return (change.to === "activated" ? "Bonus categories activated: " : "Bonus categories not activated: ") + n;
      case "bonus.planned":
        return "Custom Cash focus: " + change.to;
      case "bonus.choice":
        return "Customized Cash choice: " + change.to;
    }
    return change.type + " " + n;
  }

  // The change that puts things back. offer.status keeps the earlier status_since for an exact undo.
  function inverse(change, before) {
    var inv = { type: change.type, id: change.id, from: change.to, to: change.from };
    if (change.type === "offer.status" && before && before.status_since) inv.status_since = before.status_since;
    // Undo of a restore marks it used again on the same card.
    if (change.type === "offer.status" && before && before.usedOn) inv.usedOn = before.usedOn;
    return inv;
  }

  // Checks the change against the data and, when it fits, makes it (files are changed in place).
  // Returns { ok: true, summary, before } or { ok: false, kind, message, now }:
  //   kind "conflict": the record no longer has the "from" value (now = its current value)
  //   kind "done":     it already has the "to" value (nothing to save)
  //   kind "invalid":  the change itself is wrong (unknown record, value or card)
  function apply(files, change, today) {
    var rec = findRecord(files, change);
    var field = fieldOf(change);
    var n = nameOf(rec, change);
    function fail(kind, message, now) { return { ok: false, kind: kind, message: message, now: now }; }
    if (!field) return fail("invalid", "Unknown change type " + change.type + ".");
    if (!rec) return fail("invalid", "Couldn’t find " + change.id + " in the latest data. It may have been removed.");
    var now = rec[field];
    if (now === change.to) return fail("done", n + " is already " + label(change.to) + ". Nothing to save.", now);
    if (now !== change.from) {
      return fail("conflict", n + " was changed somewhere else at the same time: it is now " + label(now) +
        " (you saw " + label(change.from) + "). Nothing was saved.", now);
    }
    var before = { status: rec.status, status_since: rec.status_since, activation: rec.activation, planned: rec.planned, choice: rec.choice,
                   usedOn: fileOf(change) === "offers" ? usedOnOf(rec) : null };

    switch (change.type) {
      case "offer.status":
        if (["used", "active"].indexOf(change.to) === -1) return fail("invalid", "An offer can only be marked used or active.");
        var cards = USED_ON[rec.card];
        if (change.to === "used" && cards && cards.indexOf(change.usedOn) === -1) {
          return fail("invalid", "Pick which card you used: " + cards.join(" or ") + ".");
        }
        rec.status = change.to;
        rec.status_since = change.status_since || today;
        rec.other_details = (rec.other_details || []).filter(function (t) { return !USED_NOTE.test(t); });
        if (change.to === "used" && cards) rec.other_details.push("Used on " + change.usedOn);
        break;
      case "offer.activation":
        if (OFFER_ACTIVATION.indexOf(change.to) === -1 || OFFER_ACTIVATION.indexOf(change.from) === -1) {
          return fail("invalid", "Only “needs activation” and “activated” can be switched.");
        }
        rec.activation = change.to;
        break;
      case "bonus.activation":
        if (BONUS_ACTIVATION.indexOf(change.to) === -1 || BONUS_ACTIVATION.indexOf(change.from) === -1) {
          return fail("invalid", "Only “not activated” and “activated” can be switched.");
        }
        if (change.to === "not_confirmed" && !rec.activate_by) return fail("invalid", n + " has no activation deadline.");
        rec.activation = change.to;
        break;
      case "bonus.planned":
        var names = (rec.eligible || []).map(function (it) { return it.name; });
        if (names.indexOf(change.to) === -1) return fail("invalid", change.to + " is not one of " + n + "’s eligible categories.");
        rec.planned = change.to;
        break;
      case "bonus.choice":
        var opts = (rec.choices || []).map(function (it) { return it.name; });
        if (opts.indexOf(change.to) === -1) return fail("invalid", change.to + " is not one of " + n + "’s choice categories.");
        rec.choice = change.to;
        break;
    }
    return { ok: true, summary: summary(change, rec), before: before };
  }

  // Pending phone edits (site/data/phone-edits.json): offer saves write only this small file, keyed by offer id,
  // holding just the fields the phone changes, where they differ from offers.json:
  //   { "<offer id>": { "status": "used", "status_since": "2026-10-20", "used_on": "Smartly", "activation": "already_activated" } }
  // status and status_since go together; used_on is the card in the "Used on <card>" note (two-card issuers only).
  // The page puts them on top of offers.json at load; tools/fold_phone_edits.py writes them into offers.json.
  function usedOnOf(rec) {
    var t = (rec.other_details || []).filter(function (x) { return USED_NOTE.test(x); })[0];
    return t ? t.replace(USED_NOTE, "") : null;
  }
  // Puts one pending edit on an offer (changed in place), as a phone save used to write it into offers.json.
  function applyEdit(rec, entry) {
    if (!entry) return rec;
    if (entry.status !== undefined) {
      rec.status = entry.status;
      rec.status_since = entry.status_since;
      rec.other_details = (rec.other_details || []).filter(function (t) { return !USED_NOTE.test(t); });
      if (entry.used_on) rec.other_details.push("Used on " + entry.used_on);
    }
    if (entry.activation !== undefined) rec.activation = entry.activation;
    return rec;
  }
  // The offer as it is on main: a copy of the offers.json record with its pending edit on top.
  function withEdit(base, entry) {
    var rec = {};
    Object.keys(base).forEach(function (k) { rec[k] = base[k]; });
    rec.other_details = (base.other_details || []).slice();
    return applyEdit(rec, entry);
  }
  // The pending edit that turns the offers.json record into rec, or null when they match (no entry).
  function editFor(base, rec) {
    var e = {}, on = usedOnOf(rec);
    if (rec.status !== base.status || rec.status_since !== base.status_since || on !== usedOnOf(base)) {
      e.status = rec.status;
      e.status_since = rec.status_since;
      if (on) e.used_on = on;
    }
    if (rec.activation !== base.activation) e.activation = rec.activation;
    return Object.keys(e).length ? e : null;
  }
  // Puts every pending edit on the page's offers (ids no longer in offers.json are skipped).
  function applyEdits(offers, edits) {
    if (!edits) return;
    offers.forEach(function (o) {
      if (Object.prototype.hasOwnProperty.call(edits, o.id)) applyEdit(o, edits[o.id]);
    });
  }

  // Today's date in the owner's time zone (US Pacific), as CLAUDE.md requires for every stored date.
  function pacificToday(d) {
    var parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(d || new Date());
    var get = function (t) { return parts.filter(function (p) { return p.type === t; })[0].value; };
    return get("year") + "-" + get("month") + "-" + get("day");
  }

  var api = {
    USED_ON: USED_ON, apply: apply, inverse: inverse, fileOf: fileOf, findRecord: findRecord,
    summary: summary, label: label, pacificToday: pacificToday,
    withEdit: withEdit, editFor: editFor, applyEdits: applyEdits, applyEdit: applyEdit, usedOnOf: usedOnOf
  };
  root.CardEdits = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

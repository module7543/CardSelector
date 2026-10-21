// Remembered saves: display only. After a phone save comes back "saved", the page remembers which record it
// changed and the fields' values before and after, so a reload while the deploy is still on its way (or while the
// saved copy is older than the save) still shows the change. It never touches what store.js reads, checks or
// writes, never goes to the repo, and works signed in or out. Kept in localStorage (one entry per record).
//
// On every load and every swap, after phone-edits.json is on the offers, each entry is checked on the fields it
// changed: the record already shows "after" -> dropped (the site has it); it shows "before" -> "after" is put
// back on the page's copy; anything else, or the record is gone -> dropped (changed elsewhere, or a refresh).
// Entries also go after 24 hours, and when a save on that record comes back as a conflict.
(function (root) {
  "use strict";
  var E = root.CardEdits;
  var KEY = "cardselector.saves";
  var MAX_AGE = 24 * 3600 * 1000;
  var FIELDS = { offers: ["status", "status_since", "used_on", "activation"], bonus: ["activation", "planned", "choice"] };

  function load() {
    try {
      var j = JSON.parse(root.localStorage.getItem(KEY) || "{}");
      return j && typeof j === "object" && !Array.isArray(j) ? j : {};
    } catch (e) { return {}; }
  }
  function store(map) {
    try {
      if (Object.keys(map).length) root.localStorage.setItem(KEY, JSON.stringify(map));
      else root.localStorage.removeItem(KEY);
    } catch (e) {}
  }

  // The fields a remembered save can change, as the record shows them now.
  function fieldsOf(kind, rec) {
    var out = {};
    FIELDS[kind].forEach(function (f) {
      var v = f === "used_on" ? E.usedOnOf(rec) : rec[f];
      out[f] = v === undefined ? null : v;
    });
    return out;
  }

  function keyOf(kind, id) { return kind + ":" + id; }

  // After a save returned "saved": before = the page's record just before the save, after = the record as saved.
  function remember(change, before, after, commit, now) {
    if (!before || !after) return;
    var kind = E.fileOf(change), b = fieldsOf(kind, before), a = fieldsOf(kind, after), eb = {}, ea = {};
    Object.keys(a).forEach(function (f) { if (a[f] !== b[f]) { eb[f] = b[f]; ea[f] = a[f]; } });
    var map = load(), k = keyOf(kind, change.id);
    if (Object.keys(ea).length) map[k] = { kind: kind, id: change.id, before: eb, after: ea, commit: commit || null, at: now || Date.now() };
    else delete map[k];
    store(map);
  }

  function forget(change) {
    var map = load(), k = keyOf(E.fileOf(change), change.id);
    if (k in map) { delete map[k]; store(map); }
  }

  function same(want, now) {
    return Object.keys(want).every(function (f) { return want[f] === now[f]; });
  }

  // Puts "after" on a record (in place).
  function put(kind, rec, after) {
    if (kind === "bonus") { Object.keys(after).forEach(function (f) { rec[f] = after[f]; }); return; }
    var entry = {};
    if ("status" in after || "status_since" in after || "used_on" in after) {
      var cur = fieldsOf("offers", rec);
      entry.status = "status" in after ? after.status : cur.status;
      entry.status_since = "status_since" in after ? after.status_since : cur.status_since;
      var on = "used_on" in after ? after.used_on : cur.used_on;
      if (on) entry.used_on = on;
    }
    if ("activation" in after) entry.activation = after.activation;
    E.applyEdit(rec, entry);
  }

  // Checks every entry of one kind ("offers" or "bonus") against the loaded records (data.offers or
  // bonus.entries) and puts back the ones the records don't show yet. Returns the ids put back.
  function apply(kind, records, now) {
    now = now || Date.now();
    var map = load(), changed = false, back = [], byId = {};
    (records || []).forEach(function (r) { byId[r.id] = r; });
    Object.keys(map).forEach(function (k) {
      var e = map[k];
      var bad = !e || typeof e !== "object" || !FIELDS[e.kind] || !e.after || !e.before || typeof e.at !== "number";
      if (!bad && e.kind !== kind) return;
      var rec = !bad && Object.prototype.hasOwnProperty.call(byId, e.id) ? byId[e.id] : null;
      if (bad || now - e.at > MAX_AGE || e.at > now + MAX_AGE || !rec) { delete map[k]; changed = true; return; }
      var cur = fieldsOf(kind, rec);
      if (same(e.after, cur)) { delete map[k]; changed = true; return; } // the site has it now
      if (same(e.before, cur)) { put(kind, rec, e.after); back.push(e.id); return; } // not live yet
      delete map[k]; changed = true; // changed somewhere else, or by a refresh
    });
    if (changed) store(map);
    return back;
  }

  var api = { remember: remember, forget: forget, apply: apply, KEY: KEY, MAX_AGE: MAX_AGE };
  root.CardRecent = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

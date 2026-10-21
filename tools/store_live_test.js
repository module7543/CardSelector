// Live test of site/js/store.js against module7543/CardSelector, on a throwaway branch made from main (or
// BASE_SHA), deleted afterwards, so nothing deploys. Needs a token with contents write in GH_TOKEN, e.g. a
// workflow's GITHUB_TOKEN:
//   GH_TOKEN=... [BASE_SHA=<commit>] node tools/store_live_test.js [<us-bank id> <capital-one id> <needs_activation id>]
// Run it from a checkout of that same commit: the page's copy of offers.json is this checkout's file.
// Offer saves (mark used, restore, mark activated, undo) must write only site/data/phone-edits.json; a bonus
// save still writes bonus-categories.json. Prints the bytes one mark-used save sends and receives.
const fs = require("fs"), path = require("path");
const SITE = path.join(__dirname, "../site/js/");
const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) { console.error("GH_TOKEN is not set"); process.exit(2); }
const [US, CAP, NEEDS] = [process.argv[2] || "us-bank/round-table-pizza", process.argv[3] || "capital-one/cvs", process.argv[4] || "us-bank/logitech"];
const EDITS = "site/data/phone-edits.json", BONUS = "site/data/bonus-categories.json";
const TB = "phone-edit-test-" + Date.now().toString(36);
const API = "https://api.github.com/repos/module7543/CardSelector";
const realFetch = globalThis.fetch;
let hook = null, log = [], meter = null;
globalThis.fetch = async (url, opts = {}) => {
  url = url.replace("/git/ref/heads/main", "/git/ref/heads/" + TB).replace("/git/refs/heads/main", "/git/refs/heads/" + TB);
  if (hook && opts.method === "PATCH") { const h = hook; hook = null; await h(); }
  log.push((opts.method || "GET") + " " + url.replace(API, ""));
  const m = meter, res = await realFetch(url, opts);
  if (m) {
    // Sent: request line, headers and body. Received: body as decoded, plus the wire length when GitHub sends one.
    const hdr = Object.entries(opts.headers || {}).reduce((n, [k, v]) => n + k.length + String(v).length + 4, 0);
    m.sentHeaders += (opts.method || "GET").length + url.length + 12 + hdr;
    m.sentBody += Buffer.byteLength(opts.body || "");
    const body = await res.clone().arrayBuffer();
    m.received += body.byteLength;
    m.calls.push((opts.method || "GET") + " " + url.replace(API, "").replace(/[0-9a-f]{40}/, "<sha>") + " " + body.byteLength + " B" +
      (res.headers.get("content-encoding") ? " (" + res.headers.get("content-encoding") + " " + res.headers.get("content-length") + " B on the wire)" : ""));
  }
  return res;
};
globalThis.localStorage = { _s: { "cardselector.token": TOKEN }, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = v; }, removeItem(k) { delete this._s[k]; } };
const E = require(SITE + "edits.js"), S = require(SITE + "store.js");
const offersText = fs.readFileSync(path.join(__dirname, "../site/data/offers.json"), "utf8");
S.setOffersBase(offersText);
const gh = async (m, p, b, accept) => { const r = await realFetch(API + p, { method: m, headers: { Accept: accept || "application/vnd.github+json", "Content-Type": "application/json", Authorization: "Bearer " + TOKEN }, body: b && JSON.stringify(b) }); const t = await r.text(); if (!r.ok) throw new Error(m + " " + p + " " + r.status + " " + t.slice(0, 200)); return accept ? t : t ? JSON.parse(t) : null; };
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const pending = async () => { const l = await gh("GET", "/contents/site/data?ref=" + TB); return l.some(f => f.path === EDITS) ? JSON.parse(await gh("GET", "/contents/" + EDITS + "?ref=" + TB, null, "application/vnd.github.raw+json")) : {}; };
const filesOf = async sha => ((await gh("GET", "/commits/" + sha)).files || []).map(f => f.filename);
(async () => {
  const main = process.env.BASE_SHA ? { object: { sha: process.env.BASE_SHA } } : await gh("GET", "/git/ref/heads/main");
  await gh("POST", "/git/refs", { ref: "refs/heads/" + TB, sha: main.object.sha });
  console.log("branch", TB, "from", main.object.sha.slice(0, 7));
  const today = E.pacificToday();
  try {
    // 1. Mark used on a two-card issuer, metered.
    let t0 = Date.now();
    meter = { sentHeaders: 0, sentBody: 0, received: 0, calls: [] };
    let r = await S.save({ type: "offer.status", id: US, from: "active", to: "used", usedOn: "Smartly" });
    const m1 = meter; meter = null;
    ok(r.status === "saved" && r.record.status === "used" && r.record.other_details.includes("Used on Smartly"), "mark used saved (" + (Date.now() - t0) + " ms) " + r.message);
    console.log("bytes for one mark-used save: sent " + (m1.sentHeaders + m1.sentBody) + " (" + m1.sentBody + " body + ~" + m1.sentHeaders + " request line and headers), received " + m1.received + " (bodies, decoded)");
    m1.calls.forEach(c => console.log("   " + c));
    const f1 = await filesOf(r.commit);
    ok(f1.length === 1 && f1[0] === EDITS, "mark used commit touches only " + f1.join(", "));
    ok(JSON.stringify((await pending())[US]) === JSON.stringify({ status: "used", status_since: today, used_on: "Smartly" }), "phone-edits.json entry for " + US);
    const undo = r.undo;
    // 2. Same change again: already done. 3. No card picked: invalid.
    r = await S.save({ type: "offer.status", id: US, from: "active", to: "used", usedOn: "Smartly" });
    ok(r.status === "done", "repeat -> done: " + r.message);
    r = await S.save({ type: "offer.status", id: CAP, from: "active", to: "used" });
    ok(r.status === "invalid", "no card picked -> invalid: " + r.message);
    // 4. Conflict: checked against offers.json plus main's pending edit (the offer is used there now).
    r = await S.save({ type: "offer.status", id: US, from: "missing", to: "active" });
    ok(r.status === "conflict" && r.now === "used", "stale offer change -> conflict: " + r.message);
    // 5. Mark activated.
    r = await S.save({ type: "offer.activation", id: NEEDS, from: "needs_activation", to: "already_activated" });
    ok(r.status === "saved" && r.record.activation === "already_activated", "mark activated saved: " + r.message);
    ok((await filesOf(r.commit)).join() === EDITS, "mark activated commit touches only phone-edits.json");
    // 6. Main moves between the read and the branch update (another phone marks a Capital One offer used):
    //    the save starts over, both land, neither is lost.
    let inner = null;
    hook = async () => { inner = await S.save({ type: "offer.status", id: CAP, from: "active", to: "used", usedOn: "Quicksilver" }); };
    log = [];
    r = await S.save({ type: "offer.activation", id: NEEDS, from: "already_activated", to: "needs_activation" });
    const patches = log.filter(l => l.startsWith("PATCH")).length;
    ok(inner && inner.status === "saved" && r.status === "saved" && patches >= 3, "race: concurrent save landed, this one retried and saved (" + patches + " ref updates)");
    let p = await pending();
    ok(p[CAP] && p[CAP].used_on === "Quicksilver" && !p[NEEDS] && p[US], "race: both edits kept (" + Object.keys(p).join(", ") + "; " + NEEDS + " back to its offers.json value, no entry)");
    // 7. Restore (the details button: no status_since) and Undo (exact earlier status_since).
    r = await S.save({ type: "offer.status", id: CAP, from: "used", to: "active" });
    ok(r.status === "saved" && r.record.status === "active" && !r.record.other_details.some(x => x.startsWith("Used on")), "restore saved: " + r.message);
    r = await S.save(undo);
    p = await pending();
    ok(r.status === "saved" && r.record.status === "active" && !p[US], "undo saved, entry removed: " + r.message);
    // 8. A page whose offers.json differs from main's: refused before anything is written.
    S.setOffersBase(offersText + "\n");
    r = await S.save({ type: "offer.activation", id: NEEDS, from: "needs_activation", to: "already_activated" });
    ok(r.status === "error" && r.kind === "reload", "page copy differs from main -> " + r.kind + ": " + r.message);
    S.setOffersBase(offersText);
    // 9. Bonus saves are unchanged: the Custom Cash focus writes bonus-categories.json.
    const bonus = JSON.parse(fs.readFileSync(path.join(__dirname, "..", BONUS), "utf8")), cc = bonus.entries.find(e => e.planned);
    const other = cc.eligible.map(e => e.name).find(n => n !== cc.planned);
    r = await S.save({ type: "bonus.planned", id: cc.id, from: cc.planned, to: other });
    ok(r.status === "saved" && (await filesOf(r.commit)).join() === BONUS, "bonus focus save touches only bonus-categories.json");
    // 10. Deploy status for a branch commit (no workflow run on a test branch).
    const ls = await S.liveStatus({ commit: r.commit }); console.log("liveStatus:", ls.state, ls.message);
    const end = (await gh("GET", "/git/ref/heads/" + TB)).object.sha;
    const all = await gh("GET", "/compare/" + main.object.sha + "..." + end);
    console.log("commits (files each touches):");
    for (const c of all.commits || []) {
      const f = await filesOf(c.sha);
      console.log("  ", c.sha.slice(0, 7), c.commit.message.split("\n")[0], "->", f.join(", "));
      if (!/^Custom Cash focus/.test(c.commit.message)) ok(f.length === 1 && f[0] === EDITS, "  offer save " + c.sha.slice(0, 7) + " touches only phone-edits.json");
    }
    ok(!(all.files || []).some(f => f.filename === "site/data/offers.json"), "offers.json never written");
    console.log("net change vs base:"); (all.files || []).forEach(x => console.log(" ", x.filename, "+" + x.additions, "-" + x.deletions, "\n" + x.patch));
  } finally {
    if (!process.env.KEEP) { await gh("DELETE", "/git/refs/heads/" + TB); console.log("deleted", TB); }
  }
})().catch(e => { console.error(e); process.exitCode = 1; });

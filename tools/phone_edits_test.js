// Phone edits in site/data/phone-edits.json:  node tools/phone_edits_test.js
// 1. Offline: site/js/store.js against an in-memory copy of the GitHub API holding the real data files: every
//    offer save writes only phone-edits.json, conflicts, main moving mid-save, Undo, a stale page, bonus saves,
//    and the bytes each save sends and receives.
// 2. Folding: tools/fold_phone_edits.py on a temp copy gives offers.json byte for byte as the old in-place save
//    (edits.js apply() on offers.json) would have, and a second run changes nothing.
// 3. Browser at phone width (Playwright; CHROMIUM_PATH picks a browser binary): a test phone-edits.json served
//    in place of the real one (one offer used, one activated) shows correctly; a missing file is the same as an
//    empty one; a broken one shows the load error. The real data files are never written.
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto"), cp = require("child_process");
const ROOT = path.join(__dirname, ".."), SITE = path.join(ROOT, "site"), DATA = path.join(SITE, "data");
const OFFERS = "site/data/offers.json", BONUS = "site/data/bonus-categories.json", EDITS = "site/data/phone-edits.json";

let failed = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) failed++; };
const read = p => fs.readFileSync(path.join(ROOT, p), "utf8");
const ser = o => JSON.stringify(o, null, 2) + "\n";
const digest = () => fs.readdirSync(DATA).map(f => f + ":" + crypto.createHash("sha1").update(fs.readFileSync(path.join(DATA, f))).digest("hex")).join(" ");
const dataBefore = digest();

// Test offers, picked from today's data so a refresh doesn't break the test: live offers whose merchant has no
// other offer on the same card (so a search for the name finds exactly that row), longest names first (few other
// matches), id order on ties.
//   usbank: U.S. Bank, already activated, percent bonus (it shows in the "Ready now" headline); marked used on Smartly
//   needs:  U.S. Bank, needs activation; chase: a single-card issuer (Chase or Citi), needs activation; capone: Capital One
const offersText = read(OFFERS), offersData = JSON.parse(offersText);
const byId = Object.fromEntries(offersData.offers.map(o => [o.id, o]));
// Not expiring within two days: the page hides offers by the device's own date, which on CI (UTC) is already the
// next day during a Pacific evening.
const safeDate = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
const perCard = {};
offersData.offers.forEach(o => { const k = o.card + "|" + o.merchant; perCard[k] = (perCard[k] || 0) + 1; });
const pick = (pred, not = []) => (offersData.offers
  .filter(o => o.status === "active" && !(o.expires && o.expires <= safeDate) && perCard[o.card + "|" + o.merchant] === 1 && !not.includes(o.id) && pred(o))
  .sort((a, b) => b.merchant.length - a.merchant.length || (a.id < b.id ? -1 : 1))[0] || {}).id;
const ID = {};
ID.usbank = pick(o => o.card === "U.S. Bank" && o.activation === "already_activated" && /^\s*\d+(\.\d+)?\s*%/.test(o.bonus));
ID.needs = pick(o => o.card === "U.S. Bank" && o.activation === "needs_activation", [ID.usbank]);
ID.chase = pick(o => /^(Chase|Citi) /.test(o.card) && o.activation === "needs_activation");
ID.capone = pick(o => o.card === "Capital One");
const ROW_CARD = (() => { const l = JSON.parse(read("site/data/cards.json")).offer_lists || {}; return c => (l[c] && l[c].row_name) || c; })();

// ---- In-memory GitHub: commits hold whole file maps; blob shas are real git blob hashes. ----
const gitSha = buf => crypto.createHash("sha1").update(Buffer.concat([Buffer.from("blob " + buf.length + "\0"), buf])).digest("hex");
class Hub {
  constructor(files) {
    this.n = 0; this.commits = {}; this.blobs = {}; this.trees = {}; this.hook = null; this.bytes = null;
    const map = {}; for (const p of Object.keys(files)) map[p] = this.blob(files[p]);
    this.head = this.commit(this.tree(map), null, "init");
  }
  blob(text) { const s = gitSha(Buffer.from(text)); this.blobs[s] = text; return s; }
  tree(map) { const id = "tree" + (++this.n); this.trees[id] = map; return id; }
  commit(tree, parent, message) { const sha = crypto.createHash("sha1").update("c" + (++this.n)).digest("hex"); this.commits[sha] = { tree, parent, message }; return sha; }
  file(p, sha = this.head) { const b = this.trees[this.commits[sha].tree][p]; return b ? this.blobs[b] : null; }
  // Paths a commit changed against its parent.
  changed(sha) {
    const c = this.commits[sha], a = this.trees[c.tree], b = c.parent ? this.trees[this.commits[c.parent].tree] : {};
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(p => a[p] !== b[p]).sort();
  }
  // Commits from `from` (exclusive) to head, oldest first.
  since(from) { const out = []; for (let s = this.head; s && s !== from; s = this.commits[s].parent) out.unshift(s); return out; }
  async fetch(url, opts = {}) {
    const m = opts.method || "GET", u = new URL(url), p = u.pathname.replace("/repos/module7543/CardSelector", ""), ref = u.searchParams.get("ref");
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (this.bytes) this.bytes.sent += Buffer.byteLength(opts.body || "");
    if (m === "PATCH" && this.hook) { const h = this.hook; this.hook = null; await h(); }
    const res = this.route(m, p, ref, body, opts.headers || {});
    const text = res.text !== undefined ? res.text : JSON.stringify(res.json);
    if (this.bytes) { this.bytes.received += Buffer.byteLength(text); this.bytes.calls.push(m + " " + p.replace(/[0-9a-f]{40}/, "<sha>")); }
    return new Response(text, { status: res.status || 200 });
  }
  route(m, p, ref, body, headers) {
    if (m === "GET" && p === "/git/ref/heads/main") return { json: { object: { sha: this.head } } };
    let x;
    if (m === "GET" && (x = /^\/git\/commits\/(\w+)$/.exec(p))) return { json: { sha: x[1], tree: { sha: this.commits[x[1]].tree } } };
    if (m === "GET" && p === "/contents/site/data") {
      const t = this.trees[this.commits[ref].tree];
      return { json: Object.keys(t).filter(k => k.startsWith("site/data/")).map(k => ({ name: k.split("/").pop(), path: k, sha: t[k], type: "file" })) };
    }
    if (m === "GET" && (x = /^\/contents\/(.+)$/.exec(p))) {
      if (!/raw/.test(headers.Accept || "")) return { status: 415, json: {} };
      const f = this.file(x[1], ref);
      return f === null ? { status: 404, json: { message: "Not Found" } } : { text: f };
    }
    if (m === "POST" && p === "/git/blobs") return { status: 201, json: { sha: this.blob(body.content) } };
    if (m === "POST" && p === "/git/trees") {
      const map = Object.assign({}, this.trees[body.base_tree]);
      body.tree.forEach(e => { map[e.path] = e.sha; });
      return { status: 201, json: { sha: this.tree(map) } };
    }
    if (m === "POST" && p === "/git/commits") return { status: 201, json: { sha: this.commit(body.tree, body.parents[0], body.message) } };
    if (m === "PATCH" && p === "/git/refs/heads/main") {
      if (this.commits[body.sha].parent !== this.head) return { status: 422, json: { message: "Update is not a fast forward" } };
      this.head = body.sha;
      return { json: { object: { sha: body.sha } } };
    }
    return { status: 404, json: { message: "no mock for " + m + " " + p } };
  }
}

globalThis.localStorage = { _s: { "cardselector.token": "test" }, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = v; }, removeItem(k) { delete this._s[k]; } };
const E = require(path.join(SITE, "js/edits.js")), S = require(path.join(SITE, "js/store.js"));
const today = E.pacificToday();

async function offline() {
  console.log("-- offline store (mock GitHub with the real data files)");
  ok(ID.usbank && ID.needs && ID.chase && ID.capone, "test offers picked from the data: " + [ID.usbank, ID.needs, ID.chase, ID.capone].join(", "));
  const hub = new Hub({ [OFFERS]: offersText, [BONUS]: read(BONUS), [EDITS]: "{}\n" }); // no pending edits, whatever main holds
  const start = hub.head;
  globalThis.fetch = (u, o) => hub.fetch(u, o);
  S.setOffersBase(offersText);
  const saved = []; // successful offer changes, in order (for the fold parity check)
  const save = async (change, label) => {
    const outer = hub.bytes; // a save run from inside another (the race) counts on its own
    hub.bytes = { sent: 0, received: 0, calls: [] };
    const before = hub.head, mine = hub.bytes;
    const r = await S.save(change), b = mine;
    hub.bytes = outer;
    if (r.status === "saved" && E.fileOf(change) === "offers") saved.push(change);
    const files = hub.since(before).map(s => hub.changed(s).join("+"));
    console.log("     " + label + ": " + r.status + ", sent " + b.sent + " B, received " + b.received + " B, commits touching [" + files.join(", ") + "]");
    return Object.assign(r, { bytes: b, files });
  };
  const pending = () => JSON.parse(hub.file(EDITS) || "{}");

  // Mark used (two-card issuer): only phone-edits.json changes, with the entry the page reads.
  let r = await save({ type: "offer.status", id: ID.usbank, from: "active", to: "used", usedOn: "Smartly" }, "mark used");
  ok(r.status === "saved" && r.record.status === "used" && r.record.other_details.includes("Used on Smartly"), "mark used: saved, record used on Smartly");
  ok(r.files.length === 1 && r.files[0] === EDITS, "mark used: the commit touches only phone-edits.json");
  ok(JSON.stringify(pending()[ID.usbank]) === JSON.stringify({ status: "used", status_since: today, used_on: "Smartly" }), "mark used: entry " + JSON.stringify(pending()[ID.usbank]));
  ok(hub.file(OFFERS) === offersText, "mark used: offers.json on main unchanged");
  ok(r.bytes.sent < 2000 && r.bytes.received < 10000, "mark used: small transfer (" + r.bytes.sent + " B sent, " + r.bytes.received + " B received; calls: " + r.bytes.calls.join(", ") + ")");
  const undoUsed = r.undo, usedSince = byId[ID.usbank].status_since;

  r = await save({ type: "offer.status", id: ID.usbank, from: "active", to: "used", usedOn: "Smartly" }, "repeat");
  ok(r.status === "done" && /already used/.test(r.message), "repeat mark used -> done: " + r.message);
  r = await save({ type: "offer.status", id: ID.capone, from: "active", to: "used" }, "no card");
  ok(r.status === "invalid" && /Quicksilver or Discover it/.test(r.message), "no card picked -> invalid: " + r.message);
  r = await save({ type: "offer.status", id: "nope/nope", from: "active", to: "used" }, "unknown id");
  ok(r.status === "invalid" && /Couldn’t find/.test(r.message), "unknown offer -> invalid: " + r.message);

  // Conflict against the offer as it is on main (offers.json + the pending used edit), not offers.json alone.
  r = await save({ type: "offer.status", id: ID.usbank, from: "missing", to: "active" }, "conflict");
  ok(r.status === "conflict" && r.now === "used" && r.record.status === "used" && r.files.length === 0, "stale change -> conflict, now used, nothing committed: " + r.message);

  // Mark activated (single-card issuer), then main moves mid-save (another phone marks a Capital One offer used).
  r = await save({ type: "offer.activation", id: ID.chase, from: "needs_activation", to: "already_activated" }, "mark activated");
  ok(r.status === "saved" && r.record.activation === "already_activated" && r.files.join() === EDITS, "mark activated: saved, only phone-edits.json");
  ok(JSON.stringify(pending()[ID.chase]) === JSON.stringify({ activation: "already_activated" }), "mark activated: entry " + JSON.stringify(pending()[ID.chase]));
  const undoAct = r.undo;
  let inner = null;
  hub.hook = async () => { inner = await save({ type: "offer.status", id: ID.capone, from: "active", to: "used", usedOn: "Discover it" }, "  concurrent save"); };
  r = await save({ type: "offer.activation", id: ID.needs, from: "needs_activation", to: "already_activated" }, "race");
  ok(inner && inner.status === "saved" && r.status === "saved" && r.files.length === 2 && r.files.every(f => f === EDITS),
     "main moved mid-save: retried on the new main, both saved, each commit only phone-edits.json");
  ok(pending()[ID.capone] && pending()[ID.capone].used_on === "Discover it" && pending()[ID.needs] && pending()[ID.usbank] && pending()[ID.chase], "race: no edit lost (" + Object.keys(pending()).join(", ") + ")");

  // A page loaded before offers.json changed on main: refused, nothing written.
  const fold = hub.commit(hub.tree(Object.assign({}, hub.trees[hub.commits[hub.head].tree], { [OFFERS]: hub.blob(offersText.replace('"bonus": "10% cash back"', '"bonus": "10% cash back "')) })), hub.head, "offers.json changed");
  hub.head = fold;
  r = await save({ type: "offer.activation", id: ID.chase, from: "already_activated", to: "needs_activation" }, "stale page");
  ok(r.status === "error" && r.kind === "reload" && /Wait a minute, reload/.test(r.message) && r.files.length === 0, "offers.json changed on main -> " + r.kind + ": " + r.message);
  hub.head = hub.commits[fold].parent; // back to the real offers.json

  // Undo the mark used: exact earlier status_since, entry removed. Undo activation: entry removed.
  r = await save(undoUsed, "undo used");
  ok(r.status === "saved" && r.record.status === "active" && r.record.status_since === usedSince && !r.record.other_details.some(t => /^Used on/.test(t)) && !(ID.usbank in pending()),
     "undo used: active since " + usedSince + " again, entry removed");
  r = await save(undoAct, "undo activated");
  ok(r.status === "saved" && !(ID.chase in pending()), "mark not activated: back to offers.json value, entry removed");

  // Restore (the details button, no status_since): active since today, kept as an edit like the old save did.
  r = await save({ type: "offer.status", id: ID.capone, from: "used", to: "active" }, "restore");
  const wantRestore = byId[ID.capone].status_since === today ? undefined : JSON.stringify({ status: "active", status_since: today });
  ok(r.status === "saved" && JSON.stringify(pending()[ID.capone]) === wantRestore, "restore: entry " + JSON.stringify(pending()[ID.capone]));

  // Undo of that restore: used again on the same card (Discover it, from the race above), earlier date kept.
  r = await save(r.undo, "undo restore");
  ok(r.status === "saved" && r.record.status === "used" && r.record.other_details.includes("Used on Discover it") && pending()[ID.capone].used_on === "Discover it",
     "undo of a restore: used on Discover it again (" + JSON.stringify(pending()[ID.capone]) + ")");
  r = await save(r.undo, "restore again");
  ok(r.status === "saved" && r.record.status === "active", "restore again: active");

  // Bonus saves: unchanged path, bonus-categories.json only.
  const bonus = JSON.parse(read(BONUS)), cc = bonus.entries.find(e => e.planned);
  const other = cc && cc.eligible.map(e => e.name).find(n => n !== cc.planned);
  r = await save({ type: "bonus.planned", id: cc.id, from: cc.planned, to: other }, "bonus focus");
  ok(r.status === "saved" && r.files.join() === BONUS, "bonus focus save: only bonus-categories.json (" + other + ")");
  r = await save({ type: "bonus.planned", id: cc.id, from: cc.planned, to: other }, "bonus repeat");
  ok(r.status === "done", "bonus focus repeat -> done");
  const ch = bonus.entries.find(e => e.choices), chTo = ch && ch.choices.map(c => c.name).find(n => n !== ch.choice);
  r = await save({ type: "bonus.choice", id: ch.id, from: ch.choice, to: chTo }, "bonus choice");
  ok(r.status === "saved" && r.files.join() === BONUS && JSON.parse(hub.file(BONUS)).entries.find(e => e.id === ch.id).choice === chTo, "bonus choice save: only bonus-categories.json (" + chTo + ")");
  r = await save(r.undo, "bonus choice undo");
  ok(r.status === "saved" && JSON.parse(hub.file(BONUS)).entries.find(e => e.id === ch.id).choice === ch.choice, "bonus choice undo: back to " + ch.choice);

  const touched = hub.since(start).map(s => hub.changed(s)).flat();
  ok(!touched.includes(OFFERS), "no save wrote offers.json (" + hub.since(start).length + " commits)");
  ok(ser(JSON.parse(hub.file(EDITS))) === hub.file(EDITS), "phone-edits.json stays in the standard layout");
  return { hub, saved, editsText: hub.file(EDITS) };
}

// Folding: the pending edits written into offers.json equal the old in-place save of the same changes.
function folding(saved, editsText) {
  console.log("-- folding (tools/fold_phone_edits.py on a temp copy)");
  const old = JSON.parse(offersText);
  saved.forEach(c => { const a = E.apply({ offers: old }, c, today); if (!a.ok) throw new Error("old path refused " + JSON.stringify(c)); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fold-"));
  fs.writeFileSync(path.join(dir, "offers.json"), offersText);
  fs.writeFileSync(path.join(dir, "phone-edits.json"), editsText);
  const run = () => cp.execFileSync("python3", [path.join(__dirname, "fold_phone_edits.py"), dir], { encoding: "utf8" });
  const out1 = run(), after1 = fs.readFileSync(path.join(dir, "offers.json"), "utf8");
  ok(Object.keys(JSON.parse(editsText)).length > 0, "fold input has " + Object.keys(JSON.parse(editsText)).length + " pending edit(s)");
  ok(after1 === ser(old), "fold: offers.json byte for byte as the old in-place save (" + saved.length + " saves)");
  ok(fs.readFileSync(path.join(dir, "phone-edits.json"), "utf8") === "{}\n", "fold: phone-edits.json emptied");
  const out2 = run();
  ok(fs.readFileSync(path.join(dir, "offers.json"), "utf8") === after1 && /No pending/.test(out2), "fold twice: second run changes nothing");
  // Every kind of entry, folded on its own, against the old save.
  const cases = [
    [{ type: "offer.status", id: ID.capone, from: "active", to: "used", usedOn: "Quicksilver" }],
    [{ type: "offer.status", id: ID.chase, from: "active", to: "used" }],
    [{ type: "offer.activation", id: ID.needs, from: "needs_activation", to: "already_activated" }, { type: "offer.status", id: ID.needs, from: "active", to: "used", usedOn: "Cash+" }]
  ];
  cases.forEach(cs => {
    const o2 = JSON.parse(offersText), base = JSON.parse(offersText).offers.find(o => o.id === cs[0].id), edits = {};
    let rec = E.withEdit(base, null);
    cs.forEach(c => { E.apply({ offers: o2 }, c, today); const f = { offers: { offers: [rec] } }; E.apply(f, c, today); rec = f.offers.offers[0]; });
    edits[cs[0].id] = E.editFor(base, rec);
    fs.writeFileSync(path.join(dir, "offers.json"), offersText);
    fs.writeFileSync(path.join(dir, "phone-edits.json"), ser(edits));
    run();
    ok(fs.readFileSync(path.join(dir, "offers.json"), "utf8") === ser(o2), "fold " + JSON.stringify(edits[cs[0].id]) + " = old save");
  });
  fs.rmSync(dir, { recursive: true });
  foldGuard();
  console.log(out1.trim().split("\n").map(l => "     " + l).join("\n"));
}

// The fold runs only in the workflow: with no folder argument, the tool refuses outside it, and the folder argument
// can't point at the repo's own data.
function foldGuard() {
  const run = (args, env) => { try { cp.execFileSync("python3", ["-B", path.join(__dirname, "fold_phone_edits.py"), ...args], { encoding: "utf8", stdio: "pipe", env: Object.assign({}, process.env, { GITHUB_ACTIONS: "", FOLD_PHONE_EDITS: "" }, env) }); return 0; } catch (e) { return { code: e.status, out: (e.stderr || "") + (e.stdout || "") }; } };
  const before = digest();
  const r1 = run([], {});
  ok(r1 && r1.code && /only in the 'Fold phone edits'/.test(r1.out), "fold with no folder outside the workflow -> refused");
  const r2 = run([], { GITHUB_ACTIONS: "true" });
  ok(r2 && r2.code, "fold in some other Actions job (no FOLD_PHONE_EDITS=1) -> refused");
  const r3 = run([DATA], {});
  ok(r3 && r3.code && /test copies/.test(r3.out), "folder argument pointing at the repo's own data -> refused");
  ok(digest() === before, "refused folds wrote nothing");
}

// tools/fold_on_main.sh (the workflow's fold step) against a local bare repo standing in for GitHub: nothing to do,
// fold + validate + fast-forward push, main moving mid-push (start over), bad data (nothing pushed), giving up.
function foldOnMain() {
  console.log("-- tools/fold_on_main.sh against a local bare origin");
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "foldmain-")), origin = path.join(t, "origin.git");
  const env = Object.assign({}, process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
  const git = (dir, ...a) => cp.execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: "pipe", env, maxBuffer: 64 << 20 }).trim();
  cp.execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env });
  // A phone save: a clone of main with one more pending edit, pushed.
  const phone = (id, entry, name) => {
    const d = path.join(t, name || "phone-" + Math.random().toString(36).slice(2));
    git(t, "clone", "-q", origin, d);
    const f = path.join(d, EDITS), cur = JSON.parse(fs.readFileSync(f, "utf8"));
    cur[id] = entry;
    fs.writeFileSync(f, ser(cur));
    git(d, "commit", "-qam", "phone save " + id);
    git(d, "push", "-q", "origin", "main");
    return d;
  };
  const seed = path.join(t, "seed");
  fs.mkdirSync(path.join(seed, "tools"), { recursive: true }); fs.mkdirSync(path.join(seed, "site/data"), { recursive: true });
  ["fold_phone_edits.py", "validate.py", "fold_on_main.sh"].forEach(f => fs.copyFileSync(path.join(__dirname, f), path.join(seed, "tools", f)));
  fs.readdirSync(DATA).forEach(f => fs.copyFileSync(path.join(DATA, f), path.join(seed, "site/data", f)));
  fs.writeFileSync(path.join(seed, EDITS), "{}\n");
  git(seed, "init", "-q", "-b", "main"); git(seed, "add", "-A"); git(seed, "commit", "-qm", "base"); git(seed, "remote", "add", "origin", origin); git(seed, "push", "-q", "origin", "main");
  // The workflow's runner: a clone of main; runs the script as the fold job does.
  const runner = path.join(t, "runner");
  git(t, "clone", "-q", origin, runner);
  const run = (extra = {}) => {
    const outFile = path.join(t, "out-" + Date.now() + Math.random());
    fs.writeFileSync(outFile, "");
    let code = 0, log = "";
    try { log = cp.execFileSync("bash", [path.join(runner, "tools/fold_on_main.sh")], { encoding: "utf8", stdio: "pipe", env: Object.assign({}, env, { GITHUB_ACTIONS: "true", GITHUB_OUTPUT: outFile }, extra) }); }
    catch (e) { code = e.status; log = (e.stdout || "") + (e.stderr || ""); }
    const o = Object.fromEntries(fs.readFileSync(outFile, "utf8").split("\n").filter(Boolean).map(l => l.split("=")));
    return { code, log, out: o };
  };
  const head = () => git(origin, "rev-parse", "main");
  const at = (f, rev = "main") => git(origin, "show", rev + ":" + f);
  const offerAt = (id, rev) => JSON.parse(at(OFFERS, rev)).offers.find(o => o.id === id);

  // A session's working copy: a work branch with an uncommitted change. Outside Actions the script must not touch it.
  git(runner, "checkout", "-qb", "work");
  fs.appendFileSync(path.join(runner, "site/data/cards.json"), " ");
  let h0 = head(), r = run({ GITHUB_ACTIONS: "" });
  ok(r.code !== 0 && /Runs only in the Fold phone edits workflow/.test(r.log) && git(runner, "rev-parse", "--abbrev-ref", "HEAD") === "work" &&
     git(runner, "status", "--porcelain") === "M site/data/cards.json" && head() === h0,
     "outside GitHub Actions the script refuses before touching the checkout (branch and uncommitted change kept)");
  git(runner, "checkout", "-q", "--", "."); git(runner, "checkout", "-q", "main");
  r = run();
  ok(r.code === 0 && r.out.folded === "false" && head() === h0, "empty phone-edits.json -> nothing to do, nothing pushed");

  phone(ID.usbank, { status: "used", status_since: today, used_on: "Smartly" });
  h0 = head(); r = run();
  const o1 = offerAt(ID.usbank);
  ok(r.code === 0 && r.out.folded === "true" && head() === r.out.sha && git(origin, "rev-parse", r.out.sha + "^") === h0,
     "pending edit -> folded and pushed as a fast-forward of main (" + (r.out.sha || "").slice(0, 7) + ")");
  ok(o1.status === "used" && o1.status_since === today && o1.other_details.includes("Used on Smartly") && at(EDITS) === "{}",
     "the fold commit has the offer used on Smartly and an empty phone-edits.json");
  ok(git(origin, "diff", "--name-only", h0, "main").split("\n").sort().join() === [OFFERS, EDITS].sort().join(), "the fold commit touches only offers.json and phone-edits.json");
  h0 = head(); r = run();
  ok(r.code === 0 && r.out.folded === "false" && head() === h0, "second run -> nothing to do");

  // Main moves between the fold and the push: a pre-push hook lands another phone save first (once).
  phone(ID.chase, { activation: "already_activated" });
  const hook = path.join(runner, ".git/hooks/pre-push"), mark = path.join(t, "moved");
  fs.writeFileSync(hook, "#!/bin/sh\n[ -f '" + mark + "' ] && exit 0\ntouch '" + mark + "'\nd=" + JSON.stringify(t) + "/racer\ngit clone -q " + JSON.stringify(origin) + " \"$d\" && cd \"$d\" && python3 - <<'PY'\nimport json\np='site/data/phone-edits.json'; d=json.load(open(p)); d[" + JSON.stringify(ID.needs) + "]={'activation':'already_activated'}\nopen(p,'w').write(json.dumps(d, indent=2, ensure_ascii=False)+'\\n')\nPY\ngit commit -qam 'phone save during the fold' && git push -q origin main\n");
  fs.chmodSync(hook, 0o755);
  r = run();
  const c2 = offerAt(ID.chase), n2 = offerAt(ID.needs);
  ok(r.code === 0 && r.out.folded === "true" && /starting over/.test(r.log) && /try 2/.test(r.log), "main moved mid-push -> started over from the new main and pushed on try 2");
  ok(c2.activation === "already_activated" && n2.activation === "already_activated" && at(EDITS) === "{}" && git(origin, "log", "-1", "--format=%s", "main").startsWith("Fold 2 phone edit"),
     "both edits folded, the one that landed mid-fold too (" + git(origin, "log", "-1", "--format=%s", "main") + ")");
  fs.rmSync(hook);

  // Bad data: the fold refuses an unknown id, validate.py refuses a bad edit; nothing is pushed either way.
  phone("nope/nope", { activation: "already_activated" });
  h0 = head(); r = run();
  ok(r.code !== 0 && head() === h0 && /nope\/nope: no offer with this id/.test(r.log), "unknown offer id -> refused by validate.py before folding, nothing pushed");
  const fix = path.join(t, "fix"); git(t, "clone", "-q", origin, fix);
  fs.writeFileSync(path.join(fix, EDITS), ser({ [ID.capone]: { status: "used", status_since: today } })); // Capital One needs a card
  git(fix, "commit", "-qam", "bad edit"); git(fix, "push", "-q", "origin", "main");
  h0 = head(); r = run();
  ok(r.code !== 0 && head() === h0 && /used_on must be/.test(r.log), "edit validate.py rejects -> nothing pushed");

  // Main never stops moving: gives up after FOLD_TRIES, nothing pushed by the script.
  git(fix, "pull", "-q", "origin", "main");
  fs.writeFileSync(path.join(fix, EDITS), ser({ [ID.capone]: { status: "used", status_since: today, used_on: "Quicksilver" } }));
  git(fix, "commit", "-qam", "good edit"); git(fix, "push", "-q", "origin", "main");
  fs.writeFileSync(hook, "#!/bin/sh\ncd " + JSON.stringify(fix) + " && git pull -q origin main && git commit -q --allow-empty -m 'another change' && git push -q origin main\n");
  fs.chmodSync(hook, 0o755);
  r = run({ FOLD_TRIES: "2" });
  ok(r.code !== 0 && /Gave up/.test(r.log) && at(EDITS) !== "{}", "main moving on every try -> gave up after 2 tries, edits still pending");
  fs.rmSync(hook);
  fs.rmSync(t, { recursive: true, force: true });
}

// validate.py on a temp copy (tools/ + site/data/) with each kind of bad phone-edits.json.
function validator() {
  console.log("-- validate.py checks of phone-edits.json (temp copy)");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "val-"));
  fs.mkdirSync(path.join(dir, "tools")); fs.mkdirSync(path.join(dir, "site/data"), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "validate.py"), path.join(dir, "tools/validate.py"));
  fs.readdirSync(DATA).forEach(f => fs.copyFileSync(path.join(DATA, f), path.join(dir, "site/data", f)));
  const auto = offersData.offers.find(o => o.activation === "auto_enrolled" && o.status === "active").id;
  const run = text => {
    fs.writeFileSync(path.join(dir, "site/data/phone-edits.json"), text);
    try { cp.execFileSync("python3", ["-B", path.join(dir, "tools/validate.py")], { encoding: "utf8", stdio: "pipe" }); return ""; }
    catch (e) { return (e.stdout || "") + (e.stderr || "") || "failed"; }
  };
  const good = { [ID.usbank]: { status: "used", status_since: today, used_on: "Smartly" }, [ID.chase]: { status: "used", status_since: today, activation: "already_activated" } };
  ok(run(ser(good)) === "", "valid edits pass");
  ok(run("{}\n") === "", "empty file passes");
  fs.rmSync(path.join(dir, "site/data/phone-edits.json"));
  try { cp.execFileSync("python3", ["-B", path.join(dir, "tools/validate.py")], { stdio: "pipe" }); ok(true, "missing file passes"); } catch (e) { ok(false, "missing file passes"); }
  const bad = [
    ["unknown id", ser({ "nope/nope": { activation: "already_activated" } }), /no offer with this id/],
    ["bad status", ser({ [ID.usbank]: { status: "expired", status_since: today } }), /status must be active or used/],
    ["status without date", ser({ [ID.usbank]: { status: "active" } }), /status_since must be/],
    ["impossible date", ser({ [ID.usbank]: { status: "active", status_since: "2026-02-30" } }), /status_since must be/],
    ["date format", ser({ [ID.usbank]: { status: "active", status_since: "10/20/2026" } }), /status_since must be/],
    ["used without card (U.S. Bank)", ser({ [ID.usbank]: { status: "used", status_since: today } }), /used_on must be Cash\+ or Smartly/],
    ["wrong card", ser({ [ID.usbank]: { status: "used", status_since: today, used_on: "Quicksilver" } }), /used_on must be/],
    ["used_on on Chase", ser({ [ID.chase]: { status: "used", status_since: today, used_on: "Smartly" } }), /used_on belongs only/],
    ["used_on on restore", ser({ [ID.usbank]: { status: "active", status_since: today, used_on: "Smartly" } }), /used_on belongs only/],
    ["bad activation", ser({ [ID.chase]: { activation: "auto_enrolled" } }), /activation must be needs_activation or already_activated/],
    ["activation on an auto-enrolled offer", ser({ [auto]: { activation: "already_activated" } }), /can't switch activation/],
    ["extra field", ser({ [ID.chase]: { activation: "already_activated", note: "x" } }), /unexpected field/],
    ["empty entry", ser({ [ID.chase]: {} }), /non-empty object/],
    ["not an object", "[]\n", /must be an object keyed by offer id/],
    ["not JSON", "{\n", /not valid JSON/],
    ["layout: no final newline", JSON.stringify(good, null, 2), /standard layout/],
    ["layout: 4 spaces", JSON.stringify(good, null, 4) + "\n", /standard layout/]
  ];
  bad.forEach(([name, text, re]) => { const out = run(text); ok(re.test(out), "rejects " + name + ": " + out.trim().split("\n")[0]); });
  fs.rmSync(dir, { recursive: true });
}

// Used offers, signed in (phone width): marking used keeps the row in place in its merchant container, dimmed, with
// "Restore offer" in its open details (restoring puts it back as it was); the "Used (N)" filter lists every used offer newest first, with or without a
// search, under the card filter, whatever the sort; Recently unavailable no longer lists used offers; signed out
// there is no Used filter. Saves go through a stub CardStore.save running the real CardEdits.apply: nothing is sent.
async function usedChecks(page, load, search, testEdits) {
  const U = byId[ID.usbank], N = byId[ID.needs], C = byId[ID.chase];
  // d: the card in "(on <card>)"; null: no "(on ...)" (Chase, Citi); left out: either.
  const USED_RE = d => new RegExp("Used [A-Z][a-z]{2} \\d+" + (d ? " \\(on " + d + "\\)" : d === null ? "(?!\\d| \\(on )" : ""));
  // Rows of the main list (not Recently unavailable), in container order: key, dimmed or not, the row's own text
  // (details left out), and whether its open details show Restore offer.
  const rows = () => page.$$eval("#main > ul.results > li.mc li.offer", ls => ls.map(li => ({
    key: window.__offerOf(li.dataset.oid).merchant + " | " + li.querySelector(".mcard").textContent,
    gone: li.classList.contains("gone"), text: li.querySelector(".orow").innerText.replace(/\s+/g, " "),
    restore: [...li.querySelectorAll(".details:not([hidden]) button")].some(b => b.textContent === "Restore offer")
  })));
  const keyOf = o => o.merchant + " | " + ROW_CARD(o.card);
  const rowLoc = o => page.locator("#main > ul.results li.offer[data-oid='" + o.id + "']");
  // Opens the merchant container holding the offer (its header expands every row in it); no-op when open.
  const openMc = async o => {
    const h = page.locator("#main > ul.results > li.mc:has(li.offer[data-oid='" + o.id + "']) > button.mchead");
    if ((await h.getAttribute("aria-expanded")) !== "true") await h.click();
  };
  const openAll = () => page.evaluate(() => document.querySelectorAll("#main > ul.results > li.mc > button.mchead[aria-expanded=false]").forEach(b => b.click()));
  const usedBtn = () => page.$eval("#used-filter", e => e.hidden ? null : e.innerText.trim()).catch(() => null);
  const openFilters = async () => { if (await page.$eval("#ftoggle", b => b.getAttribute("aria-expanded")) !== "true") await page.click("#ftoggle"); };
  const clickUsed = async () => { await openFilters(); await page.click("#used button"); await page.waitForTimeout(100); };
  const stub = (recs) => page.evaluate(([recs, today]) => {
    window.__recs = recs;
    CardStore.save = function (change) {
      var rec = window.__recs[change.id], r = CardEdits.apply({ offers: { offers: [rec] } }, change, today);
      var copy = JSON.parse(JSON.stringify(rec));
      if (!r.ok) return Promise.resolve({ status: r.kind, message: r.message, now: r.now, record: copy });
      return Promise.resolve({ status: "saved", message: r.summary, record: copy, undo: CardEdits.inverse(change, r.before) });
    };
    CardStore.liveStatus = function () { return Promise.resolve({ state: "live" }); };
  }, [recs, today]);
  const copyOf = (o, edit) => Object.assign(JSON.parse(JSON.stringify(o)), edit ? { status: edit.status, status_since: edit.status_since,
    other_details: (o.other_details || []).filter(t => !/^Used on /.test(t)).concat(edit.used_on ? ["Used on " + edit.used_on] : []) } : {});

  // 1. Mark used keeps the row where it is, dimmed, labelled, with Restore in its details; Restore puts it back in place.
  await load({ status: 200, body: "{}\n" }, true);
  await stub({ [U.id]: copyOf(U) });
  const q = U.merchant.split(/\s+/)[0];
  await search(q);
  const before = await rows(), at = before.findIndex(r => r.key === keyOf(U));
  ok(before.length >= 2 && at !== -1, "search " + JSON.stringify(q) + ": " + before.length + " rows, " + U.merchant + " at row " + (at + 1));
  const tapRow = await page.evaluate(id => { const li = document.querySelector("#main li.offer[data-oid='" + id + "']"); li.querySelector(".orow").click(); return li.closest("li.mc").querySelector(".mchead").getAttribute("aria-expanded"); }, U.id);
  ok(tapRow === "false", "the offer row itself is not a tap target: tapping it opens nothing");
  await openMc(U);
  const opened = await rows(); // its status steps aside while the details show an activation switch
  await rowLoc(U).locator("button.edsm", { hasText: "Used on Smartly" }).click();
  await page.waitForTimeout(150);
  const marked = await rows(), mrow = marked[at] || {};
  ok(marked.length === before.length && marked.map(r => r.key).join("\n") === before.map(r => r.key).join("\n"), "mark used: same rows in the same order (" + marked.length + ")");
  ok(mrow.key === keyOf(U) && mrow.gone && USED_RE("Smartly").test(mrow.text) && mrow.restore,
     "mark used: row stays dimmed with \"Used <date> (on Smartly)\" and Restore offer in its open details: " + JSON.stringify(mrow));
  ok(marked.every((r, i) => i === at || JSON.stringify(r) === JSON.stringify(opened[i])), "mark used: other rows unchanged");
  ok(!/U\.S\. Bank offer/.test(await page.$eval("#use", e => e.hidden ? "" : e.innerText)), "mark used: the headline no longer counts the used offer");
  ok(/Used \(\d+\)/.test(await usedBtn() || ""), "mark used: Used filter shows " + JSON.stringify(await usedBtn()));
  const gone1 = await page.$eval("#main", e => (e.querySelector("details.expired") || {}).innerText || "");
  ok(!/Used [A-Z][a-z]{2} \d+/.test(gone1), "mark used: the offer is not under Recently unavailable");
  // A real tap on the row's Restore offer button.
  await rowLoc(U).locator(".details button", { hasText: "Restore offer" }).click({ timeout: 3000 });
  await page.waitForTimeout(150);
  const restored = await rows();
  ok(JSON.stringify(restored) === JSON.stringify(opened), "Restore offer: the row is back as it was, in the same place" + (JSON.stringify(restored) === JSON.stringify(opened) ? "" : ": " + JSON.stringify(restored[at])));
  // Marked used again, the row goes once the search changes.
  await rowLoc(U).locator("button.edsm", { hasText: "Used on Smartly" }).click();
  await page.waitForTimeout(150);
  ok((await rows())[at].gone, "marked used again: dimmed in place");
  await search(q + " ");
  await search(q);
  ok(!(await rows()).some(r => r.key === keyOf(U)), "after the search changes, the used row leaves the results");

  // Deep in a long list (card filter, after Show more), a mark used keeps every row shown and the row in its place.
  await search("");
  await openFilters();
  await page.locator("#cards button", { hasText: /^Capital One$/ }).click();
  await page.click("#main button.more");
  await page.waitForTimeout(150);
  const long = await rows(), deep = 150, dm = long[deep] && long[deep].key.split(" | ")[0];
  await stub(Object.fromEntries(offersData.offers.filter(o => o.card === "Capital One" && o.merchant === dm).map(o => [o.id, copyOf(o)])));
  const deepLoc = page.locator("#main > ul.results li.offer").nth(deep);
  const deepId = await deepLoc.getAttribute("data-oid");
  await openMc({ id: deepId });
  await deepLoc.locator("button.edsm", { hasText: "Used on Quicksilver" }).click();
  await page.waitForTimeout(200);
  const long2 = await rows();
  ok(long.length >= 200 && long2.length === long.length && long2[deep].key === long[deep].key && long2[deep].gone && USED_RE("Quicksilver").test(long2[deep].text),
     "after Show more: mark used on row " + (deep + 1) + " (" + dm + ") keeps all " + long2.length + " rows shown, that row dimmed in place");
  await page.locator("#cards button", { hasText: /^All cards$/ }).click();

  // 2. The Used filter: count and list, blank search and with a search, card filter, sort ignored, toggled off.
  const realUsed = offersData.offers.filter(o => o.status === "used" && !testEdits[o.id]);
  const edits = Object.assign({}, testEdits, { [N.id]: { status: "used", status_since: "2026-10-01", used_on: "Cash+" }, [C.id]: { status: "used", status_since: "2026-09-15" } });
  const used = realUsed.concat(Object.keys(edits).filter(id => edits[id].status === "used").map(id => copyOf(byId[id], edits[id])));
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const want = used.slice().sort((a, b) => a.status_since !== b.status_since ? (a.status_since < b.status_since ? 1 : -1) : coll.compare(a.merchant, b.merchant) || coll.compare(a.card, b.card));
  await load({ status: 200, body: ser(edits) }, true);
  await stub(Object.fromEntries(used.map(o => [o.id, copyOf(o)])));
  ok(await usedBtn() === "Used (" + used.length + ")", "blank search: " + JSON.stringify(await usedBtn()) + " (want Used (" + used.length + "))");
  await clickUsed();
  await openAll();
  let list = await rows();
  // Merchant containers in the order of their newest used offer (a merchant's used offers together).
  // (Merchant identity as the page has it: the full name, an approved location under its group.)
  const mkey = n => { const sp = n.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\.(com|net|org)\b/gi, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(), k = sp.replace(/ /g, ""); return k === "alibaba" ? sp.replace(/ /g, "_") : k; };
  const locs = JSON.parse(fs.readFileSync(path.join(DATA, "merchant-locations.json"))).groups, member = {};
  Object.keys(locs).forEach(g => locs[g].forEach(m => { member[mkey(m)] = mkey(g); }));
  const wantMc = (l => { const by = new Map(); l.forEach(o => { const k = member[mkey(o.merchant)] || mkey(o.merchant);
    if (!by.has(k)) by.set(k, []); by.get(k).push(o); }); return [...by.values()].flat(); })(want);
  ok(list.map(r => r.key).join("\n") === wantMc.map(keyOf).join("\n"), "Used list, blank search: every used offer, newest used first: " + list.map(r => r.key.split(" | ")[0].slice(0, 20)).join(", "));
  ok(list.length && list.every(r => r.gone && r.restore && USED_RE().test(r.text)), "Used list rows: dimmed, \"Used <date> ...\" and Restore offer" + (list.every(r => r.gone && r.restore && USED_RE().test(r.text)) ? "" : ": " + JSON.stringify(list)));
  const urow = list.find(r => r.key === keyOf(U)), crow = list.find(r => r.key === keyOf(C));
  ok(urow && USED_RE("Smartly").test(urow.text) && crow && USED_RE(null).test(crow.text) && !/\(on /.test(crow.text), "labels: \"Used <date> (on Smartly)\" for U.S. Bank, \"Used <date>\" for " + C.card);
  ok(await page.$eval("#count", e => e.innerText) === "" && /Used/.test(await page.$eval("#ftoggle", e => e.innerText)), "count line empty (the button shows N), Filters summary: " + JSON.stringify(await page.$eval("#count", e => e.innerText)) + ", " + JSON.stringify(await page.$eval("#ftoggle", e => e.innerText)));
  await page.selectOption("#sort", "az");
  await page.waitForTimeout(100);
  ok((await rows()).map(r => r.key).join("\n") === wantMc.map(keyOf).join("\n"), "sort menu (A to Z) does not reorder the Used list");
  await page.selectOption("#sort", "best");
  await search(U.merchant);
  list = await rows();
  ok(list.length === 1 && list[0].key === keyOf(U) && await usedBtn() === "Used (1)", "with a search: " + JSON.stringify(await usedBtn()) + ", rows " + JSON.stringify(list.map(r => r.key)));
  await search("");
  await page.locator("#cards button", { hasText: /^U\.S\. Bank$/ }).click();
  await page.waitForTimeout(100);
  const usb = wantMc.filter(o => o.card === "U.S. Bank");
  list = await rows();
  ok(list.map(r => r.key).join("\n") === usb.map(keyOf).join("\n") && await usedBtn() === "Used (" + usb.length + ")", "card filter U.S. Bank: " + JSON.stringify(await usedBtn()) + ", " + list.length + " rows");
  // Restore inside the Used list: the row stays in place, back to normal, until the view changes.
  const ui = list.findIndex(r => r.key === keyOf(N));
  await openMc(N);
  list = await rows();
  await rowLoc(N).locator(".details button", { hasText: "Restore offer" }).click({ timeout: 3000 });
  await page.waitForTimeout(150);
  const after = await rows();
  ok(after.length === list.length && after[ui].key === keyOf(N) && !after[ui].gone && !after[ui].restore && await usedBtn() === "Used (" + (usb.length - 1) + ")",
     "Restore in the Used list: row back to normal in place, count " + JSON.stringify(await usedBtn()));
  await page.locator("#cards button", { hasText: /^All cards$/ }).click();
  await page.waitForTimeout(100);
  ok(!(await rows()).some(r => r.key === keyOf(N)), "after a filter change the restored offer leaves the Used list");
  // A save-bar Undo of an edit made in another view: the Used list keeps its card filter.
  await search(C.merchant);
  await page.locator("#cards button", { hasText: /^U\.S\. Bank$/ }).click();
  await page.waitForTimeout(100);
  await search("");
  await page.locator("#cards button", { hasText: /^All cards$/ }).click();
  await page.waitForTimeout(100);
  await openMc(C);
  await rowLoc(C).locator(".details button", { hasText: "Restore offer" }).click({ timeout: 3000 });
  await page.waitForTimeout(150);
  await page.locator("#cards button", { hasText: /^U\.S\. Bank$/ }).click();
  await page.waitForTimeout(100);
  await page.click("#savebtns button:has-text('Undo')");
  await page.waitForTimeout(200);
  list = await rows();
  ok(list.length && list.every(r => /Smartly \/ Cash\+|U\.S\. Bank/.test(r.key)), "Used list on U.S. Bank after a save-bar Undo of a " + C.card + " edit: only U.S. Bank rows (" + list.map(r => r.key.split(" | ")[1]).join(", ") + ")");
  await page.locator("#cards button", { hasText: /^All cards$/ }).click();
  // In store / Online and Activation don't apply to the Used list: not in the summary, and it lists the same rows.
  const nUsed = (await rows()).length; // the Used list is on here
  await clickUsed();
  await page.locator("#chans button", { hasText: /^In store$/ }).click();
  await page.locator("#acts button", { hasText: /^Ready now/ }).click();
  await clickUsed();
  ok(nUsed > 0 && (await rows()).length === nUsed && await page.$eval("#ftoggle", e => e.innerText.trim()) === "Filters: Used",
     "Used list ignores In store and Ready now: every used offer listed, summary " + JSON.stringify(await page.$eval("#ftoggle", e => e.innerText.trim())));
  ok(await page.$$eval("#chans button, #acts button", bs => bs.every(b => b.disabled)) && await page.$eval("#acts", e => e.parentNode.classList.contains("off")),
     "while Used is on, the In store / Online and Activation buttons are greyed out and disabled");
  await clickUsed();
  ok(await page.$$eval("#chans button, #acts button", bs => bs.every(b => !b.disabled)), "Used off: those buttons work again");
  await page.locator("#chans button", { hasText: /^Any$/ }).click();
  await page.locator("#acts button", { hasText: /^Any/ }).click();
  await clickUsed();
  await clickUsed();
  ok(await page.$eval("#used button", b => b.getAttribute("aria-pressed")) === "false" && /active offers loaded/.test(await page.$eval("#main", e => e.innerText)), "picking Used again returns to normal results");

  // 3. Recently unavailable: dropped and expired offers only.
  const miss = offersData.offers.find(o => o.status === "missing");
  await search(U.merchant);
  const g = await page.$eval("#main", e => (e.querySelector("details.expired") || {}).innerText || "");
  ok(!/Recently unavailable/.test(g) && !(await rows()).some(r => r.key === keyOf(U)), "signed in: the used offer is not under Recently unavailable (nor in the results)");
  if (miss) {
    await search(miss.merchant);
    const m = await page.$eval("#main", e => (e.querySelector("details.expired") || {}).innerText || "");
    ok(/Recently unavailable/.test(m) && /Dropped off/.test(m), "a missing offer (" + miss.merchant + ") is still under Recently unavailable");
  } else console.log("SKIP no missing offer in the data to check Recently unavailable");
  ok(/under the Used filter/.test(await page.$eval("#editbody", e => e.textContent)), "Edit mode note points to the Used filter");

  // 4. Signed out: no Used filter, used offers hidden.
  await load({ status: 200, body: ser(edits) });
  await search(U.merchant);
  ok(await usedBtn() === null && !(await rows()).some(r => r.key === keyOf(U)) && !/Used [A-Z][a-z]{2} \d+/.test(await page.$eval("#main", e => e.innerText)), "signed out: no Used filter, the used offer stays hidden");
  await search("");
  ok(await usedBtn() === null, "signed out, blank search: no Used filter");
}

// Step 3, edit controls inside a merchant container (signed in, phone width): three offers at one merchant, two on
// the same card. Each row's Mark activated, Used on and Restore offer save a change for that offer only; the save
// bar's Undo puts it back; signed out the open container has no controls. Saves go to a stub CardStore.save running
// the real CardEdits.apply on fixture records: nothing is sent.
async function containerEditChecks(br, base) {
  const T = "2026-11-04";
  const fx = (id, card, bonus, extra) => Object.assign({ id: "test/zqe-" + id, card, merchant: "Zqedit Cafe", category: "Dining", bonus, expires: null,
    expires_text: null, activation: "already_activated", channel: "in_store", spend_cap: null, minimum_spend: null, fine_print: null, other_details: [],
    last_read: "2026-10-18", first_seen: "2026-10-18", status: "active", status_since: "2026-10-18" }, extra || {});
  const FX = [fx("a", "U.S. Bank", "10% cash back", { activation: "needs_activation" }), fx("b", "U.S. Bank", "8% cash back", { channel: "online" }),
    fx("c", "Capital One", "5% back", { activation: "none_shown", channel: "online" })];
  const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  await page.clock.install({ time: new Date(2026, 10, 4, 12, 0, 0) });
  await page.route("https://api.github.com/**", r => r.abort());
  await page.route("**/data/phone-edits.json", r => r.fulfill({ status: 200, contentType: "application/json", body: "{}\n" }));
  await page.route("**/data/offers.json", async r => { const j = await (await r.fetch()).json(); j.offers.push(...FX); await r.fulfill({ json: j }); });
  const open = async signedIn => {
    await page.goto(base);
    await page.evaluate(t => { try { localStorage.clear(); if (t) localStorage.setItem("cardselector.token", "test"); } catch (e) {} }, signedIn);
    await page.goto(base);
    await page.waitForFunction(() => /active offers loaded/.test(document.body.innerText));
    await page.evaluate(([recs, today]) => {
      window.__recs = recs; window.__calls = [];
      CardStore.save = function (change) {
        window.__calls.push(change.type + " " + change.id.replace(/^test\/zqe-/, "") + " " + change.from + "->" + change.to + (change.usedOn ? " " + change.usedOn : ""));
        var rec = window.__recs[change.id], r = CardEdits.apply({ offers: { offers: [rec] } }, change, today);
        return Promise.resolve({ status: "saved", message: r.summary, record: JSON.parse(JSON.stringify(rec)), undo: CardEdits.inverse(change, r.before) });
      };
      CardStore.liveStatus = function () { return Promise.resolve({ state: "live" }); };
    }, [Object.fromEntries(FX.map(o => [o.id, JSON.parse(JSON.stringify(o))])), T]);
    await page.fill("#q", "zqedit");
    await page.waitForTimeout(150);
    await page.click("#main li.mc > button.mchead");
    await page.waitForTimeout(50);
  };
  const st = () => page.evaluate(() => [...document.querySelectorAll("#main > ul.results li.mc li.offer")].map(li => {
    const d = li.querySelector(".details");
    return li.dataset.oid.replace(/^test\/zqe-/, "") + (li.classList.contains("gone") ? " dimmed" : "") + " | " +
      (d && !d.hidden ? [...d.querySelectorAll(".edrow")].map(r => r.innerText.replace(/\s+/g, " ").trim()).join(" / ") : "closed");
  }));
  const calls = () => page.evaluate(() => window.__calls);
  const tap = async (id, text) => { await page.locator("#main li.offer[data-oid='test/zqe-" + id + "'] .details button", { hasText: new RegExp("^" + text + "$") }).click(); await page.waitForTimeout(150); };

  await open(true);
  let s = await st();
  ok(s.length === 3 && /^a \| Needs activation Mark activated \/ Used on Cash\+ Used on Smartly$/.test(s[0]) && /^b \| Already activated Mark not activated \/ Used on Cash\+ Used on Smartly$/.test(s[1]) &&
    /^c \| Used on Quicksilver Used on Discover it$/.test(s[2]), "container edits: each open row has its own controls (" + JSON.stringify(s) + ")");
  await tap("a", "Mark activated");
  s = await st();
  ok(JSON.stringify(await calls()) === JSON.stringify(["offer.activation a needs_activation->already_activated"]) && /^a \| Already activated/.test(s[0]) && /^b \| Already activated/.test(s[1]),
    "container edits: Mark activated saves that row's offer only (" + JSON.stringify([await calls(), s]) + ")");
  await tap("b", "Used on Smartly");
  s = await st();
  const usedB = s.find(x => /^b /.test(x));
  ok((await calls())[1] === "offer.status b active->used Smartly" && /^b dimmed \| .*Restore offer/.test(usedB) && s.filter(x => / dimmed/.test(x)).length === 1 && s.length === 3,
    "container edits: Used on Smartly marks only that offer; it stays in its container, dimmed, with Restore offer (" + JSON.stringify(s) + ")");
  const usedLabel = await page.$eval("#main li.offer[data-oid='test/zqe-b'] .ostat", e => e.textContent);
  ok(/^Used [A-Z][a-z]{2} \d+ \(on Smartly\)$/.test(usedLabel), "container edits: the used row's status reads \"" + usedLabel + "\"");
  await tap("b", "Restore offer");
  s = await st();
  ok((await calls())[2] === "offer.status b used->active" && !s.some(x => / dimmed/.test(x)) && /^a \| Already activated/.test(s[0]),
    "container edits: Restore offer restores only that offer (" + JSON.stringify([(await calls())[2], s]) + ")");
  await page.click("#savebtns button:has-text('Undo')");
  await page.waitForTimeout(200);
  s = await st();
  ok((await calls())[3] === "offer.status b active->used Smartly" && /^b dimmed/.test(s.find(x => /^b /.test(x))) && /^a \| Already activated/.test(s[0]),
    "container edits: the save bar's Undo puts that offer back as it was (" + JSON.stringify([(await calls())[3], s]) + ")");
  await open(false);
  s = await st();
  ok(s.length === 3 && s.every(x => / \| $/.test(x)) && !(await page.locator("#main li.mc .details button").count()), "container edits: signed out, the open container has no edit controls (" + JSON.stringify(s) + ")");
  ok(!errs.length, "container edits: no page errors (" + errs.join("; ") + ")");
  await ctx.close();
}

// Card bonuses fixture (bonus-categories.json in the standard layout): the real keyword lists and standing Citi Custom
// Cash and Customized Cash entries, plus Smartly and two Q4 2026 Chase entries, so the checks don't follow the real
// quarter. rot: [id, card, short, activation, end, activate_by]; extra entries go last.
function bonusText(rots, extra) {
  const real = JSON.parse(read(BONUS));
  const base = { categories_text: "test quarter", cap_text: "up to $1,500 in combined purchases", activation_note: null, likely_note: null, strip_note: null,
    search: true, source_url: "https://example.com/", unconfirmed: null, checked: "2026-10-19" };
  const dining = { name: "dining", app_categories: ["Dining"], exclude_cuisines: ["Gift Cards & Dining Services"], list: "dining_chains" };
  const grocery = { name: "grocery stores", list: "grocery_stores", button_categories: ["Groceries & Food Delivery"] };
  const entries = [Object.assign({}, base, { id: "test/smartly", card: "Smartly", app_card: "U.S. Bank", kind: "fixed", start: null, end: null, rate: 4,
    activation: "not_needed", activate_by: null, everyday: true, strip_note: "first $10,000 per billing cycle, some categories 2%", match: [] })];
  rots.forEach(([id, card, short, activation, end, by]) => entries.push(Object.assign({}, base, { id, card, app_card: "Chase " + card,
    kind: "rotating", start: "2026-10-01", end: end || "2026-12-31", rate: 5, activation, activate_by: by || "2026-12-14", match: [grocery, dining] }, short ? { short } : {})));
  real.entries.filter(e => e.kind === "top_category" || e.kind === "chosen").forEach(e => entries.push(e));
  return JSON.stringify({ keyword_lists: real.keyword_lists, entries: entries.concat(extra || []) }, null, 2) + "\n";
}

// Card bonuses' Mark activated (redesign step 4B), signed in at phone width, the real store.js saving to an in-memory
// GitHub (the Hub above, routed in the browser): the pending row's button saves the bonus entry's activation through
// the usual path (bonus-categories.json only, one fast-forward commit), the row, the header count and the Quick picks
// follow at once, the save bar goes Saving… -> Saved · Deploying · Undo -> Live · Undo, and the bar's Undo puts all of
// it back. A second activation that leaves the Quick pick winner as it is still updates the row and header. Signed
// out the same rows show with no control.
async function cardBonusChecks(br, base) {
  console.log("-- Card bonuses: Mark activated (real store.js, mock GitHub)");
  const FLEX = "test/flex-q4", FREE = "test/freedom-q4";
  const text = bonusText([[FLEX, "Freedom Flex", "Flex", "not_confirmed"], [FREE, "Freedom", null, "not_confirmed"]]);
  const hub = new Hub({ [OFFERS]: offersText, [BONUS]: text, [EDITS]: "{}\n" });
  const start = hub.head, calls = [];
  let deployed = false;
  const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  await page.clock.install({ time: new Date(2026, 10, 4, 12, 0, 0) });
  await page.route("**/data/bonus-categories.json", r => r.fulfill({ status: 200, contentType: "application/json", body: text }));
  await page.route("**/data/phone-edits.json", r => r.fulfill({ status: 200, contentType: "application/json", body: "{}\n" }));
  await page.route("https://api.github.com/**", r => {
    const req = r.request(), u = new URL(req.url()), p = u.pathname.replace("/repos/module7543/CardSelector", "");
    calls.push(req.method() + " " + p);
    if (/\/actions\/workflows\//.test(p)) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ workflow_runs: deployed ?
      [{ status: "completed", conclusion: "success", head_sha: hub.head, html_url: "https://example.com/run", created_at: "2026-11-04T20:00:00Z" }] : [] }) });
    const res = hub.route(req.method(), p, u.searchParams.get("ref"), req.postData() ? JSON.parse(req.postData()) : null, { Accept: req.headers().accept || "" });
    return r.fulfill({ status: res.status || 200, contentType: "application/json", body: res.text !== undefined ? res.text : JSON.stringify(res.json) });
  });
  const load = async signedIn => {
    await page.goto(base);
    await page.evaluate(t => { try { localStorage.clear(); if (t) localStorage.setItem("cardselector.token", "test"); } catch (e) {} }, signedIn);
    await page.goto(base);
    await page.waitForFunction(() => window.__cardsReady && window.__bonusReady && !document.getElementById("cb").hidden && !document.getElementById("qp").hidden);
  };
  const view = () => page.evaluate(() => {
    const plain = e => e ? e.innerText.replace(/\s+/g, " ").trim() : null, b = document.getElementById("savebar");
    // A tile's rate, card, "+N more ready" and activation line (its Likely tag and screen-reader text left out).
    const bare = e => { if (!e) return null; const c = e.cloneNode(true); c.querySelectorAll(".likely, .sr, .sr-only").forEach(x => x.remove()); return c.textContent.replace(/\s+/g, " ").trim(); };
    const tile = t => { const li = document.querySelector("#qp li.qpt[data-topic='" + t + "']"); return [bare(li.querySelector(".qpr")), bare(li.querySelector(".qpc")),
      bare(li.querySelector(".qpm:not(.qpd)")), bare(li.querySelector(".qpa"))]; };
    return { pend: plain(document.querySelector("#cb .cbpend")),
      rows: Object.fromEntries([...document.querySelectorAll("#cb li[data-eid]")].map(l => [l.dataset.eid, plain(l.querySelector(".cbst"))])),
      buttons: [...document.querySelectorAll("#cb button")].map(x => x.closest("li").dataset.eid + ":" + x.textContent + (x.disabled ? " (disabled)" : "")),
      grocery: tile("Grocery stores"), dining: tile("Dining"),
      bar: b.hidden ? null : (btns => document.getElementById("savemsg").firstChild.textContent + (btns.length ? " · " + btns.join(" ") : ""))([...document.querySelectorAll("#savebtns button")].map(x => x.textContent)),
      live: b.classList.contains("live") };
  });
  const fileAct = id => JSON.parse(hub.file(BONUS)).entries.find(e => e.id === id).activation;
  const J = x => JSON.stringify(x);

  // Signed out: the rows and their state lines, no control.
  await load(false);
  let v = await view();
  ok(v.rows[FLEX] === "⚠ Not activated, activate by Dec 14" && v.rows[FREE] === "⚠ Not activated, activate by Dec 14" && !v.buttons.length && v.pend === "⚠ 2 activations pending",
    "cb signed out: the pending rows show, with no Mark activated (" + J(v) + ")");

  await load(true);
  v = await view();
  ok(J(v.buttons) === J([FLEX + ":Mark activated", FREE + ":Mark activated"]) && v.pend === "⚠ 2 activations pending" && v.rows[FLEX] === "⚠ Not activated, activate by Dec 14 Mark activated",
    "cb signed in: Mark activated on both pending rows (" + J(v) + ")");
  ok(J(v.grocery) === J(["4%", "Smartly", null, "Activate Flex or Freedom: 5% · +1 pt"]), "cb before: the Grocery stores Quick pick is Smartly 4%, activate Flex or Freedom (" + J(v.grocery) + ")");
  const v0 = v, nCalls = calls.length;
  // 1. Mark activated on Freedom Flex.
  await page.locator("#cb li[data-eid='" + FLEX + "'] button", { hasText: /^Mark activated$/ }).click();
  await page.waitForFunction(() => /Deploying/.test(document.getElementById("savemsg").textContent));
  v = await view();
  const commit = hub.commits[hub.head], wrote = calls.slice(nCalls).filter(c => !/^GET/.test(c));
  ok(hub.since(start).length === 1 && J(hub.changed(hub.head)) === J([BONUS]) && commit.message.startsWith("Bonus categories activated: Freedom Flex") &&
    fileAct(FLEX) === "activated" && fileAct(FREE) === "not_confirmed" && J(wrote) === J(["POST /git/blobs", "POST /git/trees", "POST /git/commits", "PATCH /git/refs/heads/main"]),
    "cb Mark activated: one commit to bonus-categories.json only, that entry activated (blob, tree, commit, fast-forward) (" + J([commit.message, wrote]) + ")");
  const after = JSON.parse(hub.file(BONUS)), want = JSON.parse(text);
  want.entries.find(e => e.id === FLEX).activation = "activated";
  ok(hub.file(BONUS) === JSON.stringify(want, null, 2) + "\n" && J(after) === J(want), "cb Mark activated: the saved file is the old one with that one field changed, in the standard layout");
  ok(v.rows[FLEX] === "✓ Activated · ends Dec 31" && v.pend === "⚠ 1 activation pending" && J(v.buttons) === J([FREE + ":Mark activated"]),
    "cb Mark activated: the row is activated at once, no Undo beside it, the header count drops (" + J([v.rows[FLEX], v.pend, v.buttons]) + ")");
  ok(J(v.grocery) === J(["5%", "Freedom Flex", null, null]) && J(v.dining) !== J(v0.dining),
    "cb Mark activated: Quick picks follow at once (Grocery stores " + J(v0.grocery) + " -> " + J(v.grocery) + "; Dining " + J(v0.dining) + " -> " + J(v.dining) + ")");
  ok(v.bar === "Saved · Deploying · Undo ×" && !v.live, "cb Mark activated: save bar \"" + v.bar + "\"");
  deployed = true;
  await page.clock.runFor(6000);
  await page.waitForFunction(() => document.getElementById("savebar").classList.contains("live"));
  v = await view();
  ok(v.bar === "Live · Undo ×" && v.live, "cb Mark activated: then \"" + v.bar + "\" as a pill");
  // 2. The save bar's Undo: back to not_confirmed, the count and the Quick pick restored.
  deployed = false;
  await page.locator("#savebtns button", { hasText: /^Undo$/ }).click();
  await page.waitForFunction(() => /Deploying/.test(document.getElementById("savemsg").textContent));
  v = await view();
  ok(fileAct(FLEX) === "not_confirmed" && hub.since(start).length === 2 && J(hub.changed(hub.head)) === J([BONUS]) && hub.file(BONUS) === text,
    "cb Undo: a second commit puts the file back byte for byte (" + hub.commits[hub.head].message + ")");
  ok(J(v.rows) === J(v0.rows) && v.pend === v0.pend && J(v.buttons) === J(v0.buttons) && J(v.grocery) === J(v0.grocery) && J(v.dining) === J(v0.dining) && v.bar === "Saved · Deploying · Undo ×",
    "cb Undo: the row, the header (" + v.pend + "), Mark activated and the Quick picks are back as before (" + J(v.grocery) + ")");
  // 3. An activation that doesn't change a Quick pick winner: Flex first, then Freedom (Flex 5% still leads).
  await page.locator("#cb li[data-eid='" + FLEX + "'] button", { hasText: /^Mark activated$/ }).click();
  await page.waitForFunction(() => document.querySelectorAll("#cb button").length === 1 && /Deploying/.test(document.getElementById("savemsg").textContent));
  const v1 = await view();
  await page.locator("#cb li[data-eid='" + FREE + "'] button", { hasText: /^Mark activated$/ }).click();
  await page.waitForFunction(() => document.querySelectorAll("#cb button").length === 0);
  v = await view();
  ok(v1.grocery[1] === "Freedom Flex" && v.grocery[1] === "Freedom Flex" && v.grocery[0] === v1.grocery[0] && v.rows[FREE] === "✓ Activated · ends Dec 31" &&
    v.pend === "No activations pending" && !v.buttons.length && fileAct(FREE) === "activated",
    "cb second activation, Quick pick winner unchanged (" + J([v1.grocery, v.grocery]) + "): the row and the header still follow (" + v.pend + ")");
  ok(!errs.length, "cb Mark activated: no page errors (" + errs.join("; ") + ")");
  await ctx.close();
}

// A new day while saving (signed in, phone width, the clock at 23:59:50 on Oct 21): no redraw while the save runs,
// exactly one right after it ends (the offer that ended Oct 21 moves to Recently unavailable), the save bar and Undo
// as always. The same with Card bonuses' Mark activated in use on the home screen (focused): no redraw until it loses
// focus, then one (a bonus entry that ended Oct 21 leaves Card bonuses). Saves go to a stub CardStore.save that waits
// until told to finish.
async function dayChecks(br, base) {
  const iso = n => { const t = new Date(2026, 9, 21 + n); return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0"); };
  const mk = (merchant, n, i) => ({ id: "test/zzday-" + i, card: "Chase Freedom Flex", merchant, category: "Dining", bonus: (10 + i) + "% cash back",
    expires: n == null ? null : iso(n), expires_text: null, activation: "needs_activation", channel: "online", spend_cap: null, minimum_spend: null,
    fine_print: null, other_details: [], last_read: "2026-10-18", first_seen: "2026-10-18", status: "active", status_since: "2026-10-18" });
  const tests = [mk("Zzday Ends Today", 0, 0), mk("Zzday Ends Tomorrow", 1, 1)];
  // On the home screen (home: no search), Card bonuses: Freedom Flex pending, and a bonus entry that ends Oct 21.
  const btext = bonusText([["test/flex-q4", "Freedom Flex", "Flex", "not_confirmed"], ["test/zzday-bonus", "Freedom", null, "activated", "2026-10-21", "2026-10-14"]]);
  const open = async home => {
    const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    const page = await ctx.newPage();
    await page.clock.install({ time: new Date(2026, 9, 21, 23, 59, 0) });
    await page.route("https://api.github.com/**", r => r.abort());
    await page.route("**/data/phone-edits.json", r => r.fulfill({ status: 200, contentType: "application/json", body: "{}\n" }));
    await page.route("**/data/offers.json", async r => { const j = await (await r.fetch()).json(); j.offers.push(...tests); await r.fulfill({ json: j }); });
    if (home) await page.route("**/data/bonus-categories.json", r => r.fulfill({ status: 200, contentType: "application/json", body: btext }));
    await page.goto(base);
    await page.evaluate(() => { try { localStorage.clear(); localStorage.setItem("cardselector.token", "test"); } catch (e) {} });
    await page.goto(base);
    await page.waitForFunction(() => /active offers loaded/.test(document.body.innerText));
    await page.evaluate(([recs, today]) => {
      window.__recs = recs; window.__pend = [];
      CardStore.save = function (change) {
        return new Promise(function (res) {
          window.__pend.push(function () {
            if (/^bonus\./.test(change.type)) return res({ status: "saved", message: "Bonus categories activated", undo: { type: change.type, id: change.id, from: change.to, to: change.from },
              record: { activation: change.to } });
            var rec = window.__recs[change.id], r = CardEdits.apply({ offers: { offers: [rec] } }, change, today);
            res({ status: "saved", message: r.summary, record: JSON.parse(JSON.stringify(rec)), undo: CardEdits.inverse(change, r.before) });
          });
        });
      };
      CardStore.liveStatus = function () { return Promise.resolve({ state: "live" }); };
    }, [Object.fromEntries(tests.map(o => [o.id, JSON.parse(JSON.stringify(o))])), iso(1)]);
    if (home) await page.waitForFunction(() => !document.getElementById("cb").hidden);
    else { await page.fill("#q", "zzday"); await page.waitForTimeout(900); }
    await page.clock.pauseAt(new Date(2026, 9, 21, 23, 59, 50));
    return { ctx, page };
  };
  const st = page => page.evaluate(() => {
    const row = m => [...document.querySelectorAll("li.offer")].find(l => window.__offerOf(l.dataset.oid).merchant === m);
    const t = row("Zzday Ends Today"), b = document.getElementById("savebar");
    return { renders: window.__renders, today: t ? (t.classList.contains("gone") ? "gone" : "live") : "none",
      bonusToday: !!document.querySelector("#cb li[data-eid='test/zzday-bonus']"), flex: (document.querySelector("#cb li[data-eid='test/flex-q4'] .cbst") || {}).innerText || null,
      bar: b.hidden ? null : (btns => document.getElementById("savemsg").firstChild.textContent + (btns.length ? " · " + btns.join(" ") : ""))([...document.querySelectorAll("#savebtns button")].map(x => x.textContent)),
      live: b.classList.contains("live"), q: document.getElementById("q").value,
      open: [...document.querySelectorAll("li.mc > button.mchead[aria-expanded=true]")].map(x => x.querySelector(".mcname").textContent) };
  });

  // 1. A save running across midnight.
  let { ctx, page } = await open();
  await page.locator("li.mc:has(li.offer[data-oid='test/zzday-1']) > button.mchead").first().click();
  await page.locator("li.offer[data-oid='test/zzday-1'] button", { hasText: /^Mark activated$/ }).click();
  const s0 = await st(page);
  await page.clock.runFor(15000); // past midnight, the save still running
  const s1 = await st(page);
  ok(s0.bar === "Saving…" && s1.renders === s0.renders && s1.today === "live", "save across midnight: no redraw while it runs (" + JSON.stringify([s0, s1]) + ")");
  await page.evaluate(() => window.__pend.shift()());
  await page.waitForTimeout(50);
  const s2 = await st(page);
  ok(s2.renders === s1.renders + 1 && s2.today === "gone" && s2.q === "zzday" && JSON.stringify(s2.open) === JSON.stringify(["Zzday Ends Tomorrow"]),
    "save across midnight: exactly one redraw when it ends, the ended offer moved, search and open details kept (" + (s2.renders - s1.renders) + " renders, " + JSON.stringify(s2) + ")");
  ok(s2.bar === "Saved · Deploying · Undo ×" && !s2.live, "save across midnight: bar \"" + s2.bar + "\"");
  ok(/Already activated/.test(await page.locator("li.offer[data-oid='test/zzday-1']").first().innerText()), "save across midnight: the offer shows Already activated");
  await page.clock.runFor(6000);
  await page.waitForTimeout(50);
  const s3 = await st(page);
  ok(s3.bar === "Live · Undo ×" && s3.live && s3.renders === s2.renders, "save across midnight: then \"" + s3.bar + "\" as a pill, no more redraws");
  await page.locator("#savebtns button", { hasText: /^Undo$/ }).click();
  await page.evaluate(() => window.__pend.shift()());
  await page.waitForTimeout(50);
  const s4 = await st(page);
  ok(s4.bar === "Saved · Deploying · Undo ×" && s4.renders === s3.renders + 2 &&
    /Needs activation/.test(await page.locator("li.offer[data-oid='test/zzday-1']").first().innerText()),
    "save across midnight: Undo saves as always (bar \"" + s4.bar + "\", " + (s4.renders - s3.renders) + " renders, back to Needs activation)");
  await ctx.close();

  // 2. Card bonuses' Mark activated focused across midnight (home screen): no redraw while it has focus, one once it
  // loses it (the entry that ended Oct 21 leaves), nothing saved.
  ({ ctx, page } = await open(true));
  const mbtn = "#cb li[data-eid='test/flex-q4'] button";
  await page.focus(mbtn);
  const f0 = await st(page);
  await page.clock.runFor(15000);
  const f1 = await st(page);
  ok(f0.bonusToday && f1.renders === f0.renders && f1.bonusToday, "Mark activated focused across midnight: no redraw while it has focus (" + (f1.renders - f0.renders) + " renders)");
  await page.evaluate(() => document.activeElement.blur());
  await page.clock.runFor(10);
  await page.waitForTimeout(50);
  const f2 = await st(page);
  ok(f2.renders === f1.renders + 1 && !f2.bonusToday && /^⚠ Not activated/.test(f2.flex) && await page.evaluate(() => window.__pend.length) === 0,
    "Mark activated: one redraw once it loses focus, the ended entry left Card bonuses, nothing saved (" + JSON.stringify([f2.renders - f1.renders, f2.flex]) + ")");
  await ctx.close();

  // 3. A Mark activated save running across midnight: one redraw when it ends, the row activated, the ended entry gone,
  // the bar and its Undo as always.
  ({ ctx, page } = await open(true));
  await page.click(mbtn);
  const m0 = await st(page);
  await page.clock.runFor(15000);
  const m1 = await st(page);
  ok(m0.bar === "Saving…" && m1.renders === m0.renders && m1.bonusToday, "Mark activated save across midnight: no redraw while it runs (" + JSON.stringify([m0.bar, m1.renders - m0.renders]) + ")");
  await page.evaluate(() => window.__pend.shift()());
  await page.waitForTimeout(50);
  const m2 = await st(page);
  ok(m2.renders === m1.renders + 1 && !m2.bonusToday && m2.flex === "✓ Activated · ends Dec 31" && m2.bar === "Saved · Deploying · Undo ×",
    "Mark activated saved across midnight: one redraw, the row activated, the ended entry gone, bar \"" + m2.bar + "\" (" + JSON.stringify(m2) + ")");
  await page.locator("#savebtns button", { hasText: /^Undo$/ }).click();
  await page.evaluate(() => window.__pend.shift()());
  await page.waitForTimeout(50);
  const m3 = await st(page);
  ok(/^⚠ Not activated, activate by Dec 14/.test(m3.flex) && m3.bar === "Saved · Deploying · Undo ×", "Mark activated across midnight: the bar's Undo puts it back (" + m3.flex + ")");
  await ctx.close();

  // 4. A held redraw doesn't eat a tap: midnight passes with Mark activated focused, then it is tapped the way iOS
  // taps (the button takes no focus, so focus leaves it on the press, before the click).
  ({ ctx, page } = await open(true));
  await page.focus(mbtn);
  await page.clock.runFor(15000);
  await page.evaluate(() => document.addEventListener("mousedown", function (e) {
    if (e.target.closest("#cb button")) { e.preventDefault(); document.activeElement.blur(); }
  }, true));
  const box = await page.locator(mbtn).boundingBox();
  const r4 = (await st(page)).renders;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.clock.runFor(20); // the focusout's release gets its chance between press and click
  await page.waitForTimeout(30);
  await page.mouse.up();
  await page.clock.runFor(10); // the tap's end (a 0 ms timer, long before a real save returns)
  await page.waitForTimeout(50);
  const n4 = await page.evaluate(() => window.__pend.length);
  ok(n4 === 1, "tap after a held midnight redraw: the Mark activated tap starts one save (" + n4 + ")");
  await page.evaluate(() => (window.__pend.shift() || function () {})()); // none when the tap was lost
  await page.clock.runFor(10);
  await page.waitForTimeout(50);
  const g4 = await st(page);
  ok(!g4.bonusToday && g4.flex === "✓ Activated · ends Dec 31" && g4.renders === r4 + 2, "tap after a held midnight redraw: the save's own redraws carry the new day (" + (g4.renders - r4) + " renders: save start, save end)");
  await ctx.close();
}

async function browser() {
  console.log("-- browser, phone width");
  const http = require("http"), { chromium } = require("playwright");
  const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };
  const server = http.createServer((req, res) => {
    const p = path.join(SITE, decodeURIComponent(req.url.split("?")[0]).replace(/\/$/, "/index.html"));
    if (!p.startsWith(SITE) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" });
    fs.createReadStream(p).pipe(res);
  }).listen(0);
  const base = "http://127.0.0.1:" + server.address().port + "/";
  const br = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  // Service workers blocked: the saved copy (sw.js) would answer requests before page.route sees them.
  const page = await br.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  await page.route("https://api.github.com/**", r => r.abort());
  let serve = null; // what data/phone-edits.json answers: { status, body }
  await page.route("**/data/phone-edits.json", r => serve ? r.fulfill({ status: serve.status, contentType: "application/json", body: serve.body }) : r.continue());
  const load = async (edits, signedIn) => {
    serve = edits;
    await page.goto(base);
    await page.evaluate(t => { try { localStorage.clear(); if (t) localStorage.setItem("cardselector.token", "test"); } catch (e) {} }, signedIn ? 1 : 0);
    await page.goto(base);
    await page.waitForFunction(() => /active offers loaded|Couldn’t load the offer list/.test(document.body.innerText));
  };
  const search = async q => {
    await page.fill("#q", q);
    await page.waitForTimeout(150);
    return page.$$eval("#main li.offer", ls => ls.map(li => ({
      id: window.__offerOf(li.dataset.oid).merchant + " | " + li.querySelector(".mcard").textContent,
      gone: li.classList.contains("gone"),
      text: li.innerText.replace(/\s+/g, " ")
    })));
  };
  // The answer card for the offer's own channel (Step 2: under Any a merchant whose In store and Online answers differ
  // shows two compact rows; a picked channel shows the full lines these checks read), without the selector and the
  // Card rates here disclosure. Picking it here is not remembered: load() clears storage.
  const useOf = async o => {
    const ch = o.channel === "online" ? "online" : "store", b = page.locator("#use .chansel button[data-ch=" + ch + "]");
    if (await b.count() && (await b.getAttribute("aria-pressed")) !== "true") { await b.click(); await page.waitForTimeout(100); }
    const t = await page.$eval("#use", e => e.hidden ? "" : [...e.children].filter(c => !c.matches(".chansel, details.rates")).map(c => c.innerText).join("\n"));
    const any = page.locator("#use .chansel button[data-ch=any]");
    if (await any.count() && (await any.getAttribute("aria-pressed")) !== "true") { await any.click(); await page.waitForTimeout(100); } // back to Any for the next search
    return t;
  };
  const snapshot = async (q, o) => ({ rows: await search(q), use: await useOf(o), count: await page.$eval("#count", e => e.innerText).catch(() => "") });
  const testEdits = { [ID.usbank]: { status: "used", status_since: today, used_on: "Smartly" }, [ID.chase]: { activation: "already_activated" } };
  const U = byId[ID.usbank], C = byId[ID.chase];
  const rowOf = (o, rows) => rows.find(r => r.id === o.merchant + " | " + ROW_CARD(o.card) && !r.gone);
  const both = async () => ({ u: await snapshot(U.merchant, U), c: await snapshot(C.merchant, C) });

  await load({ status: 200, body: "{}\n" });
  const empty = await both();
  await load(null); // the real file
  const real = await both();
  await load({ status: 404, body: "" });
  const missing = await both();
  const realEmpty = read(EDITS) === "{}\n"; // main may hold pending edits between folds
  ok(JSON.stringify(empty) === JSON.stringify(missing) && (!realEmpty || JSON.stringify(empty) === JSON.stringify(real)),
     "missing phone-edits.json = empty file" + (realEmpty ? " = the real file" : " (real file has pending edits, not compared)") + " (searches: " + JSON.stringify(U.merchant) + ", " + JSON.stringify(C.merchant) + ")");
  ok(rowOf(U, empty.u.rows) && /\bReady\b/.test(rowOf(U, empty.u.rows).text) && rowOf(C, empty.c.rows) && /\bActivate\b/.test(rowOf(C, empty.c.rows).text),
     "without edits: " + U.merchant + " (" + U.card + ") listed, " + C.merchant + " (" + C.card + ") needs activation");

  await load({ status: 200, body: ser(testEdits) });
  const ed = await both();
  ok(!rowOf(U, ed.u.rows), "used edit: " + U.merchant + " (" + U.card + ") is gone from the results (signed out)");
  ok(rowOf(C, ed.c.rows) && /\bReady\b/.test(rowOf(C, ed.c.rows).text), "activated edit: " + C.merchant + " (" + C.card + ") shows Ready");
  // The headlines, where they named these offers without the edits.
  if (/U\.S\. Bank offer/.test(empty.u.use)) ok(!/U\.S\. Bank offer/.test(ed.u.use), "headline no longer counts the used U.S. Bank offer: " + JSON.stringify(ed.u.use.split("\n").slice(0, 2).join(" / ")));
  else console.log("SKIP headline for " + U.merchant + " didn't name the U.S. Bank offer: " + JSON.stringify(empty.u.use.split("\n").slice(0, 2).join(" / ")));
  if (/After activating/.test(empty.c.use)) ok(ed.c.use !== empty.c.use && /Ready now/.test(ed.c.use), "headline for " + C.merchant + " changes with the activation: " + JSON.stringify(ed.c.use.split("\n").slice(0, 2).join(" / ")));
  else console.log("SKIP headline for " + C.merchant + " had no After activating line: " + JSON.stringify(empty.c.use.split("\n").slice(0, 2).join(" / ")));
  const others = ed.c.rows.filter(r => !r.gone && r.id !== C.merchant + " | " + ROW_CARD(C.card));
  ok(JSON.stringify(others) === JSON.stringify(empty.c.rows.filter(r => !r.gone && r.id !== C.merchant + " | " + ROW_CARD(C.card))), "other rows in that search untouched (" + others.length + ")");

  await usedChecks(page, load, search, testEdits);

  await load({ status: 500, body: "" });
  ok(/Couldn’t load the offer list/.test(await page.$eval("#main", e => e.innerText)), "phone-edits.json answering 500 -> the offers load error");
  await load({ status: 200, body: "{ not json" });
  ok(/Couldn’t load the offer list/.test(await page.$eval("#main", e => e.innerText)), "broken phone-edits.json -> the offers load error");
  await load({ status: 200, body: "[]" });
  ok(/Couldn’t load the offer list/.test(await page.$eval("#main", e => e.innerText)), "phone-edits.json not an object -> the offers load error");

  // The page's own copy check in the browser: a save gets past it (to writing a blob) only when the hash the page
  // works out for its offers.json is git's blob hash of the file. The GitHub API is a stub here; nothing is sent.
  const want = gitSha(fs.readFileSync(path.join(DATA, "offers.json")));
  const calls = [];
  await page.unroute("https://api.github.com/**");
  await page.route("https://api.github.com/**", r => {
    const u = new URL(r.request().url()), p = u.pathname.replace("/repos/module7543/CardSelector", ""), m = r.request().method();
    calls.push(m + " " + p);
    const j = b => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (p === "/git/ref/heads/main") return j({ object: { sha: "a".repeat(40) } });
    if (/^\/git\/commits\//.test(p)) return j({ tree: { sha: "b".repeat(40) } });
    if (p === "/contents/site/data") return j([{ path: OFFERS, sha: want }, { path: EDITS, sha: "c".repeat(40) }]);
    if (p === "/contents/" + EDITS) return r.fulfill({ status: 200, body: "{}\n" });
    return r.fulfill({ status: 500, body: "{}" }); // stop at the first write
  });
  await load(null, true);
  const res = await page.evaluate(id => CardStore.save({ type: "offer.activation", id: id, from: "needs_activation", to: "already_activated" }), ID.chase);
  ok(calls.includes("POST /git/blobs") && res.status === "error" && res.kind === "network", "browser: the page's offers.json hash matches main's (" + want.slice(0, 10) + "), so the save reached the write (" + calls.join(", ") + ")");
  calls.length = 0;
  await load(null); // signed out at load: nothing worked out until the first save
  await page.evaluate(() => localStorage.setItem("cardselector.token", "test"));
  const res1 = await page.evaluate(id => CardStore.save({ type: "offer.activation", id: id, from: "needs_activation", to: "already_activated" }), ID.chase);
  ok(calls.includes("POST /git/blobs") && res1.kind === "network", "browser: signed in after load, the first save works out the hash and reaches the write");
  calls.length = 0;
  await page.unroute("https://api.github.com/**");
  await page.route("https://api.github.com/**", r => {
    const p = new URL(r.request().url()).pathname.replace("/repos/module7543/CardSelector", "");
    calls.push(r.request().method() + " " + p);
    if (p === "/git/ref/heads/main") return r.fulfill({ status: 200, body: JSON.stringify({ object: { sha: "a".repeat(40) } }) });
    if (/^\/git\/commits\//.test(p)) return r.fulfill({ status: 200, body: JSON.stringify({ tree: { sha: "b".repeat(40) } }) });
    if (p === "/contents/site/data") return r.fulfill({ status: 200, body: JSON.stringify([{ path: OFFERS, sha: "d".repeat(40) }]) });
    return r.fulfill({ status: 500, body: "{}" });
  });
  const res2 = await page.evaluate(id => CardStore.save({ type: "offer.activation", id: id, from: "needs_activation", to: "already_activated" }), ID.chase);
  ok(res2.kind === "reload" && !calls.some(c => /^POST/.test(c)), "browser: a different offers.json on main -> reload, nothing written: " + res2.message);

  await dayChecks(br, base);
  await containerEditChecks(br, base);
  await cardBonusChecks(br, base);

  await br.close();
  server.close();
}

(async () => {
  const { saved, editsText } = await offline();
  folding(saved, editsText);
  foldOnMain();
  validator();
  if (process.env.SKIP_BROWSER) console.log("SKIP browser checks (SKIP_BROWSER set)");
  else await browser();
  ok(digest() === dataBefore, "real data files unchanged");
  console.log(failed ? failed + " FAILED" : "all passed");
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });

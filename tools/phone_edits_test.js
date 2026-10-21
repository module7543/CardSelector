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

// Used offers, signed in (phone width): marking used keeps the row in place, dimmed, with "Restore offer" on the row
// (restoring puts it back as it was); the "Used (N)" filter lists every used offer newest first, with or without a
// search, under the card filter, whatever the sort; Recently unavailable no longer lists used offers; signed out
// there is no Used filter. Saves go through a stub CardStore.save running the real CardEdits.apply: nothing is sent.
async function usedChecks(page, load, search, testEdits) {
  const U = byId[ID.usbank], N = byId[ID.needs], C = byId[ID.chase];
  // d: the card in "(on <card>)"; null: no "(on ...)" (Chase, Citi); left out: either.
  const USED_RE = d => new RegExp("Used [A-Z][a-z]{2} \\d+" + (d ? " \\(on " + d + "\\)" : d === null ? "(?!\\d| \\(on )" : ""));
  // Rows of the main list (not Recently unavailable): key, dimmed or not, the row's own text (details left out).
  const rows = () => page.$$eval("#main > ul.results > li.offer", ls => ls.map(li => ({
    key: li.querySelector(".merchant").textContent + " | " + li.querySelector(".mcard").textContent,
    gone: li.classList.contains("gone"), text: li.querySelector(".row").innerText.replace(/\s+/g, " ")
  })));
  const keyOf = o => o.merchant + " | " + ROW_CARD(o.card);
  const rowLoc = o => page.locator("#main > ul.results > li.offer").filter({ has: page.locator(".merchant", { hasText: new RegExp("^" + o.merchant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$") }) })
    .filter({ has: page.locator(".mcard", { hasText: ROW_CARD(o.card) }) });
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

  // 1. Mark used keeps the row where it is, dimmed, labelled, with Restore on the row; Restore puts it back in place.
  await load({ status: 200, body: "{}\n" }, true);
  await stub({ [U.id]: copyOf(U) });
  const q = U.merchant.split(/\s+/)[0];
  await search(q);
  const before = await rows(), at = before.findIndex(r => r.key === keyOf(U));
  ok(before.length >= 2 && at !== -1, "search " + JSON.stringify(q) + ": " + before.length + " rows, " + U.merchant + " at row " + (at + 1));
  await rowLoc(U).locator("button.toggle").click();
  const opened = await rows(); // its activation badge steps aside while the details are open
  await rowLoc(U).locator("button.edsm", { hasText: "Used on Smartly" }).click();
  await page.waitForTimeout(150);
  const marked = await rows(), mrow = marked[at] || {};
  ok(marked.length === before.length && marked.map(r => r.key).join("\n") === before.map(r => r.key).join("\n"), "mark used: same rows in the same order (" + marked.length + ")");
  ok(mrow.key === keyOf(U) && mrow.gone && USED_RE("Smartly").test(mrow.text) && /Restore offer/.test(mrow.text),
     "mark used: row stays dimmed with \"Used <date> (on Smartly)\" and Restore offer: " + JSON.stringify(mrow.text));
  ok(marked.every((r, i) => i === at || JSON.stringify(r) === JSON.stringify(opened[i])), "mark used: other rows unchanged");
  ok(!/U\.S\. Bank offer/.test(await page.$eval("#use", e => e.hidden ? "" : e.innerText)), "mark used: the headline no longer counts the used offer");
  ok(/Used \(\d+\)/.test(await usedBtn() || ""), "mark used: Used filter shows " + JSON.stringify(await usedBtn()));
  const gone1 = await page.$eval("#main", e => (e.querySelector("details.expired") || {}).innerText || "");
  ok(!/Used [A-Z][a-z]{2} \d+/.test(gone1), "mark used: the offer is not under Recently unavailable");
  // A real tap on the row's Restore link (it must sit above the row's own tap layer).
  await rowLoc(U).locator(".meta button.edlink", { hasText: "Restore offer" }).click({ timeout: 3000 });
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
  const deepLoc = page.locator("#main > ul.results > li.offer").nth(deep);
  await deepLoc.locator("button.toggle").click();
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
  let list = await rows();
  ok(list.map(r => r.key).join("\n") === want.map(keyOf).join("\n"), "Used list, blank search: every used offer, newest used first: " + list.map(r => r.key.split(" | ")[0].slice(0, 20)).join(", "));
  ok(list.length && list.every(r => r.gone && /Restore offer/.test(r.text) && USED_RE().test(r.text)), "Used list rows: dimmed, \"Used <date> ...\" and Restore offer" + (list.every(r => r.gone && /Restore offer/.test(r.text) && USED_RE().test(r.text)) ? "" : ": " + JSON.stringify(list)));
  const urow = list.find(r => r.key === keyOf(U)), crow = list.find(r => r.key === keyOf(C));
  ok(urow && USED_RE("Smartly").test(urow.text) && crow && USED_RE(null).test(crow.text) && !/\(on /.test(crow.text), "labels: \"Used <date> (on Smartly)\" for U.S. Bank, \"Used <date>\" for " + C.card);
  ok(await page.$eval("#count", e => e.innerText) === "" && /Used/.test(await page.$eval("#ftoggle", e => e.innerText)), "count line empty (the button shows N), Filters summary: " + JSON.stringify(await page.$eval("#count", e => e.innerText)) + ", " + JSON.stringify(await page.$eval("#ftoggle", e => e.innerText)));
  await page.selectOption("#sort", "az");
  await page.waitForTimeout(100);
  ok((await rows()).map(r => r.key).join("\n") === want.map(keyOf).join("\n"), "sort menu (A to Z) does not reorder the Used list");
  await page.selectOption("#sort", "best");
  await search(U.merchant);
  list = await rows();
  ok(list.length === 1 && list[0].key === keyOf(U) && await usedBtn() === "Used (1)", "with a search: " + JSON.stringify(await usedBtn()) + ", rows " + JSON.stringify(list.map(r => r.key)));
  await search("");
  await page.locator("#cards button", { hasText: /^U\.S\. Bank$/ }).click();
  await page.waitForTimeout(100);
  const usb = want.filter(o => o.card === "U.S. Bank");
  list = await rows();
  ok(list.map(r => r.key).join("\n") === usb.map(keyOf).join("\n") && await usedBtn() === "Used (" + usb.length + ")", "card filter U.S. Bank: " + JSON.stringify(await usedBtn()) + ", " + list.length + " rows");
  // Restore inside the Used list: the row stays in place, back to normal, until the view changes.
  const ui = list.findIndex(r => r.key === keyOf(N));
  await rowLoc(N).locator(".meta button.edlink", { hasText: "Restore offer" }).click({ timeout: 3000 });
  await page.waitForTimeout(150);
  const after = await rows();
  ok(after.length === list.length && after[ui].key === keyOf(N) && !after[ui].gone && !/Restore offer/.test(after[ui].text) && await usedBtn() === "Used (" + (usb.length - 1) + ")",
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
  await rowLoc(C).locator(".meta button.edlink", { hasText: "Restore offer" }).click({ timeout: 3000 });
  await page.waitForTimeout(150);
  await page.locator("#cards button", { hasText: /^U\.S\. Bank$/ }).click();
  await page.waitForTimeout(100);
  await page.click("#savebtns button:has-text('Undo')");
  await page.waitForTimeout(200);
  list = await rows();
  ok(list.length && list.every(r => /Smartly \/ Cash\+|U\.S\. Bank/.test(r.key)), "Used list on U.S. Bank after a save-bar Undo of a " + C.card + " edit: only U.S. Bank rows (" + list.map(r => r.key.split(" | ")[1]).join(", ") + ")");
  await page.locator("#cards button", { hasText: /^All cards$/ }).click();
  // In store / Online and Activation don't apply to the Used list: no "channel not shown" label, not in the summary.
  await clickUsed();
  await page.locator("#chans button", { hasText: /^In store$/ }).click();
  await page.locator("#acts button", { hasText: /^Ready now/ }).click();
  await clickUsed();
  ok(!/channel not shown/.test(await page.$eval("#main", e => e.innerText)) && await page.$eval("#ftoggle", e => e.innerText.trim()) === "Filters: Used",
     "Used list ignores In store and Ready now: no \"channel not shown\", summary " + JSON.stringify(await page.$eval("#ftoggle", e => e.innerText.trim())));
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
      id: li.querySelector(".merchant").textContent + " | " + li.querySelector(".mcard").textContent,
      gone: li.classList.contains("gone"),
      text: li.innerText.replace(/\s+/g, " ")
    })));
  };
  const snapshot = async q => ({ rows: await search(q), use: await page.$eval("#use", e => e.hidden ? "" : e.innerText), count: await page.$eval("#count", e => e.innerText).catch(() => "") });
  const testEdits = { [ID.usbank]: { status: "used", status_since: today, used_on: "Smartly" }, [ID.chase]: { activation: "already_activated" } };
  const U = byId[ID.usbank], C = byId[ID.chase];
  const rowOf = (o, rows) => rows.find(r => r.id === o.merchant + " | " + ROW_CARD(o.card) && !r.gone);
  const both = async () => ({ u: await snapshot(U.merchant), c: await snapshot(C.merchant) });

  await load({ status: 200, body: "{}\n" });
  const empty = await both();
  await load(null); // the real file
  const real = await both();
  await load({ status: 404, body: "" });
  const missing = await both();
  const realEmpty = read(EDITS) === "{}\n"; // main may hold pending edits between folds
  ok(JSON.stringify(empty) === JSON.stringify(missing) && (!realEmpty || JSON.stringify(empty) === JSON.stringify(real)),
     "missing phone-edits.json = empty file" + (realEmpty ? " = the real file" : " (real file has pending edits, not compared)") + " (searches: " + JSON.stringify(U.merchant) + ", " + JSON.stringify(C.merchant) + ")");
  ok(rowOf(U, empty.u.rows) && /Already activated/.test(rowOf(U, empty.u.rows).text) && rowOf(C, empty.c.rows) && /Needs activation/.test(rowOf(C, empty.c.rows).text),
     "without edits: " + U.merchant + " (" + U.card + ") listed, " + C.merchant + " (" + C.card + ") needs activation");

  await load({ status: 200, body: ser(testEdits) });
  const ed = await both();
  ok(!rowOf(U, ed.u.rows), "used edit: " + U.merchant + " (" + U.card + ") is gone from the results (signed out)");
  ok(rowOf(C, ed.c.rows) && /Already activated/.test(rowOf(C, ed.c.rows).text), "activated edit: " + C.merchant + " (" + C.card + ") shows Already activated");
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

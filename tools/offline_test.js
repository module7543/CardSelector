// Saved copy checks (site/sw.js, site/js/copy.js, site/js/recent.js) at phone width (390 x 844), with the worker on:
//   node tools/offline_test.js
// Needs Playwright (npm i playwright). CHROMIUM_PATH picks a browser binary; BROWSER=firefox runs it in Firefox.
// The site is served the way GitHub Pages serves it (ETag, 304 to a conditional request, max-age=600), from the
// real site/ files plus test overrides held in memory, with a test version.json written like
// tools/write_version.py does. The GitHub API is a mock in the browser. Nothing is written to the data files.
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const pw = require("playwright");
const SITE = path.join(__dirname, "../site");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8" };
const read = p => fs.readFileSync(path.join(SITE, p));

let failed = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) failed++; };
const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");
const gitSha = b => crypto.createHash("sha1").update(Buffer.concat([Buffer.from("blob " + b.length + "\0"), b])).digest("hex");
const ser = o => JSON.stringify(o, null, 2) + "\n";

// Test offers from today's data (as tools/phone_edits_test.js picks them): live, one offer per merchant on that
// card, not expiring within two days, not in the real pending edits.
const offersText = read("data/offers.json").toString(), offersData = JSON.parse(offersText);
const realEdits = JSON.parse(read("data/phone-edits.json"));
const ROW_CARD = (() => { const l = JSON.parse(read("data/cards.json")).offer_lists || {}; return c => (l[c] && l[c].row_name) || c; })();
const safeDate = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
const perCard = {};
offersData.offers.forEach(o => { const k = o.card + "|" + o.merchant; perCard[k] = (perCard[k] || 0) + 1; });
const taken = [];
const pick = pred => {
  const o = offersData.offers.filter(o => o.status === "active" && !(o.expires && o.expires <= safeDate) && perCard[o.card + "|" + o.merchant] === 1 &&
    !(o.id in realEdits) && !taken.includes(o.id) && !taken.some(t => offersData.offers.find(x => x.id === t).merchant === o.merchant) && pred(o))
    .sort((a, b) => b.merchant.length - a.merchant.length || (a.id < b.id ? -1 : 1))[0];
  taken.push(o.id);
  return o;
};
const usb = o => o.card === "U.S. Bank" && o.activation === "already_activated" && /^\s*\d+(\.\d+)?\s*%/.test(o.bonus);
const U = pick(usb), U2 = pick(usb), U3 = pick(usb), U4 = pick(usb), U5 = pick(usb);
const C = pick(o => /^(Chase|Citi) /.test(o.card) && o.activation === "needs_activation");
const C2 = pick(o => /^(Chase|Citi) /.test(o.card) && o.activation === "needs_activation");
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
console.log("test offers: " + [U, U2, U3, U4, U5, C, C2].map(o => o.id).join(", "));

// offers.json with some offers changed (a fold writes the edit in) and test offers added.
function offersWith(change = {}, add = []) {
  const d = JSON.parse(offersText);
  d.offers.forEach(o => { if (change[o.id]) Object.assign(o, change[o.id](o)); });
  add.forEach(a => d.offers.push(Object.assign({ expires: null, expires_text: null, activation: "already_activated", spend_cap: null, minimum_spend: null,
    fine_print: null, other_details: [], last_read: "2026-10-18", first_seen: "2026-10-18", status: "active", status_since: "2026-10-18" }, a)));
  return ser(d);
}
const usedOn = card => o => ({ status: "used", status_since: today, other_details: (o.other_details || []).filter(t => !/^Used on /.test(t)).concat(["Used on " + card]) });

// ---- The site, served as GitHub Pages serves it.
class Site {
  constructor() { this.over = {}; this.fail = {}; this.delay = {}; this.version = null; this.n = 0; this.hook = null; this.log = []; this.sockets = new Set(); }
  body(p) {
    if (p in this.over) return Buffer.from(this.over[p]);
    const f = path.join(SITE, p);
    return f.startsWith(SITE + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile() ? fs.readFileSync(f) : null;
  }
  files() {
    const out = [];
    const walk = d => fs.readdirSync(path.join(SITE, d)).forEach(n => {
      const rel = d ? d + "/" + n : n;
      if (fs.statSync(path.join(SITE, rel)).isDirectory()) walk(rel); else if (rel !== "version.json") out.push(rel);
    });
    walk("");
    Object.keys(this.over).forEach(p => { if (!out.includes(p)) out.push(p); });
    return out;
  }
  // A deploy: the overrides go live together with a new version.json (as tools/write_version.py writes it).
  publish(changes = {}) {
    Object.assign(this.over, changes);
    const files = {};
    this.files().forEach(p => { files[p] = sha256(this.body(p)); });
    this.version = { commit: "test-" + (++this.n), files };
    return this.version.commit;
  }
  handle(req, res) {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\//, "");
    if (p === "" || p.endsWith("/")) p += "index.html";
    this.log.push(p);
    if (this.hook) this.hook(p);
    const send = () => {
      if (p === "version.json" && typeof this.fail[p] === "number") { res.writeHead(this.fail[p]); return res.end(); }
      if (p === "version.json") {
        if (!this.version) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { "Content-Type": TYPES[".json"], "Cache-Control": "max-age=600" });
        return res.end(JSON.stringify(this.version));
      }
      const f = this.fail[p];
      if (f === "abort") return req.socket.destroy();
      if (typeof f === "number") { res.writeHead(f); return res.end(); }
      let b = this.body(p);
      if (f === "badjson") b = Buffer.from("{ not json");
      if (!b) { res.writeHead(404); return res.end(); }
      const etag = '"' + sha256(b).slice(0, 16) + '"';
      const h = { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream", "Cache-Control": "max-age=600", ETag: etag, "Last-Modified": "Tue, 20 Oct 2026 10:00:00 GMT" };
      if (req.headers["if-none-match"] === etag) { res.writeHead(304, h); return res.end(); }
      res.writeHead(200, h);
      res.end(b);
    };
    if (this.delay[p]) setTimeout(send, this.delay[p]); else send();
  }
  start(port) {
    return new Promise(r => {
      this.server = http.createServer((q, s) => this.handle(q, s));
      this.server.on("connection", s => { this.sockets.add(s); s.on("close", () => this.sockets.delete(s)); });
      this.server.listen(port || 0, "127.0.0.1", () => { this.port = this.server.address().port; r(); });
    });
  }
  stop() { return new Promise(r => { this.sockets.forEach(s => s.destroy()); this.server.close(() => r()); }); }
}

// ---- A mock of the GitHub API (only what store.js calls), with main's data files in memory.
class Hub {
  constructor(site) {
    this.site = site; this.n = 0; this.head = "c0"; this.trees = {}; this.blobs = {}; this.calls = [];
    this.files = { "site/data/phone-edits.json": site.body("data/phone-edits.json").toString(), "site/data/bonus-categories.json": site.body("data/bonus-categories.json").toString() };
    this.offersSha = gitSha(site.body("data/offers.json"));
  }
  async route(route) {
    const req = route.request(), u = new URL(req.url()), p = u.pathname.replace("/repos/module7543/CardSelector", ""), m = req.method();
    this.calls.push(m + " " + p);
    const j = (b, s) => route.fulfill({ status: s || 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/actions\/workflows\//.test(p)) return j({ workflow_runs: [] });
    if (p === "" && m === "GET") return j({});
    if (p === "/git/ref/heads/main") return j({ object: { sha: this.head } });
    if (/^\/git\/commits\/./.test(p) && m === "GET") return j({ tree: { sha: "t-" + this.head } });
    if (p === "/contents/site/data") return j([{ path: "site/data/offers.json", sha: this.offersSha }, { path: "site/data/phone-edits.json", sha: "e".repeat(40) }]);
    if (/^\/contents\/site\/data\/.+/.test(p)) {
      const f = this.files[p.replace("/contents/", "")];
      return f === undefined ? j({}, 404) : route.fulfill({ status: 200, contentType: "application/json", body: f });
    }
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    if (p === "/git/blobs") { const s = "b" + (++this.n); this.blobs[s] = body.content; return j({ sha: s }); }
    if (p === "/git/trees") { const s = "t" + (++this.n); this.trees[s] = body.tree; return j({ sha: s }); }
    if (p === "/git/commits" && m === "POST") { const s = "c" + (++this.n); this.trees[s] = this.trees[body.tree]; return j({ sha: s }); }
    if (p === "/git/refs/heads/main" && m === "PATCH") {
      this.trees[body.sha].forEach(t => { this.files[t.path] = this.blobs[t.sha]; });
      this.head = body.sha;
      return j({});
    }
    return j({ message: "not mocked: " + m + " " + p }, 500);
  }
  // A deploy of main's data files to the site.
  deploy(extra = {}) {
    return this.site.publish(Object.assign({ "data/phone-edits.json": this.files["site/data/phone-edits.json"], "data/bonus-categories.json": this.files["site/data/bonus-categories.json"] }, extra));
  }
}

(async () => {
  const kind = process.env.BROWSER === "firefox" ? "firefox" : "chromium";
  const browser = await pw[kind].launch(process.env.CHROMIUM_PATH && kind === "chromium" ? { executablePath: process.env.CHROMIUM_PATH } : {});
  console.log("-- " + kind + " " + browser.version());
  const site = new Site();
  await site.start();
  const base = () => "http://127.0.0.1:" + site.port + "/";
  let ctx, page, hub;
  const fresh = async (opts = {}) => {
    if (ctx) await ctx.close();
    site.over = Object.assign({ "data/phone-edits.json": opts.edits || "{}\n" }, opts.over || {}); site.fail = {}; site.delay = {}; site.hook = null;
    site.publish();
    hub = new Hub(site);
    ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); // service workers allowed
    await ctx.route("https://api.github.com/**", r => hub.route(r));
    if (opts.token) await ctx.addInitScript(t => { try { if (!localStorage.getItem("cardselector.init")) { localStorage.setItem("cardselector.init", "1"); localStorage.setItem("cardselector.token", t); } } catch (e) {} }, opts.token);
    page = await ctx.newPage();
    page.on("pageerror", e => { console.log("pageerror: " + e.message); failed++; });
    await open();
  };
  // Opens the page and waits for the check it starts on every open.
  const open = async (reload) => {
    if (reload) await page.reload(); else await page.goto(base());
    await page.waitForFunction(() => window.__copyLast, null, { timeout: 30000 });
    return page.evaluate(() => window.__copyLast);
  };
  const check = (opts) => page.evaluate(o => window.__copyCheck(o), opts || {});
  const search = async q => {
    await page.fill("#q", q);
    await page.waitForTimeout(150);
    return page.$$eval("#main li.offer", ls => ls.map(li => ({ merchant: window.__offerOf(li.dataset.oid).merchant, card: li.querySelector(".mcard").textContent, gone: li.classList.contains("gone"), text: li.innerText })));
  };
  const shows = (rows, o) => rows.some(r => r.merchant === o.merchant && r.card === ROW_CARD(o.card) && !r.gone);
  // The saved copy as the worker keeps it: the current set's name and version, and its phone-edits.json / offers.json.
  const copy = () => page.evaluate(async () => {
    const meta = await caches.open("cardselector-copy-v1-meta");
    const r = await meta.match(new URL("__saved-copy__/current", location.href).href);
    if (!r) return null;
    const m = await r.json(), c = await caches.open(m.name);
    const t = async p => { const x = await c.match(new URL(p, location.href).href); return x ? x.text() : null; };
    return { name: m.name, version: m.version, edits: await t("data/phone-edits.json"), offers: await t("data/offers.json"), locs: await t("data/merchant-locations.json") };
  });
  const remembered = () => page.evaluate(() => JSON.parse(localStorage.getItem("cardselector.saves") || "{}"));
  const offline = () => page.$eval("#offline", e => e.hidden ? "" : e.textContent);
  const openMcOf = async id => {
    const h = page.locator("#main li.mc:has(li.offer[data-oid='" + id + "']) > button.mchead").first();
    if ((await h.getAttribute("aria-expanded")) !== "true") await h.click();
  };
  const openRow = async o => {
    await search(o.merchant);
    // The offer's row; its merchant container's header opens every row's details.
    const li = page.locator("#main li.offer[data-oid='" + o.id + "']").first();
    await openMcOf(o.id);
    return li;
  };
  const bar = () => page.$eval("#savebar", e => e.hidden ? "" : e.innerText.replace(/\s+/g, " "));
  const waitBar = re => page.waitForFunction(r => { const b = document.getElementById("savebar"); return !b.hidden && new RegExp(r).test(b.innerText); }, re.source, { timeout: 30000 });

  // 1. Second open with the server stopped: results from the copy, used offers from phone-edits.json hidden.
  console.log("-- 1. offline open");
  await fresh({ edits: ser({ [U.id]: { status: "used", status_since: today, used_on: "Smartly" } }) });
  let st = await copy();
  ok(st && JSON.parse(st.edits)[U.id] && st.version === site.version.commit, "first visit saved a copy (" + (st && st.version) + ")");
  ok(!shows(await search(U.merchant), U), "online: the used offer " + U.merchant + " is hidden");
  const port = site.port;
  await site.stop();
  await page.goto(base()).catch(() => {});
  await page.waitForFunction(() => window.__copyLast, null, { timeout: 30000 });
  const r1 = await page.evaluate(() => window.__copyLast);
  const pz = await search("pizza");
  ok(pz.length > 5, "offline: the page opens from the copy and a search shows results (" + pz.length + " for pizza)");
  ok(!shows(await search(U.merchant), U), "offline: the used offer stays hidden");
  const line = await offline();
  ok(r1 && r1.offline && /^Offline · saved copy from [A-Z][a-z]{2} \d{1,2}(, \d{4})?, \d{1,2}:\d\d (am|pm)$/.test(line), "offline line: \"" + line + "\"");
  ok(await page.$eval("#offline", e => e.previousElementSibling.id === "count"), "the offline line sits right under the count line");
  await site.start(port);
  await check();
  ok(await offline() === "", "the offline line goes away once a check gets through");

  // 2. A fold deploy replaces the copy as a whole; a download with one bad file leaves the old set; used offers
  // never reappear.
  console.log("-- 2. fold and partial downloads");
  await page.exposeFunction("__sawUsed", t => { sawUsed.push(t); }).catch(() => {});
  var sawUsed = [];
  await page.evaluate(([m, c]) => {
    new MutationObserver(() => {
      document.querySelectorAll("#main li.offer:not(.gone)").forEach(li => {
        if (window.__offerOf(li.dataset.oid).merchant === m && li.querySelector(".mcard").textContent === c) window.__sawUsed(new Date().toISOString());
      });
    }).observe(document.getElementById("main"), { childList: true, subtree: true });
  }, [U.merchant, ROW_CARD(U.card)]);
  await search(U.merchant);
  const folded = offersWith({ [U.id]: usedOn("Smartly") });
  site.publish({ "data/offers.json": folded, "data/phone-edits.json": "{}\n" });
  let r2 = await check();
  st = await copy();
  ok(r2.status === "updated" && st.edits === "{}\n" && JSON.parse(st.offers).offers.find(o => o.id === U.id).status === "used", "fold: the copy now has the folded offers.json and the empty phone-edits.json, together (" + r2.status + ")");
  ok(!shows(await search(U.merchant), U), "fold: the used offer is still hidden after the swap");
  const before = await copy();
  for (const [file, how] of [["data/offers.json", 500], ["data/phone-edits.json", "abort"], ["data/cuisines.json", "badjson"], ["js/app.js", 404]]) {
    // The deploy restores the pending edit to offers.json and drops it from phone-edits.json in other ways; one
    // file of it fails to download.
    // The failing file changes in that deploy too (an unchanged one is reused without a request).
    const touched = { [file]: (site.body(file).toString() + (/\.json$/.test(file) ? " " : "\n// changed\n")) };
    site.publish(Object.assign({ "data/offers.json": offersWith({ [U.id]: usedOn("Smartly") }, [{ id: "test/zqx-partial", card: "U.S. Bank", merchant: "Zqxpartial Shop", category: "Clothing & Jewelry", bonus: "5% back", channel: "online" }]),
                   "data/phone-edits.json": ser({ [U2.id]: { activation: "needs_activation" } }) }, file === "data/offers.json" || file === "data/phone-edits.json" ? {} : touched));
    site.fail = { [file]: how };
    const r = await check();
    const now = await copy();
    ok(r.status !== "updated" && now.name === before.name && now.edits === before.edits && now.offers === before.offers, file + " " + how + ": nothing replaced (" + r.status + (r.reason ? ": " + r.reason : "") + ")");
    ok(!(await search("zqxpartial")).length && !shows(await search(U.merchant), U), file + " " + how + ": the page keeps the old set, the used offer stays hidden");
  }
  site.fail = {};
  // A site whose files don't match its version.json (a CDN still serving an older file) is refused too.
  site.publish({ "data/offers.json": offersWith({ [U.id]: usedOn("Smartly") }, [{ id: "test/zqx-cdn", card: "U.S. Bank", merchant: "Zqxcdn Shop", category: "Clothing & Jewelry", bonus: "5% back", channel: "online" }]) });
  site.over["data/offers.json"] = offersText;
  r2 = await check();
  ok(r2.status === "failed" && (await copy()).name === before.name, "offers.json not matching version.json: refused (" + r2.reason + ")");
  site.publish();
  r2 = await check();
  // offers.json is the unfolded one now and phone-edits.json no longer has U: U is live, as the site says.
  ok(r2.status === "updated", "after the failures, a good deploy goes in (" + r2.status + ")");
  site.publish({ "data/offers.json": folded, "data/phone-edits.json": "{}\n" });
  await check();
  sawUsed = [];
  await search(U.merchant);
  for (let i = 0; i < 3; i++) { await open(true); ok(!shows(await search(U.merchant), U), "reload " + (i + 1) + " after the fold: the used offer stays hidden"); }
  ok(!sawUsed.length, "the used offer never showed during the fold swaps and reloads (" + sawUsed.length + ")");

  // 3. version.json changing during the download: the staging copy is dropped, the next check takes the new one.
  console.log("-- 3. deploy during the download");
  const midOffers = offersWith({ [U.id]: usedOn("Smartly") }, [{ id: "test/zqx-mid", card: "U.S. Bank", merchant: "Zqxmid Shop", category: "Clothing & Jewelry", bonus: "5% back", channel: "online" }]);
  site.publish({ "data/offers.json": midOffers });
  const before3 = await copy();
  let fired = 0;
  site.hook = p => { if (p === "data/offers.json" && !fired++) site.publish(); };
  const r3 = await check();
  site.hook = null;
  ok(fired === 1 && r3.status === "raced" && (await copy()).name === before3.name && !(await search("zqxmid")).length, "version.json changed mid-download: staging copy discarded (" + r3.status + ")");
  const r3b = await check();
  ok(r3b.status === "updated" && (await copy()).version === site.version.commit && (await search("zqxmid")).length === 1, "the next check takes the new deploy (" + r3b.status + ")");

  // 4. Remembered saves: a save, then a reload while the site still serves the old data.
  console.log("-- 4. remembered saves");
  await fresh({ token: "test-token-offline" });
  let li = await openRow(U2);
  await li.locator("button", { hasText: "Used on Smartly" }).click();
  await waitBar(/Deploying/);
  let mem = await remembered();
  const k2 = "offers:" + U2.id;
  ok(mem[k2] && mem[k2].before.status === "active" && mem[k2].after.status === "used" && mem[k2].after.used_on === "Smartly" && mem[k2].commit, "the save is remembered: " + JSON.stringify(mem[k2] && { before: mem[k2].before, after: mem[k2].after }));
  ok(!("activation" in mem[k2].after), "only the fields the save changed are remembered");
  await open(true);
  ok(!shows(await search(U2.merchant), U2), "reload before the deploy: the used offer stays hidden (remembered save put back)");
  ok((await remembered())[k2], "the entry stays while the site doesn't show the save");
  hub.deploy();
  await check();
  ok(!(await remembered())[k2] && !shows(await search(U2.merchant), U2), "the site now shows the save: entry dropped, offer still hidden");
  // Restoring it replaces the entry; after a reload during the restore's deploy, the offer is back.
  await page.click("#ftoggle");
  await page.locator("#used button").click();
  await openMcOf(U2.id);
  await page.locator("#main li.offer[data-oid='" + U2.id + "']").locator("button", { hasText: "Restore offer" }).click();
  await waitBar(/Deploying/);
  mem = await remembered();
  ok(mem[k2] && mem[k2].after.status === "active" && mem[k2].before.status === "used", "restore replaces the entry (one per record)");
  await open(true);
  ok(shows(await search(U2.merchant), U2), "reload during the restore's deploy: the offer is back");

  // An entry is dropped when the record shows something else.
  li = await openRow(U3);
  await li.locator("button", { hasText: "Used on Smartly" }).click();
  await waitBar(/Deploying/);
  hub.files["site/data/phone-edits.json"] = ser(Object.assign(JSON.parse(hub.files["site/data/phone-edits.json"]), { [U3.id]: { status: "used", status_since: today, used_on: "Cash+" } }));
  hub.deploy();
  await open(true);
  ok(!(await remembered())["offers:" + U3.id], "record shows something else (used on Cash+): entry dropped");
  // ... and after 24 hours.
  li = await openRow(U4);
  await li.locator("button", { hasText: "Used on Smartly" }).click();
  await waitBar(/Deploying/);
  await page.evaluate(k => { const m = JSON.parse(localStorage.getItem("cardselector.saves")); m[k].at -= 25 * 3600 * 1000; localStorage.setItem("cardselector.saves", JSON.stringify(m)); }, "offers:" + U4.id);
  await open(true);
  ok(!(await remembered())["offers:" + U4.id] && shows(await search(U4.merchant), U4), "after 24 hours: entry dropped, the old data shows (the site never got it)");
  // ... and when a save on that record comes back as a conflict.
  li = await openRow(C);
  await li.locator("button", { hasText: "Mark activated" }).click();
  await waitBar(/Deploying/);
  ok((await remembered())["offers:" + C.id], "activation save remembered");
  await open(true);
  li = await openRow(C);
  // main now holds a third value for it (neither what the page shows nor what the button asks for): a conflict.
  hub.files["site/data/phone-edits.json"] = ser(Object.assign(JSON.parse(hub.files["site/data/phone-edits.json"]), { [C.id]: { activation: "auto_enrolled" } }));
  await li.locator("button", { hasText: "Mark not activated" }).click();
  await waitBar(/changed somewhere else/);
  ok(!(await remembered())["offers:" + C.id], "a conflict on that record drops its entry");

  // 5. Card bonuses' Mark activated: survives a reload during the deploy (a remembered bonus save), then the deployed
  // file takes over. One rotating entry is made live and not activated in the served (and main's) file.
  console.log("-- 5. Card bonuses: Mark activated");
  const B5 = JSON.parse(read("data/bonus-categories.json")), E5 = B5.entries.find(e => e.kind === "rotating");
  Object.assign(E5, { start: "2000-01-01", end: "2099-12-31", activate_by: "2099-12-31", activation: "not_confirmed" });
  await fresh({ token: "test-token-offline", over: { "data/bonus-categories.json": ser(B5) } });
  const row5 = "#cb li[data-eid='" + E5.id + "']";
  const st5 = () => page.$eval(row5, l => l.querySelector(".cbst").innerText.replace(/\s+/g, " ").trim());
  const pend5 = () => page.$eval("#cb .cbpend", e => e.textContent);
  const p0 = await pend5();
  ok(/^⚠ Not activated, activate by Dec 31(, 2099)? Mark activated$/.test(await st5()) && /^⚠ \d+ activations? pending$/.test(p0), "a pending row with Mark activated (" + await st5() + "; " + p0 + ")");
  await page.locator(row5 + " button", { hasText: /^Mark activated$/ }).click();
  await waitBar(/Deploying/);
  ok(/^✓ Activated · ends Dec 31/.test(await st5()) && (await pend5()) !== p0 && JSON.parse(hub.files["site/data/bonus-categories.json"]).entries.find(e => e.id === E5.id).activation === "activated",
    "after the save the row is activated and main's file has it (" + await st5() + "; " + await pend5() + ")");
  ok((await remembered())["bonus:" + E5.id], "activation save remembered");
  await open(true);
  ok(/^✓ Activated · ends Dec 31/.test(await st5()) && !(await page.$(row5 + " button:not(.cbgo)")), "reload during the deploy: the row stays activated, no button (" + await st5() + ")");
  hub.deploy();
  await check();
  ok(!(await remembered())["bonus:" + E5.id] && /^✓ Activated/.test(await st5()), "once deployed: entry dropped, the row unchanged");

  // 5b. Customized Cash choice, saved from its Card Bonus detail page's Choice picker: survives a reload during the
  // deploy, and the headline and Card bonuses use it.
  console.log("-- 5b. Customized Cash choice");
  await fresh({ token: "test-token-offline" });
  const CC = "bank-of-america-customized-cash/standing", q5 = "chevron";
  const choiceRow = () => page.$eval("#cb li[data-eid='" + CC + "'] .cbst", e => e.textContent);
  await search(q5);
  const use0 = await page.$eval("#use", e => e.innerText);
  const choice0 = JSON.parse(hub.files["site/data/bonus-categories.json"]).entries.find(e => e.id === CC).choice;
  await page.fill("#q", "");
  await page.click("#cb li[data-eid='" + CC + "'] .cbgo");
  await page.waitForTimeout(450); // a tap within 400 ms of a page swap is dropped (double-tap guard)
  await page.selectOption("#dt .bfocus select", "gas & EV charging stations");
  await page.click("#dt .bfocus button:has-text('Save')");
  await waitBar(/Deploying/);
  ok(await page.$eval("#dt", d => /Choice: gas & EV charging stations/.test(d.innerText)), "the detail shows the saved choice");
  await page.click("#dtback");
  await page.waitForTimeout(450);
  await search(q5);
  const use1 = await page.$eval("#use", e => e.innerText);
  ok(choice0 !== "gas & EV charging stations" && /Customized Cash/.test(use1) && use1 !== use0 && await choiceRow() === "Choice: gas & EV charging stations",
    "after the save the headline and Card bonuses use the new choice: " + JSON.stringify(use1.split("\n").find(l => /Customized Cash/.test(l))));
  ok((await remembered())["bonus:" + CC], "choice save remembered");
  await open(true);
  await search(q5);
  const use2 = await page.$eval("#use", e => e.innerText);
  ok(use2 === use1 && await choiceRow() === "Choice: gas & EV charging stations", "reload during the deploy: the choice and the headline stay (" + JSON.stringify(use2.split("\n").find(l => /Customized Cash/.test(l))) + ")");
  hub.deploy();
  await check();
  ok(!(await remembered())["bonus:" + CC] && (await page.$eval("#use", e => e.innerText)) === use1, "once deployed: entry dropped, the headline unchanged");
  await page.fill("#q", "");

  // 6. A save refused with "reload": an immediate check, then one retry.
  console.log("-- 6. refused save");
  await fresh({ token: "test-token-offline" });
  const newer = offersWith({}, [{ id: "test/zqx-newer", card: "U.S. Bank", merchant: "Zqxnewer Shop", category: "Clothing & Jewelry", bonus: "5% back", channel: "online" }]);
  site.publish({ "data/offers.json": newer }); // the site has a newer offers.json than the page's copy
  hub.offersSha = gitSha(Buffer.from(newer));  // and main has it too
  li = await openRow(C);
  await li.locator("button", { hasText: "Mark activated" }).click();
  await waitBar(/Deploying|Not saved/);
  const lists = hub.calls.filter(c => c === "GET /contents/site/data").length;
  ok(/Deploying/.test(await bar()) && lists === 2 && (await search("zqxnewer")).length === 1, "refused, checked, swapped and retried once: " + JSON.stringify(await bar()) + " (" + lists + " checks of main)");
  hub.offersSha = "f".repeat(40); // main is ahead of the site
  li = await openRow(C2);
  await li.locator("button", { hasText: "Mark activated" }).click();
  await waitBar(/Not saved/);
  ok(/Not saved: The offer list was updated and the site may still be catching up\. Wait a minute, reload the page, then try again\. Nothing was saved\./.test(await bar()) &&
     hub.calls.filter(c => c === "GET /contents/site/data").length === lists + 1, "site still behind: the existing message, no retry: " + JSON.stringify(await bar()));

  // 7. A swap keeps the search, filters, sort and open details, and waits for a save in progress.
  console.log("-- 7. swap while in use");
  await fresh({ token: "test-token-offline" });
  await page.click("#ftoggle").catch(() => {});
  await page.selectOption("#sort", "percent");
  await page.locator("#cats button", { hasText: /^Dining/ }).first().click();
  await page.locator("#chans button", { hasText: /^In store/ }).click();
  await page.click("#ftoggle").catch(() => {});
  let rows = await search("pizza");
  const opened = rows[1];
  await page.evaluate(() => document.querySelectorAll("#main li.offer")[1].closest("li.mc").querySelector(".mchead").click());
  await page.evaluate(() => window.scrollTo(0, 400));
  await page.waitForTimeout(100);
  const y0 = await page.evaluate(() => window.scrollY);
  const swaps0 = await page.evaluate(() => window.__swaps || 0);
  const pizzaOffers = offersWith({}, [{ id: "test/zqx-pizza", card: "U.S. Bank", merchant: "Zqx Pizza Test", category: "Dining", bonus: "99% back", channel: "in_store" }]);
  site.publish({ "data/offers.json": pizzaOffers });
  await check();
  rows = await page.$$eval("#main li.offer", ls => ls.map(li => ({ merchant: window.__offerOf(li.dataset.oid).merchant, card: li.querySelector(".mcard").textContent, open: li.closest("li.mc").querySelector(".mchead").getAttribute("aria-expanded") })));
  const state = await page.evaluate(() => ({ q: document.getElementById("q").value, sort: document.getElementById("sort").value,
    cat: (document.querySelector("#cats button[aria-pressed=true]") || {}).textContent, chan: (document.querySelector("#chans button[aria-pressed=true]") || {}).textContent, y: window.scrollY, swaps: window.__swaps }));
  ok(state.swaps === swaps0 + 1 && rows[0].merchant === "Zqx Pizza Test", "new data swapped in right away (first row now " + rows[0].merchant + ")");
  ok(state.q === "pizza" && state.sort === "percent" && /^Dining/.test(state.cat) && /^In store/.test(state.chan), "search, sort, category and In store filter kept (" + JSON.stringify(state) + ")");
  ok(rows.some(r => r.merchant === opened.merchant && r.card === opened.card && r.open === "true"), "the open details stay open (" + opened.merchant + ")");
  ok(Math.abs(state.y - y0) < 5, "scroll position kept (" + y0 + " -> " + state.y + ")");
  // A save in progress holds the swap until it ends.
  await page.evaluate(() => { window.__hold = new Promise(r => { window.__release = r; }); const save = CardStore.save; CardStore.save = c => window.__hold.then(() => save(c)); });
  li = await openRow(U5);
  await li.locator("button", { hasText: "Used on Smartly" }).click();
  site.publish({ "data/offers.json": offersWith({}, [{ id: "test/zqx-held", card: "U.S. Bank", merchant: "Zqxheld Pizza", category: "Dining", bonus: "5% back", channel: "in_store" }]) });
  hub.offersSha = gitSha(Buffer.from(pizzaOffers)); // main has the offers.json the page shows
  await check();
  const held = await page.evaluate(() => window.__swaps);
  ok(held === swaps0 + 1 && /Saving/.test(await bar()), "during the save: no swap (still " + held + " swaps)");
  await page.evaluate(() => window.__release());
  await waitBar(/Deploying/);
  await page.waitForFunction(n => window.__swaps === n, swaps0 + 2, { timeout: 15000 }).catch(() => {});
  ok(await page.evaluate(() => window.__swaps) === swaps0 + 2 && (await search("zqxheld")).length === 1, "the swap goes in once the save ends (Dining and In store still on)");

  // 8. New page code reloads the page only when it comes back on screen and nothing would be lost. The page is
  // opened as the phone opens it: the search box autofocused and empty, and it is never blurred here.
  console.log("-- 8. code update");
  await open(true);
  const focusQ = () => page.evaluate(() => document.activeElement === document.getElementById("q"));
  const comeBack8 = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  ok(await focusQ() && await page.$eval("#q", e => e.value) === "", "opened as on the phone: the empty search box has focus");
  site.publish({ "index.html": read("index.html").toString().replace("</body>", "<!-- code update test -->\n</body>") });
  const r8 = await check();
  ok(r8.code === true, "the check reports new page code");
  await page.evaluate(() => { window.__mark = 1; });
  const stays = async label => { await page.waitForTimeout(500); ok(await page.evaluate(() => window.__mark) === 1, "back on screen " + label + ": no reload"); };
  await page.fill("#q", "pizza"); // fill keeps the focus in the search box
  ok(await focusQ(), "the search box still has focus with text in it");
  await comeBack8();
  await stays("with text in the focused search box");
  for (const text of ["пицца", "&"]) { // text that matches no merchant still counts as typed
    await page.fill("#q", text);
    await comeBack8();
    await stays("with " + JSON.stringify(text) + " in the focused search box");
  }
  // A save bar still showing (here "Saved · Deploying · Undo") blocks it; the details closed, search box empty.
  hub.offersSha = gitSha(site.body("data/offers.json")); // main has the offers.json the page shows
  const li8 = await openRow(U3);
  await li8.locator("button", { hasText: "Used on Smartly" }).click();
  await waitBar(/Deploying/);
  await page.fill("#q", "");
  await page.focus("#q");
  ok(!(await page.$("#main button.mchead[aria-expanded=true]")), "no details open");
  await comeBack8();
  await stays("with the save bar showing (" + (await bar()).slice(0, 20) + "…)");
  await page.click("#savebar button.xbtn");
  await page.fill("#q", "");
  await page.click("#ftoggle");
  await page.locator("#cats button", { hasText: /^Dining/ }).first().click();
  await page.click("#ftoggle");
  await page.focus("#q");
  await comeBack8();
  await stays("with the Dining category picked (empty search box focused)");
  await page.click("#ftoggle");
  await page.locator("#cats button", { hasText: /^All$/ }).click();
  await page.click("#ftoggle");
  await page.evaluate(() => { document.getElementById("editmode").open = true; });
  await page.focus("#q");
  await comeBack8();
  await stays("with the Edit mode panel open");
  await page.evaluate(() => { document.getElementById("editmode").open = false; });
  // In a Quick Pick or Card Bonus detail (a mode of the page; an unsaved Focus or Choice pick lives there): no reload.
  await page.click("#qp li.qpt[data-topic='Dining'] .qpgo");
  await page.waitForTimeout(450);
  await comeBack8();
  await stays("in a Quick Pick detail");
  await page.click("#dtback");
  await page.waitForTimeout(450);
  await page.click("#cb li[data-eid='bank-of-america-customized-cash/standing'] .cbgo");
  await page.waitForTimeout(450);
  await page.selectOption("#dt .bfocus select", "dining");
  await page.focus("#dtback");
  await comeBack8();
  await stays("in a Card Bonus detail with an unsaved Choice pick");
  ok(await page.$eval("#dt .bfocus select", s => s.value) === "dining" && await page.$eval("#dt .bfocus button", b => !b.hidden), "the unsaved pick and its Save are still there");
  await page.click("#dtback");
  await page.waitForTimeout(450);
  // In the Ending soon list (step 4D: its chip holds the view from before, put back when it is removed): no reload.
  await page.click("#sc-end");
  await page.waitForTimeout(100);
  ok(await page.evaluate(() => !document.getElementById("endbar").hidden && document.getElementById("q").value === ""), "the Ending shortcut opened its list (chip on, search box empty)");
  await page.focus("#q");
  await comeBack8();
  await stays("in the Ending soon list (its chip on, empty search box focused)");
  await page.click("#endchip");
  await page.waitForTimeout(100);
  await page.focus("#q");
  // Another field in use blocks it too. At phone width every other field is inside a panel that already blocks
  // the reload (Filters, Edit mode), so this one case runs wide, where the sort select is visible.
  await page.setViewportSize({ width: 1000, height: 844 });
  await page.focus("#sort");
  ok(await page.evaluate(() => document.activeElement.id === "sort"), "wide screen: the sort select has focus");
  await comeBack8();
  await stays("with another field (the sort select, wide screen) focused");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.focus("#q");
  ok(await focusQ() && await page.$eval("#q", e => e.value) === "", "the empty search box has focus again");
  await Promise.all([page.waitForNavigation({ timeout: 15000 }).catch(() => null), comeBack8()]);
  await page.waitForFunction(() => window.__copyLast, null, { timeout: 30000 });
  ok(await page.evaluate(() => window.__mark === undefined && document.documentElement.outerHTML.includes("code update test")), "back on screen with the empty search box focused and nothing picked: reloaded onto the new code");
  ok(!(await check()).code, "after the reload the page's code is current");
  ok(await focusQ(), "after the reload the search box is autofocused again");

  // Coming back on screen checks at most once per 30 seconds (this page just opened, so none now).
  const vBefore = site.log.filter(p => p === "version.json").length;
  await page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(500);
  ok(site.log.filter(p => p === "version.json").length === vBefore, "back on screen within 30 seconds of the last check: no new check");
  await page.evaluate(() => { const n = Date.now; Date.now = () => n() + 31000; document.dispatchEvent(new Event("visibilitychange")); });
  await page.evaluate(() => window.__copyLast);
  ok(site.log.filter(p => p === "version.json").length > vBefore, "back on screen 30 seconds later: a check runs");

  // 9. Nothing from api.github.com, and no token, in Cache Storage.
  console.log("-- 9. what the copy holds");
  const held9 = await page.evaluate(async () => {
    const out = [];
    for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) out.push({ cache: n, url: r.url, body: await (await (await caches.open(n)).match(r)).text() });
    return out;
  });
  ok(held9.length > 0 && !held9.some(e => /api\.github\.com/.test(e.url)), "no api.github.com request in Cache Storage (" + held9.length + " entries)");
  ok(!held9.some(e => e.body.includes("test-token-offline")), "the sign-in token is in no saved file");
  const allowed = /\/(index\.html|js\/(edits|store|recent|copy|app)\.js|data\/(offers|phone-edits|bonus-categories|cuisines|cards|card-links|merchant-locations)\.json|__saved-copy__\/(current|known))$/;
  ok(held9.every(e => allowed.test(new URL(e.url).pathname)), "only the page, its scripts and its data files are saved: " + [...new Set(held9.map(e => new URL(e.url).pathname))].filter(p => !allowed.test(p)).join(", "));
  const vj = await page.evaluate(() => fetch("version.json").then(r => r.headers.get("X-Saved-Copy")));
  ok(vj === null, "version.json is never answered from the copy");

  // 10. Checks that must not change the copy, or must not download what didn't change.
  console.log("-- 10. version.json errors, unchanged files, Card bonuses");
  const before10 = await copy();
  site.publish({ "data/offers.json": offersText, "data/phone-edits.json": ser({ [U.id]: { status: "used", status_since: today, used_on: "Smartly" } }) });
  for (const how of [503, "badjson"]) {
    const keep = site.version;
    if (how === 503) site.fail["version.json"] = 503; else site.version = { nope: 1 };
    const r = await check();
    site.fail = {}; site.version = keep;
    ok(r.status === "failed" && (await copy()).name === before10.name, "version.json " + how + ": the check fails and keeps the copy (" + r.status + ": " + r.reason + ")");
  }
  // A deploy that changes only phone-edits.json: offers.json is reused with no request, whatever its ETag.
  ok((await check()).status === "updated", "with version.json back, the deploy goes in");
  site.publish({ "data/phone-edits.json": "{}\n" });
  let n10 = site.log.length;
  await check();
  const asked = site.log.slice(n10).filter(p => /^(data|js)\/|^index\.html$/.test(p));
  ok(JSON.stringify(asked) === JSON.stringify(["data/phone-edits.json"]), "only the changed file is requested: " + asked.join(", "));
  // A swap that doesn't change the bonus file leaves Card bonuses as it is (the same rows, not drawn again).
  await page.fill("#q", "");
  await page.$eval("#cb li[data-eid]", l => { l.__kept = 1; });
  const sw10 = await page.evaluate(() => window.__swaps || 0);
  site.publish({ "data/offers.json": offersWith({}, [{ id: "test/zqx-strip", card: "U.S. Bank", merchant: "Zqxstrip Shop", category: "Clothing & Jewelry", bonus: "5% back", channel: "online" }]) });
  await check();
  ok(await page.evaluate(() => window.__swaps) === sw10 + 1 && await page.$eval("#cb li[data-eid]", l => l.__kept === 1) && await page.isVisible("#cb"), "a swap of offers.json only keeps Card bonuses as it is");

  // 11. A deploy that changes sw.js together with data: the open that picks up the new worker swaps the data in,
  // and the next open still loads (it once hung in Chromium).
  console.log("-- 11. new sw.js with new data");
  site.publish({ "sw.js": read("sw.js").toString() + "\n// changed\n", "data/phone-edits.json": ser({ [U.id]: { status: "used", status_since: today, used_on: "Smartly" } }) });
  await open(true);
  await page.waitForTimeout(3000);
  const t11 = Date.now();
  const r11 = await page.reload({ timeout: 20000 }).then(() => "loaded in " + (Date.now() - t11) + " ms", e => "hung: " + e.message.split("\n")[0]);
  ok(/^loaded/.test(r11), "the next open after a sw.js + data deploy loads (" + r11 + ")");

  // A save refused while the new worker installs (slow sw.js): the forced check's swap reads the copy from Cache
  // Storage, not through the old worker, so the next open still loads (reads through it once hung Chromium).
  for (const [D, O] of [[1000, 1000], [1500, 1500]]) {
    await fresh({ token: "test-token-offline" });
    await open(true);
    site.publish({ "sw.js": read("sw.js").toString() + "\n// r" + D + "\n", "data/phone-edits.json": ser({ [U5.id]: { activation: "needs_activation" } }) });
    site.delay = { "sw.js": D };
    const li11 = await openRow(C);
    await check();
    const newer11 = offersWith({}, [{ id: "test/zqx-r" + D, card: "U.S. Bank", merchant: "Zqxr" + D + " Shop", category: "Clothing & Jewelry", bonus: "5% back", channel: "online" }]);
    site.publish({ "data/offers.json": newer11 }); hub.offersSha = gitSha(Buffer.from(newer11)); site.delay["data/offers.json"] = O;
    await li11.locator("button", { hasText: "Mark activated" }).click();
    await waitBar(/Deploying|Not saved/).catch(() => {});
    const saved11 = await bar();
    await page.waitForTimeout(5000);
    site.delay = {};
    const t = Date.now();
    const r = await page.reload({ timeout: 15000 }).then(() => "loaded in " + (Date.now() - t) + " ms", e => "hung: " + e.message.split("\n")[0]);
    ok(/Deploying/.test(saved11) && /^loaded/.test(r), "refused save during a worker update (sw.js after " + D + " ms, offers.json after " + O + " ms): saved, and the next open " + r);
  }

  // 12. The off switch: sw.js deployed with ON = false deletes the saved copy and unregisters on the next open,
  // also when the same deploy changes data.
  console.log("-- 12. off switch");
  site.publish({ "sw.js": read("sw.js").toString().replace(/^var ON = true;$/m, "var ON = false;"), "data/phone-edits.json": "{}\n" });
  ok(site.over["sw.js"].includes("var ON = false;"), "test sw.js has the switch off");
  // The tab only comes back on screen (no page load): its check, then the update after it, installs the off worker.
  const swReqs = site.log.filter(p => p === "sw.js").length;
  await page.evaluate(() => { const n = Date.now; Date.now = () => n() + 3600000; document.dispatchEvent(new Event("visibilitychange")); });
  const leftNow = () => page.evaluate(async () => ({ regs: (await navigator.serviceWorker.getRegistrations()).length, caches: (await caches.keys()).filter(k => /^cardselector-copy-/.test(k)) }));
  let left = await leftNow();
  for (let i = 0; i < 120 && (left.regs || left.caches.length); i++) { await page.waitForTimeout(250); left = await leftNow(); }
  ok(site.log.filter(p => p === "sw.js").length > swReqs, "coming back on screen asked for sw.js after the check");
  ok(!left.regs && !left.caches.length, "off (tab only came back on screen): saved copy deleted and the worker unregistered (" + JSON.stringify(left) + ")");
  await page.goto(base());
  await page.waitForFunction(() => /active offers loaded/.test(document.body.innerText) || document.querySelector("#main li.offer"), null, { timeout: 30000 });
  const offRows = await search("pizza");
  const offHeader = await page.evaluate(() => fetch("data/offers.json").then(r => r.headers.get("X-Saved-Copy")));
  ok(offRows.length > 5 && offHeader === null && !(await page.evaluate(() => navigator.serviceWorker.controller)), "off: the next open loads from the network and works (" + offRows.length + " rows)");

  // 13. merchant-locations.json: in the saved set, swapped in on its own, used offline; a set saved by a worker that
  // predates the file opens with no location merges until the new worker's set brings it.
  console.log("-- 13. merchant locations");
  const locOffers = offersWith({}, [{ id: "test/zqxloc", card: "U.S. Bank", merchant: "Zqxloc Pizza", category: "Dining", bonus: "5% back", channel: "in_store" },
    { id: "test/zqxloc-nb", card: "U.S. Bank", merchant: "Zqxloc Pizza - Newport Beach", category: "Dining", bonus: "7% back", channel: "in_store" }]);
  const grouping = ser({ groups: { "Zqxloc Pizza": ["Zqxloc Pizza - Newport Beach"] } });
  const TWO = JSON.stringify(["Zqxloc Pizza", "Zqxloc Pizza - Newport Beach"]), ONE = JSON.stringify(["Zqxloc Pizza"]);
  const locView = async () => {
    const rows = await search("zqxloc");
    const names = await page.$$eval("#use .usemname, #use .useat", es => es.map(e => e.textContent.replace(/:\s*$/, "").replace(/^At /, "")).sort());
    return { names: JSON.stringify(names), n: await page.evaluate(() => window.__locations), rows: rows.filter(r => !r.gone).length };
  };
  const noGroups = '{ "groups": {} }\n'; // this section's own starting state, whatever groups are deployed
  await fresh({ over: { "data/offers.json": locOffers, "data/merchant-locations.json": noGroups } });
  st = await copy();
  let lv = await locView();
  ok(st.locs === noGroups, "the saved set holds merchant-locations.json as deployed (" + JSON.stringify(st.locs) + ")");
  ok(lv.names === TWO && lv.n === 0 && lv.rows === 2, "empty locations file: Zqxloc Pizza and its - Newport Beach name are two merchants (" + lv.names + ")");
  const sw13 = await page.evaluate(() => window.__swaps || 0);
  site.publish({ "data/merchant-locations.json": grouping });
  let n13 = site.log.length;
  const r13 = await check();
  const asked13 = site.log.slice(n13).filter(p => /^(data|js)\/|^index\.html$/.test(p));
  lv = await locView();
  ok(r13.status === "updated" && JSON.stringify(asked13) === JSON.stringify(["data/merchant-locations.json"]) && (await copy()).locs === grouping,
    "a deploy changing only merchant-locations.json: only it is downloaded, into a new set (" + asked13.join(", ") + ")");
  ok(await page.evaluate(() => window.__swaps) === sw13 + 1 && lv.names === ONE && lv.n === 1 && lv.rows === 2,
    "the swap of that file alone re-groups: one merchant, both offers still listed (" + lv.names + ", " + lv.rows + " rows)");
  const port13 = site.port;
  await site.stop();
  await page.goto(base()).catch(() => {});
  await page.waitForFunction(() => window.__copyLast, null, { timeout: 30000 });
  lv = await locView();
  ok(lv.names === ONE && lv.n === 1 && lv.rows === 2, "offline first load from the copy: grouped as online (" + lv.names + ")");
  await site.start(port13);

  // A worker that predates the file (main's sw.js: no merchant-locations.json in DATA) saved the set.
  const oldSw = read("sw.js").toString().replace(', "data/merchant-locations.json"', "");
  ok(oldSw !== read("sw.js").toString(), "test sw.js without merchant-locations.json in DATA");
  await fresh({ over: { "sw.js": oldSw, "data/offers.json": locOffers, "data/merchant-locations.json": grouping } });
  let n13b = site.log.length;
  await open(true);
  const asked13b = site.log.slice(n13b).filter(p => /^data\//.test(p));
  st = await copy();
  lv = await locView();
  ok(st && st.locs === null && lv.names === ONE, "older saved set without the file, online: the file comes from the network and groups (" + lv.names + ")");
  ok(JSON.stringify(asked13b) === JSON.stringify(["data/merchant-locations.json"]), "older saved set, online: offers.json and the rest still open from the copy, only the missing file is fetched (" + asked13b.join(", ") + ")");
  await site.stop();
  await page.goto(base()).catch(() => {});
  await page.waitForFunction(() => window.__copyLast, null, { timeout: 30000 });
  lv = await locView();
  ok(lv.names === TWO && lv.n === 0 && lv.rows === 2 && (await search("pizza")).length > 5, "older saved set without the file, offline: the page opens from the copy with no location merges (" + lv.names + ")");
  await site.start(port13);
  // A swap from such a set still goes in (the missing file means no merges).
  site.publish({ "data/offers.json": offersWith({}, [{ id: "test/zqxloc-old", card: "U.S. Bank", merchant: "Zqxloc Oldset", category: "Clothing & Jewelry", bonus: "5% back", channel: "online" }]) });
  await check();
  ok((await copy()).locs === null && (await search("zqxloc oldset")).length === 1, "a swap from a set without the file goes in");
  // The deploy of the new sw.js: its first complete set brings the file, and the page groups.
  site.publish({ "sw.js": read("sw.js").toString(), "data/offers.json": locOffers });
  await open(true);
  for (let i = 0; i < 20 && (await copy()).locs !== grouping; i++) { await page.waitForTimeout(250); await check(); }
  lv = await locView();
  ok((await copy()).locs === grouping && lv.names === ONE && lv.n === 1, "the new worker's set brings merchant-locations.json and the page groups (" + lv.names + ")");

  await ctx.close();
  await browser.close();
  await site.stop();
  console.log(failed ? failed + " check(s) failed" : "All offline checks passed");
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exit(1); });

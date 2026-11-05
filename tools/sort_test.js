// Headless sort checks at phone width (390 x 844), run against the site/ folder:
//   node tools/sort_test.js
// Needs Playwright (npm i playwright). CHROMIUM_PATH picks a browser binary if Playwright's own isn't installed.
// The checks use the live data where they can; some add test-only offers in the browser (a Shell offer for
// "shell", and Shell, Shelly, Bombshell Sportswear, BP and NBPure for the shell / bp whole-word headline check).
// Nothing is written to the data files.
const http = require("http"), fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const { chromium } = require("playwright");
const SITE = path.join(__dirname, "../site");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

let failed = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) failed++; };
const skip = m => console.log("SKIP " + m);

// Same tiers as the page's Best offer: definite % (5), "Up to" % (4), $ (3), "Up to $" (2), other (1), discounts last.
function rank(text) {
  const s = text.toLowerCase(), up = /^\s*up to\b/.test(s);
  let m;
  if (/^\s*save\b/.test(s)) return (m = /(\d+(?:\.\d+)?)\s*%/.exec(s)) ? [0.6, +m[1]] : (m = /\$\s*(\d[\d,]*(?:\.\d+)?)/.exec(s)) ? [0.4, +m[1].replace(/,/g, "")] : [0, 0];
  if ((m = /(\d+(?:\.\d+)?)\s*%/.exec(s))) return [up ? 4 : 5, +m[1]];
  if ((m = /earn\s*\$\s*(\d[\d,]*(?:\.\d+)?)/.exec(s)) || (m = /\$\s*(\d[\d,]*(?:\.\d+)?)/.exec(s))) return [up ? 2 : 3, +m[1].replace(/,/g, "")];
  return [1, 0];
}
const spaced = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// Whole-word match of a merchant name, as the page's wholeWordName(): apostrophes ignored, a trailing "s" allowed
// on either side ("charley" hits Charley's and Charleys), nothing looser.
const wordForm = s => spaced(s.replace(/['\u2018\u2019\u02bc`\u00b4]/g, ""));
// strict = exact words only (no "s" rule).
const sameWord = (a, b, strict) => !!a && !!b && (a === b || (!strict && (a === b + "s" || b === a + "s")));
function whole(name, query, strict) {
  const ws = wordForm(name).split(" "), words = wordForm(query).split(" "), qc = words.join("");
  if (words.every(w => ws.some(x => sameWord(w, x, strict)))) return true;
  for (let i = 0; i < ws.length; i++) for (let j = i, acc = ""; j < ws.length && acc.length < qc.length; j++) { acc += ws[j]; if (sameWord(acc, qc, strict)) return true; }
  return false;
}
// A row's names for whole-word matching, as the page's containerNames(): its merchant, its aliases and, for an
// approved location member, its group's name.
const wholeRow = (r, query, strict) => r.names.some(n => whole(n, query, strict));
// Whole-word grouping, as the page's wholeLevel(): the matches with the "s" rule when they are 1 to 3 merchants
// (merchant identity as the page has it: the container key, so an approved location and its group are one
// merchant); when more than 3, the exact-word matches when those are 1 to 3; else none.
// Returns false (no grouping) or the strict flag to use. `rows` must be the full result list.
function grouped(rows, query) {
  if (!query) return false;
  const count = strict => new Set(rows.filter(r => wholeRow(r, query, strict)).map(r => r.ck)).size;
  const n = count(false);
  if (n >= 1 && n <= 3) return { strict: false };
  if (n > 3) { const m = count(true); if (m >= 1 && m <= 3) return { strict: true }; }
  return false;
}
// Container-aware order check: the rows inside each merchant container follow key() (lexicographic, smaller first),
// and containers rank by their first (best) row. Returns the index of the first row out of order, or -1.
function orderBreak(rows, key) {
  const less = (a, b) => { for (let k = 0; k < a.length; k++) { if (a[k] < b[k]) return -1; if (a[k] > b[k]) return 1; } return 0; };
  let head = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], prev = rows[i - 1];
    if (!prev || prev.ci !== r.ci) { if (head && less(key(head), key(r)) > 0) return i; head = r; }
    else if (less(key(prev), key(r)) > 0) return i;
  }
  return -1;
}
// Best offer order: (whole-word matches first, when grouped), then tier high to low, then amount high to low.
// A percent offer's amount is its row total (the big number).
function bestOrderBreak(rows, query) {
  const g = grouped(rows, query);
  const amt = r => { const k = rank(r.bonus); return (k[0] === 5 || k[0] === 4) && r.total != null ? r.total : k[1]; };
  return orderBreak(rows, r => [g && !wholeRow(r, query, g.strict) ? 1 : 0, -rank(r.bonus)[0], -amt(r)]);
}
// Each merchant container's first row, in container order.
const heads = rows => rows.filter((r, i) => !i || rows[i - 1].ci !== r.ci);
// Every offer row exactly once, every container's rows together (a container never split or repeated).
const containersWhole = rows => new Set(rows.map(r => r.id)).size === rows.length &&
  heads(rows).length === new Set(rows.map(r => r.ci)).size && new Set(heads(rows).map(r => r.ck)).size === heads(rows).length;
const label = r => r.merchant + " | " + r.card + " | " + r.bonus;
// The result rows in page order (run in the page): each offer row of every merchant container under `sel`, with the
// offer it shows (window.__offerOf), its container (ci: its index, ck: its key, cname: its name) and its big number
// (total: the row total of a percent offer). Main's flat rows (no containers, for the base app.js) read as before.
function listRows(sel) {
  const out = [];
  document.querySelectorAll(sel + " > li.mc, " + sel + " > li.offer").forEach((c, ci) => {
    const flat = c.matches("li.offer");
    (flat ? [c] : [...c.querySelectorAll("li.offer")]).forEach(li => {
      const o = window.__offerOf ? window.__offerOf(li.dataset.oid) : null;
      const big = li.querySelector(".obig"), pctBig = big && /([\d.]+)%$/.exec(big.textContent);
      const merchant = o ? o.merchant : li.querySelector(".merchant").textContent;
      const old = flat && li.querySelector(".bonus .total");
      out.push({ id: li.dataset.oid, merchant, card: li.querySelector(".mcard").textContent,
        bonus: o ? o.bonus : li.querySelector(".bonus").firstChild.textContent,
        total: flat ? (old ? +/([\d.]+)%/.exec(old.textContent)[1] : null) : pctBig ? +pctBig[1] : null,
        totalText: flat ? (old ? old.textContent : "") : (li.querySelector(".obreak") || {}).textContent || "",
        text: li.innerText, gone: li.classList.contains("gone"), loc: (li.querySelector(".loctag") || {}).textContent || null,
        ci, ck: flat ? merchant : c.dataset.ck.replace(/^[^:]*:/, ""), cname: flat ? merchant : c.querySelector(".mcname").textContent,
        names: [merchant].concat(o && o.aliases || [], !flat && li.querySelector(".loctag") ? [c.querySelector(".mcname").textContent] : []) });
    });
  });
  return out;
}

(async () => {
  const server = http.createServer((req, res) => {
    const p = path.join(SITE, decodeURIComponent(req.url.split("?")[0]).replace(/\/$/, "/index.html"));
    if (!p.startsWith(SITE) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" });
    fs.createReadStream(p).pipe(res);
  }).listen(0);
  const base = "http://127.0.0.1:" + server.address().port + "/";
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  // Service workers blocked: the saved copy (sw.js) would answer requests before page.route sees them.
  let page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  const rows = () => page.evaluate(listRows, "#main > ul.results");
  // Merchants the per-merchant "Use:" headline names (none for the category headline).
  const useNames = () => page.$$eval("#use .usemname, #use .useat", es => es.map(e => e.textContent.replace(/:\s*$/, "").replace(/^At /, "")).sort());
  // The answer card's text, without its Any / In store / Online selector and its Card rates here disclosure.
  const useText = () => page.$eval("#use", e => e.hidden ? "" : [...e.children].filter(c => !c.matches(".chansel, details.rates")).map(c => c.innerText).join("\n"));
  const moreAll = async () => { for (;;) { const b = page.locator("#main > button.more:visible"); if (!(await b.count())) return; await b.click(); } };
  // Fresh page, Best offer unless told otherwise, then the filters and the search.
  const setup = async (q, o = {}) => {
    await page.goto(base);
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.goto(base);
    await page.waitForFunction(() => /active offers loaded/.test(document.body.innerText));
    if (await page.locator("#ftoggle").isVisible()) await page.click("#ftoggle");
    await page.selectOption("#sort", o.sort || "best");
    const pick = async (box, text) => page.locator(box + " button", { hasText: new RegExp("^" + text) }).first().click();
    if (o.cat) await pick("#cats", o.cat);
    if (o.card) await pick("#cards", o.card);
    if (o.act) await pick("#acts", o.act);
    if (o.chan) await pick("#chans", o.chan);
    await page.fill("#q", q);
    await page.waitForTimeout(100);
    if (o.all) await moreAll();
    return rows();
  };

  // 1. "pizza": Round Table Pizza 10% above 1.92%, the same order with and without the Dining filter.
  // Many merchants match "pizza" as a whole word, so it is plain reward order (Greco's New York Pizzeria 5% above 4%).
  const pz = await setup("pizza", { all: true }), pzD = await setup("pizza", { cat: "Dining", all: true });
  ok(pz.length > 0 && !grouped(pz, "pizza") && bestOrderBreak(pz, "pizza") === -1 && containersWhole(pz),
    "pizza, Best offer: plain reward order (inside each merchant container and across them), no whole-word grouping (" + pz.length + " rows, " + heads(pz).length + " merchants)");
  ok(JSON.stringify(pz.map(label)) === JSON.stringify(pzD.map(label)), "pizza: same order with and without the Dining filter");
  // Merchant containers rank by their best row: compared on each container's first row.
  const pzh = heads(pz);
  const rt = pzh.findIndex(r => r.cname === "Round Table Pizza"), low = pzh.findIndex(r => /^1\.92%/.test(r.bonus));
  if (rt === -1 || low === -1) skip("pizza: Round Table Pizza or a merchant led by a 1.92% offer is no longer active");
  else ok(rt < low, "pizza: the Round Table Pizza container (" + (rt + 1) + ") above one led by 1.92% (" + (low + 1) + ")");
  const gr = pzh.findIndex(r => /^Greco's New York Pizzeria$/.test(r.cname) && /^5%/.test(r.bonus)), p4 = pzh.findIndex(r => /^4%/.test(r.bonus));
  if (gr === -1 || p4 === -1) skip("pizza: Greco's New York Pizzeria led by 5%, or a merchant led by 4%, is no longer active");
  else ok(gr < p4, "pizza: Greco's New York Pizzeria 5% (container " + (gr + 1) + ") above the first led by 4% (" + (p4 + 1) + ")");

  // 2. "shell": a Shell offer above Bombshell Sportswear and Shelly, even with a smaller reward.
  await page.route("**/data/offers.json", async route => {
    const d = await (await route.fetch()).json();
    d.offers.push({ id: "test/shell", card: "Capital One", merchant: "Shell", category: "Auto & Gas", bonus: "1% back",
      expires: null, expires_text: null, activation: "none_shown", channel: "pay_at_pump", spend_cap: null, minimum_spend: null,
      fine_print: null, other_details: [], last_read: "2026-10-18", first_seen: "2026-10-18", status: "active", status_since: "2026-10-18" });
    await route.fulfill({ json: d });
  });
  const sh = await setup("shell");
  await page.unroute("**/data/offers.json");
  ok(sh.length > 0 && sh[0].merchant === "Shell" && grouped(sh, "shell"), "shell: one whole-word merchant, so the Shell offer is first (" + sh.map(r => r.merchant).join(", ") + ")");
  ok(bestOrderBreak(sh, "shell") === -1, "shell: whole-word Shell, then the partial matches in reward order");
  if (!sh.some(r => /^(Bombshell Sportswear|Shelly)$/.test(r.merchant))) skip("shell: Bombshell Sportswear and Shelly are no longer active");

  // 3. Needs activation, Highest percent: every definite percent above every "Up to" percent.
  const na = await setup("", { act: "Needs activation", sort: "percent", all: true });
  // Percent first (no percent last), definite above "Up to", then the percent high to low: inside each container and
  // across containers (by their first row).
  const pctKey = r => { const m = /(\d+(?:\.\d+)?)\s*%/.exec(r.bonus), sv = /^\s*save\b/i.test(r.bonus); return m && !sv ? [0, /^\s*up to\b/i.test(r.bonus) ? 1 : 0, -m[1]] : [1, 0, 0]; };
  const nah = heads(na), pct = nah.filter(r => pctKey(r)[0] === 0);
  const firstUp = pct.findIndex(r => /^\s*up to\b/i.test(r.bonus)), lastDef = pct.map(r => !/^\s*up to\b/i.test(r.bonus)).lastIndexOf(true);
  ok(pct.length > 0 && (firstUp === -1 || lastDef < firstUp) && orderBreak(na, pctKey) === -1,
    "Needs activation, Highest percent: definite percents above \"Up to\" percents, in each container and across them (" + na.length + " rows, " + nah.length + " merchants)");
  const yt = nah.findIndex(r => /^50%/.test(r.bonus)), up50 = nah.findIndex(r => /^up to (\d+)/i.test(r.bonus) && +/^up to (\d+)/i.exec(r.bonus)[1] >= 50);
  if (yt === -1 || up50 === -1) skip("Needs activation: no definite 50% or no \"Up to 50%\"-or-more offer is active");
  else ok(yt < up50, "Needs activation, Highest percent: a merchant led by a definite 50% (" + (yt + 1) + ") above one led by \"Up to\" 50%+ (" + (up50 + 1) + ")");
  const nb = await setup("", { act: "Needs activation" });
  ok(bestOrderBreak(nb, "") === -1, "Needs activation, Best offer: first page in tier order (definite % before \"Up to\" %)");
  const nr = await setup("", { act: "Needs activation", sort: "rate", all: true });
  const nrh = heads(nr), ru = nrh.findIndex(r => /^\s*up to\b.*%/i.test(r.bonus)), rd = nrh.map(r => /\d\s*%/.test(r.bonus) && !/^\s*(up to|save)\b/i.test(r.bonus)).lastIndexOf(true);
  ok(ru !== -1 && rd !== -1 && rd < ru, "Needs activation, Best rate: merchants led by definite percents (last at " + (rd + 1) + ") above those led by \"Up to\" percents (first at " + (ru + 1) + ")");

  // Ties break by merchant A to Z, then card, in every reward sort: 021 Originals and 1Password (both 30%) keep
  // one order in Best offer and Highest percent.
  const tie = (list, m) => list.findIndex(r => r.merchant === m);
  const [b021, b1p, p021, p1p] = [tie(nb, "021 Originals"), tie(nb, "1Password"), tie(na, "021 Originals"), tie(na, "1Password")];
  if ([b021, b1p, p021, p1p].includes(-1)) skip("ties: 021 Originals or 1Password is not on the Needs activation lists");
  else ok((b021 < b1p) === (p021 < p1p), "ties: 021 Originals / 1Password in the same order in Best offer and Highest percent");

  // 4. Show more continues the same order with no repeats (a search with more than 60 merchants: Show more pages by
  // merchant container).
  let cq = null, cf0 = null;
  for (const q of ["bar", "grill", "house", "cafe"]) { cf0 = await setup(q); cq = q; if (await page.locator("#main > button.more:visible").count()) break; }
  await moreAll();
  const cf = await rows();
  ok(cf.length > cf0.length, cq + ": Show more added rows (" + cf0.length + " -> " + cf.length + ")");
  ok(heads(cf0).length === 60 && containersWhole(cf), cq + ": the first page is 60 merchant containers, none split (" + heads(cf0).length + " containers, " + cf0.length + " rows)");
  ok(JSON.stringify(cf.slice(0, cf0.length).map(label)) === JSON.stringify(cf0.map(label)), cq + ": the first page is unchanged after Show more");
  ok(new Set(cf.map(r => r.id)).size === cf.length, cq + ": no repeated rows");
  ok(bestOrderBreak(cf, cq) === -1, cq + ": Best offer order holds across the pages");

  // 5. Save offers rank last under Best offer (Bank of America has them).
  const bo = await setup("", { card: "Bank of America", all: true });
  // Saves last: in each container after its rewards, and merchants led by a Save after every other merchant.
  const boh = heads(bo), firstSave = boh.findIndex(r => /^\s*save\b/i.test(r.bonus)), saves = boh.filter(r => /^\s*save\b/i.test(r.bonus)).length;
  if (firstSave === -1) skip("Bank of America: no Save offers are active");
  else ok(firstSave === boh.length - saves && bestOrderBreak(bo, "") === -1, "Bank of America, Best offer: the " + saves + " merchants led by a Save offer last, Save Now at the very end, Saves last inside each container (" + bo.length + " rows)");

  // 6. Best offer ranks percent offers by total: offer + what its card earns there.
  const near = (a, b) => a != null && Math.abs(a - b) < 0.006;
  const rtb = await setup("round table");
  const at = (list, card, bonus) => list.findIndex(r => r.merchant === "Round Table Pizza" && r.card === card && bonus.test(r.bonus));
  const [fr, fx, sm, ba] = [at(rtb, "Chase Freedom", /^10%/), at(rtb, "Chase Freedom Flex", /^10%/), at(rtb, "Smartly / Cash+", /^10%/), at(rtb, "Customized Cash / Unlimited Cash", /^10%/)];
  if ([fr, fx, sm, ba].includes(-1)) skip("round table: a 10% Round Table Pizza offer is no longer active on Freedom, Freedom Flex, U.S. Bank or BofA");
  else {
    ok(near(rtb[fr].total, 15) && near(rtb[fx].total, 15) && near(rtb[sm].total, 14) && near(rtb[ba].total, 12.63),
      "round table: totals Freedom " + rtb[fr].total + ", Freedom Flex " + rtb[fx].total + ", Smartly " + rtb[sm].total + ", BofA " + rtb[ba].total + " (want 15, 15, 14, 12.63)");
    ok(Math.max(fr, fx) < sm && sm < ba, "round table: Freedom and Freedom Flex 15% above Smartly 14% above Bank of America 12.63%");
  }
  const fb = n => pz.findIndex(r => r.merchant === "Fresh Brothers Pizza" && r.card === n);
  const [fcc, fdc] = [fb("Citi Custom Cash"), fb("Citi Double Cash")];
  if (fcc === -1 || fdc === -1) skip("pizza: Fresh Brothers Pizza is no longer on both Citi cards");
  else ok(near(pz[fcc].total, 10) && near(pz[fdc].total, 7) && fcc < fdc,
    "pizza: Fresh Brothers on Custom Cash (" + pz[fcc].total + "%, row " + (fcc + 1) + ") above Double Cash (" + pz[fdc].total + "%, row " + (fdc + 1) + ")");
  // Two test-only Bank of America offers: the 5.25% Customized Cash online shopping rate counts online-only.
  await page.route("**/data/offers.json", async route => {
    const d = await (await route.fetch()).json();
    const mk = (id, merchant, channel) => ({ id, card: "Bank of America", merchant, category: "Clothing & Jewelry", bonus: "4% Cash back",
      expires: null, expires_text: null, activation: "already_activated", channel, spend_cap: null, minimum_spend: null,
      fine_print: null, other_details: [], last_read: "2026-10-18", first_seen: "2026-10-18", status: "active", status_since: "2026-10-18" });
    d.offers.push(mk("test/zqx-online", "Zqxtest Online Shop", "online"), mk("test/zqx-store", "Zqxtest Store", "in_store"));
    await route.fulfill({ json: d });
  });
  const zq = await setup("zqxtest");
  await page.unroute("**/data/offers.json");
  const zo = zq.find(r => r.merchant === "Zqxtest Online Shop"), zs = zq.find(r => r.merchant === "Zqxtest Store");
  ok(zo && near(zo.total, 9.25) && /Customized Cash/.test(zo.totalText), "BofA online-only offer: 4% + 5.25% online shopping = " + (zo && zo.totalText));
  ok(zs && near(zs.total, 6.63) && /Unlimited Cash/.test(zs.totalText), "BofA in-store offer: no online rate, 4% + Unlimited Cash 2.625% = " + (zs && zs.totalText));

  // 7. Whole-word headline: apostrophes and a trailing "s" don't split a merchant off. "charley", "charleys" and
  // "charley's" name the same merchants (Charley's Cheesesteaks and Charleys Philly Steaks); "charl" matches more
  // than 3 merchants, so it gets the category headline and drops neither.
  const CH = ["Charley's Cheesesteaks", "Charleys Philly Steaks"];
  const chRows = await setup("charl", { all: true });
  if (!CH.every(m => chRows.some(r => r.merchant === m))) skip("charley: Charley's Cheesesteaks or Charleys Philly Steaks is no longer active");
  else {
    const chUse = await useNames();
    ok(!chUse.length || CH.every(m => chUse.includes(m)), "charl: headline drops neither Charley merchant (" + (chUse.join(", ") || "category headline") + ")");
    const got = {};
    for (const q of ["charley", "charleys", "charley's"]) { await setup(q); got[q] = await useNames(); }
    ok(Object.values(got).every(v => JSON.stringify(v) === JSON.stringify(CH)),
      "charley / charleys / charley's: same headline merchants, both Charleys (" + Object.entries(got).map(([q, v]) => q + ": " + v.join(" + ")).join("; ") + ")");
  }
  // The "s" rule never pushes a search past 3 merchants: "book" hits more than 3 with it (Books A Million, Better
  // World Books...), so the exact-word stores name the headline (Book Outlet) and lead the Best offer rows.
  const bk = await setup("book", { all: true }), bkUse = await useNames();
  if (!bk.some(r => r.merchant === "Book Outlet")) skip("book: Book Outlet is no longer active");
  else {
    ok(bkUse.includes("Book Outlet") && bkUse.every(n => whole(n, "book", true)), "book: headline names the exact-word stores (" + (bkUse.join(", ") || "category headline") + ")");
    const gb = grouped(bk, "book");
    ok(gb && gb.strict && bestOrderBreak(bk, "book") === -1, "book: exact-word stores first in Best offer (" + bk.slice(0, 3).map(r => r.merchant).join(", ") + ")");
  }
  // Nothing looser: "shell" never names Shelly or Bombshell Sportswear, "bp" never names NBPure.
  // Test-only offers with no end date: the whole-word merchant (the saved BP offers are Citi countdown estimates,
  // and once they end "bp" gets the category headline, whose "Top offer" hint may name NBPure) and the partial
  // matches, so the check never depends on today's date or on what the last refresh kept.
  const looseOffers = [["Shell", "Auto & Gas", "1% back", "pay_at_pump"], ["Shelly", "Electronics & Software", "6% back", "online"],
    ["Bombshell Sportswear", "Clothing & Jewelry", "Spend $20, earn $10", "online"], ["BP", "Auto & Gas", "$5 back", "pay_at_pump"],
    ["NBPure", "Beauty & Personal Care", "10% back", "online"]].map(([merchant, category, bonus, channel]) => ({
    id: "test/loose-" + merchant.toLowerCase().replace(/\W+/g, "-"), card: "Capital One", merchant, category, bonus,
    expires: null, expires_text: null, activation: "none_shown", channel, spend_cap: null, minimum_spend: null,
    fine_print: null, other_details: [], last_read: "2026-10-18", first_seen: "2026-10-18", status: "active", status_since: "2026-10-18" }));
  await page.route("**/data/offers.json", async route => {
    const d = await (await route.fetch()).json();
    d.offers.push(...looseOffers);
    await route.fulfill({ json: d });
  });
  for (const [q, want, bad] of [["shell", "Shell", /Shelly|Bombshell/], ["bp", "BP", /NBPure/]]) {
    const r = await setup(q), names = await useNames(), t = await useText();
    ok(names.includes(want) || (!names.length && /^Ready now:/.test(t)), q + ": headline is the whole-word " + want + " line (" + (names.join(", ") || t.split("\n")[0]) + ")");
    ok(!names.some(n => bad.test(n)) && !bad.test(t), q + ": headline leaves out " + bad.source.replace(/\|/g, " and ") + " (" + (names.join(", ") || t.split("\n")[0]) + ")");
    const part = [...new Set(r.filter(x => bad.test(x.merchant)).map(x => x.merchant))];
    ok(part.length && part.every(m => !whole(m, q)), q + ": " + (part.join(", ") || "no partial match in the results") + " not whole-word matches");
  }
  await page.unroute("**/data/offers.json");

  // Bonus rows sit in the answer card's "Card rates here", which starts collapsed; opened, they work as before.
  const openRates = async () => {
    const st = await page.evaluate(() => { const d = document.querySelector("#use details.rates"); return d ? d.open : null; });
    if (st === false) await page.click("#use details.rates > summary");
    await page.waitForTimeout(50);
    return st;
  };
  // Bonus rows open and close, closed on every render. Closed, one line of whole entries then "+N" for the rest
  // (entries left off plus the ones below the everyday rate); open, every entry on its own line, then the notes.
  const bonusRows = () => page.$$eval("#use .bonusrows > details.bonusrow", ds => ds.map(d => {
    const line = d.querySelector(".bline"), lr = line.getBoundingClientRect();
    const shown = [...line.querySelectorAll(".bent")].filter(e => getComputedStyle(e).display !== "none");
    const more = line.querySelector(".bplus"), moreOn = getComputedStyle(more).display !== "none";
    const n = moreOn ? +/^\+(\d+)$/.exec(more.firstChild.textContent)[1] : 0;
    const sum = d.querySelector("summary").getBoundingClientRect();
    return { open: d.open, lead: d.querySelector(".bhead").textContent, shown: shown.length, n, total: d.querySelectorAll(".blist > li").length,
      // Against the line's own edge and the screen's (a line wider than the screen would hide the cut).
      cut: shown.concat(moreOn ? [more] : []).filter(e => e.getBoundingClientRect().right > Math.min(lr.right, document.documentElement.clientWidth - 16) + 0.5).map(e => e.textContent),
      bodyHidden: !d.querySelector(".bbody").checkVisibility() && !d.querySelector(".bnote").checkVisibility(), sumH: sum.height, sumW: Math.round(sum.width), rowW: Math.round(d.getBoundingClientRect().width) };
  }));
  for (const w of [390, 360]) {
    await page.setViewportSize({ width: w, height: 844 });
    const seen = [];
    for (const [q, o] of [["round table"], ["pizza"], ["shell"], ["costco gas"], ["", { cat: "Dining" }], ["", { cat: "Travel" }]]) {
      await setup(q, o);
      await page.waitForTimeout(100);
      const name = (q || o.cat) + " @" + w;
      const was = await openRates();
      if (was !== null) ok(was === false, name + ": Card rates here starts collapsed");
      const br = await bonusRows();
      if (!br.length) { skip(name + ": no bonus row"); continue; }
      seen.push(name);
      ok(br.every(r => !r.open && r.bodyHidden), name + ": " + br.length + " bonus row(s) render closed");
      ok(br.every(r => !r.cut.length), name + ": closed line cuts off no name" + (br.some(r => r.cut.length) ? " (cut: " + br.map(r => r.cut.join(", ")).join("; ") + ")" : ""));
      ok(br.every(r => r.shown + r.n === r.total && (r.n > 0 || r.shown === r.total)),
        name + ": +N counts every entry not on the line (" + br.map(r => r.shown + " shown +" + r.n + " of " + r.total).join("; ") + ")");
      ok(br.every(r => r.sumH >= 44 && Math.abs(r.sumW - r.rowW) <= 1 && r.rowW <= w - 32), name + ": summary is a full-width 44px+ tap target (" + br.map(r => r.sumW + "x" + r.sumH).join("; ") + ")");
      if (q === "round table" || o) {
        await page.locator("#use details.bonusrow > summary").first().click();
        const op = await page.$eval("#use details.bonusrow", d => ({ open: d.open,
          lis: [...d.querySelectorAll(".blist > li")].map(li => li.checkVisibility() ? li.textContent : null),
          notes: [...d.querySelectorAll(".bnote")].map(n => n.checkVisibility() ? n.textContent : null),
          lineHidden: !d.querySelector(".bline").checkVisibility() }));
        ok(op.open && op.lineHidden && op.lis.length === br[0].total && op.lis.every(Boolean) && op.notes.length && op.notes.every(Boolean) &&
          op.notes.some(n => /^Likely, not certain/.test(n)),
          name + ": opening the first row shows all " + op.lis.length + " entries and " + op.notes.length + " notes, line 2 hidden");
        await page.locator("#use details.bonusrow > summary").first().click();
        ok(!(await page.$eval("#use details.bonusrow", d => d.open)), name + ": tapping again closes it");
      }
    }
    ok(seen.length >= 4, "bonus rows checked at " + w + "px (" + seen.join(", ") + ")");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  // The round table row squeezed to 150px refits and still shows only whole names.
  await setup("round table");
  await openRates();
  const fitNarrow = await page.evaluate(() => {
    const d = document.querySelector("#use details.bonusrow"); d.parentNode.style.width = "150px";
    return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => {
      const line = d.querySelector(".bline"), lr = line.getBoundingClientRect();
      const shown = [...line.querySelectorAll(".bent")].filter(e => getComputedStyle(e).display !== "none");
      const more = line.querySelector(".bplus");
      r({ cut: shown.concat([more]).filter(e => getComputedStyle(e).display !== "none" && e.getBoundingClientRect().right > lr.right + 0.5).length,
        shown: shown.length, more: more.firstChild.textContent, total: d.querySelectorAll(".blist > li").length });
    })));
  });
  ok(!fitNarrow.cut && fitNarrow.more === "+" + (fitNarrow.total - fitNarrow.shown), "round table, row squeezed to 150px: refits on resize, no cut name (" + fitNarrow.shown + " shown, " + fitNarrow.more + ")");

  // Headline: one issuer dot before every bold total, for the card it names first; the "Likely" tag ends the last
  // headline line where the old "Likely, not certain" note was, and that sentence is no longer a visible note.
  const headDots = () => page.$$eval("#use .usehead strong", ss => ss.map(s => {
    const d = s.previousElementSibling, m = /^(.*?) (?:\+|up to |\d)/.exec(s.textContent);
    return { text: s.textContent, dot: d && d.classList.contains("idot") ? [...d.classList].find(c => /^i-/.test(c)).slice(2) : null,
      want: m ? window.__issuerOf(m[1]) : "?", dots: s.parentNode.querySelectorAll(".idot").length, strongs: s.parentNode.querySelectorAll("strong").length };
  }));
  const likelyAt = () => page.evaluate(() => {
    const tags = [...document.querySelectorAll("#use .likely")], heads = [...document.querySelectorAll("#use .usehead")];
    const last = heads[heads.length - 1];
    return { n: tags.length, atEnd: !tags.length || (tags[0].parentNode === last && last.lastElementChild === tags[0]),
      visible: tags.length ? tags[0].firstChild.textContent : null, sr: tags.length ? tags[0].querySelector(".sr").textContent : null,
      oldNote: [...document.querySelectorAll("#use .usenote, #use .usesub")].some(e => /^Likely, not certain|^Totals add/.test(e.textContent)) };
  });
  await setup("round table");
  const rtDots = await headDots();
  ok(rtDots.length >= 1 && rtDots.every(x => x.dot && x.dot === x.want && x.dots === x.strongs),
    "round table: exactly one dot per bold total, matching its first card (" + rtDots.map(x => x.text + " -> " + x.dot).join("; ") + ")");
  for (const [q, want] of [["round table", true], ["pizza", true], ["costco gas", true], ["jamba", true], ["shell", false], ["zzqx", false]]) {
    await setup(q);
    const la = await likelyAt(), hd = await headDots();
    ok(la.n === (want ? 1 : 0) && la.atEnd && !la.oldNote && (!want || (la.visible === "Likely" && /^, not certain: how the merchant codes/.test(la.sr))),
      q + ": " + (want ? "one \"Likely\" tag at the end of the last headline line" : "no \"Likely\" tag") + ", no old note (" + JSON.stringify(la) + ")");
    ok(hd.every(x => x.dot === x.want && x.dots === x.strongs), q + ": one matching dot per bold total (" + hd.map(x => x.text + " -> " + x.dot).join("; ") + ")");
  }

  // Issuer dots: issuerOf() gives the right issuer for every card and offer-list name in cards.json
  // (card names, offer-list keys, their row names and card lists), and null for a name it doesn't know.
  const WANT = {
    "Freedom": "chase", "Freedom Flex": "chase", "Chase Freedom": "chase", "Chase Freedom Flex": "chase",
    "Smartly": "usb", "Cash+": "usb", "U.S. Bank": "usb", "Smartly / Cash+": "usb",
    "Unlimited Cash": "boa", "Customized Cash": "boa", "Bank of America": "boa", "Customized Cash / Unlimited Cash": "boa",
    "Double Cash": "citi", "Citi Custom Cash": "citi", "Costco Visa": "citi", "Citi Double Cash": "citi",
    "Quicksilver": "cap1", "Discover it": "cap1", "Capital One": "cap1", "Quicksilver / Discover it": "cap1"
  };
  const cj = JSON.parse(fs.readFileSync(path.join(SITE, "data/cards.json"), "utf8"));
  const names = new Set(cj.cards.map(c => c.name));
  for (const [k, l] of Object.entries(cj.offer_lists)) { names.add(k); if (l.row_name) names.add(l.row_name); (l.cards || []).forEach(c => names.add(c)); }
  const probe = [...names, "Mystery Card", "", "Citizens Cash", "Chaser", null];
  const got = await page.evaluate(ns => ns.map(n => window.__issuerOf(n)), probe);
  const wrong = probe.map((n, i) => [n, got[i], n in WANT ? WANT[n] : null]).filter(([, g, w]) => g !== w);
  // A card added to cards.json must get an issuer here too, or its rows would show no dot.
  [...names].filter(n => !(n in WANT)).forEach(n => wrong.push([n, got[probe.indexOf(n)], "a listed issuer (add it to WANT)"]));
  ok(names.size > 0 && !wrong.length, "issuerOf: " + names.size + " cards.json names and 5 unknown names give the right key" +
    (wrong.length ? " (wrong: " + wrong.map(([n, g, w]) => JSON.stringify(n) + " -> " + g + ", want " + w).join("; ") + ")" : ""));

  // Ends soon: with a fixed "today", test-only active offers ending in 0, 1, 2, 7 and 8 days (and one with no
  // date, one already gone) get "Ends today", "Ends tomorrow", "Ends in 2 days", "Ends in 7 days" and nothing,
  // between the activation and channel badges; never on a Recently unavailable row. Estimated Citi dates (a "12d left"
  // countdown) say "about"; a Chase offer with the same countdown text doesn't.
  const mainPage = page;
  const fixedCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  page = await fixedCtx.newPage();
  await page.clock.setFixedTime(new Date(2026, 9, 21, 12, 0, 0));
  const plusDays = n => { const d = new Date(2026, 9, 21 + n); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  const EXP = [["Zzexp Day0", 0, "Ends today"], ["Zzexp Day1", 1, "Ends tomorrow"], ["Zzexp Day2", 2, "Ends in 2 days"],
    ["Zzexp Day7", 7, "Ends in 7 days"], ["Zzexp Day8", 8, null], ["Zzexp Nodate", null, null],
    ["Zzexp Citi0", 0, "Ends about today", "Citi Double Cash", "12d left"], ["Zzexp Citi1", 1, "Ends about tomorrow", "Citi Custom Cash", "12d left"],
    ["Zzexp Citi3", 3, "Ends in about 3 days", "Citi Double Cash", "12d left"], ["Zzexp Citi8", 8, null, "Citi Double Cash", "12d left"],
    ["Zzexp Chase0", 0, "Ends today", "Chase Freedom Flex", "12d left"], ["Zzexp Chase1", 1, "Ends tomorrow", "Chase Freedom Flex", "12d left"],
    ["Zzexp Chase3", 3, "Ends in 3 days", "Chase Freedom Flex", "12d left"]];
  await page.route("**/data/offers.json", async route => {
    const d = await (await route.fetch()).json();
    const mk = (merchant, n, status, card, text) => ({ id: "test/" + merchant.toLowerCase().replace(/ /g, "-"), card: card || "U.S. Bank", merchant, category: "Clothing & Jewelry",
      bonus: "5% cash back", expires: n == null ? null : plusDays(n), expires_text: text || null, activation: "needs_activation", channel: "online",
      spend_cap: null, minimum_spend: null, fine_print: null, other_details: [], last_read: "2026-10-18", first_seen: "2026-10-18",
      status: status || "active", status_since: "2026-10-18" });
    EXP.forEach(([m, n, , card, text]) => d.offers.push(mk(m, n, null, card, text)));
    d.offers.push(mk("Zzexp Gone", 1, "missing"));
    await route.fulfill({ json: d });
  });
  await setup("zzexp");
  const exp = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll("li.offer").forEach(li => {
      const t = li.querySelector(".oterms"), kids = [...t.children], soon = t.querySelector(".soon");
      out[window.__offerOf(li.dataset.oid).merchant] = { gone: li.classList.contains("gone"), text: soon ? soon.textContent : null,
        icon: soon ? !!soon.querySelector("svg.bico[aria-hidden='true'] circle") : null,
        // The terms line: channel first, then the ends-soon note (in place of the end date); the status on the right.
        after: soon ? kids.indexOf(soon) > kids.indexOf(t.querySelector(".chan")) && kids.indexOf(t.querySelector(".chan")) !== -1 : null,
        status: (li.querySelector(".ostat") || {}).textContent || null, ends: /Ends (about )?[A-Z][a-z]{2} \d/.test(t.textContent) };
    });
    return out;
  });
  await page.unroute("**/data/offers.json");
  for (const [m, n, want] of EXP) {
    const x = exp[m];
    ok(x && !x.gone && x.text === want && x.status === "Activate" && (want ? x.icon && x.after && !x.ends : x.ends === (n != null)),
      m + ": " + (want ? "\"" + want + "\" with a clock, after the channel, no plain end date" : "no ends-soon note" + (n != null ? ", its end date instead" : "")) + " (" + JSON.stringify(x) + ")");
  }
  ok(exp["Zzexp Gone"] && exp["Zzexp Gone"].gone && exp["Zzexp Gone"].text === null, "Zzexp Gone (Recently unavailable, ends tomorrow): no ends-soon badge (" + JSON.stringify(exp["Zzexp Gone"]) + ")");
  // The badge is display only: the first 10 rows of 12 searches, on the same fixed day, match the base branch's
  // app.js (BASE_REF, else origin/main, else main, else main fetched from origin), when git can get it. A base
  // without merchant containers lists offers flat, so its order is clustered first: each merchant's offers moved
  // up to its best one, merchants in the order of their best offers (merchant identity as the page has it).
  let baseApp = null, baseRef = null;
  for (const ref of [process.env.BASE_REF, "origin/main", "main"].filter(Boolean)) {
    try { baseApp = execFileSync("git", ["show", ref + ":site/js/app.js"], { cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "ignore"] }); baseRef = ref; break; } catch (e) {}
  }
  // A shallow pull request checkout has neither ref: fetch main's tip once.
  if (!baseApp) {
    try {
      const git = args => execFileSync("git", args, { cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "ignore"] });
      git(["fetch", "--depth=1", "origin", "main"]);
      baseApp = git(["show", "FETCH_HEAD:site/js/app.js"]); baseRef = "origin main (fetched)";
    } catch (e) {}
  }
  const SEARCHES = ["pizza", "grill", "round table", "charley", "book", "shell", "bp", "persian", "costco gas", "levain", "target", "zzqx"];
  if (!baseApp) skip("ends soon: no base app.js in git (set BASE_REF), first-10 order not compared");
  else {
    const diff = [];
    let soonSeen = 0;
    const locs = JSON.parse(fs.readFileSync(path.join(SITE, "data/merchant-locations.json"))).groups;
    // Merchant identity as the page has it (merchantKey: Alibaba and Ali Baba kept apart).
    const mkey = s => { const sp = s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\.(com|net|org)\b/gi, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(), k = sp.replace(/ /g, ""); return k === "alibaba" ? sp.replace(/ /g, "_") : k; };
    const member = {};
    Object.keys(locs).forEach(g => locs[g].forEach(m => { member[mkey(m)] = mkey(g); }));
    const cluster = list => { const by = new Map(); list.forEach(r => { const k = member[mkey(r.merchant)] || mkey(r.merchant); if (!by.has(k)) by.set(k, []); by.get(k).push(r); }); return [...by.values()].flat(); };
    for (const q of SEARCHES) {
      await setup(q, { all: true });
      const mineAll = await rows();
      const mine = mineAll.slice(0, 10).map(r => r.id);
      soonSeen += await page.locator("#main .oterms .soon").count();
      await page.route("**/js/app.js", route => route.fulfill({ body: baseApp, contentType: "text/javascript" }));
      await setup(q, { all: true });
      const base0 = await rows(), flatBase = base0.every((r, i) => r.ci === i);
      const theirs = (flatBase ? cluster(base0) : base0).slice(0, 10).map(r => r.id);
      await page.unroute("**/js/app.js");
      if (new Set(mineAll.map(r => r.id)).size !== mineAll.length || mineAll.length !== base0.length) diff.push(q + " (" + mineAll.length + " rows, base " + base0.length + ")");
      if (JSON.stringify(mine) !== JSON.stringify(theirs)) diff.push(q);
    }
    ok(!diff.length, "ends soon: first 10 rows of " + SEARCHES.length + " searches match " + baseRef + " on 2026-10-21 (" + soonSeen + " ends-soon badges on them)" + (diff.length ? " (differ: " + diff.join(", ") + ")" : ""));
  }
  await fixedCtx.close();
  page = mainPage;

  // Day rollover: loaded at 23:59 on Oct 21 with a search, the Dining and Chase Freedom Flex filters, a cuisine,
  // Online, Needs activation, A to Z, one offer's details, the Filters panel, the bonus strip with one "More
  // details", one bonus row, Recently unavailable, Offer freshness and Edit mode open, scrolled down, focus on the open
  // offer's row. Crossing midnight (the timer; a tab hidden across it and shown again; a bfcache pageshow) redraws
  // once: the offer that ended Oct 21 moves to Recently unavailable, "Ends tomorrow" becomes "Ends today", and every
  // piece of state stays. visibilitychange, focus and pageshow on the same day draw nothing.
  const dayPlus = (y, m, d, n) => { const t = new Date(y, m, d + n); return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0"); };
  const dayOffers = (y, m, d) => async route => {
    const j = await (await route.fetch()).json();
    const mk = (merchant, n, i) => ({ id: "test/zzday-" + i, card: "Chase Freedom Flex", merchant, category: "Dining",
      bonus: (10 + i) + "% cash back", expires: n == null ? null : dayPlus(y, m, d, n), expires_text: null, activation: "needs_activation",
      channel: "online", spend_cap: null, minimum_spend: null, fine_print: null, other_details: [], last_read: "2026-10-18",
      first_seen: "2026-10-18", status: "active", status_since: "2026-10-18" });
    j.offers.push(mk("Zzday Ends Today", 0, 0), mk("Zzday Ends Tomorrow", 1, 1), Object.assign(mk("Zzday Dropped", null, 16), { status: "missing" }));
    for (let i = 2; i < 16; i++) j.offers.push(mk("Zzday Filler " + i, null, i));
    await route.fulfill({ json: j });
  };
  const dayState = () => page.evaluate(() => {
    const q = document.getElementById("q"), f = document.activeElement, li = f && f.closest("li[data-oid]"), mc = f && f.closest("li[data-ck]");
    const pressed = id => [...document.querySelectorAll("#" + id + " button[aria-pressed=true]")].map(b => b.textContent.replace(/\s*\(?\d+\)?$/, "").trim());
    const rowOf = m => [...document.querySelectorAll("li.offer")].find(l => window.__offerOf(l.dataset.oid).merchant === m);
    const soon = m => { const l = rowOf(m); const b = l && l.querySelector(".oterms .soon"); return b ? b.textContent : null; };
    return {
      renders: window.__renders, y: Math.round(window.scrollY), q: q.value, caret: [q.selectionStart, q.selectionEnd],
      focus: f === q ? "input" : li ? li.getAttribute("data-oid") + " " + f.tagName + "." + f.className : mc ? mc.getAttribute("data-ck") + " " + f.tagName + "." + f.className :
        f ? f.tagName + "#" + f.id + "." + f.className : null,
      cats: pressed("cats"), cards: pressed("cards"), cuis: pressed("cuis"), chans: pressed("chans"), acts: pressed("acts"), sort: document.getElementById("sort").value,
      open: [...document.querySelectorAll("li.mc > button.mchead[aria-expanded=true]")].map(b => b.querySelector(".mcname").textContent),
      filters: document.getElementById("filters").classList.contains("open"), strip: document.getElementById("bstrip").open,
      more: [...document.querySelectorAll("#blist li[data-eid] > details.bmore[open]")].map(d => d.parentNode.getAttribute("data-eid")),
      rates: (document.querySelector("#use details.rates") || {}).open,
      rows: [...document.querySelectorAll("#use details.bonusrow[open]")].map(d => d.getAttribute("data-topic")),
      leads: [...document.querySelectorAll("#use details.bonusrow[open] .bhead")].map(h => h.textContent),
      expired: (document.querySelector("#main details.expired") || {}).open,
      fresh: document.getElementById("foot").open, edit: document.getElementById("editmode").open,
      gone: [...document.querySelectorAll("#main details.expired li.offer")].map(l => window.__offerOf(l.dataset.oid).merchant),
      today: rowOf("Zzday Ends Today") ? (rowOf("Zzday Ends Today").classList.contains("gone") ? "gone" : "live") : "none",
      soonToday: soon("Zzday Ends Today"), soonTomorrow: soon("Zzday Ends Tomorrow")
    };
  });
  // Loads the page at 23:59:00 on the day, sets every piece of state, then pauses the clock at 23:59:50.
  const dayCtx = async (y, m, d) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    page = await ctx.newPage();
    await page.clock.install({ time: new Date(y, m, d, 23, 59, 0) });
    await page.route("**/data/offers.json", dayOffers(y, m, d));
    await page.goto(base);
    await page.waitForFunction(() => /active offers loaded/.test(document.body.innerText));
    return ctx;
  };
  const daySetup = async () => {
    if (await page.locator("#ftoggle").isVisible()) await page.click("#ftoggle");
    await page.selectOption("#sort", "az");
    await page.locator("#cats button", { hasText: /^Dining/ }).first().click();
    await page.locator("#cards button", { hasText: /^Chase Freedom Flex/ }).first().click();
    await page.locator("#chans button", { hasText: /^Online/ }).first().click();
    await page.locator("#acts button", { hasText: /^Needs activation/ }).first().click();
    await page.fill("#q", "zzday");
    await page.waitForTimeout(900); // past the after-typing scroll
    await page.locator("#cuis button", { hasText: /^Unclassified/ }).first().click();
    await page.locator("li.mc:has(li.offer[data-oid='test/zzday-1']) > button.mchead").first().click();
    await page.click("#bstrip > summary");
    await page.locator("#blist li[data-eid='citi-custom-cash/standing'] > details.bmore > summary").click();
    await page.click("#use details.rates > summary");
    await page.locator("#use details.bonusrow > summary").first().click();
    await page.locator("#main details.expired > summary").click(); // closed (it opens under a search)
    await page.evaluate(() => { document.getElementById("foot").open = true; document.getElementById("editmode").open = true; });
    await page.evaluate(() => { const q = document.getElementById("q"); q.setSelectionRange(2, 2); });
    await page.evaluate(() => document.querySelector("#main > ul.results li.mc:not(.gone) > button.mchead[aria-expanded=true]").focus({ preventScroll: true }));
    await page.evaluate(() => window.scrollTo(0, Math.min(700, document.documentElement.scrollHeight - innerHeight)));
    await page.clock.pauseAt(new Date(2026, 9, 21, 23, 59, 50));
  };
  const sameState = (a, b) => ["q", "caret", "focus", "cats", "cards", "cuis", "chans", "acts", "sort", "open", "filters", "strip", "more", "rates", "rows", "expired", "fresh", "edit"]
    .filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  for (const how of ["midnight timer", "hidden across midnight, visibilitychange", "bfcache pageshow"]) {
    const ctx = await dayCtx(2026, 9, 21);
    await daySetup();
    const before = await dayState();
    if (how === "midnight timer") await page.clock.runFor(15000);
    else {
      if (how !== "bfcache pageshow") await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.clock.setSystemTime(new Date(2026, 9, 22, 7, 30, 0)); // no timer runs
      const mid = await dayState();
      ok(mid.renders === before.renders && mid.today === "live", how + ": nothing drawn before the page comes back (" + (mid.renders - before.renders) + " renders)");
      await page.evaluate(h => {
        if (h === "bfcache pageshow") { window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); return; }
        Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
      }, how);
    }
    const after = await dayState();
    ok(before.today === "live" && before.soonToday === "Ends today" && before.soonTomorrow === "Ends tomorrow" && before.y > 300,
      how + ": set up at 23:59:50 (" + JSON.stringify({ today: before.today, soon: [before.soonToday, before.soonTomorrow], y: before.y, focus: before.focus, rows: before.rows, leads: before.leads }) + ")");
    ok(after.renders - before.renders === 1, how + ": one redraw (" + (after.renders - before.renders) + ")");
    ok(after.today === "gone" && after.gone.includes("Zzday Ends Today") && after.soonTomorrow === "Ends today",
      how + ": the offer that ended moved to Recently unavailable, \"Ends tomorrow\" -> \"" + after.soonTomorrow + "\"");
    const lost = sameState(before, after);
    ok(!lost.length && before.open.length === 1 && before.rows.length === 1 && before.more.length === 1 && before.strip && before.filters && before.expired === false && before.fresh && before.edit,
      how + ": search, caret, focus, filters, sort, open details, strip, More details, bonus row, Recently unavailable, freshness and Edit mode kept" + (lost.length ? " (lost: " + lost.map(k => k + " " + JSON.stringify(before[k]) + " -> " + JSON.stringify(after[k])).join("; ") + ")" : ""));
    ok(Math.abs(after.y - before.y) <= 2, how + ": scroll kept (" + before.y + " -> " + after.y + ")");
    // A later visibilitychange, focus and pageshow on the new day draw nothing more.
    await page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
    ok((await dayState()).renders === after.renders, how + ": visibilitychange, focus and pageshow later the same day draw nothing");
    await ctx.close();
  }
  {
    // Same day: no redraw at all.
    const ctx = await dayCtx(2026, 9, 21);
    await daySetup();
    const before = await dayState();
    await page.clock.runFor(5000); // 23:59:55
    await page.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
    });
    const after = await dayState();
    ok(after.renders === before.renders && !sameState(before, after).length && after.y === before.y, "same day: visibilitychange, focus and pageshow cause no redraw (" + (after.renders - before.renders) + " renders)");
    await ctx.close();
  }
  {
    // Dec 31 -> Jan 1: the quarter's entries leave the bonus strip at midnight.
    const ctx = await dayCtx(2026, 11, 31);
    await page.clock.pauseAt(new Date(2026, 11, 31, 23, 59, 50));
    const strip = () => page.$$eval("#blist li[data-eid]", ls => ls.map(l => l.getAttribute("data-eid")));
    const s0 = await strip();
    await page.clock.runFor(15000);
    const s1 = await strip();
    ok(s0.includes("chase-freedom-flex/2026-q4") && !s1.some(id => /2026-q4$/.test(id)) && s1.length > 0,
      "Dec 31 -> Jan 1: the 2026 Q4 entries leave the bonus strip (" + s0.length + " -> " + s1.length + " entries)");
    await ctx.close();
  }
  {
    // Typing just after midnight, before the midnight timer: the results follow the new day at once, and the timer
    // still redraws the strip.
    const ctx = await dayCtx(2026, 11, 31);
    await page.clock.pauseAt(new Date(2026, 11, 31, 23, 59, 59, 900));
    await page.clock.runFor(300); // 00:00:00.2, the timer (00:00:00.5) not yet run
    await page.fill("#q", "pi");
    await page.clock.runFor(5000);
    const s2 = await page.$$eval("#blist li[data-eid]", ls => ls.map(l => l.getAttribute("data-eid")));
    ok(!s2.some(id => /2026-q4$/.test(id)) && s2.length > 0, "typed at 00:00:00.2 on Jan 1: the timer still takes the 2026 Q4 entries out of the strip (" + s2.join(", ") + ")");
    await ctx.close();
  }
  {
    // The bonus file didn't load (no strip): focus, visibilitychange and pageshow the same day draw nothing.
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    page = await ctx.newPage();
    await page.clock.setFixedTime(new Date(2026, 9, 21, 12));
    await page.route("**/data/bonus-categories.json", r => r.abort());
    await page.goto(base);
    await page.waitForFunction(() => /active offers loaded/.test(document.body.innerText));
    await page.fill("#q", "pizza");
    await page.waitForTimeout(900);
    const r0 = await page.evaluate(() => window.__renders);
    await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
    const r1 = await page.evaluate(() => window.__renders);
    ok(r1 === r0, "no bonus file, same day: focus, visibilitychange and pageshow draw nothing (" + (r1 - r0) + " renders)");
    await ctx.close();
  }
  {
    // A press cut off by hiding the tab (no pointerup or pointercancel) doesn't hold the redraw: back the next day,
    // it redraws once.
    const ctx = await dayCtx(2026, 9, 21);
    await page.fill("#q", "zzday");
    await page.waitForTimeout(900);
    await page.clock.pauseAt(new Date(2026, 9, 21, 23, 59, 50));
    const vis = h => page.evaluate(h => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => h ? "hidden" : "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    }, h);
    await page.evaluate(() => document.getElementById("main").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" })));
    await vis(true);
    await page.clock.setSystemTime(new Date(2026, 9, 22, 8, 0, 0));
    const r0 = await page.evaluate(() => window.__renders);
    await vis(false);
    const r1 = await page.evaluate(() => window.__renders);
    ok(r1 === r0 + 1, "press cut off by hiding the tab, back the next day: one redraw (" + (r1 - r0) + " renders)");
    await ctx.close();
  }
  page = mainPage;

  // Not activated: with the three quarterly entries forced to not_confirmed, the closed line puts a "⚠" (the
  // strip warning's color and size) before exactly those cards, with a hidden ", not activated"; the line still
  // fits whole names and +N counts the rest, at 390 and 360px.
  const FORCE = new Set(["Freedom Flex", "Freedom", "Discover it"]);
  await page.route("**/data/bonus-categories.json", async route => {
    const d = await (await route.fetch()).json();
    d.entries.forEach(e => { if (FORCE.has(e.card)) e.activation = "not_confirmed"; });
    await route.fulfill({ json: d });
  });
  const marks = () => page.$$eval("#use details.bonusrow .bent", (es, force) => {
    const ref = document.querySelector("#bsum .bwarn"), rs = ref && getComputedStyle(ref);
    return es.map(e => {
      const mk = e.querySelector(".bwarnmk"), ms = mk && getComputedStyle(mk), sr = e.querySelector(".sr-only:last-child");
      return { card: e.querySelector(".bcn").textContent, mk: !!mk, want: force.includes(e.querySelector(".bcn").textContent),
        sr: !!sr && sr.textContent === ", not activated", hidden: !!mk && mk.getAttribute("aria-hidden") === "true",
        style: !mk || (!!rs && ms.color === rs.color && ms.fontSize === rs.fontSize), afterDot: !mk || !mk.previousElementSibling || mk.previousElementSibling.classList.contains("idot") };
    });
  }, [...FORCE]);
  for (const w of [390, 360]) {
    await page.setViewportSize({ width: w, height: 844 });
    let warned = 0;
    for (const [q, o] of [["round table"], ["pizza"], ["costco gas"], ["", { cat: "Dining" }], ["", { cat: "Travel" }], ["", { cat: "Groceries" }]]) {
      await setup(q, o);
      await page.waitForTimeout(100);
      const name = (q || o.cat) + " @" + w + ", not activated";
      await openRates();
      const mm = await marks(), br = await bonusRows();
      if (!br.length) { skip(name + ": no bonus row"); continue; }
      warned += mm.filter(m => m.mk).length;
      const bad = mm.filter(m => m.mk !== m.want || (m.mk && !(m.sr && m.hidden && m.style && m.afterDot)) || (!m.mk && m.sr));
      ok(!bad.length, name + ": ⚠ and hidden text on exactly " + [...new Set(mm.filter(m => m.mk).map(m => m.card))].join(", ") + (bad.length ? " (wrong: " + JSON.stringify(bad) + ")" : ""));
      ok(br.every(r => !r.cut.length) && br.every(r => r.shown + r.n === r.total && (r.n > 0 || r.shown === r.total)),
        name + ": whole names only, +N right (" + br.map(r => r.shown + " shown +" + r.n + " of " + r.total + (r.cut.length ? ", cut " + r.cut.join(", ") : "")).join("; ") + ")");
    }
    ok(warned > 0, "not activated @" + w + ": " + warned + " ⚠ marks seen");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.unroute("**/data/bonus-categories.json");

  // Caveat line: a closed row with notes shows them as one cut line (no Matched, no Likely); open, the line hides
  // and every note shows in full.
  for (const [q, o] of [["", { cat: "Streaming" }], ["", { cat: "Groceries" }], ["instacart"], ["stubhub"]]) {
    await setup(q, o);
    await page.waitForTimeout(100);
    const name = (q || o.cat) + ", caveat line";
    await openRates();
    const cv = await page.$$eval("#use details.bonusrow", ds => ds.map(d => {
      const c = d.querySelector(".bcav"), notes = [...d.querySelectorAll(".bnote")].map(n => n.textContent);
      const own = notes.filter(n => !/^Matched: |^Likely, not certain/.test(n));
      if (!c) return { none: true, own: own.length };
      const r = c.getBoundingClientRect(), s = d.querySelector("summary").getBoundingClientRect();
      return { text: c.textContent, want: own.join(" "), visible: c.checkVisibility(), h: r.height, rects: c.getClientRects().length,
        inside: r.right <= s.right + 0.5, sumH: s.height, white: getComputedStyle(c).whiteSpace, ell: getComputedStyle(c).textOverflow };
    }));
    const withC = cv.filter(x => !x.none);
    if (!withC.length) { ok(false, name + ": no row shows a caveat line (" + JSON.stringify(cv) + ")"); continue; }
    ok(cv.every(x => !x.none || !x.own), name + ": every row with notes has the line");
    ok(withC.every(x => x.visible && x.text === x.want && !/Matched: |Likely, not certain/.test(x.text)),
      name + ": " + withC.length + " line(s) show the notes, no Matched or Likely (" + withC.map(x => x.text.slice(0, 60)).join(" | ") + ")");
    ok(withC.every(x => Math.abs(x.h - 18) < 0.5 && x.rects === 1 && x.white === "nowrap" && x.ell === "ellipsis" && x.inside && x.sumH >= 44),
      name + ": one 18px line, cut with an ellipsis inside the summary, summary 44px+ (" + withC.map(x => x.h + "px, " + x.sumH + "px").join("; ") + ")");
    const i = cv.findIndex(x => !x.none);
    await page.locator("#use details.bonusrow > summary").nth(i).click();
    const op = await page.$eval("#use", (m, i) => {
      const d = m.querySelectorAll("details.bonusrow")[i];
      return { open: d.open, cav: d.querySelector(".bcav").checkVisibility(), notes: [...d.querySelectorAll(".bnote")].map(n => n.checkVisibility() && n.getClientRects().length > 0 ? n.textContent : null) };
    }, i);
    ok(op.open && !op.cav && op.notes.length && op.notes.every(Boolean), name + ": open hides the line and shows all " + op.notes.length + " notes in full");
  }

  // What changed and the New tag, on test-only offers and batches that replace the real ones (so real data moving
  // can't turn these red), with the clock fixed at noon on Nov 1, 2026. Cards and reads:
  //   Chase Freedom Flex 10-18, 10-31 (twice): 2 new, 4 gone (2 pulled early, 2 ended); Chase Freedom 10-18, 10-31:
  //   no changes; Capital One 10-18, 10-27: 1 new, 1 gone (no end date); Bank of America 10-18, 10-23: gone only;
  //   U.S. Bank 10-18, 10-23: new only; Citi Double Cash 10-18 only: first read (adds nothing).
  {
    const wcCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    page = await wcCtx.newPage();
    const errs = [];
    page.on("pageerror", e => errs.push(e.message));
    await page.clock.install({ time: new Date(2026, 10, 1, 12, 0, 0) });
    const WC_BATCHES = [["Chase Freedom Flex", "2026-10-18"], ["Chase Freedom Flex", "2026-10-31"], ["Chase Freedom Flex", "2026-10-31"],
      ["Chase Freedom", "2026-10-18"], ["Chase Freedom", "2026-10-31"], ["Capital One", "2026-10-18"], ["Capital One", "2026-10-27"],
      ["Bank of America", "2026-10-18"], ["Bank of America", "2026-10-23"], ["U.S. Bank", "2026-10-18"], ["U.S. Bank", "2026-10-23"],
      ["Citi Double Cash", "2026-10-18"]].map(([card, read_date]) => ({ card, read_date, offers_found: 10 }));
    let wcN = 0;
    const wo = (card, merchant, first_seen, status, status_since, expires, category) => ({
      id: "test/wc-" + (wcN++), card, merchant, category: category || "Clothing & Jewelry", bonus: (5 + wcN) + "% cash back",
      expires: expires || null, expires_text: null, activation: "needs_activation", channel: "online", spend_cap: null,
      minimum_spend: null, fine_print: null, other_details: [], last_read: status_since, first_seen, status, status_since });
    const FX = "Chase Freedom Flex";
    const WC_OFFERS = [
      wo(FX, "Zq Alpha Coffee", "2026-10-31", "active", "2026-10-31", null, "Dining"), // new
      wo(FX, "Zq Bravo Books", "2026-10-31", "active", "2026-10-31", "2026-11-20"), // new
      wo(FX, "Zq Charlie Used", "2026-10-31", "used", "2026-10-31"), // used: not new
      wo(FX, "Zq Delta Ended", "2026-10-31", "active", "2026-10-31", "2026-10-30"), // past its end date: not new
      wo(FX, "Zq Echo Old", "2026-10-18", "active", "2026-10-31"), // seen before: not new
      wo(FX, "Zq Foxtrot Pulled", "2026-10-18", "missing", "2026-10-31", "2026-11-25"), // gone, pulled early
      wo(FX, "Zq Juliet Cafe", "2026-10-18", "missing", "2026-10-31", "2026-11-09", "Dining"), // gone, pulled early
      wo(FX, "Zq Golf Ended", "2026-10-18", "missing", "2026-10-31", "2026-10-31"), // gone, ended on the read date
      wo(FX, "Zq Hotel Expired", "2026-10-18", "expired", "2026-10-31", "2026-10-29"), // gone, ended
      wo(FX, "Zq India Older", "2026-10-18", "missing", "2026-10-18"), // gone at an earlier read: not gone now
      wo("Chase Freedom", "Zq Oscar Steady", "2026-10-18", "active", "2026-10-31"),
      wo("Capital One", "Zq Kilo Kites", "2026-10-27", "active", "2026-10-27"), // new
      wo("Capital One", "Zq Lima Lamps", "2026-10-18", "missing", "2026-10-27"), // gone, no end date
      wo("Capital One", "zq-foxtrot pulled", "2026-10-18", "active", "2026-10-27"), // Foxtrot is still on Capital One
      wo("Capital One", "Zq Alpha Coffee", "2026-10-18", "active", "2026-10-27", null, "Dining"), // same name, not new here
      wo("Bank of America", "ZQ Foxtrôt Pulled", "2026-10-18", "active", "2026-10-23"), // and on Bank of America
      wo("Bank of America", "Zq Mike Mugs", "2026-10-18", "missing", "2026-10-23"), // gone, no end date
      wo("U.S. Bank", "Zq November Nails", "2026-10-23", "active", "2026-10-23"), // new
      wo("U.S. Bank", "Zq Foxtrot Pulled", "2026-10-18", "missing", "2026-10-18"), // not live: not "still on" (gone at an earlier read)
      wo("Citi Double Cash", "Zq Papa Pens", "2026-10-18", "active", "2026-10-18"), // first read: not new
      wo("Citi Double Cash", "Zq Quebec Quills", "2026-10-18", "missing", "2026-10-18") // first read: not gone
    ];
    // 120 low offers seen before (Chase Freedom stays "no changes"), so a "zq" search has a Show more page.
    for (let i = 0; i < 120; i++) WC_OFFERS.push(Object.assign(wo("Chase Freedom", "Zq Zfiller " + String(i).padStart(3, "0"), "2026-10-18", "active", "2026-10-31"), { bonus: "1% cash back" }));
    await page.route("**/data/offers.json", async route => {
      const d = await (await route.fetch()).json();
      await route.fulfill({ json: { categories: d.categories, batches: WC_BATCHES, offers: WC_OFFERS } });
    });
    await page.route("**/data/phone-edits.json", route => route.fulfill({ json: {} }));
    const wcLoad = async () => {
      await page.goto(base);
      await page.waitForFunction(() => /active offers loaded/.test(document.body.innerText));
      await page.evaluate(() => { document.getElementById("fresh").open = true; });
    };
    const fresh = () => page.$$eval("#flist .fhead", bs => bs.map(b => ({ card: b.dataset.card, age: b.querySelector(".fage").textContent,
      chev: !!b.querySelector(".fchev"), green: b.querySelector(".fnew") ? getComputedStyle(b.querySelector(".fnew")).color : null })));
    const freshRowBtn = c => page.locator("#flist .fhead[data-card='" + c + "']");
    const wcState = () => page.evaluate(() => {
      const wc = document.getElementById("wc"), tabs = [...document.querySelectorAll("#wctabs button")];
      const groups = [...document.querySelectorAll("#main h3.wcgroup")].map(h => h.textContent);
      return {
        on: !wc.hidden, name: document.getElementById("wcname").textContent, dot: (document.querySelector("#wcname .idot") || {}).className || null,
        sub: document.getElementById("wcsub").textContent, tabs: tabs.map(b => b.textContent), picked: tabs.filter(b => b.getAttribute("aria-pressed") === "true").map(b => b.textContent.split(" ")[0]),
        groups, rows: [...document.querySelectorAll("#main li.offer")].map(li => window.__offerOf(li.dataset.oid).merchant + " | " + li.querySelector(".mcard").textContent +
          (li.querySelector(".dropped") ? " | " + li.querySelector(".dropped").textContent : "")),
        // The merchant containers in page order: "<heading>: <name> [<offer ids>]".
        mcs: [...document.querySelectorAll("#main > ul.results > li.mc")].map(m => {
          let h = m.parentNode.previousElementSibling;
          while (h && !h.matches("h3.wcgroup")) h = h.previousElementSibling;
          return (h ? h.textContent + ": " : "") + m.querySelector(".mcname").textContent + " [" + [...m.querySelectorAll("li.offer")].map(l => l.dataset.oid.replace(/^test\/wc-/, "")).join(", ") + "]";
        }),
        headline: !document.getElementById("use").hidden, strip: document.getElementById("bstrip").checkVisibility(),
        bonusRows: document.querySelectorAll(".bonusrows").length, expired: document.querySelectorAll("#main details.expired").length
      };
    });
    await wcLoad();

    // Freshness rows: the change on the age line (zero parts left out, "no changes", "first read"), the chevron only
    // on rows with changes, "+N new" in the bonus green.
    const fr = await fresh(), byCard = Object.fromEntries(fr.map(r => [r.card, r]));
    const bonusGreen = await page.evaluate(() => { const s = document.createElement("span"); s.style.color = "var(--bonus)"; document.body.appendChild(s); const c = getComputedStyle(s).color; s.remove(); return c; });
    const WANT = { "Chase Freedom Flex": ["Yesterday · +2 new · 4 gone", true], "Chase Freedom": ["Yesterday · no changes", false],
      "Capital One": ["5 days ago · +1 new · 1 gone", true], "Bank of America": ["9 days ago · 1 gone", true],
      "U.S. Bank": ["9 days ago · +1 new", true], "Citi Double Cash": ["14 days ago · first read", false] };
    for (const [c, [age, chev]] of Object.entries(WANT)) {
      const r = byCard[c];
      ok(r && r.age === age && r.chev === chev && (!/\+\d+ new/.test(age) || r.green === bonusGreen),
        "what changed, freshness row " + c + ": \"" + age + "\"" + (chev ? " with a chevron" : ", no chevron") + " (" + JSON.stringify(r) + ")");
    }
    ok(/what that read changed/.test(await page.$eval("#fresh .fnote", e => e.textContent)), "what changed: freshness note mentions what the read changed");
    // A first-read row and a no-changes row keep the tap: it shows the date and doesn't open the mode.
    for (const c of ["Citi Double Cash", "Chase Freedom"]) {
      await freshRowBtn(c).click();
      const st = await page.evaluate(c => { const b = document.querySelector("#flist .fhead[data-card='" + c + "']"); return { exp: b.getAttribute("aria-expanded"), det: document.getElementById(b.getAttribute("aria-controls")).textContent, wc: !document.getElementById("wc").hidden }; }, c);
      ok(st.exp === "true" && /^Last full read: October (18|31), 2026$/.test(st.det) && !st.wc, "what changed: tapping " + c + " shows the last full read, no mode (" + JSON.stringify(st) + ")");
    }

    // New tag (outside the mode): right after the card name on New offers only: not on a first-read card, an older
    // offer, or the same merchant on another card where it isn't new.
    await page.fill("#q", "zq");
    await page.waitForTimeout(100);
    const tags = await page.$$eval("#main li.offer", ls => ls.map(li => {
      const t = li.querySelector(".newtag"), s = t && getComputedStyle(t);
      return { row: window.__offerOf(li.dataset.oid).merchant + " | " + li.querySelector(".mcard").textContent, tag: !!t,
        after: !!t && t.previousElementSibling && t.previousElementSibling.classList.contains("mcard"), gone: li.classList.contains("gone"),
        style: s ? [s.fontSize, s.fontWeight, s.paddingTop + " " + s.paddingRight, s.borderTopLeftRadius].join(" ") : null };
    }));
    const tagged = tags.filter(t => t.tag).map(t => t.row).sort();
    ok(JSON.stringify(tagged) === JSON.stringify(["Zq Alpha Coffee | Chase Freedom Flex", "Zq Bravo Books | Chase Freedom Flex", "Zq Kilo Kites | Quicksilver / Discover it", "Zq November Nails | Smartly / Cash+"]),
      "New tag: on the four new offers only (" + tagged.join("; ") + ")");
    ok(tags.filter(t => t.tag).every(t => t.after && !t.gone && t.style === "13px 650 1px 7px 6px"), "New tag: right after the card name, 13px, 650, 1px 7px, 6px radius (" + JSON.stringify(tags.filter(t => t.tag)[0]) + ")");
    ok(tags.some(t => /Zq Papa Pens/.test(t.row) && !t.tag) && tags.some(t => /Zq Alpha Coffee \| Quicksilver/.test(t.row) && !t.tag),
      "New tag: none on the first-read Citi offer or the Capital One Zq Alpha Coffee (seen before)");
    {
      // The links are in an open container's details.
      await page.evaluate(() => document.querySelectorAll("#main li.mc > button.mchead[aria-expanded=false]").forEach(b => b.click()));
      const ic = await page.$$eval("#main details.expired li.offer.gone", ls => ls.map(li => [getComputedStyle(li.querySelector("a.glink svg")).color, getComputedStyle(li.querySelector("a.cardlink svg")).color]));
      const live = await page.$eval("#main > ul.results li.offer:not(.gone) a.glink svg", e => getComputedStyle(e).color);
      ok(ic.length && ic.every(c => c[0] === c[1] && c[0] !== live), "Recently unavailable: the Google icon is grey like the card icon, blue on live rows (" + JSON.stringify([ic[0], live]) + ")");
      await page.evaluate(() => document.querySelectorAll("#main li.mc > button.mchead[aria-expanded=true]").forEach(b => b.click()));
    }
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      const cr = await page.$eval("#main .newtag", t => {
        const rgb = c => c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number), lum = c => { const v = rgb(c).map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
        const s = getComputedStyle(t), a = lum(s.color), b = lum(s.backgroundColor);
        return Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100;
      });
      ok(cr >= 4.5, "New tag contrast, " + scheme + ": " + cr + ":1");
    }
    await page.emulateMedia({ colorScheme: "light" });

    // Entering from a row: state before it (search, Online, A to Z, scrolled to the footer) is put back on leaving.
    await page.click("#ftoggle");
    await page.selectOption("#sort", "az");
    await page.locator("#chans button", { hasText: /^Online/ }).click();
    await page.click("#ftoggle"); // closed again
    const stored = () => page.evaluate(() => ["cardselector.sort", "cardselector.channel", "cardselector.activation"].map(k => localStorage.getItem(k)));
    const st0 = await stored();
    await freshRowBtn("Chase Freedom Flex").scrollIntoViewIfNeeded();
    const outside = () => page.evaluate(() => ({ q: document.getElementById("q").value, sort: document.getElementById("sort").value, y: Math.round(window.scrollY),
      chans: [...document.querySelectorAll("#chans button[aria-pressed=true]")].map(b => b.textContent), cards: [...document.querySelectorAll("#cards button[aria-pressed=true]")].map(b => b.textContent),
      cats: [...document.querySelectorAll("#cats button[aria-pressed=true]")].map(b => b.textContent), wc: !document.getElementById("wc").hidden }));
    const before = await outside();
    const hist0 = await page.evaluate(() => history.length);
    await freshRowBtn("Chase Freedom Flex").click();
    let s = await wcState();
    ok(s.on && s.name === "Chase Freedom Flex" && /i-chase/.test(s.dot) && s.sub === "Read Oct 31 · compared with Oct 18" && s.picked[0] === "New" &&
      JSON.stringify(s.tabs) === JSON.stringify(["New 2", "Gone 4"]) && !s.headline && !s.strip && !s.bonusRows && !s.expired,
      "what changed: Freedom Flex row opens New, header and counts, no headline, strip, bonus rows or Recently unavailable (" + JSON.stringify(s) + ")");
    ok(JSON.stringify(s.rows.map(r => r.split(" | ")[0]).sort()) === JSON.stringify(["Zq Alpha Coffee", "Zq Bravo Books"]), "what changed: New lists Zq Alpha Coffee and Zq Bravo Books (" + s.rows.join("; ") + ")");
    ok(await page.evaluate(() => history.length) === hist0 + 1, "what changed: entering pushes one history entry");
    const geo = await page.evaluate(() => {
      const r = e => e.getBoundingClientRect(), back = document.getElementById("wcback"), tabs = [...document.querySelectorAll("#wctabs button")];
      const panel = document.getElementById("wc"), ft = document.getElementById("ftoggle"), sel = getComputedStyle(tabs[0]), card = document.querySelector("#cards button[aria-pressed=true]");
      return { back: [r(back).width, r(back).height], tabs: tabs.map(t => [Math.round(r(t).width), r(t).height]), sub: getComputedStyle(document.getElementById("wcsub")).fontSize,
        joined: Math.abs(r(panel).bottom - r(ft).top) < 1.5, selBg: sel.backgroundColor === getComputedStyle(card).backgroundColor };
    });
    ok(geo.back[0] >= 44 && geo.back[1] >= 44 && geo.tabs.every(t => t[1] >= 44) && geo.tabs[0][0] === geo.tabs[1][0] && geo.sub === "13px" && geo.joined && geo.selBg,
      "what changed: 44px back arrow, two equal 44px buttons in the card button's selected colors, 13px read line, Filters joined below (" + JSON.stringify(geo) + ")");

    // Counts follow the category, the search and the card; the other filters reset on entering.
    if ((await page.getAttribute("#ftoggle", "aria-expanded")) !== "true") await page.click("#ftoggle");
    await page.locator("#cats button", { hasText: /^Dining/ }).click();
    s = await wcState();
    ok(JSON.stringify(s.tabs) === JSON.stringify(["New 1", "Gone 1"]) && JSON.stringify(s.rows) === JSON.stringify(["Zq Alpha Coffee | Chase Freedom Flex"]), "what changed: Dining gives New 1, Gone 1 (" + JSON.stringify(s.tabs) + ")");
    await page.locator("#wctabs button", { hasText: /^Gone/ }).click();
    s = await wcState();
    ok(s.picked[0] === "Gone" && JSON.stringify(s.groups) === JSON.stringify(["Pulled early 1"]) && JSON.stringify(s.rows) === JSON.stringify(["Zq Juliet Cafe | Chase Freedom Flex | Was to end Nov 9"]),
      "what changed: Dining, Gone: only the Pulled early 1 heading (no empty Ended heading), Zq Juliet Cafe \"Was to end Nov 9\" (" + JSON.stringify(s) + ")");
    await page.locator("#cats button", { hasText: /^All$/ }).click();
    s = await wcState();
    ok(JSON.stringify(s.groups) === JSON.stringify(["Pulled early 2", "Ended 2"]) &&
      JSON.stringify(s.rows) === JSON.stringify(["Zq Foxtrot Pulled | Chase Freedom Flex | Was to end Nov 25", "Zq Juliet Cafe | Chase Freedom Flex | Was to end Nov 9",
        "Zq Golf Ended | Chase Freedom Flex | Ended Oct 31", "Zq Hotel Expired | Chase Freedom Flex | Ended Oct 29"]),
      "what changed: Gone in groups, the sort (A to Z) inside each, Pulled early and Ended labels (" + s.groups.join(", ") + ": " + s.rows.join("; ") + ")");
    const still = await page.$$eval("#main li.offer", ls => ls.map(li => {
      const so = li.querySelector(".stillon");
      return { m: window.__offerOf(li.dataset.oid).merchant, text: so ? so.textContent : null, dots: so ? [...so.querySelectorAll(".idot")].map(d => d.className.replace("idot ", "")) : [] };
    }));
    const fox = still.find(x => x.m === "Zq Foxtrot Pulled");
    ok(fox && fox.text === "Still on Bank of America and Capital One" && JSON.stringify(fox.dots) === JSON.stringify(["i-boa", "i-cap1"]),
      "what changed: Still on Bank of America and Capital One, each with its dot (names compared ignoring case, accents and punctuation; a missing U.S. Bank offer left out) (" + JSON.stringify(fox) + ")");
    ok(still.filter(x => x.m !== "Zq Foxtrot Pulled").every(x => x.text === null), "what changed: no Still on line where no other card has the merchant live");
    // Gone rows: the Google icon is grey like the card icon (its own blue .ext color doesn't win).
    const iconColors = async () => {
      await page.evaluate(() => document.querySelectorAll("#main li.mc > button.mchead[aria-expanded=false]").forEach(b => b.click()));
      const c = await page.$$eval("li.offer.gone", ls => ls.map(li => [getComputedStyle(li.querySelector("a.glink svg")).color, getComputedStyle(li.querySelector("a.cardlink svg")).color, getComputedStyle(li.querySelector(".oterms")).color]));
      await page.evaluate(() => document.querySelectorAll("#main li.mc > button.mchead[aria-expanded=true]").forEach(b => b.click()));
      return c;
    };
    const ic = await iconColors();
    ok(ic.length && ic.every(c => c[0] === c[1] && c[0] === c[2]), "what changed: Gone rows' Google and card icons are both grey (" + JSON.stringify(ic[0]) + ")");
    // Headings only for the groups the search leaves: one group left keeps its heading.
    for (const [q, want] of [["zq hotel", ["Ended 1"]], ["zq foxtrot", ["Pulled early 1"]]]) {
      await page.fill("#q", q);
      await page.waitForTimeout(100);
      s = await wcState();
      ok(JSON.stringify(s.groups) === JSON.stringify(want) && s.rows.length === 1, "what changed: \"" + q + "\" on Gone keeps only the " + want[0] + " heading (" + JSON.stringify(s.groups) + ")");
    }
    await page.fill("#q", "zq foxtrot");
    await page.waitForTimeout(100);
    s = await wcState();
    ok(JSON.stringify(s.tabs) === JSON.stringify(["New 0", "Gone 1"]) && s.rows.length === 1, "what changed: a search narrows both counts (" + JSON.stringify(s.tabs) + ")");
    await page.fill("#q", "zq");
    await page.waitForTimeout(100);
    s = await wcState();
    ok(JSON.stringify(s.groups) === JSON.stringify(["Pulled early 2", "Ended 2"]), "what changed: both headings back with the search widened (" + JSON.stringify(s.groups) + ")");
    await page.fill("#q", "");
    await page.locator("#cards button", { hasText: /^Capital One/ }).click();
    s = await wcState();
    ok(s.name === "Capital One" && /i-cap1/.test(s.dot) && s.sub === "Read Oct 27 · compared with Oct 18" && JSON.stringify(s.tabs) === JSON.stringify(["New 1", "Gone 1"]) &&
      !s.groups.length && JSON.stringify(s.rows) === JSON.stringify(["Zq Lima Lamps | Quicksilver / Discover it | Dropped Oct 27"]),
      "what changed: picking Capital One switches the header; a gone offer with no end date reads \"Dropped Oct 27\", no headings (" + JSON.stringify(s) + ")");
    await page.locator("#cards button", { hasText: /^All cards/ }).click();
    s = await wcState();
    ok(s.name === "All cards" && s.dot === null && s.sub === "Each card's latest read" && JSON.stringify(s.tabs) === JSON.stringify(["New 4", "Gone 6"]) &&
      JSON.stringify(s.groups) === JSON.stringify(["Pulled early 2", "Ended 2", "Dropped 2"]) && s.rows.some(r => r === "Zq Mike Mugs | Customized Cash / Unlimited Cash | Dropped Oct 23") &&
      !s.rows.some(r => /Quebec|India/.test(r)), "what changed: All cards, each card against its own latest read, first read adds nothing (" + JSON.stringify(s) + ")");
    await page.locator("#wctabs button", { hasText: /^New/ }).click();
    s = await wcState();
    ok(JSON.stringify(s.rows.map(r => r.split(" | ")[0]).sort()) === JSON.stringify(["Zq Alpha Coffee", "Zq Bravo Books", "Zq Kilo Kites", "Zq November Nails"]) &&
      (await page.locator("#main .newtag").count()) === 0, "what changed: All cards New lists the four new offers, no New tags inside the mode (" + s.rows.join("; ") + ")");

    // In the mode: In store, Newest added and a search; none of it is saved. The back arrow puts the old state back.
    await page.selectOption("#sort", "newest");
    await page.locator("#chans button", { hasText: /^In store/ }).click();
    // Every test offer is online: the count line says how many the In store choice hides, as on the main list.
    ok((await page.textContent("#count")) === "0 new offers shown for In store · 4 online only hidden", "what changed: the count line names what the In store filter hides (\"" + (await page.textContent("#count")) + "\")");
    await page.fill("#q", "kilo");
    const stIn = await stored();
    await page.click("#wcback");
    await page.waitForFunction(() => document.getElementById("wc").hidden);
    let after = await outside();
    ok(JSON.stringify(stIn) === JSON.stringify(st0) && JSON.stringify(await stored()) === JSON.stringify(st0), "what changed: nothing picked in the mode is saved (" + JSON.stringify(stIn) + ")");
    ok(!after.wc && after.q === before.q && after.sort === before.sort && JSON.stringify(after.chans) === JSON.stringify(before.chans) && JSON.stringify(after.cards) === JSON.stringify(before.cards) &&
      JSON.stringify(after.cats) === JSON.stringify(before.cats) && Math.abs(after.y - before.y) <= 2 && (await page.locator("#main .newtag").count()) > 0,
      "what changed: the back arrow leaves and puts back the search, filters, sort and scroll (" + JSON.stringify([before, after]) + ")");
    ok(await page.evaluate(() => history.length) === hist0 + 1 && await page.evaluate(() => !(history.state && history.state.cardselectorWc)), "what changed: the back arrow went back through the pushed entry");

    // The phone's back button leaves the same way; Bank of America (gone only) opens on Gone.
    await freshRowBtn("Bank of America").scrollIntoViewIfNeeded();
    const before2 = await outside();
    await freshRowBtn("Bank of America").click();
    s = await wcState();
    ok(s.on && s.picked[0] === "Gone" && JSON.stringify(s.tabs) === JSON.stringify(["New 0", "Gone 1"]), "what changed: a row with nothing new opens on Gone (" + JSON.stringify(s.tabs) + ")");
    await page.fill("#q", "mike");
    await page.goBack();
    await page.waitForFunction(() => document.getElementById("wc").hidden);
    after = await outside();
    ok(!after.wc && after.q === before2.q && after.sort === before2.sort && JSON.stringify(after.chans) === JSON.stringify(before2.chans) && Math.abs(after.y - before2.y) <= 2,
      "what changed: the phone's back button leaves and puts the state back (" + JSON.stringify([before2, after]) + ")");

    // Show more pages shown before entering come back on leaving. Typing in the mode keeps the New and Gone buttons in
    // view (the after-typing scroll). A double tap on the back arrow leaves the mode but stays on the page.
    await page.locator("#main > button.more").click();
    const shown0 = await page.locator("#main li.offer").count();
    await freshRowBtn("Chase Freedom Flex").scrollIntoViewIfNeeded();
    await freshRowBtn("Chase Freedom Flex").click();
    await page.fill("#q", "z");
    await page.waitForTimeout(900);
    const inView = await page.evaluate(() => ({ tabsTop: Math.round(document.getElementById("wctabs").getBoundingClientRect().top), barBottom: Math.round(document.querySelector(".searchbar").getBoundingClientRect().bottom) }));
    ok(inView.tabsTop >= inView.barBottom, "what changed: after typing in the mode the New and Gone buttons stay below the search box (" + JSON.stringify(inView) + ")");
    await page.dblclick("#wcback");
    await page.waitForTimeout(300);
    ok(page.url() === base && await page.evaluate(() => document.getElementById("wc").hidden) && (await page.locator("#main li.offer").count()) === shown0 && shown0 > 100,
      "what changed: a double tap on the back arrow stays on the page, and the " + shown0 + " rows shown before entering (Show more) are back (" + page.url() + ")");

    // Day rollover in the mode: it stays, with its tab and filters.
    await freshRowBtn("Chase Freedom Flex").click();
    await page.locator("#wctabs button", { hasText: /^Gone/ }).click();
    if ((await page.getAttribute("#ftoggle", "aria-expanded")) !== "true") await page.click("#ftoggle");
    await page.locator("#cats button", { hasText: /^Dining/ }).click();
    await page.waitForTimeout(800); // past the tap hold
    const r0 = await page.evaluate(() => window.__renders);
    await page.clock.setSystemTime(new Date(2026, 10, 2, 0, 0, 5));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    s = await wcState();
    ok((await page.evaluate(() => window.__renders)) === r0 + 1 && s.on && s.picked[0] === "Gone" && s.name === "Chase Freedom Flex" &&
      JSON.stringify(s.rows) === JSON.stringify(["Zq Juliet Cafe | Chase Freedom Flex | Was to end Nov 9"]), "what changed: the day redraw keeps the mode, its tab and filters (" + JSON.stringify(s) + ")");
    // A reload starts outside the mode.
    await page.reload();
    await page.waitForFunction(() => window.__renders >= 1); // Online is remembered, so it opens with results
    ok(await page.evaluate(() => document.getElementById("wc").hidden && !document.querySelector(".wrap").classList.contains("wcon")), "what changed: a reload starts outside the mode");
    await page.waitForTimeout(200);
    await page.goBack();
    ok(page.url() !== base, "what changed: after a reload in the mode, one press of the phone's back button leaves the page (" + page.url() + ")");
    ok(!errs.length, "what changed: no page errors (" + errs.join("; ") + ")");
    await wcCtx.close();
    page = mainPage;
  }

  // Merchant identity on fixed fixture offers (offers.json replaced by these only): the full name is the merchant,
  // nothing groups because of " - " or an alias, and only a member listed in merchant-locations.json joins its group.
  {
    const real = JSON.parse(fs.readFileSync(path.join(SITE, "data/offers.json")));
    const fx = (id, card, merchant, category, bonus, extra) => Object.assign({ id: "test/id-" + id, card, merchant, category, bonus,
      expires: null, expires_text: null, activation: "already_activated", channel: "in_store", spend_cap: null, minimum_spend: null,
      fine_print: null, other_details: [], last_read: "2026-10-18", first_seen: "2026-10-18", status: "active", status_since: "2026-10-18" }, extra || {});
    const FX = [
      fx("ka-major", "Capital One", "KitchenAid - Major Appliances", "Home & Garden", "5% back", { activation: "none_shown", channel: "online" }),
      fx("ka-counter", "Capital One", "KitchenAid - Countertop Appliances", "Home & Garden", "3% back", { activation: "none_shown", channel: "online" }),
      fx("jb", "Citi Double Cash", "JetBlue", "Travel", "$50 Back", { activation: "needs_activation", channel: "none_shown" }),
      fx("jb-points", "Citi Double Cash", "JetBlue TrueBlue Points", "Travel", "5% Back", { activation: "needs_activation", channel: "none_shown", aliases: ["JetBlue"] }),
      fx("jb-vac", "Citi Double Cash", "jetBlue Vacations", "Travel", "4% Back", { activation: "needs_activation", channel: "none_shown" }),
      fx("rt-flex", "Chase Freedom Flex", "Round Table Pizza", "Dining", "10% cash back", { activation: "needs_activation", channel: "none_shown" }),
      fx("rt-usb", "U.S. Bank", "Round Table Pizza", "Dining", "6% cash back"),
      fx("rt-nb", "Bank of America", "Round Table Pizza - Newport Beach", "Dining", "20% Cash back", { fine_print: "Zq Newport Beach terms only" }),
      fx("rt-nb-2", "Bank of America", "Round Table Pizza - Newport Beach", "Dining", "$5 Cash back"),
      fx("rt-irv", "Bank of America", "Round Table Pizza - Irvine", "Dining", "2% Cash back"),
      ...["North", "South", "East", "West"].map((l, i) => fx("zqloc-" + i, "U.S. Bank", "Zqloc - " + l, "Clothing & Jewelry", (2 + i) + "% cash back")),
      fx("zqlocal", "U.S. Bank", "Zqlocal Shop", "Clothing & Jewelry", "30% cash back")
    ];
    let LOC = { status: 200, body: '{ "groups": {} }\n' };
    await page.route("**/data/offers.json", r => r.fulfill({ json: Object.assign({}, real, { offers: FX }) }));
    await page.route("**/data/phone-edits.json", r => r.fulfill({ json: {} }));
    await page.route("**/data/merchant-locations.json", r => r.fulfill({ status: LOC.status, contentType: "application/json", body: LOC.body }));
    const id = async (q, o) => {
      const r = await setup(q, o);
      return { rows: r, names: await useNames(), text: await useText(), top: await page.$eval("#use", e => (e.querySelector(".usetop") || {}).textContent || ""),
        n: await page.evaluate(() => window.__locations) };
    };
    const RT3 = ["Round Table Pizza", "Round Table Pizza - Irvine", "Round Table Pizza - Newport Beach"];
    const empty = { rt: await id("round table"), ka: await id("kitchenaid"), jb: await id("jetblue"), zq: await id("zqloc"), top: await id("", { cat: "Dining" }) };
    ok(empty.rt.n === 0, "identity: the empty locations file gives no merges");
    ok(JSON.stringify(empty.ka.names) === JSON.stringify(["KitchenAid - Countertop Appliances", "KitchenAid - Major Appliances"]),
      "identity: KitchenAid - Major Appliances and - Countertop Appliances are two merchants (" + empty.ka.names.join(", ") + ")");
    ok(JSON.stringify(empty.jb.names) === JSON.stringify(["JetBlue", "JetBlue TrueBlue Points", "jetBlue Vacations"]),
      "identity: JetBlue, JetBlue TrueBlue Points (alias JetBlue) and jetBlue Vacations are three merchants (" + empty.jb.names.join(", ") + ")");
    ok(JSON.stringify(empty.rt.names) === JSON.stringify(RT3), "identity: \" - \" groups nothing, round table names three merchants (" + empty.rt.names.join(", ") + ")");
    ok(!empty.zq.names.length && empty.zq.rows[0].merchant === "Zqlocal Shop" && !grouped(empty.zq.rows, "zqloc") && bestOrderBreak(empty.zq.rows, "zqloc") === -1,
      "identity: four Zqloc - <place> names are four merchants: category headline, plain reward order (" + empty.zq.rows.map(r => r.merchant).join(", ") + ")");
    ok(/^Top offer: Round Table Pizza - Newport Beach /.test(empty.top.top), "identity: Top offer names the Newport Beach offer's own merchant (" + empty.top.top + ")");

    LOC = { status: 200, body: JSON.stringify({ groups: { "Round Table Pizza": ["Round Table Pizza - Newport Beach"], "Zqloc": ["Zqloc - North", "Zqloc - South", "Zqloc - East", "Zqloc - West"] } }) };
    const g = { rt: await id("round table"), ka: await id("kitchenaid"), jb: await id("jetblue"), zq: await id("zqloc"), top: await id("", { cat: "Dining" }), nb: await id("newport") };
    ok(g.rt.n === 5, "locations: five approved members loaded (" + g.rt.n + ")");
    ok(JSON.stringify(g.rt.names) === JSON.stringify(["Round Table Pizza", "Round Table Pizza - Irvine"]),
      "locations: only the listed Newport Beach member joins Round Table Pizza; Irvine stays apart (" + g.rt.names.join(", ") + ")");
    ok(JSON.stringify(g.ka.names) === JSON.stringify(empty.ka.names) && JSON.stringify(g.jb.names) === JSON.stringify(empty.jb.names),
      "locations: KitchenAid and JetBlue unchanged by a file that doesn't list them");
    const rowsOf = x => x.rows.map(label).sort();
    ok(JSON.stringify(rowsOf(g.rt)) === JSON.stringify(rowsOf(empty.rt)) && g.rt.rows.filter(r => r.merchant === "Round Table Pizza - Newport Beach").length === 2,
      "locations: a grouped member keeps its own rows, name and bonus (" + g.rt.rows.length + " rows, same as without the file)");
    await page.locator("#main li.mc:has(li.offer[data-oid='test/id-rt-nb']) > button.mchead").click();
    const terms = await page.$eval("#main li.offer[data-oid='test/id-rt-nb']", li => li.innerText);
    ok(/Zq Newport Beach terms only/.test(terms), "locations: the grouped offer's details show its own terms");
    // (Step 2: under Any, an answer whose In store and Online results differ shows two channel rows instead.)
    const answered = t => /Ready now: |^In store: /m.test(t);
    ok(answered(g.nb.text) && JSON.stringify(g.nb.names) === JSON.stringify(["Round Table Pizza"]), "locations: \"newport\" names the group's merchant (" + g.nb.names.join(", ") + ")");
    ok(!g.zq.names.length && answered(g.zq.text) && g.zq.rows[0].merchant !== "Zqlocal Shop" && grouped(g.zq.rows.map(r => Object.assign({}, r, { merchant: r.merchant.replace(/^Zqloc - .*$/, "Zqloc") })), "zqloc"),
      "locations: the four Zqloc members are one merchant: its headline, and its offers first in Best offer (" + g.zq.rows.map(r => r.merchant).join(", ") + ")");
    ok(/^Top offer: Round Table Pizza \d/.test(g.top.top), "locations: Top offer names the group (" + g.top.top + ")");

    // A missing, broken or invalid file: no merges, the page works.
    for (const [label, L] of [["404", { status: 404, body: "" }], ["not JSON", { status: 200, body: "{ nope" }], ["wrong shape", { status: 200, body: '{"groups": []}' }],
      ["member not '<base> - <suffix>'", { status: 200, body: '{"groups": {"Round Table Pizza": ["Round Table Pizza Irvine", "Round Table Pizza - Newport Beach"]}}' }],
      ["member in two groups", { status: 200, body: '{"groups": {"Round Table Pizza": ["Round Table Pizza - Newport Beach"], "Round Table": ["Round Table Pizza - Newport Beach"]}}' }]]) {
      LOC = L;
      const x = await id("round table");
      ok(x.n === 0 && JSON.stringify(x.names) === JSON.stringify(RT3) && x.rows.length === empty.rt.rows.length, "locations file " + label + ": no merges, the page works (" + x.names.join(", ") + ")");
    }
    await page.unroute("**/data/offers.json");
    await page.unroute("**/data/phone-edits.json");
    await page.unroute("**/data/merchant-locations.json");
  }

  // Step 2, the channel-aware answer card, on fixed fixture offers (offers.json replaced by these only) with a fixed
  // clock (noon, Nov 4, 2026: the Q4 bonuses are live). The bonus file is the real one, with activations changed per
  // case; the locations file is a fixture except in the check on the real one at the end.
  {
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    page = await ctx2.newPage();
    const errs = [];
    page.on("pageerror", e => errs.push(e.message));
    await page.clock.install({ time: new Date(2026, 10, 4, 12, 0, 0) });
    const real = JSON.parse(fs.readFileSync(path.join(SITE, "data/offers.json")));
    const fx = (id, card, merchant, category, bonus, extra) => Object.assign({ id: "test/s2-" + id, card, merchant, category, bonus,
      expires: null, expires_text: null, activation: "already_activated", channel: "in_store", spend_cap: null, minimum_spend: null,
      fine_print: null, other_details: [], last_read: "2026-10-18", first_seen: "2026-10-18", status: "active", status_since: "2026-10-18" }, extra || {});
    const FX = [
      // La Colombe: Chase 15% online x2 (needs activation), U.S. Bank 15% in store and 15% online.
      fx("lc-flex", "Chase Freedom Flex", "La Colombe", "Dining", "15% cash back", { activation: "needs_activation", channel: "online", expires: "2026-11-29" }),
      fx("lc-free", "Chase Freedom", "La Colombe", "Dining", "15% cash back", { activation: "needs_activation", channel: "online", expires: "2026-11-29" }),
      fx("lc-usb", "U.S. Bank", "La Colombe", "Dining", "15% cash back", { channel: "in_store", expires: "2026-11-27" }),
      fx("lc-usb-2", "U.S. Bank", "La Colombe", "Dining", "15% cash back", { channel: "online", expires: "2026-11-29" }),
      // Coffee Bean & Tea Leaf: Chase 10% max $2 with no channel shown x2, Capital One $10 on $20+ online.
      fx("cb-flex", "Chase Freedom Flex", "Coffee Bean & Tea Leaf", "Dining", "10% cash back", { activation: "needs_activation", channel: "none_shown",
        fine_print: "Earn 10% cash back with a $2 cash back maximum." }),
      fx("cb-free", "Chase Freedom", "Coffee Bean & Tea Leaf", "Dining", "10% cash back", { activation: "needs_activation", channel: "none_shown",
        fine_print: "Earn 10% cash back with a $2 cash back maximum." }),
      fx("cb-c1", "Capital One", "Coffee Bean & Tea Leaf", "Dining", "Spend $20, earn $10", { activation: "none_shown", channel: "online" }),
      // A Dining merchant with only a dollar offer that has no minimum (it stays in the rows, never a percent).
      fx("zd-c1", "Capital One", "Zqdine Grill", "Dining", "$5 back", { activation: "none_shown", channel: "none_shown" }),
      // An "Up to" offer: never wins on its maximum.
      fx("zu-c1", "Capital One", "Zqupto Gadgets", "Electronics & Software", "Up to 20% back", { activation: "none_shown", channel: "online" }),
      // Identity: three JetBlue merchants (an alias never merges), two KitchenAid merchants (no " - " grouping).
      fx("jb", "Citi Double Cash", "JetBlue", "Travel", "$50 Back", { activation: "needs_activation", channel: "none_shown" }),
      fx("jb-points", "Citi Double Cash", "JetBlue TrueBlue Points", "Travel", "5% Back", { activation: "needs_activation", channel: "none_shown", aliases: ["JetBlue"] }),
      fx("jb-vac", "Citi Double Cash", "jetBlue Vacations", "Travel", "4% Back", { activation: "needs_activation", channel: "none_shown" }),
      fx("ka-major", "Capital One", "KitchenAid - Major Appliances", "Home & Garden", "5% back", { activation: "none_shown", channel: "online" }),
      fx("ka-counter", "Capital One", "KitchenAid - Countertop Appliances", "Home & Garden", "3% back", { activation: "none_shown", channel: "online" }),
      // Round Table Pizza with an approved location member (Newport Beach), each offer its own record and terms.
      fx("rt-flex", "Chase Freedom Flex", "Round Table Pizza", "Dining", "10% cash back", { activation: "needs_activation", channel: "none_shown" }),
      fx("rt-usb", "U.S. Bank", "Round Table Pizza", "Dining", "6% cash back"),
      fx("rt-nb", "Bank of America", "Round Table Pizza - Newport Beach", "Dining", "20% Cash back", { fine_print: "Zq Newport Beach terms only" }),
      fx("rt-nb-2", "Bank of America", "Round Table Pizza - Newport Beach", "Dining", "$5 Cash back"),
      // Review round 1. Online shopping at Zqalpha (all known online) is not blocked by another merchant's offer
      // with no channel (Zqalphabet Toys, matched by the same query).
      fx("za-c1", "Capital One", "Zqalpha", "Electronics & Software", "3% back", { activation: "none_shown", channel: "online" }),
      fx("zab-flex", "Chase Freedom Flex", "Zqalphabet Toys", "Pets & Baby", "5% cash back", { activation: "needs_activation", channel: "none_shown" }),
      // The merchants answered follow the channel's matches: under In store only Zqbook Shop has an offer.
      fx("zb-c1", "Capital One", "Zqbook Outlet", "Clothing & Jewelry", "5% back", { activation: "none_shown", channel: "online" }),
      fx("zb-usb", "U.S. Bank", "Zqbook Shop", "Clothing & Jewelry", "5% cash back", { channel: "in_store" }),
      // Only online offers: under In store the answer falls back to the merchant's offers in every channel.
      fx("zw-c1", "Capital One", "Zqweb Cafe", "Dining", "11% back", { activation: "none_shown", channel: "online" }),
      // A cuisine search ("burmese", the real cuisines.json detail) in both channels.
      fx("bu-usb", "U.S. Bank", "Irrawaddy Taste of Burma", "Dining", "5% cash back", { channel: "in_store" }),
      fx("bu-c1", "Capital One", "Irrawaddy Taste of Burma", "Dining", "5% back", { activation: "none_shown", channel: "online" }),
      // A Citi Custom Cash offer that leads Top offer under the Dining button (with its planned 5%).
      fx("zcc", "Citi Custom Cash", "Zqcc Diner", "Dining", "25% Back", { channel: "none_shown" }),
      // Review round 2. One merchant across every channel stays the merchant under each (store-only partial names).
      fx("zk-c1", "Capital One", "Zqknown Shop", "Clothing & Jewelry", "10% back", { activation: "none_shown", channel: "online" }),
      ...["abc", "xyz", "mno", "pqr"].map((x, i) => fx("zk-" + x, "U.S. Bank", "Zqknown" + x + " Store", "Clothing & Jewelry", (2 + i) + "% cash back")),
      // Two merchants, different online shopping verdicts.
      fx("zt-c1", "Capital One", "Zqtory", "Clothing & Jewelry", "3% back", { activation: "none_shown", channel: "online" }),
      fx("zt-flex", "Chase Freedom Flex", "Zqtory Outlet", "Clothing & Jewelry", "5% cash back", { activation: "needs_activation", channel: "none_shown" }),
      // A typed keyword with no offer of its own (Amazon) next to a merchant with an in-store offer.
      fx("amf", "U.S. Bank", "Amazon Fresh", "Groceries & Food Delivery", "5% cash back", { channel: "in_store" }),
      // Step 2A. Online shopping through offers needs channel "online": combined channels don't prove it.
      fx("zo-c1", "Capital One", "Zqonl Gadgets", "Electronics & Software", "3% back", { activation: "none_shown", channel: "online" }),
      fx("zi-c1", "Capital One", "Zqiso Gadgets", "Electronics & Software", "3% back", { activation: "none_shown", channel: "in_store_and_online" }),
      fx("zp-c1", "Capital One", "Zqapp Gadgets", "Electronics & Software", "3% back", { activation: "none_shown", channel: "in_store_and_app" }),
      fx("zn-c1", "Capital One", "Zqns Gadgets", "Electronics & Software", "3% back", { activation: "none_shown", channel: "online" }),
      fx("zn-flex", "Chase Freedom Flex", "Zqns Gadgets", "Electronics & Software", "5% cash back", { activation: "needs_activation", channel: "none_shown" }),
      fx("zm-c1", "Capital One", "Zqmixo Gadgets", "Electronics & Software", "3% back", { activation: "none_shown", channel: "online" }),
      fx("zm-boa", "Bank of America", "Zqmixo Gadgets", "Electronics & Software", "2% Cash back", { channel: "in_store_and_online" }),
      // Step 2A review: two merchants blocked for different reasons; a "may not count" line with a condition.
      fx("zt3-c1", "Capital One", "Zqtri", "Electronics & Software", "3% back", { activation: "none_shown", channel: "online" }),
      fx("zt3-ns", "Chase Freedom Flex", "Zqtri", "Electronics & Software", "5% cash back", { activation: "needs_activation", channel: "none_shown" }),
      fx("zt4-c1", "Capital One", "Zqtri Shop", "Electronics & Software", "3% back", { activation: "none_shown", channel: "online" }),
      fx("zt4-io", "Capital One", "Zqtri Shop", "Electronics & Software", "2% back", { activation: "none_shown", channel: "in_store_and_online" }),
      fx("is-boa", "Bank of America", "Instacart", "Groceries & Food Delivery", "10% Cash back", { channel: "in_store", fine_print: "Earn 10% cash back with a $5 cash back maximum." }),
      fx("is-c1", "Capital One", "Instacart", "Groceries & Food Delivery", "2% back", { activation: "none_shown", channel: "online" }),
      fx("etsy", "Capital One", "Etsy", "Marketplaces & Department Stores", "3% back", { activation: "none_shown", channel: "in_store_and_online" }),
      // Compact rows keep one short condition: a max reward (first $60) in store, ending in 5 days online.
      fx("zc-usb", "U.S. Bank", "Zqcond Cafe", "Dining", "10% cash back", { channel: "in_store", fine_print: "Earn 10% cash back with a $6 cash back maximum." }),
      fx("zc-flex", "Chase Freedom Flex", "Zqcond Cafe", "Dining", "15% cash back", { activation: "needs_activation", channel: "online", expires: "2026-11-09" })
    ];
    let BONUS = null; // entries' card -> activation (or "ended"), applied to the real bonus file
    const realBonus = JSON.parse(fs.readFileSync(path.join(SITE, "data/bonus-categories.json")));
    await page.route("**/data/offers.json", r => r.fulfill({ json: Object.assign({}, real, { offers: FX }) }));
    await page.route("**/data/phone-edits.json", r => r.fulfill({ json: {} }));
    await page.route("**/data/merchant-locations.json", r => r.fulfill({ json: { groups: { "Round Table Pizza": ["Round Table Pizza - Newport Beach"] } } }));
    await page.route("**/data/bonus-categories.json", r => {
      const d = JSON.parse(JSON.stringify(realBonus));
      d.entries.forEach(e => {
        const b = BONUS && BONUS[e.card];
        if (b === "ended") { e.start = "2026-07-01"; e.end = "2026-09-30"; } else if (b) e.activation = b;
      });
      return r.fulfill({ json: d });
    });
    const open = async (q, chan, bonusSet) => {
      BONUS = bonusSet || null;
      await page.goto(base);
      await page.evaluate(c => { try { localStorage.clear(); if (c) localStorage.setItem("cardselector.channel", c); } catch (e) {} }, chan || null);
      await page.goto(base);
      await page.waitForFunction(() => window.__cardsReady && window.__bonusReady && document.querySelectorAll("#cards button").length > 1);
      await page.fill("#q", q);
      await page.waitForTimeout(150);
      return ans();
    };
    const ans = () => page.evaluate(() => {
      const u = document.getElementById("use"), sel = u.querySelector(".chansel"), d = u.querySelector("details.rates");
      return {
        sel: sel ? [...sel.querySelectorAll("button")].map(b => b.textContent + (b.getAttribute("aria-pressed") === "true" ? "*" : "")).join(" | ") : null,
        heads: [...u.querySelectorAll(":scope > .usehead:not(.usechan)")].map(e => e.innerText),
        chanRows: [...u.querySelectorAll(":scope > button.usechan:not(.usealt)")].map(b => b.innerText),
        alt: (u.querySelector(":scope > .usealt") || {}).innerText || null,
        cond: [...u.querySelectorAll(":scope > .usecond")].map(e => (e.classList.contains("strong") ? "STRONG " : "muted ") + e.innerText),
        names: [...u.querySelectorAll(".usemname, .useat")].map(e => e.textContent.replace(/:\s*$/, "").replace(/^At /, "")),
        rates: d ? { open: d.open, sum: d.querySelector("summary").innerText.replace(/\s+/g, " "), nc: (d.querySelector(".ratesnc") || {}).textContent || "",
          rows: d.querySelectorAll(".bonusrow").length } : null,
        text: [...u.children].filter(c => !c.matches(".chansel, details.rates")).map(c => c.innerText).join("\n"),
        rows: [...document.querySelectorAll("#main > ul.results li.offer")].map(li => li.getAttribute("data-oid").replace(/^test\/s2-/, "")),
        rowText: [...document.querySelectorAll("#main > ul.results li.offer")].map(li => li.innerText),
        mcs: [...document.querySelectorAll("#main > ul.results > li.mc")].map(m => m.querySelector(".mcname").textContent + " [" + m.querySelectorAll("li.offer").length + "]"),
        stored: (() => { try { return localStorage.getItem("cardselector.channel"); } catch (e) { return "?"; } })(),
        filterChan: [...document.querySelectorAll("#chans button[aria-pressed=true]")].map(b => b.textContent).join()
      };
    });
    const J = x => JSON.stringify(x);

    // La Colombe, In store: Smartly 19% ready; only the in-store offer listed; online-only offers hidden; Online is better.
    let a = await open("la colombe", "store");
    ok(a.sel === "Any | In store* | Online", "s2 La Colombe in store: the selector shows In store picked (" + a.sel + ")");
    ok(/^Ready now: Smartly 19%/.test(a.heads[0]) && a.heads.length === 1, "s2 La Colombe in store: Ready now Smartly 19%, no second line (" + J(a.heads) + ")");
    ok(J(a.rows) === J(["lc-usb"]), "s2 La Colombe in store: only the in-store offer is listed, online-only ones hidden (" + J(a.rows) + ")");
    ok(!/channel not shown/.test(a.text), "s2 La Colombe in store: nothing called channel not shown (none is)");
    ok(/^Online: Freedom Flex 20% or Freedom 20% after activating/.test(a.alt || ""), "s2 La Colombe in store: the better Online answer is offered (" + a.alt + ")");
    ok(a.rates && !a.rates.open && /dining 5%/.test(a.rates.sum) && !/online shopping/.test(a.rates.sum), "s2 La Colombe in store: Card rates collapsed, dining only (" + J(a.rates) + ")");
    await page.click("#use .usealt");
    a = await ans();
    ok(a.sel === "Any | In store | Online*" && a.stored === "online" && a.filterChan === "Online", "s2 tapping the alternate line picks Online (selector, Filters row and storage) (" + J([a.sel, a.stored, a.filterChan]) + ")");
    ok(await page.evaluate(() => document.activeElement && document.activeElement.matches(".chansel button[data-ch=online]")), "s2 focus goes to the picked selector segment");

    // La Colombe, Online: Smartly 19% ready, After activating Flex / Freedom 20% +1 pt; online shopping counts (all known online).
    a = await open("la colombe", "online");
    ok(/^Ready now: Smartly 19%/.test(a.heads[0]), "s2 La Colombe online: Ready now Smartly 19% (" + a.heads[0] + ")");
    ok(/^After activating: Freedom Flex 20% or Freedom 20%.*\+1 pt/.test(a.heads[1] || ""), "s2 La Colombe online: After activating 20% with +1 pt (" + a.heads[1] + ")");
    ok(J(a.rows.slice().sort()) === J(["lc-flex", "lc-free", "lc-usb-2"]), "s2 La Colombe online: the three online offers (" + J(a.rows) + ")");
    ok(/online shopping 5\.25%/.test(a.rates.sum) && !/online only/.test(a.rates.sum) && !a.rates.nc, "s2 La Colombe online: online shopping counted (" + a.rates.sum + ")");
    ok(!a.alt, "s2 La Colombe online: no alternate line (In store is not better)");

    // La Colombe, Any: an In store row and an Online row, each that channel's answer; all four records listed.
    a = await open("la colombe", null);
    ok(a.sel === "Any* | In store | Online", "s2 La Colombe any: Any picked by default (" + a.sel + ")");
    ok(a.chanRows.length === 2 && /^In store: Smartly 19% ready now/.test(a.chanRows[0]) && !/after activating/.test(a.chanRows[0]) &&
      /^Online: Smartly 19% ready now · Freedom Flex 20% or Freedom 20% after activating\s*\+1 pt/.test(a.chanRows[1]),
      "s2 La Colombe any: In store and Online rows, not conflated (" + J(a.chanRows) + ")");
    ok(J(a.rows.slice().sort()) === J(["lc-flex", "lc-free", "lc-usb", "lc-usb-2"]), "s2 La Colombe any: all four offers stay their own records (" + J(a.rows) + ")");
    ok(/online shopping 5\.25% online only/.test(a.rates.sum), "s2 La Colombe any: Card rates qualifies online shopping as online only (" + a.rates.sum + ")");
    await page.click("#use details.rates > summary");
    let st = await ans();
    ok(st.rates.open && st.rates.rows >= 2, "s2 Card rates here opens in place (" + J(st.rates) + ")");
    await page.click("#use details.rates > summary");
    ok(!(await ans()).rates.open, "s2 Card rates here closes again");
    await page.click("#use button.usechan[data-ch=store]");
    a = await ans();
    ok(a.sel === "Any | In store* | Online" && a.stored === "store" && J(a.rows) === J(["lc-usb"]), "s2 tapping the In store row picks In store (" + J([a.sel, a.stored, a.rows]) + ")");
    // Remembered across opens.
    await page.goto(base);
    await page.waitForFunction(() => window.__cardsReady && window.__bonusReady && document.querySelectorAll("#cards button").length > 1);
    await page.fill("#q", "la colombe");
    await page.waitForTimeout(150);
    a = await ans();
    ok(a.sel === "Any | In store* | Online" && a.filterChan === "In store", "s2 the channel is remembered across page opens (" + J([a.sel, a.filterChan]) + ")");
    await page.click("#use .chansel button[data-ch=any]");
    ok((await ans()).stored === "any", "s2 a selector segment picks that channel (Any)");

    // Coffee Bean & Tea Leaf, Online: Chase rows survive as channel not shown; Capital One's online offer is the best
    // deal; online shopping not inferred while offers with no channel remain.
    a = await open("coffee bean", "online");
    ok(J(a.rows.slice().sort()) === J(["cb-c1", "cb-flex", "cb-free"]), "s2 Coffee Bean online: Chase rows survive with Capital One (" + J(a.rows) + ")");
    ok(a.rowText.filter(t => /channel not shown/i.test(t)).length === 2, "s2 Coffee Bean online: the two Chase rows say channel not shown");
    ok(/^Ready now: Freedom Flex 5% or Freedom 5%, \+1 more ready at 5%/.test(a.heads[0]), "s2 Coffee Bean online: Ready now Freedom Flex / Freedom 5%, +1 more ready (Discover it) (" + a.heads[0] + ")");
    ok(/^Best deal: Discover it \+\$10 on \$20\+/.test(a.heads[1] || ""), "s2 Coffee Bean online: Best deal Discover it +$10 on $20+ (" + a.heads[1] + ")");
    ok(!/online shopping/.test(a.rates.sum) && /Online shopping.*channel not shown on 2 offers/.test(a.rates.nc), "s2 Coffee Bean online: online shopping Not counted, channel not shown (" + J(a.rates) + ")");
    ok(!/Customized Cash/.test(a.text), "s2 Coffee Bean online: no online shopping rate in the answer");

    // Coffee Bean, In store: Capital One hidden; the Chase activation answer says channel not shown.
    a = await open("coffee bean", "store");
    ok(J(a.rows.slice().sort()) === J(["cb-flex", "cb-free"]), "s2 Coffee Bean in store: the online-only Capital One offer is hidden (" + J(a.rows) + ")");
    ok(/^After activating: Freedom Flex 15% or Freedom 15% \(5% dining \+ 10% Chase offer, first \$20, channel not shown\)\s*\+10 pts/.test(a.heads[1] || ""),
      "s2 Coffee Bean in store: After activating 15% +10 pts, channel not shown (" + a.heads[1] + ")");
    ok(!/in store/i.test(a.heads.join(" ")), "s2 Coffee Bean in store: the Chase answer is never called in store (" + J(a.heads) + ")");
    ok(/^Online: Discover it \+\$10 on \$20\+ best deal/.test(a.alt || ""), "s2 Coffee Bean in store: the better Online deal is offered (" + a.alt + ")");

    // Chipotle: no offers (a dining keyword only): no selector; "+1 more ready" (Discover it), not +2; Custom Cash apart.
    a = await open("chipotle", null);
    ok(a.sel === null, "s2 Chipotle: no channel selector with no offers to filter");
    ok(/^Use: Freedom Flex 5% or Freedom 5%, \+1 more ready at 5%/.test(a.heads[0]), "s2 Chipotle: +1 more ready at 5%, not +2 (" + a.heads[0] + ")");
    ok(a.cond.length === 1 && /^muted Citi Custom Cash 5% only if restaurants is your actual top eligible category this cycle/.test(a.cond[0]),
      "s2 Chipotle: Custom Cash on its own conditional line (" + J(a.cond) + ")");

    // Custom Cash with no ready 5% (Flex, Freedom and Discover it ended): Smartly 4% is the answer, Custom Cash a
    // separate conditional alternative, +1 pt, never Ready now and never in "+N more ready".
    const ENDED = { "Freedom Flex": "ended", "Freedom": "ended", "Discover it": "ended" };
    a = await open("chipotle", null, ENDED);
    ok(/^Use: Smartly 4%/.test(a.heads[0]) && !/more ready/.test(a.heads[0]) && !/Custom Cash/.test(a.heads[0]), "s2 no ready 5%, Chipotle: Use Smartly 4% (" + a.heads[0] + ")");
    ok(a.cond.length === 1 && /^STRONG Citi Custom Cash 5% · conditional · only if restaurants is your actual top eligible category this cycle\s*\+1 pt/.test(a.cond[0]),
      "s2 no ready 5%, Chipotle: Custom Cash 5% conditional alternative, +1 pt (" + J(a.cond) + ")");
    a = await open("zqdine", null, ENDED);
    ok(/^Ready now: Smartly 4%/.test(a.heads[0]) && !/Custom Cash/.test(a.heads[0]) && !/more ready/.test(a.heads[0]), "s2 no ready 5%, Zqdine Grill: Ready now Smartly 4% (" + a.heads[0] + ")");
    ok(a.cond.length === 1 && /^STRONG Citi Custom Cash 5% · conditional · only if restaurants .* this cycle\s*\+1 pt/.test(a.cond[0]), "s2 no ready 5%, Zqdine Grill: conditional Custom Cash +1 pt (" + J(a.cond) + ")");
    ok(!/Best deal/.test(a.text) && J(a.rows) === J(["zd-c1"]), "s2 a dollar offer with no minimum stays in the rows (" + J(a.heads) + ")");
    ok(!/everywhere|on everything/.test(await page.evaluate(() => document.body.innerText)), "s2 Smartly is never \"4% everywhere\" or \"4% on everything\"");

    // Activation: only when it beats what is ready now. Freedom on, Flex off: Freedom leads, no prompt for a tie.
    a = await open("ralphs", null, { "Freedom Flex": "not_confirmed" });
    ok(/^Use: Freedom 5%/.test(a.heads[0]) && !a.heads.some(h => /^After activating/.test(h)), "s2 Flex off, Freedom on: Freedom 5%, no activation prompt (" + J(a.heads) + ")");
    // Both Chase cards off: Smartly 4% ready, then the 5% activation opportunity, +1 pt.
    a = await open("ralphs", null, { "Freedom Flex": "not_confirmed", "Freedom": "not_confirmed" });
    ok(/^Use: Smartly 4%/.test(a.heads[0]) && /^After activating: Freedom Flex 5% or Freedom 5% \(grocery stores, activate by .*\)\s*\+1 pt/.test(a.heads[1] || ""),
      "s2 both Chase off: Smartly 4%, then After activating 5% +1 pt (" + J(a.heads) + ")");
    // The same at a merchant: Zqdine Grill with Chase and Discover it off.
    a = await open("zqdine", null, { "Freedom Flex": "not_confirmed", "Freedom": "not_confirmed", "Discover it": "not_confirmed" });
    ok(/^Ready now: Smartly 4%/.test(a.heads[0]) && /^After activating: .*5%.*\+1 pt/.test(a.heads[1] || "") && /^STRONG Citi Custom Cash 5%/.test(a.cond[0] || ""),
      "s2 Zqdine Grill, quarterly bonuses off: Smartly 4%, activation +1 pt, Custom Cash conditional (" + J([a.heads, a.cond]) + ")");
    // With Flex off and Freedom on, the merchant answer has no activation line for the tie.
    a = await open("zqdine", null, { "Freedom Flex": "not_confirmed" });
    ok(/^Ready now: Freedom 5%/.test(a.heads[0]) && !a.heads.some(h => /^After activating/.test(h)), "s2 Zqdine Grill, Flex off: Freedom 5% ready, no prompt (" + J(a.heads) + ")");

    // Smartly wins a tie it is in (shell: Costco Visa 4% gas noted after it).
    a = await open("shell", null);
    ok(/^(Ready now|Use): Smartly 4% \(Costco Visa also 4%/.test(a.heads[0] || ""), "s2 shell: Smartly wins the 4% tie (" + a.heads[0] + ")");
    // Up to: the maximum never wins as if certain; Ready now uses the card rate alone.
    a = await open("zqupto", "online");
    ok(/^Ready now: Customized Cash 5\.25%/.test(a.heads[0]) && /^Up to: Quicksilver 21\.5%/.test(a.heads[1] || ""), "s2 Up to: its own line under Ready now (" + J(a.heads) + ")");

    // Identity: JetBlue x3 and KitchenAid x2 stay separate answer targets; the Citi $50 (no minimum) stays in the rows.
    a = await open("jetblue", null);
    ok(J(a.names.slice().sort()) === J(["JetBlue", "JetBlue TrueBlue Points", "jetBlue Vacations"]), "s2 jetblue: three merchants, the alias merges nothing (" + J(a.names) + ")");
    ok(!/\$50/.test(a.text), "s2 jetblue: the $50 offer with no minimum is not turned into a rate (" + a.text.split("\n").join(" / ") + ")");
    a = await open("kitchenaid", "online");
    ok(J(a.names.slice().sort()) === J(["KitchenAid - Countertop Appliances", "KitchenAid - Major Appliances"]), "s2 kitchenaid: two merchants, no dash grouping (" + J(a.names) + ")");
    // An approved location group is one merchant; every offer keeps its own row and terms.
    a = await open("round table", "store");
    ok(J(a.names) === J(["Round Table Pizza"]) && /^Ready now: /.test(a.heads[0]), "s2 round table: the approved group is one merchant answer (" + J([a.names, a.heads]) + ")");
    ok(J(a.rows.slice().sort()) === J(["rt-flex", "rt-nb", "rt-nb-2", "rt-usb"]), "s2 round table: four separate records listed (" + J(a.rows) + ")");
    ok(/Unlimited Cash 22\.63%/.test(a.heads[0]), "s2 round table in store: the Newport Beach member's 20% offer answers for the group (" + a.heads[0] + ")");
    // Review round 1 fixes.
    a = await open("zqalpha", "online");
    ok(J(a.names) === J([]) && /^Ready now: Customized Cash 5\.25%/.test(a.heads[0]) && /online shopping 5\.25%/.test(a.rates.sum) && !a.rates.nc,
      "s2 r1 the answer and Card rates agree: online shopping counted at Zqalpha, not blocked by Zqalphabet Toys (" + J([a.heads[0], a.rates]) + ")");
    a = await open("netflix", "store");
    ok(a.sel === null && /^Use: Customized Cash 5\.25% online/.test(a.heads[0] || "") && !a.rates.nc,
      "s2 r1 no offers, no selector: a remembered In store changes nothing (" + J([a.heads[0], a.rates]) + ")");
    a = await open("zqbook", null);
    ok(J(a.names.slice().sort()) === J(["Zqbook Outlet", "Zqbook Shop"]), "s2 r1 zqbook any: both merchants (" + J(a.names) + ")");
    a = await open("zqbook", "store");
    ok(J(a.names) === J(["Zqbook Shop"]) && J(a.rows) === J(["zb-usb"]), "s2 r1 zqbook in store: the answer names the merchant the list shows (" + J([a.names, a.rows]) + ")");
    a = await open("zqweb", "store");
    ok(J(a.names) === J(["Zqweb Cafe"]) && /^Ready now: /.test(a.heads[0] || "") && /^Online: /.test(a.alt || "") && !a.rows.length,
      "s2 r1 zqweb in store: no in-store offer, still answered, with the Online line (" + J([a.heads, a.alt]) + ")");
    a = await open("zqweb", null);
    ok(a.chanRows.length === 2 && /add to Discover it/.test(a.chanRows[1]) && !/after activating/.test(a.chanRows[1]),
      "s2 r1 compact rows keep \"add to <card>\", not \"after activating\" (" + J(a.chanRows) + ")");
    a = await open("la colombe", null);
    ok(!/Likely/.test(a.chanRows[0]) && /Likely/.test(a.chanRows[1]), "s2 r1 Likely only on the row whose total has a category rate (" + J(a.chanRows) + ")");
    // (Review round 2: as on main, a match through a cuisine detail doesn't stop the merchant answer; the same
    // shape under every channel.)
    for (const ch of [null, "store", "online"]) {
      a = await open("burmese", ch);
      ok(J(a.names) === J(["Irrawaddy Taste of Burma"]), "s2 r2 burmese answers its one merchant under " + (ch || "any") + " (" + J([a.names, a.heads[0]]) + ")");
    }
    a = await open("zqknown", "store");
    ok(J(a.names) === J(["Zqknown Shop"]) && /^Online: /.test(a.alt || ""), "s2 r2 one merchant under Any stays the merchant in store, with its Online line (" + J([a.names, a.alt]) + ")");
    a = await open("zqtory", "online");
    ok(J(a.names.slice().sort()) === J(["Zqtory", "Zqtory Outlet"]) && /online shopping 5\.25%/.test(a.rates.sum) &&
      /Online shopping at Zqtory Outlet: channel not shown on 1 offer\./.test(a.rates.nc), "s2 r2 mixed verdicts: counted at Zqtory, Not counted at Zqtory Outlet (" + J(a.rates) + ")");
    a = await open("amazon", "store");
    ok(a.sel && !/Customized Cash/.test(a.text) && !/online shopping/.test(a.rates.sum), "s2 r2 with the selector showing, the keyword merchant follows In store too (" + J([a.text, a.rates]) + ")");
    a = await open("ralphs", null, { "Freedom Flex": "not_confirmed", "Freedom": "not_confirmed" });
    ok(/grocery stores 3\.5% \(5% not activated, below Smartly 4%\)/.test(a.rates.sum), "s2 r1 Card rates summary qualifies a rate below the answer (" + a.rates.sum + ")");
    await open("", null);
    if (await page.locator("#ftoggle").isVisible()) await page.click("#ftoggle");
    await page.locator("#cats button", { hasText: /^Dining/ }).first().click();
    await page.waitForTimeout(150);
    const top = await page.$eval("#use .usetop", e => e.textContent).catch(() => "");
    ok(/^Top offer: Zqcc Diner 30% with Citi Custom Cash, conditional: only if restaurants is your actual top eligible category this cycle\.$/.test(top),
      "s2 r1 Top offer says when its total is conditional (" + top + ")");
    // Step 2A 1: the online shopping rate through offers only for channel "online" (a keyword still qualifies;
    // none_shown still blocks). The Online filter itself still keeps the combined channels.
    for (const [q, want, why] of [["zqonl", true, "an online offer qualifies"], ["zqiso", false, "an in_store_and_online offer alone doesn't"],
      ["zqapp", false, "an in_store_and_app offer alone doesn't"], ["etsy", true, "a keyword store qualifies whatever its offer's channel"],
      ["zqns", false, "an offer with no channel shown blocks it"]]) {
      a = await open(q, "online");
      const cc = /^Ready now: Customized Cash 5\.25%/.test(a.heads[0] || "");
      const sum = a.rates ? a.rates.sum : "";
      ok(cc === want && a.rows.length >= 1 && (want ? /online shopping 5\.25%/.test(sum) : !/online shopping/.test(sum)),
        "s2a online shopping: " + why + " (" + J([a.heads[0], a.rates, a.rows]) + ")");
    }
    a = await open("zqmixo", "online");
    ok(!/^Ready now: Customized Cash/.test(a.heads[0] || "") && /: 1 offer at Zqmixo Gadgets also works in store or in an app\./.test(a.rates.nc),
      "s2a an online offer next to an in_store_and_online one: not counted, and Not counted says why (" + J([a.heads[0], a.rates.nc]) + ")");
    // Step 2A 2: the count line, from the list's own channel rules.
    const count = () => page.textContent("#count");
    for (const [q, ch, want] of [["la colombe", "store", "1 offer shown for In store · 3 online only hidden"],
      ["la colombe", "online", "3 offers shown for Online · 1 in store only hidden"], ["la colombe", null, "4 offers · 3 online only · 1 in store only"],
      ["coffee bean", "online", "3 offers shown for Online · 2 channel not shown"],
      ["coffee bean", "store", "2 offers shown for In store · 2 channel not shown · 1 online only hidden"],
      ["coffee bean", null, "3 offers · 1 online only · 2 channel not shown"],
      ["zqiso", "store", "1 offer shown for In store"], ["zqapp", null, "1 offer · 1 in store & app"]]) {
      a = await open(q, ch);
      const c = await count();
      ok(c === want && (/(\d+) offers? /.exec(c) || [0, -1])[1] == a.rows.length, "s2a count line, " + q + " " + (ch || "any") + ": \"" + c + "\" (" + a.rows.length + " rows)");
    }
    // Step 2A 3: compact rows keep their one short condition (and the activation wording).
    a = await open("zqcond", null);
    ok(a.chanRows.length === 2 && /^In store: Smartly 14% ready now \(first \$60\)/.test(a.chanRows[0]) &&
      /Freedom Flex 20% after activating \(ends Nov 9\)/.test(a.chanRows[1]), "s2a compact rows keep first $60 / ends Nov 9 (" + J(a.chanRows) + ")");
    a = await open("zqcond", "store");
    ok(/^Online: Freedom Flex 20% after activating \(ends Nov 9\)/.test(a.alt || "") && /first \$60/.test(a.heads[0]), "s2a the other-channel row keeps its condition (" + J([a.heads[0], a.alt]) + ")");
    a = await open("zqcond", "online");
    ok(/^After activating: Freedom Flex 20% \(5% dining \+ 15% Chase offer, ends Nov 9\)/.test(a.heads[1] || ""), "s2a under Online the full line keeps ends Nov 9, not a repeated online (" + a.heads[1] + ")");
    a = await open("zqweb", null);
    ok(/Discover it 16% add to Discover it/.test(a.chanRows[1] || ""), "s2a compact rows still say add to <card> (" + a.chanRows[1] + ")");
    a = await open("zqtri", "online");
    ok(/channel not shown on 1 offer at Zqtri · 1 offer at Zqtri Shop also works in store or in an app\./.test(a.rates.nc),
      "s2a review: Not counted gives each merchant its own reason (" + a.rates.nc + ")");
    a = await open("instacart", null);
    ok(/ready now \(first \$50, may not count\) · else Smartly 4%/.test(a.chanRows[0] || "") && !/\) \(/.test(a.chanRows[0] || ""),
      "s2a review: one condition group on a compact row, may not count inside it (" + a.chanRows[0] + ")");
    ok(!errs.length, "s2: no page errors (" + errs.join("; ") + ")");

    // The real merchant-locations.json (52 groups when this was written) with the real offers: it loads, and a
    // grouped name with live offers on more than one member is one answer, every record still its own row.
    await page.unroute("**/data/offers.json");
    await page.unroute("**/data/merchant-locations.json");
    await page.unroute("**/data/bonus-categories.json");
    const locs = JSON.parse(fs.readFileSync(path.join(SITE, "data/merchant-locations.json"))).groups;
    const nMembers = Object.values(locs).reduce((n, l) => n + l.length, 0);
    const live = real.offers.filter(o => o.status === "active" && !(o.expires && o.expires < "2026-11-04"));
    const key = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\.(com|net|org)\b/gi, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const pickG = Object.keys(locs).find(g => { const ms = new Set(locs[g].map(key).concat([key(g)])); return new Set(live.filter(o => ms.has(key(o.merchant))).map(o => key(o.merchant))).size >= 2; });
    a = await open(pickG ? pickG : "zzqx", null);
    const nLoc = await page.evaluate(() => window.__locations);
    ok(nLoc === nMembers && nMembers > 0, "s2 real locations file: " + nLoc + " approved members loaded (file has " + Object.keys(locs).length + " groups, " + nMembers + " members)");
    if (!pickG) skip("s2 real locations file: no group with live offers on two names");
    else {
      const want = live.filter(o => new Set(locs[pickG].map(key).concat([key(pickG)])).has(key(o.merchant))).length;
      ok(!a.names.some(n => n !== pickG) && /Ready now: |^In store: |^Use/m.test(a.text) && a.rows.length >= want,
        "s2 real locations file: \"" + pickG + "\" is one answer (" + (J(a.names) || "[]") + "), its " + want + " offers all listed (" + a.rows.length + " rows)");
    }
    await ctx2.close();
    page = mainPage;
  }

  // Step 3, merchant containers in result lists, on fixed fixture offers (offers.json replaced by these only) with a
  // fixed clock (noon, Nov 4, 2026) and an approved Round Table Pizza location. The answer card and the count line
  // are compared with the base app.js (main, without containers) on the same fixtures.
  {
    const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    page = await ctx3.newPage();
    const errs = [];
    page.on("pageerror", e => errs.push(e.message));
    await page.clock.install({ time: new Date(2026, 10, 4, 12, 0, 0) });
    const real = JSON.parse(fs.readFileSync(path.join(SITE, "data/offers.json")));
    const fx = (id, card, merchant, category, bonus, extra) => Object.assign({ id: "test/s3-" + id, card, merchant, category, bonus,
      expires: null, expires_text: null, activation: "already_activated", channel: "in_store", spend_cap: null, minimum_spend: null,
      fine_print: null, other_details: [], last_read: "2026-10-18", first_seen: "2026-10-18", status: "active", status_since: "2026-10-18" }, extra || {});
    const FX = [
      // Coffee Bean & Tea Leaf (the Step 2 shape): two Chase offers with no channel shown, Capital One $10 on $20+ online.
      fx("cb-flex", "Chase Freedom Flex", "Coffee Bean & Tea Leaf", "Dining", "10% cash back", { activation: "needs_activation", channel: "none_shown",
        fine_print: "Earn 10% cash back with a $2 cash back maximum." }),
      fx("cb-free", "Chase Freedom", "Coffee Bean & Tea Leaf", "Dining", "10% cash back", { activation: "needs_activation", channel: "none_shown",
        fine_print: "Earn 10% cash back with a $2 cash back maximum." }),
      fx("cb-c1", "Capital One", "Coffee Bean & Tea Leaf", "Dining", "Spend $20, earn $10", { activation: "none_shown", channel: "online" }),
      // Round Table Pizza: the approved Newport Beach member, Chase x2, U.S. Bank, BofA 10% and 4% (two rows on one
      // card), and an unapproved Irvine name that stays its own merchant.
      fx("rt-flex", "Chase Freedom Flex", "Round Table Pizza", "Dining", "10% cash back", { activation: "needs_activation", channel: "none_shown" }),
      fx("rt-free", "Chase Freedom", "Round Table Pizza", "Dining", "10% cash back", { activation: "needs_activation", channel: "none_shown" }),
      fx("rt-usb", "U.S. Bank", "Round Table Pizza", "Dining", "6% cash back"),
      fx("rt-boa10", "Bank of America", "Round Table Pizza", "Dining", "10% Cash back", { activation: "auto_enrolled" }),
      fx("rt-boa4", "Bank of America", "Round Table Pizza", "Dining", "4% Cash back", { activation: "auto_enrolled", other_details: ["3 locations listed"] }),
      fx("rt-nb", "Bank of America", "Round Table Pizza - Newport Beach", "Dining", "20% Cash back", { fine_print: "Zq Newport Beach terms only" }),
      fx("rt-irv", "Bank of America", "Round Table Pizza - Irvine", "Dining", "2% Cash back"),
      // La Colombe: Chase 15% online x2, U.S. Bank 15% in store and 15% online.
      fx("lc-flex", "Chase Freedom Flex", "La Colombe", "Dining", "15% cash back", { activation: "needs_activation", channel: "online", expires: "2026-11-29" }),
      fx("lc-free", "Chase Freedom", "La Colombe", "Dining", "15% cash back", { activation: "needs_activation", channel: "online", expires: "2026-11-29" }),
      fx("lc-usb", "U.S. Bank", "La Colombe", "Dining", "15% cash back", { channel: "in_store", expires: "2026-11-27" }),
      fx("lc-usb-2", "U.S. Bank", "La Colombe", "Dining", "15% cash back", { channel: "online", expires: "2026-11-29" }),
      // Panda Express: a BofA merchant offer needing activation and a BofA Shop now offer, on the same card.
      fx("pe-boa", "Bank of America", "Panda Express", "Dining", "5% Cash back", { activation: "needs_activation" }),
      fx("pe-boa-2", "Bank of America", "Panda Express", "Dining", "Save 20%", { activation: "via_shop_link", channel: "online" }),
      // Identity: three JetBlue merchants (an alias groups nothing), two KitchenAid merchants (no " - " grouping).
      fx("jb", "Citi Double Cash", "JetBlue", "Travel", "$50 Back", { activation: "needs_activation", channel: "none_shown" }),
      fx("jb-points", "Citi Double Cash", "JetBlue TrueBlue Points", "Travel", "5% Back", { activation: "needs_activation", channel: "none_shown", aliases: ["JetBlue"] }),
      fx("jb-vac", "Citi Double Cash", "jetBlue Vacations", "Travel", "4% Back", { activation: "needs_activation", channel: "none_shown" }),
      fx("ka-major", "Capital One", "KitchenAid - Major Appliances", "Home & Garden", "5% back", { activation: "none_shown", channel: "online" }),
      fx("ka-counter", "Capital One", "KitchenAid - Countertop Appliances", "Home & Garden", "3% back", { activation: "none_shown", channel: "online" }),
      // Sorting: Alpha has one excellent and one weak row, Bravo two medium ones, Charlie a dollar offer (U.S. Bank:
      // every percent offer adds Smartly 4%).
      fx("zs-a30", "U.S. Bank", "Zqsort Alpha", "Clothing & Jewelry", "30% cash back", { first_seen: "2026-10-18" }),
      fx("zs-a1", "U.S. Bank", "Zqsort Alpha", "Clothing & Jewelry", "1% cash back", { first_seen: "2026-10-31", expires: "2026-11-06" }),
      fx("zs-b12", "U.S. Bank", "Zqsort Bravo", "Clothing & Jewelry", "12% cash back", { first_seen: "2026-10-25", expires: "2026-11-20" }),
      fx("zs-b11", "U.S. Bank", "Zqsort Bravo", "Clothing & Jewelry", "11% cash back", { first_seen: "2026-10-18", expires: "2026-11-10" }),
      fx("zs-c", "U.S. Bank", "Zqsort Charlie", "Clothing & Jewelry", "Spend $50, earn $25", { first_seen: "2026-10-20", expires: "2026-11-08" }),
      // Recently unavailable: one merchant, three unavailable rows (missing, expired, past its end date) and a used one.
      fx("zg-miss", "U.S. Bank", "Zqgone Deli", "Dining", "8% cash back", { status: "missing", status_since: "2026-11-01" }),
      fx("zg-exp", "U.S. Bank", "Zqgone Deli", "Dining", "5% cash back", { status: "expired", expires: "2026-10-30", status_since: "2026-10-31" }),
      fx("zg-past", "Chase Freedom", "Zqgone Deli", "Dining", "6% cash back", { activation: "needs_activation", channel: "none_shown", expires: "2026-11-01" }),
      fx("zg-used", "U.S. Bank", "Zqgone Deli", "Dining", "9% cash back", { status: "used", status_since: "2026-11-02", other_details: ["Used on Smartly"] }),
      fx("zg-live", "Capital One", "Zqgone Deli", "Dining", "3% back", { activation: "none_shown", channel: "online" }),
      // Review round 1: an approved group whose base row sorts first and whose member has more rows than the base.
      fx("zgr-base", "U.S. Bank", "Zqgroup Diner", "Clothing & Jewelry", "30% cash back"),
      fx("zgr-n1", "U.S. Bank", "Zqgroup Diner - North Hills", "Clothing & Jewelry", "10% cash back"),
      fx("zgr-n2", "U.S. Bank", "Zqgroup Diner - North Hills", "Clothing & Jewelry", "8% cash back"),
      // Step 3A: Ali Baba (a restaurant) and Alibaba (a marketplace) are two merchants; Amazon / Amazon.com stay one.
      fx("ab-rest", "Bank of America", "Ali Baba", "Dining", "4% Cash back", { activation: "auto_enrolled" }),
      fx("ab-mkt", "Capital One", "Alibaba", "Marketplaces & Department Stores", "Up to 4% back", { activation: "none_shown", channel: "online" }),
      fx("am-usb", "U.S. Bank", "Zqamazon", "Marketplaces & Department Stores", "5% cash back"),
      fx("am-c1", "Capital One", "Zqamazon.com", "Marketplaces & Department Stores", "3% back", { activation: "none_shown", channel: "online" }),
      fx("zsh-c1", "Capital One", "Zqshopx.com", "Clothing & Jewelry", "6% back", { activation: "none_shown", channel: "online" }),
      fx("zdn-c1", "Capital One", "Zqdinerx.com", "Dining", "6% back", { activation: "none_shown", channel: "online" }),
      // Step 3A: a Custom Cash row whose total adds the planned restaurants 5% (conditional), and one in a category
      // the plan doesn't cover (its 1% base rate, certain).
      fx("cc-dine", "Citi Custom Cash", "Zqcc Bistro", "Dining", "5% Back", { activation: "needs_activation", channel: "none_shown" }),
      fx("cc-shop", "Citi Custom Cash", "Zqcc Boutique", "Clothing & Jewelry", "5% Back", { activation: "needs_activation", channel: "none_shown" })
    ];
    // Paging: 65 merchants, the 60th (the last on the first page) with 8 offers, its 7 weaker ones below the best of
    // the 5 merchants after it.
    for (let i = 1; i <= 65; i++) {
      const m = "Zqpage " + String(i).padStart(3, "0");
      FX.push(fx("zp-" + i, "U.S. Bank", m, "Clothing & Jewelry", (100 - i) + "% cash back"));
      if (i === 60) for (let k = 1; k <= 7; k++) FX.push(fx("zp-60-" + k, "U.S. Bank", m, "Clothing & Jewelry", k + "% cash back"));
    }
    const LOCS = { groups: { "Round Table Pizza": ["Round Table Pizza - Newport Beach"], "Zqgroup Diner": ["Zqgroup Diner - North Hills"] } };
    await page.route("**/data/offers.json", r => r.fulfill({ json: Object.assign({}, real, { offers: FX }) }));
    await page.route("**/data/phone-edits.json", r => r.fulfill({ json: {} }));
    await page.route("**/data/merchant-locations.json", r => r.fulfill({ json: LOCS }));
    const open = async (q, chan, sort, opts) => {
      await page.goto(base);
      await page.evaluate(([c, s]) => { try { localStorage.clear(); if (c) localStorage.setItem("cardselector.channel", c); if (s) localStorage.setItem("cardselector.sort", s); } catch (e) {} }, [chan || null, sort || null]);
      await page.goto(base);
      await page.waitForFunction(() => window.__cardsReady && window.__bonusReady && document.querySelectorAll("#cards button").length > 1);
      if (opts && opts.card) {
        if (await page.locator("#ftoggle").isVisible()) await page.click("#ftoggle");
        await page.locator("#cards button", { hasText: new RegExp("^" + opts.card) }).first().click();
      }
      await page.fill("#q", q);
      await page.waitForTimeout(150);
      return view();
    };
    const view = () => page.evaluate(() => {
      const u = document.getElementById("use");
      const mc = m => ({ name: m.querySelector(".mcname").textContent, sub: m.querySelector(".mcsub").textContent, gone: m.classList.contains("gone"),
        exp: m.querySelector(".mchead").getAttribute("aria-expanded"),
        rows: [...m.querySelectorAll("li.offer")].map(li => ({ id: li.dataset.oid.replace(/^test\/s3-/, ""), loc: (li.querySelector(".loctag") || {}).textContent || null,
          big: li.querySelector(".obig").textContent, sub: (li.querySelector(".omin") || {}).textContent || null, status: li.querySelector(".ostat").textContent,
          brk: li.querySelector(".obreak").textContent, terms: li.querySelector(".oterms").textContent, gone: li.classList.contains("gone"),
          isNew: !!li.querySelector(".newtag"), card: li.querySelector(".mcard").textContent })) });
      return {
        ans: u.hidden ? "" : [...u.children].filter(c => !c.matches(".chansel, details.rates")).map(c => c.innerText).join("\n"),
        count: document.getElementById("count").textContent,
        mcs: [...document.querySelectorAll("#main > ul.results > li.mc")].map(mc),
        gone: [...document.querySelectorAll("#main details.expired li.mc")].map(mc),
        more: (document.querySelector("#main > button.more:not([hidden])") || {}).textContent || null
      };
    });
    const J = x => JSON.stringify(x);
    const ids = v => v.mcs.map(m => m.name + ": " + m.rows.map(r => r.id).join(" "));
    // The answer card and count line on main's app.js, same fixtures (null when git has no base).
    const onBase = async (q, chan) => {
      if (!baseApp) return null;
      await page.route("**/js/app.js", route => route.fulfill({ body: baseApp, contentType: "text/javascript" }));
      const v = await open(q, chan);
      await page.unroute("**/js/app.js");
      return v;
    };
    const sameAsBase = async (q, chan, v) => {
      const b = await onBase(q, chan);
      if (!b) return skip("s3 " + q + " " + (chan || "any") + ": no base app.js, answer card not compared");
      ok(b.ans === v.ans && b.count === v.count, "s3 " + q + " " + (chan || "any") + ": answer card and count line as on " + baseRef + " (" + J([v.ans.split("\n")[0], v.count]) + ")" +
        (b.ans === v.ans && b.count === v.count ? "" : " base: " + J([b.ans, b.count]) + " now: " + J([v.ans, v.count])));
    };

    // Coffee Bean & Tea Leaf, Any: one container, three rows, the Step 2 count line; In store: the two Chase rows
    // with no channel shown; Online: all three, the Chase rows still "channel not shown".
    let v = await open("coffee bean", null);
    ok(J(ids(v)) === J(["Coffee Bean & Tea Leaf: cb-free cb-flex cb-c1"]) && v.mcs[0].sub === "Cafés, Coffee & Tea · 3 offers",
      "s3 Coffee Bean any: one container, three rows (Chase by total, then the dollar offer), header \"Cafés, Coffee & Tea · 3 offers\" (" + J([ids(v), v.mcs[0] && v.mcs[0].sub]) + ")");
    ok(v.count === "3 offers · 1 online only · 2 channel not shown", "s3 Coffee Bean any: count line " + J(v.count));
    const cbRow = id => v.mcs[0].rows.find(r => r.id === id);
    ok(cbRow("cb-flex").big === "15%" && cbRow("cb-flex").brk === "10% Chase offer + 5% dining" && cbRow("cb-flex").status === "Activate" &&
      /^Channel not shown · Max \$2$/.test(cbRow("cb-flex").terms),
      "s3 Coffee Bean: the Chase row shows its total big, the breakdown, Activate and its terms (" + J(cbRow("cb-flex")) + ")");
    ok(cbRow("cb-c1").big === "$10" && cbRow("cb-c1").sub === "on $20+" && cbRow("cb-c1").status === "Add to card" && /^Online$/.test(cbRow("cb-c1").terms) &&
      /^Spend \$20, earn \$10 · Capital One offer$/.test(cbRow("cb-c1").brk), "s3 Coffee Bean: the dollar row shows $10 on $20+, Add to card (" + J(cbRow("cb-c1")) + ")");
    await sameAsBase("coffee bean", null, v);
    v = await open("coffee bean", "store");
    ok(J(ids(v)) === J(["Coffee Bean & Tea Leaf: cb-free cb-flex"]) && v.mcs[0].sub === "Cafés, Coffee & Tea · 2 offers" &&
      v.mcs[0].rows.every(r => /^Channel not shown/.test(r.terms)), "s3 Coffee Bean in store: one container, the two Chase rows, Capital One hidden (" + J(ids(v)) + ")");
    await sameAsBase("coffee bean", "store", v);
    v = await open("coffee bean", "online");
    ok(J(ids(v)) === J(["Coffee Bean & Tea Leaf: cb-free cb-flex cb-c1"]) && v.mcs[0].rows.filter(r => /^Channel not shown/.test(r.terms)).length === 2,
      "s3 Coffee Bean online: one container, all three rows, the Chase rows still say channel not shown (" + J(ids(v)) + ")");
    await sameAsBase("coffee bean", "online", v);

    // Round Table Pizza: one container for the approved group, every offer its own row (BofA 10% and 4% apart), the
    // Newport Beach row tagged with its place; Irvine (not approved) is its own container with no tag.
    v = await open("round table", null);
    ok(J(ids(v)) === J(["Round Table Pizza: rt-nb rt-free rt-flex rt-boa10 rt-usb rt-boa4", "Round Table Pizza - Irvine: rt-irv"]),
      "s3 Round Table: one approved container (by total, the Newport Beach 20% first), Irvine apart and after it (" + J(ids(v)) + ")");
    const rtRows = v.mcs[0].rows;
    ok(rtRows.find(r => r.id === "rt-nb").loc === "Newport Beach" && rtRows.filter(r => r.loc).length === 1 && !v.mcs[1].rows[0].loc,
      "s3 Round Table: only the approved member's row has a location tag (Newport Beach); Irvine has none (" + J(rtRows.map(r => r.loc)) + ")");
    ok(v.mcs[0].sub === "Italian & Pizza · 6 offers" && v.mcs[1].sub === "Dining · 1 offer", "s3 Round Table: header cuisine and offer counts (\"" + v.mcs[0].sub + "\", \"" + v.mcs[1].sub + "\")");
    ok(rtRows.find(r => r.id === "rt-boa10").big === "12.63%" && rtRows.find(r => r.id === "rt-boa4").big === "6.63%" &&
      rtRows.find(r => r.id === "rt-boa10").brk === "10% BofA offer + 2.63% Unlimited Cash", "s3 Round Table: BofA 10% and 4% are two rows with their own totals (" + J(rtRows.filter(r => /boa/.test(r.id))) + ")");
    await sameAsBase("round table", null, v);
    v = await open("round table", "store");
    ok(v.mcs.length === 2 && v.mcs[0].rows.length === 6, "s3 Round Table in store: the same containers (" + J(ids(v)) + ")");
    await sameAsBase("round table", "store", v);

    // La Colombe: one container under each channel; the channel changes its rows, not the container.
    for (const [ch, want] of [[null, ["lc-free", "lc-flex"]], ["store", ["lc-usb"]], ["online", ["lc-free", "lc-flex", "lc-usb-2"]]]) {
      v = await open("la colombe", ch);
      const got = v.mcs.length === 1 ? v.mcs[0].rows.map(r => r.id) : null;
      ok(got && J(got.slice(0, want.length)) === J(want) && got.length === (ch ? want.length : 4) && v.mcs[0].sub === "Cafés, Coffee & Tea · " + got.length + (got.length === 1 ? " offer" : " offers"),
        "s3 La Colombe " + (ch || "any") + ": one container, rows in total order (" + J(ids(v)) + ")");
      await sameAsBase("la colombe", ch, v);
    }

    // Panda Express: two offers on one card, two rows with their own statuses; the Shop now offer says so.
    v = await open("panda express", null);
    const pe = v.mcs.length === 1 ? v.mcs[0].rows : [];
    ok(J(pe.map(r => [r.id, r.status])) === J([["pe-boa", "Activate"], ["pe-boa-2", "Shop link"]]) && /Shop now link only/.test(pe[1].terms) && pe[1].big === "Save 20%",
      "s3 Panda Express: two rows on one BofA card, Activate and Shop link (" + J(pe) + ")");
    await sameAsBase("panda express", null, v);

    // JetBlue: three containers (the alias groups nothing); KitchenAid: two, with no location tags.
    v = await open("jetblue", null);
    ok(J(v.mcs.map(m => m.name).sort()) === J(["JetBlue", "JetBlue TrueBlue Points", "jetBlue Vacations"]) && v.mcs.every(m => m.rows.length === 1),
      "s3 JetBlue: three containers (" + J(ids(v)) + ")");
    await sameAsBase("jetblue", null, v);
    v = await open("kitchenaid", null);
    ok(J(v.mcs.map(m => m.name)) === J(["KitchenAid - Major Appliances", "KitchenAid - Countertop Appliances"]) && v.mcs.every(m => m.rows.every(r => !r.loc)),
      "s3 KitchenAid: two containers, no location tags (" + J(ids(v)) + ")");
    await sameAsBase("kitchenaid", null, v);

    // Sorting: containers rank by their best row under the sort, rows inside follow the same comparator.
    const SORTED = {
      best: ["Zqsort Alpha: zs-a30 zs-a1", "Zqsort Bravo: zs-b12 zs-b11", "Zqsort Charlie: zs-c"],
      percent: ["Zqsort Alpha: zs-a30 zs-a1", "Zqsort Bravo: zs-b12 zs-b11", "Zqsort Charlie: zs-c"],
      dollar: ["Zqsort Charlie: zs-c", "Zqsort Alpha: zs-a30 zs-a1", "Zqsort Bravo: zs-b12 zs-b11"],
      rate: ["Zqsort Charlie: zs-c", "Zqsort Alpha: zs-a30 zs-a1", "Zqsort Bravo: zs-b12 zs-b11"],
      az: ["Zqsort Alpha: zs-a30 zs-a1", "Zqsort Bravo: zs-b12 zs-b11", "Zqsort Charlie: zs-c"],
      za: ["Zqsort Charlie: zs-c", "Zqsort Bravo: zs-b12 zs-b11", "Zqsort Alpha: zs-a30 zs-a1"],
      newest: ["Zqsort Alpha: zs-a1 zs-a30", "Zqsort Bravo: zs-b12 zs-b11", "Zqsort Charlie: zs-c"],
      oldest: ["Zqsort Alpha: zs-a30 zs-a1", "Zqsort Bravo: zs-b11 zs-b12", "Zqsort Charlie: zs-c"],
      expiring: ["Zqsort Alpha: zs-a1 zs-a30", "Zqsort Charlie: zs-c", "Zqsort Bravo: zs-b11 zs-b12"]
    };
    for (const [mode, want] of Object.entries(SORTED)) {
      v = await open("zqsort", null, mode);
      ok(J(ids(v)) === J(want), "s3 sort " + mode + ": " + J(ids(v)));
    }
    v = await open("zqsort", null, "best");
    ok(J(v.mcs[0].rows.map(r => r.big)) === J(["34%", "5%"]) && v.mcs[1].rows[0].big === "16%",
      "s3 sort best: Alpha's 5% row stays in its container above Bravo's 16% (a container ranks by its best row) (" + J(v.mcs.map(m => m.rows.map(r => r.big))) + ")");

    // Review round 1: the group's name heads its container whichever row comes first (the base under most sorts, the
    // member under Z to A), even when a member has more rows; only the member rows are tagged.
    for (const mode of ["best", "az", "za", "newest", "oldest", "expiring"]) {
      v = await open("zqgroup", null, mode);
      ok(J(v.mcs.map(m => [m.name, m.rows.map(r => r.id + (r.loc ? "@" + r.loc : ""))])) === J([["Zqgroup Diner", mode === "za" ? ["zgr-n1@North Hills", "zgr-n2@North Hills", "zgr-base"] : ["zgr-base", "zgr-n1@North Hills", "zgr-n2@North Hills"]]]),
        "s3 r1 group name heads its container under " + mode + " (base first, member with more rows) (" + J(v.mcs.map(m => [m.name, m.rows.map(r => r.id + (r.loc ? "@" + r.loc : ""))])) + ")");
    }

    // Step 3A: Ali Baba and Alibaba are separate containers and separate answer merchants (the named exception);
    // Zqamazon and Zqamazon.com are one (".com" dropped, as before).
    v = await open("alibaba", null);
    ok(J(v.mcs.map(m => m.name + ": " + m.rows.map(r => r.id).join(" ")).sort()) === J(["Ali Baba: ab-rest", "Alibaba: ab-mkt"]),
      "s3a Ali Baba and Alibaba: two containers (" + J(ids(v)) + ")");
    const abNames = await page.$$eval("#use .usemname, #use .useat", es => es.map(e => e.textContent.replace(/:\s*$/, "").replace(/^At /, "")).sort());
    ok(J(abNames) === J(["Ali Baba", "Alibaba"]), "s3a Ali Baba and Alibaba: two merchants in the answer card (" + J(abNames) + ")");
    // The "At <merchant>" lead follows the same identity: "alibaba" answered for the restaurant names it.
    // Ordinary names compare as in Step 2: "zqshopx" is not "Zqshopx.com" (lead shown), "zqshopx com" is (no lead).
    for (const [q, ch, want] of [["alibaba", "store", "At Ali Baba"], ["ali baba", "online", "At Alibaba"], ["ali baba", "store", null],
      ["zqshopx", null, "At Zqshopx.com"], ["zqshopx com", null, null], ["zqshopx.com", null, null]]) {
      await open(q, ch);
      const at = await page.$$eval("#use .useat", es => es.map(e => e.textContent));
      ok(J(at) === J(want ? [want] : []), "s3a \"" + q + "\" " + ch + ": lead " + J(at));
    }
    // The bonus rows' lead keeps Step 2's test too: "zqdinerx" is the merchant Zqdinerx.com (merchant identity), so its
    // dining row has no "Dining at Zqdinerx.com" lead; "alibaba" in store matched the restaurant, so it has one.
    for (const [q, ch, want] of [["zqdinerx", null, false], ["alibaba", "store", true]]) {
      await open(q, ch);
      const leads = await page.$$eval("#use details.bonusrow .bhead", es => es.map(e => e.textContent));
      ok(leads.length && leads.some(l => / at /.test(l)) === want, "s3a bonus-row lead for \"" + q + "\" " + (ch || "any") + ": " + J(leads));
    }
    v = await open("zqamazon", null);
    ok(J(ids(v)) === J(["Zqamazon: am-usb am-c1"]) && v.mcs[0].sub === "Marketplaces & Department Stores · 2 offers",
      "s3a Zqamazon and Zqamazon.com: one container, as before (" + J(ids(v)) + ")");
    // Step 3A: a Custom Cash row's planned-category rate is marked conditional; the total and order are unchanged.
    v = await open("zqcc", null);
    const ccRow = id => v.mcs.flatMap(m => m.rows).find(r => r.id === id) || {};
    ok(ccRow("cc-dine").brk === "5% Citi offer + 5% dining (conditional)" && ccRow("cc-dine").big === "10%",
      "s3a Custom Cash with its planned 5%: the card rate reads conditional, the total stays 10% (" + J(ccRow("cc-dine")) + ")");
    ok(ccRow("cc-shop").brk === "5% Citi offer + 1% Citi Custom Cash" && ccRow("cc-shop").big === "6%",
      "s3a Custom Cash with no conditional rate added: no label (" + J(ccRow("cc-shop")) + ")");
    ok(J(v.mcs.map(m => m.name)) === J(["Zqcc Bistro", "Zqcc Boutique"]), "s3a Custom Cash rows rank by the same totals (" + J(ids(v)) + ")");
    v = await open("coffee bean", null);
    ok(v.mcs[0].rows.filter(r => /^cb-f/.test(r.id)).every(r => r.brk === "10% Chase offer + 5% dining"),
      "s3a an activated Chase dining rate is certain: no conditional label (" + J(v.mcs[0].rows.map(r => r.brk)) + ")");
    if (baseApp) {
      // The big numbers are today's offerTotal(): main's rows show the same totals in the same order.
      await page.route("**/js/app.js", route => route.fulfill({ body: baseApp, contentType: "text/javascript" }));
      await open("zqcc", null);
      const baseTot = await page.$$eval("#main li.offer", ls => ls.map(li => li.dataset.oid.replace(/^test\/s3-/, "") + " " +
        ((li.querySelector(".obig") || li.querySelector(".bonus .total") || {}).textContent || "").replace(/ with .*$/, "")));
      await page.unroute("**/js/app.js");
      ok(J(baseTot) === J(["cc-dine 10%", "cc-shop 6%"]), "s3a Custom Cash totals and order as on " + baseRef + " (" + J(baseTot) + ")");
    }

    // Paging: 60 containers on the first page, the 60th whole (8 rows); Show more adds the last 5 whole; every
    // record once. The count line still counts offers.
    v = await open("zqpage", null);
    const pageIds = v.mcs.flatMap(m => m.rows.map(r => r.id));
    ok(v.mcs.length === 60 && v.mcs[59].name === "Zqpage 060" && v.mcs[59].rows.length === 8 && pageIds.length === 67,
      "s3 paging: the first page is 60 containers, the boundary merchant with all 8 rows (" + v.mcs.length + " containers, " + pageIds.length + " rows, last " + J(v.mcs[59] && [v.mcs[59].name, v.mcs[59].rows.length]) + ")");
    ok(v.more === "Show 5 more merchants (5 left)" && /^72 offers \(showing 67, keep typing to narrow\) · 72 in store only$/.test(v.count),
      "s3 paging: Show more counts merchants, the count line offers (" + J([v.more, v.count]) + ")");
    await page.click("#main > button.more");
    v = await view();
    const allIds = v.mcs.flatMap(m => m.rows.map(r => r.id)), wantIds = FX.filter(o => /^Zqpage /.test(o.merchant)).map(o => o.id.replace(/^test\/s3-/, ""));
    ok(v.mcs.length === 65 && !v.more && allIds.length === wantIds.length && new Set(allIds).size === allIds.length && wantIds.every(i => allIds.includes(i)) &&
      J(v.mcs.slice(0, 60).flatMap(m => m.rows.map(r => r.id))) === J(pageIds), "s3 paging: Show more adds the 5 whole containers; all 72 records once, the first page unchanged (" + v.mcs.length + " containers, " + allIds.length + " rows)");
    v = await open("zqpage", null, null, { card: "U.S. Bank" });
    ok(v.mcs.length === 65 && !v.more, "s3 paging: with a card picked, up to 100 containers on a page (" + v.mcs.length + ")");

    // Recently unavailable: one container, each row with its own status; the used offer is hidden signed out.
    v = await open("zqgone", null);
    const zg = v.gone.length === 1 ? v.gone[0] : null;
    ok(zg && zg.gone && J(zg.rows.map(r => [r.id, r.status])) === J([["zg-miss", "Dropped off Nov 1"], ["zg-past", "Expired Nov 1"], ["zg-exp", "Expired Oct 30"]]) &&
      zg.sub === "Dining · 3 offers", "s3 Recently unavailable: one Zqgone Deli container, each row its own status (" + J(zg) + ")");
    ok(J(ids(v)) === J(["Zqgone Deli: zg-live"]) && !J(v).includes("zg-used"), "s3 Recently unavailable: the live row in the results, the used one hidden signed out (" + J(ids(v)) + ")");

    // Interaction: the header expands and collapses (aria-expanded, aria-controls, keyboard); a row is not a tap
    // target; open rows show their details, the Google search for their own name and the issuer link; no edit
    // controls signed out.
    v = await open("round table", null);
    const head = page.locator("#main li.mc").first().locator("> button.mchead");
    await page.locator("#main li.offer[data-oid='test/s3-rt-nb'] .orow").click();
    ok((await head.getAttribute("aria-expanded")) === "false" && !(await page.locator("#main li.offer .details:visible").count()), "s3 tapping an offer row does nothing (not a tap target)");
    await head.click();
    const opened = await page.evaluate(() => {
      const m = document.querySelector("#main li.mc"), h = m.querySelector(".mchead"), ctl = (h.getAttribute("aria-controls") || "").split(" ").filter(Boolean);
      const nb = m.querySelector("li.offer[data-oid='test/s3-rt-nb']"), g = nb.querySelector("a.glink"), c = nb.querySelector("a.cardlink");
      return { exp: h.getAttribute("aria-expanded"), ctl: ctl.length, all: ctl.every(id => document.getElementById(id) && !document.getElementById(id).hidden),
        rows: m.querySelectorAll("li.offer").length, terms: /Zq Newport Beach terms only/.test(nb.innerText),
        g: g && [g.href, g.target, g.rel], c: c && [c.href, c.target, c.rel], edits: m.querySelectorAll(".edrow button").length, h: Math.round(h.getBoundingClientRect().height) };
    });
    ok(opened.exp === "true" && opened.ctl === 6 && opened.all && opened.terms && opened.h >= 44,
      "s3 the header opens every row's details (aria-expanded, aria-controls naming each), a 44px target (" + J(opened) + ")");
    ok(J(opened.g) === J(["https://www.google.com/search?q=Round%20Table%20Pizza%20-%20Newport%20Beach", "_blank", "noopener noreferrer"]) &&
      J(opened.c) === J(["https://www.bankofamerica.com/", "_blank", "noopener noreferrer"]), "s3 the open location row searches its own name and links its issuer (" + J([opened.g, opened.c]) + ")");
    ok(opened.edits === 0, "s3 signed out: no edit controls in the open container");
    ok(!(await page.locator("#main li.offer:not(:has(.details:visible)) a.glink").count()) && !(await page.locator("#main li.mc").nth(1).locator("a.glink, a.cardlink").count()),
      "s3 closed containers show no link icons (the links are in the open details)");
    await head.focus();
    await page.keyboard.press("Enter");
    ok((await head.getAttribute("aria-expanded")) === "false" && !(await page.locator("#main li.mc").first().locator(".details:visible").count()), "s3 Enter on the header closes it");
    await page.keyboard.press(" ");
    ok((await head.getAttribute("aria-expanded")) === "true", "s3 Space on the header opens it");
    // The open container stays open across a redraw in the same view (a channel change keeps the search).
    await page.click("#use .chansel button[data-ch=store]");
    ok((await page.locator("#main li.mc").first().locator("> button.mchead").getAttribute("aria-expanded")) === "true", "s3 an open container stays open across a redraw");
    ok(!errs.length, "s3: no page errors (" + errs.join("; ") + ")");
    await ctx3.close();
  }

  // Step 3, What changed: New and Gone lists in merchant containers, each Gone group on its own; Still on <cards>
  // follows merchant identity (an approved location and its group are one merchant; an alias or an unapproved
  // " - " name is not).
  {
    const ctx4 = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    page = await ctx4.newPage();
    const J = x => JSON.stringify(x);
    const errs = [];
    page.on("pageerror", e => errs.push(e.message));
    await page.clock.install({ time: new Date(2026, 10, 4, 12, 0, 0) });
    const wx = (id, card, merchant, first, status, since, expires, extra) => Object.assign({ id: "test/s3w-" + id, card, merchant, category: "Dining", bonus: "10% cash back",
      expires: expires || null, expires_text: null, activation: "needs_activation", channel: "none_shown", spend_cap: null, minimum_spend: null, fine_print: null,
      other_details: [], last_read: "2026-10-31", first_seen: first, status, status_since: since }, extra || {});
    const BATCHES = [["Chase Freedom Flex", "2026-10-18"], ["Chase Freedom Flex", "2026-10-31"], ["Bank of America", "2026-10-18"], ["Bank of America", "2026-10-31"],
      ["U.S. Bank", "2026-10-18"], ["Capital One", "2026-10-18"], ["Citi Double Cash", "2026-10-18"]].map(([card, read_date]) => ({ card, read_date, offers_found: 1 }));
    const OFF = [
      // New on Freedom Flex: two offers at the Round Table group (one at the approved Newport Beach member).
      wx("new-rt", "Chase Freedom Flex", "Round Table Pizza", "2026-10-31", "active", "2026-10-31"),
      wx("new-nb", "Chase Freedom Flex", "Round Table Pizza - Newport Beach", "2026-10-31", "active", "2026-10-31", null, { bonus: "12% cash back" }),
      // New on Bank of America, at the member: live, so the group is still on Bank of America.
      wx("new-boa-nb", "Bank of America", "Round Table Pizza - Newport Beach", "2026-10-31", "active", "2026-10-31", null, { activation: "auto_enrolled", channel: "in_store" }),
      // Gone on Freedom Flex: two pulled early (the member and the base), one ended, one dropped with no end date.
      wx("gone-nb", "Chase Freedom Flex", "Round Table Pizza - Newport Beach", "2026-10-18", "missing", "2026-10-31", "2026-11-20"),
      wx("gone-pulled", "Chase Freedom Flex", "Round Table Pizza", "2026-10-18", "missing", "2026-10-31", "2026-11-25", { bonus: "8% cash back" }),
      wx("gone-ended", "Chase Freedom Flex", "Round Table Pizza", "2026-10-18", "expired", "2026-10-31", "2026-10-30", { bonus: "7% cash back" }),
      wx("gone-dropped", "Chase Freedom Flex", "Round Table Pizza", "2026-10-18", "missing", "2026-10-31", null, { bonus: "6% cash back" }),
      // Still live elsewhere: the base on U.S. Bank; an alias of the name (Capital One) and an unapproved location
      // (Citi) that are other merchants.
      wx("usb-rt", "U.S. Bank", "Round Table Pizza", "2026-10-18", "active", "2026-10-18", null, { activation: "already_activated", channel: "in_store" }),
      wx("c1-alias", "Capital One", "Zqround Pies", "2026-10-18", "active", "2026-10-18", null, { activation: "none_shown", channel: "online", aliases: ["Round Table Pizza"] }),
      wx("citi-irv", "Citi Double Cash", "Round Table Pizza - Irvine", "2026-10-18", "active", "2026-10-18"),
      // Step 3A: a gone Ali Baba (restaurant) is still on U.S. Bank (same name, other case), not on Capital One's Alibaba.
      wx("gone-aliba", "Bank of America", "Ali Baba", "2026-10-18", "missing", "2026-10-31", null, { activation: "auto_enrolled", channel: "in_store" }),
      wx("usb-aliba", "U.S. Bank", "ALI BABA", "2026-10-18", "active", "2026-10-18", null, { activation: "already_activated", channel: "in_store" }),
      wx("c1-alibaba", "Capital One", "Alibaba", "2026-10-18", "active", "2026-10-18", null, { category: "Marketplaces & Department Stores", activation: "none_shown", channel: "online" }),
      // And the reverse: a gone Alibaba (marketplace) is still on Capital One, not on U.S. Bank's ALI BABA.
      wx("gone-alibaba", "Bank of America", "Alibaba", "2026-10-18", "missing", "2026-10-31", null, { category: "Marketplaces & Department Stores", activation: "auto_enrolled", channel: "online" })
    ];
    const real = JSON.parse(fs.readFileSync(path.join(SITE, "data/offers.json")));
    await page.route("**/data/offers.json", r => r.fulfill({ json: { categories: real.categories, batches: BATCHES, offers: OFF } }));
    await page.route("**/data/phone-edits.json", r => r.fulfill({ json: {} }));
    await page.route("**/data/merchant-locations.json", r => r.fulfill({ json: { groups: { "Round Table Pizza": ["Round Table Pizza - Newport Beach"] } } }));
    await page.goto(base);
    await page.waitForFunction(() => /active offers loaded/.test(document.body.innerText));
    await page.evaluate(() => { document.getElementById("fresh").open = true; });
    const wv = () => page.evaluate(() => ({
      tabs: [...document.querySelectorAll("#wctabs button")].map(b => b.textContent),
      groups: [...document.querySelectorAll("#main h3.wcgroup")].map(h => h.textContent),
      mcs: [...document.querySelectorAll("#main > ul.results > li.mc")].map(m => {
        let h = m.parentNode.previousElementSibling;
        while (h && !h.matches("h3.wcgroup")) h = h.previousElementSibling;
        return (h ? h.textContent + ": " : "") + m.querySelector(".mcname").textContent + " [" + [...m.querySelectorAll("li.offer")].map(l => l.dataset.oid.replace(/^test\/s3w-/, "") +
          (l.querySelector(".loctag") ? "@" + l.querySelector(".loctag").textContent : "")).join(", ") + "]";
      }),
      still: Object.fromEntries([...document.querySelectorAll("#main li.offer")].map(l => [l.dataset.oid.replace(/^test\/s3w-/, ""), (l.querySelector(".stillon") || {}).textContent || null]))
    }));
    await page.locator("#flist .fhead[data-card='Chase Freedom Flex']").click();
    let w = await wv();
    ok(J(w.tabs) === J(["New 2", "Gone 4"]) && J(w.mcs) === J(["Round Table Pizza [new-nb@Newport Beach, new-rt]"]),
      "s3 what changed New: Freedom Flex's two new offers in one Round Table container, counts unchanged (" + J(w) + ")");
    await page.locator("#wctabs button", { hasText: /^Gone/ }).click();
    w = await wv();
    ok(J(w.groups) === J(["Pulled early 2", "Ended 1", "Dropped 1"]) && J(w.mcs) === J(["Pulled early 2: Round Table Pizza [gone-nb@Newport Beach, gone-pulled]",
      "Ended 1: Round Table Pizza [gone-ended]", "Dropped 1: Round Table Pizza [gone-dropped]"]),
      "s3 what changed Gone: a container in each group, no offer leaves its group to merge (" + J(w) + ")");
    ok(["gone-nb", "gone-pulled", "gone-ended", "gone-dropped"].every(id => w.still[id] === "Still on Bank of America and U.S. Bank"),
      "s3 what changed: Still on follows merchant identity: the Newport Beach member and the base are one merchant; the alias and the unapproved Irvine name don't count (" + J(w.still) + ")");
    if ((await page.getAttribute("#ftoggle", "aria-expanded")) !== "true") await page.click("#ftoggle");
    await page.locator("#cards button", { hasText: /^All cards/ }).click();
    w = await wv();
    ok(J(w.tabs) === J(["New 3", "Gone 6"]), "s3 what changed All cards: counts are offer counts (" + J(w.tabs) + ")");
    ok(w.still["gone-alibaba"] === "Still on Capital One" && w.mcs.some(m => /: Alibaba \[gone-alibaba\]$/.test(m)),
      "s3a what changed: a gone Alibaba is still on Capital One, not on U.S. Bank's ALI BABA (" + J([w.still["gone-alibaba"], w.mcs]) + ")");
    ok(w.still["gone-aliba"] === "Still on U.S. Bank" && w.mcs.some(m => /: Ali Baba \[gone-aliba\]$/.test(m)),
      "s3a what changed: a gone Ali Baba is still on U.S. Bank (ALI BABA), not on Capital One's Alibaba (" + J([w.still["gone-aliba"], w.mcs]) + ")");
    await page.locator("#wctabs button", { hasText: /^New/ }).click();
    w = await wv();
    ok(J(w.mcs) === J(["Round Table Pizza [new-nb@Newport Beach, new-rt, new-boa-nb@Newport Beach]"]), "s3 what changed All cards New: one container, three rows (" + J(w.mcs) + ")");
    ok(!errs.length, "s3 what changed: no page errors (" + errs.join("; ") + ")");
    await ctx4.close();
    page = mainPage;
  }

  // Step 4A, Quick picks on the home screen, on fixture bonus and card files written here (a Q4 2026 quarter, so a
  // quarterly refresh of the real files can't turn these red; only the keyword lists are the real ones) with a fixed
  // clock (noon, Nov 4, 2026, unless a case moves it). Every tile is also checked against the Step 2 answer card for
  // a merchant of the same topic with no percent offer (Ready now, +N more ready, After activating, the strong
  // Citi Custom Cash line): one set of rules, so the two can't disagree.
  {
    const ctx5 = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    page = await ctx5.newPage();
    const errs = [];
    page.on("pageerror", e => errs.push(e.message));
    const real = JSON.parse(fs.readFileSync(path.join(SITE, "data/offers.json")));
    const realBonus = JSON.parse(fs.readFileSync(path.join(SITE, "data/bonus-categories.json")));
    const realCards = JSON.parse(fs.readFileSync(path.join(SITE, "data/cards.json")));
    const J = x => JSON.stringify(x);
    const GROCERY_NOTE = "Grocery stores only, not meal kits, wine clubs or delivery services.";
    const ENT_NOTE = "Discover it: streaming and subscription services are excluded.";
    const dining = { name: "dining", app_categories: ["Dining"], exclude_cuisines: ["Gift Cards & Dining Services"], list: "dining_chains" };
    const grocery = { name: "grocery stores", list: "grocery_stores", button_categories: ["Groceries & Food Delivery"], button_note: GROCERY_NOTE };
    const rot = (id, card, app, match, extra) => Object.assign({ id, card, app_card: app, kind: "rotating", start: "2026-10-01", end: "2026-12-31",
      categories_text: "test quarter", rate: 5, cap_text: "up to $1,500 in combined purchases", activation: "activated", activate_by: "2026-12-14",
      activation_note: null, likely_note: null, strip_note: null, search: true, source_url: "https://example.com/", unconfirmed: null, checked: "2026-10-19", match }, extra || {});
    const std = (id, card, app, kind, rate, match, extra) => rot(id, card, app, match, Object.assign({ kind, start: null, end: null, rate, activation: "not_needed", activate_by: null }, extra));
    const ENTRIES = [
      std("us-bank-smartly/standing", "Smartly", "U.S. Bank", "fixed", 4, [], { everyday: true, strip_note: "first $10,000 per billing cycle, some categories 2%",
        headline_note: "first $10,000 per billing cycle, then 2%; some categories always 2%", cap_text: "4% on the first $10,000 of purchases each billing cycle, then 2%" }),
      rot("chase-freedom-flex/2026-q4", "Freedom Flex", "Chase Freedom Flex", [grocery, dining, { name: "American Red Cross donations", list: "red_cross" }], { short: "Flex" }),
      rot("chase-freedom/2026-q4", "Freedom", "Chase Freedom", [grocery, dining, { name: "American Red Cross donations", list: "red_cross" }]),
      rot("discover-it/2026-q4", "Discover it", "Capital One", [
        Object.assign({}, dining, { caveat_cuisines: { "Bakeries & Desserts": "Discover it: bakeries may not count as restaurants." } }),
        { name: "entertainment", list: "entertainment", button_categories: ["Streaming & Entertainment"], button_note: ENT_NOTE },
        { name: "utilities", list: "utilities", button_categories: ["Services & Utilities"] }], { activate_by: "2026-12-31", activation_note: "5% starts the day you activate" }),
      std("citi-custom-cash/standing", "Citi Custom Cash", "Citi Custom Cash", "top_category", 5, [], { eligible_text: "test", planned: "restaurants",
        cap_text: "up to $500 spent each billing cycle, then 1%", eligible: [
          Object.assign({}, dining, { name: "restaurants", topic: "dining" }),
          { name: "gas stations", topic: "gas stations", list: "gas_stations", button_categories: ["Auto & Gas"] },
          { name: "grocery stores", topic: "grocery stores", list: "grocery_stores", button_categories: ["Groceries & Food Delivery"] },
          { name: "live entertainment", topic: "entertainment", list: "live_entertainment", button_categories: ["Streaming & Entertainment"] }] }),
      std("costco-visa/standing", "Costco Visa", null, "fixed", null, [
        Object.assign({}, dining, { rate: 3 }), { name: "Costco gas", rate: 5, list: "costco_gas" },
        { name: "gas stations", rate: 4, rate_note: "5% at Costco gas", list: "gas_stations", button_categories: ["Auto & Gas"],
          button_note: "Costco Visa: 4% also covers EV charging. Gas at superstores, supermarkets, convenience stores and warehouse clubs other than Costco doesn't count." }],
        { strip_note: "Rewards come as an annual certificate" }),
      std("bank-of-america-customized-cash/standing", "Customized Cash", "Bank of America", "chosen", 3, [
        { name: "grocery stores", rate: 2, list: "grocery_stores", button_categories: ["Groceries & Food Delivery"], button_note: GROCERY_NOTE },
        { name: "wholesale clubs", rate: 2, list: "wholesale_clubs" }], { choices_text: "test", choice: "online shopping", choices: [
          { name: "gas & EV charging stations", topic: "gas stations", list: ["gas_stations", "ev_charging"], button_categories: ["Auto & Gas"] },
          { name: "online shopping", topic: "online shopping", channel: "online", list: ["online_stores", "telecom", "select_streaming"] },
          Object.assign({}, dining, { name: "dining", topic: "dining" })],
        cap_text: "up to $2,500 each quarter, combined with the 2% grocery and wholesale club purchases, then 1%" })
    ];
    // One merchant per topic for the Step 2 comparison: a Capital One "$5 back" (a dollar offer with no minimum never
    // adds to a rate), matched by app category (Dining) or by a keyword of the topic's list.
    const fx = (id, merchant, category, channel) => ({ id: "test/qp-" + id, card: "Capital One", merchant, category, bonus: "$5 back", expires: null,
      expires_text: null, activation: "none_shown", channel, spend_cap: null, minimum_spend: null, fine_print: null, other_details: [],
      last_read: "2026-10-18", first_seen: "2026-10-18", status: "active", status_since: "2026-10-18" });
    const PAR = { "Dining": ["zqdine grill", null], "Grocery stores": ["ralphs", null], "Online shopping": ["temu", "online"],
      "Gas stations": ["chevron", null], "Entertainment": ["regal", null], "Utilities": ["socalgas", null] };
    const FX = [fx("dine", "Zqdine Grill", "Dining", "none_shown"), fx("ralphs", "Ralphs", "Groceries & Food Delivery", "in_store"),
      fx("temu", "Temu", "Marketplaces & Department Stores", "online"), fx("chevron", "Chevron", "Auto & Gas", "in_store"),
      fx("regal", "Regal", "Streaming & Entertainment", "in_store"), fx("socal", "SoCalGas", "Services & Utilities", "in_store")];
    ["Ralphs", "Temu", "Chevron", "Regal", "SoCalGas"].forEach(k => ok(Object.values(realBonus.keyword_lists).some(l => (l.keywords || []).includes(k)),
      "qp fixture: \"" + k + "\" is still a keyword in the real lists (the Step 2 comparison matches through it)"));
    let CASE = {}; // { set: { card: activation | "ended" | {start, end} }, choice }
    const ROUTES = {
      "offers.json": r => r.fulfill({ json: Object.assign({}, real, { offers: FX }) }),
      "phone-edits.json": r => r.fulfill({ json: {} }),
      "merchant-locations.json": r => r.fulfill({ json: { groups: {} } }),
      "cards.json": r => r.fulfill({ json: Object.assign({}, realCards, {
        preferred_rewards: { cards: ["Unlimited Cash", "Customized Cash"], percent: 75, until: "2026-12-15", then_percent: 50, note: "test", checked: "2026-10-20" } }) }),
      "bonus-categories.json": r => {
        const d = { keyword_lists: realBonus.keyword_lists, entries: JSON.parse(JSON.stringify(ENTRIES)) };
        d.entries.forEach(e => {
          const b = (CASE.set || {})[e.card];
          if (b === "ended") { e.start = "2026-07-01"; e.end = "2026-09-30"; } else if (b && typeof b === "object") Object.assign(e, b); else if (b) e.activation = b;
          if (e.choices && CASE.choice) e.choice = CASE.choice;
        });
        return r.fulfill({ json: d });
      }
    };
    for (const k of Object.keys(ROUTES)) await page.route("**/data/" + k, ROUTES[k]);
    // Everything a tile shows (screen-reader-only text left out), plus the section's layout facts.
    const quick = () => page.evaluate(() => {
      const q = document.getElementById("qp");
      if (q.hidden) return null;
      const txt = e => { if (!e) return null; const c = e.cloneNode(true); c.querySelectorAll(".sr-only, .usegain, .likely").forEach(x => x.remove()); return c.textContent.replace(/\u00a0/g, " "); };
      const gain = e => e && e.querySelector(".usegain") ? e.querySelector(".usegain").textContent : null;
      const tiles = {};
      q.querySelectorAll(".qpgrid > li.qpt").forEach(li => {
        const a = li.querySelector(".qpa"), c = li.querySelector(".qpcond");
        tiles[li.dataset.topic] = { rate: txt(li.querySelector(".qpr")), card: txt(li.querySelector(".qpc")), more: txt(li.querySelector(".qpm:not(.qpd)")),
          dated: txt(li.querySelector(".qpd")), after: a ? txt(a) + gain(a) : null, afterCards: a ? a.dataset.cards.split("|") : null,
          cond: c ? (txt(c) + (gain(c) || "")).trim() : null, condKind: c ? (c.classList.contains("strong") ? "strong" : "muted") : null,
          condSr: c ? (c.querySelector(".sr-only") || {}).textContent : null, note: txt(li.querySelector(".qpnote")),
          likely: li.querySelector(".qpw .likely") ? li.querySelector(".qpw .likely").textContent : null,
          afterLikely: a && a.querySelector(".likely") ? a.querySelector(".likely").textContent : null,
          afterLikelyLast: a && a.querySelector(".likely") ? a.lastElementChild === a.querySelector(".likely") : null,
          afterLikelyIn: a && a.querySelector(".likely") ? a.querySelector(".likely").getBoundingClientRect().right <= li.getBoundingClientRect().right - 1 : null,
          empty: [...li.querySelectorAll("*")].filter(x => !x.textContent.trim() && !x.classList.contains("idot")).length,
          over: li.scrollWidth > li.clientWidth + 1, h: Math.round(li.getBoundingClientRect().height) };
      });
      const sizes = [...q.querySelectorAll("*")].filter(x => x.textContent.trim() && !x.closest(".sr-only")).map(x => parseFloat(getComputedStyle(x).fontSize));
      const ev = q.querySelector(".qpe"), r = q.getBoundingClientRect(), strip = document.getElementById("bstrip");
      return { head: q.querySelector(".qph").textContent, headLikely: !!q.querySelector(".qphead .likely"),
        order: [...q.querySelectorAll(".qpgrid > li.qpt")].map(li => li.dataset.topic), tiles,
        ev: ev ? ev.innerText.replace(/\s+/g, " ").trim() : null, evFull: ev ? Math.abs(ev.getBoundingClientRect().width - q.getBoundingClientRect().width) < 1 : false,
        cols: getComputedStyle(q.querySelector(".qpgrid")).gridTemplateColumns.split(" ").length,
        actions: q.querySelectorAll("button, a, input, select, [tabindex], [role=button], [onclick]").length,
        minFont: Math.min.apply(null, sizes), top: Math.round(r.top), bottom: Math.round(r.bottom), pageW: document.documentElement.scrollWidth,
        afterSearch: !!(document.querySelector(".searchbar").compareDocumentPosition(q) & Node.DOCUMENT_POSITION_FOLLOWING),
        beforeStrip: !!(q.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING), stripShown: !strip.hidden && strip.getBoundingClientRect().height > 0 };
    });
    // The Step 2 answer for one merchant: the Ready now card and rate, how many cards are ready at it (named, "+N more
    // ready", a Smartly tie's "also"), the After activating cards (named, "+N more at"), rate and gain, and the Citi
    // Custom Cash line (strong with its gain, or muted).
    const step2 = async (q, chan) => {
      await page.fill("#q", q);
      await page.waitForTimeout(120);
      if (chan) { await page.click("#use .chansel button[data-ch=" + chan + "]"); await page.waitForTimeout(80); }
      const a = await page.evaluate(() => {
        const u = document.getElementById("use");
        const hs = [...u.querySelectorAll(":scope > .usehead:not(.usechan)")].map(e => ({ t: e.innerText.replace(/\s+/g, " "),
          s: (e.querySelector("strong") || {}).textContent || "", g: (e.querySelector(".usegain") || {}).textContent || null, l: !!e.querySelector(".likely") }));
        const c = u.querySelector(":scope > .usecond.strong"), m = u.querySelector(":scope > .usecond:not(.strong)");
        return { hs, cond: c ? { k: "strong", s: c.querySelector("strong").textContent, g: (c.querySelector(".usegain") || {}).textContent || null } :
          m ? { k: "muted", s: m.textContent, g: null } : null };
      });
      if (chan) await page.click("#use .chansel button[data-ch=any]");
      await page.fill("#q", "");
      await page.waitForTimeout(80);
      const r = a.hs.find(h => /^Ready now: /.test(h.t)), f = a.hs.find(h => /^After activating: /.test(h.t));
      const first = s => { const m = /^(.+?) ([\d.]+)%/.exec(s.split(" or ")[0]); return m ? { card: m[1], rate: m[2] + "%" } : {}; };
      const n = r ? r.s.split(" or ").length + +((/\+(\d+) more ready/.exec(r.t) || [0, 0])[1]) + (r.t.match(/ also [\d.]+%/g) || []).length : 0;
      const fNames = f ? f.s.split(" or ").map(x => /^(.+?) [\d.]+%/.exec(x)[1]) : null;
      const fN = f ? fNames.length + +((/\+(\d+) more at/.exec(f.t) || [0, 0])[1]) : 0;
      return { ready: r ? Object.assign(first(r.s), { n }) : null, after: f ? Object.assign(first(f.s), { gain: f.g, names: fNames, n: fN, likely: f.l }) : null,
        cond: a.cond ? Object.assign(first(a.cond.s), { kind: a.cond.k, gain: a.cond.g }) : null, raw: a.hs.map(h => h.t) };
    };
    const open = async (c, when) => {
      CASE = c || {};
      await page.clock.setFixedTime(when || new Date(2026, 10, 4, 12, 0, 0));
      await page.goto(base);
      await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
      await page.goto(base);
      await page.waitForFunction(() => window.__cardsReady && window.__bonusReady && !document.getElementById("qp").hidden);
      return quick();
    };
    // Every tile against Step 2, for the case open now.
    const parity = async (name, Q) => {
      for (const topic of Object.keys(PAR)) {
        const t = Q.tiles[topic], s = await step2(PAR[topic][0], PAR[topic][1]);
        // A line the tile shows but that doesn't read as expected counts as a mismatch, never as no line.
        const parts = (text, re) => { if (!text) return null; const m = re.exec(text); return m ? [m[1], m[2], m[3]] : ["unreadable", text]; };
        // The activation line: every tied card (Step 2 names two, then "+N more at"), the rate and the gain.
        const tA = parts(t.after, /^Activate (.+): ([\d.]+%) · (\+.+)$/);
        const tAfter = tA && tA[0] !== "unreadable" ? [t.afterCards.slice(0, 2), t.afterCards.length, tA[1], tA[2]] : tA;
        const tC = t.cond ? parts(t.cond, t.condKind === "strong" ? /^(.+) ([\d.]+%) · conditional · (\+.+)$/ : /^(.+) ([\d.]+%) · (conditional)$/) : null;
        const tCond = tC && tC[0] !== "unreadable" ? [t.condKind, tC[0], tC[1], t.condKind === "strong" ? tC[2] : null] : tC;
        const same = s.ready && t.card === s.ready.card && t.rate === s.ready.rate && (t.more ? +/\d+/.exec(t.more)[0] : 0) === s.ready.n - 1 &&
          J(tAfter) === J(s.after ? [s.after.names, s.after.n, s.after.rate, s.after.gain] : null) &&
          J(tCond) === J(s.cond ? [s.cond.kind, s.cond.card, s.cond.rate, s.cond.gain] : null);
        ok(same, "qp " + name + ": " + topic + " matches the Step 2 answer for \"" + PAR[topic][0] + "\" (tile " + J(t) + "; Step 2 " + J(s.raw) + ")");
        // Likely on the activation line exactly when Step 2's After activating line (the last line) carries it.
        if (t.after || s.after) ok(!!t.afterLikely === !!(s.after && s.after.likely), "qp " + name + ": " + topic + " activation Likely matches Step 2's After activating (" + J([t.afterLikely, s.after && s.after.likely]) + ")");
      }
    };
    const tileIs = (name, Q, topic, want) => {
      const t = Q.tiles[topic] || {}, got = {};
      Object.keys(want).forEach(k => { got[k] = t[k]; });
      ok(J(got) === J(want), "qp " + name + ": " + topic + " " + J(want) + (J(got) === J(want) ? "" : " (got " + J(got) + ")"));
    };
    const BOOST = "Incl. 75% Preferred Rewards (50% after Dec 15)", Q4 = "Q4 · through Dec 31";
    const LIKELY = "Likely, not certain: how the merchant codes the purchase decides it."; // likelyTag(), with its screen-reader text

    // A. Every bonus activated: the six tiles in order, ready winners, +N more ready, Smartly's tie, notes from the data.
    let Q = await open({});
    ok(J(Q.order) === J(["Dining", "Grocery stores", "Online shopping", "Gas stations", "Entertainment", "Utilities"]), "qp A: the six topics in order (" + J(Q.order) + ")");
    ok(Q.head === "Quick picks · no offer needed" && !/Q\d|Dec|Nov|through|20\d\d/.test(Q.head), "qp G: the heading has no quarter or date (" + Q.head + ")");
    tileIs("A", Q, "Dining", { rate: "5%", card: "Freedom Flex", more: "+2 more ready", dated: Q4, after: null, cond: "Citi Custom Cash 5% · conditional", condKind: "muted", note: null });
    tileIs("A", Q, "Grocery stores", { rate: "5%", card: "Freedom Flex", more: "+1 more ready", dated: Q4, after: null, cond: null, note: GROCERY_NOTE });
    tileIs("A", Q, "Online shopping", { rate: "5.25%", card: "Customized Cash", more: null, dated: null, after: null, cond: null, note: BOOST });
    tileIs("A/E", Q, "Gas stations", { rate: "4%", card: "Smartly", more: "+1 more ready", dated: null, after: null, cond: null, note: "Costco Visa also 4%, 5% at Costco gas" });
    tileIs("A", Q, "Entertainment", { rate: "5%", card: "Discover it", more: null, dated: Q4, after: null, cond: null, note: ENT_NOTE });
    tileIs("A/H", Q, "Utilities", { rate: "5%", card: "Discover it", more: null, dated: Q4, after: null, cond: null, note: null });
    ok(Object.keys(Q.tiles).every(k => !Q.tiles[k].after && !Q.tiles[k].afterLikely), "qp A: nothing to activate, so no activation line and no activation Likely");
    ok(Object.keys(Q.tiles).every(k => !Q.tiles[k].empty && !Q.tiles[k].over), "qp H: no empty parts and nothing wider than its tile (" + J(Object.keys(Q.tiles).map(k => [k, Q.tiles[k].empty, Q.tiles[k].over])) + ")");
    ok(Q.ev === "Everyday default · Smartly 4% First $10,000 per billing cycle, then 2%; some categories always 2%" && Q.evFull,
      "qp everyday: full-width tile, rate and caveat from Smartly's headline_note (" + Q.ev + ")");
    ok(!/everywhere|on everything/i.test(J(Q)), "qp: never \"4% everywhere\" or \"4% on everything\"");
    // Likely on each tile whose winner is a category rate (merchant coding decides it), never on the heading, and not on
    // Smartly's everyday rate (Gas stations) just because other tiles have it.
    ok(!Q.headLikely && J(Q.order.map(k => !!Q.tiles[k].likely)) === J([true, true, true, false, true, true]) && Q.tiles.Dining.likely === "Likely, not certain: how the merchant codes the purchase decides it.",
      "qp Likely: on the five category-rate tiles, not on Gas stations (Smartly) or the heading, with likelyTag's screen-reader text (" + J([Q.headLikely, Q.order.map(k => Q.tiles[k].likely)]) + ")");
    // A Custom Cash conditional 5% that ties the ready 5% (Dining, its focus): the short muted line, no gain, and not
    // counted in +N more ready (+2 is Freedom and Discover it). Topics that aren't its focus get no Custom Cash line.
    ok(Q.tiles.Dining.condSr === ", only if restaurants is your actual top eligible category this cycle" &&
      ["Grocery stores", "Online shopping", "Gas stations", "Entertainment", "Utilities"].every(k => Q.tiles[k].cond === null),
      "qp custom cash: muted line on its focus topic (with why, for screen readers), none on the other five");
    ok(Q.cols === 2 && Q.actions === 0 && Q.minFont >= 11.5 && Q.pageW <= 390,
      "qp 390px: a two-column grid, no buttons or links (no tap action in 4A), no text under 11.5px, no sideways scroll (" + J([Q.cols, Q.actions, Q.minFont, Q.pageW]) + ")");
    ok(Q.afterSearch && Q.beforeStrip && Q.stripShown && Q.bottom < 844, "qp placement: after the search box, before the Bonus categories strip, which still shows; within the first screen (" + J([Q.top, Q.bottom]) + ")");
    // The old strip still works under it: opens, lists every live entry, Smartly's line and the activation status.
    await page.click("#bsum");
    const strip = await page.evaluate(() => ({ open: document.getElementById("bstrip").open, n: document.querySelectorAll("#blist > li[data-eid]").length,
      text: document.getElementById("blist").innerText.replace(/\s+/g, " ") }));
    ok(strip.open && strip.n === 7 && /Smartly: Everyday 4% · first \$10,000 per billing cycle, some categories 2%/.test(strip.text) && /Activated/.test(strip.text),
      "qp: the old Bonus categories strip opens with every live entry (" + strip.n + ")");
    await page.click("#bsum");
    await parity("A", Q);
    // Not on a search, a category or a card (the answer card answers those), back on the home screen.
    const hiddenBy = async act => { await act(); await page.waitForTimeout(80); return page.$eval("#qp", q => q.hidden); };
    const hid = [await hiddenBy(() => page.fill("#q", "ralphs")), await hiddenBy(() => page.fill("#q", "")),
      await hiddenBy(async () => { await page.click("#ftoggle"); await page.locator("#cats button", { hasText: /^Dining/ }).first().click(); }),
      await hiddenBy(() => page.locator("#cats button", { hasText: /^All/ }).first().click()),
      await hiddenBy(() => page.locator("#cards button", { hasText: /^Capital One/ }).first().click()),
      await hiddenBy(() => page.locator("#cards button", { hasText: /^All cards/ }).first().click())];
    ok(J(hid) === J([true, false, true, false, true, false]), "qp: hidden on a search, a category or a card, shown again when cleared (" + J(hid) + ")");

    // B. Freedom activated, Freedom Flex not: Freedom 5% is the answer; no prompt to activate Flex just to tie.
    Q = await open({ set: { "Freedom Flex": "not_confirmed" } });
    tileIs("B", Q, "Grocery stores", { rate: "5%", card: "Freedom", more: null, after: null });
    tileIs("B", Q, "Dining", { rate: "5%", card: "Freedom", more: "+1 more ready", after: null });
    await parity("B", Q);

    // C / I. Both Chase cards not activated: Smartly 4% stays the ready answer for grocery stores, with the 5%
    // after activating (+1 pt); a not-activated bonus never leads or counts as ready.
    Q = await open({ set: { "Freedom Flex": "not_confirmed", "Freedom": "not_confirmed" } });
    tileIs("C", Q, "Grocery stores", { rate: "4%", card: "Smartly", more: null, dated: null, after: "Activate Flex or Freedom: 5% · +1 pt", cond: null, note: null, likely: null,
      afterLikely: LIKELY, afterLikelyLast: true });
    // The activation Likely is likelyTag() itself (same screen-reader wording), compact, and the tile still fits.
    const qpaL = await page.evaluate(() => {
      const a = document.querySelector("#qp li.qpt[data-topic='Grocery stores'] .qpa"), l = a && a.querySelector(".likely"), w = document.querySelector("#qp .qpw .likely");
      const li = a.closest("li");
      return { sr: l && l.querySelector(".sr") ? l.querySelector(".sr").textContent : null, font: l ? getComputedStyle(l).fontSize : null,
        border: l ? getComputedStyle(l).borderTopStyle : null, inside: !!l && l.getBoundingClientRect().right <= li.getBoundingClientRect().right - 1 };
    });
    ok(qpaL.sr === ", not certain: how the merchant codes the purchase decides it." && qpaL.font === "11.5px" && qpaL.border === "solid" && qpaL.inside,
      "qp C: the activation line's Likely has likelyTag's screen-reader text and the compact tag style, inside the tile (" + J(qpaL) + ")");
    tileIs("C", Q, "Dining", { rate: "5%", card: "Discover it", more: null, after: null });
    await parity("C", Q);

    // D. Citi Custom Cash's conditional 5% beats the ready answer (the other 5% dining cards ended): Smartly 4% leads,
    // Custom Cash is a separate conditional alternative (+1 pt), not ready and not in +N more ready.
    Q = await open({ set: { "Freedom Flex": "ended", "Freedom": "ended", "Discover it": "ended" } });
    tileIs("D", Q, "Dining", { rate: "4%", card: "Smartly", more: null, dated: null, after: null, cond: "Citi Custom Cash 5% · conditional · +1 pt", condKind: "strong", likely: null });
    // A mix: Smartly-led tiles have no Likely; Customized Cash's online shopping rate (a category rate) does.
    ok(J(Q.order.map(k => !!Q.tiles[k].likely)) === J([false, false, true, false, false, false]) && !Q.headLikely,
      "qp Likely D: only Online shopping (Customized Cash), not the Smartly tiles (" + J(Q.order.map(k => Q.tiles[k].card + ":" + !!Q.tiles[k].likely)) + ")");
    ok(Q.tiles.Dining.condSr === ", only if restaurants is your actual top eligible category this cycle", "qp D: screen readers hear why it is conditional (" + Q.tiles.Dining.condSr + ")");
    tileIs("D/G", Q, "Utilities", { rate: "4%", card: "Smartly", dated: null });
    await parity("D", Q);
    // D with the 5% cards not activated instead: both the activation and the conditional alternative, Smartly still leads.
    Q = await open({ set: { "Freedom Flex": "not_confirmed", "Freedom": "not_confirmed", "Discover it": "not_confirmed" } });
    tileIs("D/I", Q, "Dining", { rate: "4%", card: "Smartly", more: null, after: "Activate Flex, Freedom or Discover it: 5% · +1 pt",
      afterCards: ["Freedom Flex", "Freedom", "Discover it"], cond: "Citi Custom Cash 5% · conditional · +1 pt", condKind: "strong", likely: null, afterLikely: LIKELY });
    ok(Object.keys(Q.tiles).every(k => !!Q.tiles[k].after === !!Q.tiles[k].afterLikely && (!Q.tiles[k].afterLikely || Q.tiles[k].afterLikelyIn)),
      "qp D/I: every activation line (and only those) carries Likely, each inside its tile (" + J(Object.keys(Q.tiles).map(k => [k, Q.tiles[k].after, !!Q.tiles[k].afterLikely, Q.tiles[k].afterLikelyIn])) + ")");
    // The longest lines (Dining: "Activate Flex, Freedom or Discover it: 5% · +1 pt" and the strong
    // "Citi Custom Cash 5% · conditional · +1 pt") wrap inside the tile at every phone width, with the same words.
    for (const w of [320, 330, 350, 390]) {
      await page.setViewportSize({ width: w, height: 844 });
      await page.waitForTimeout(60);
      const W = await quick();
      const fit = await page.evaluate(() => [...document.querySelectorAll("#qp li.qpt")].map(li => {
        // Where the visible text and chips end, against the tile's content edge (scrollWidth misses text that only
        // runs into the padding).
        const edge = li.getBoundingClientRect().right - parseFloat(getComputedStyle(li).paddingRight), rects = [];
        const tw = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
        for (let n; (n = tw.nextNode());) {
          if (!n.textContent.trim() || n.parentElement.closest(".sr-only, .sr")) continue;
          const r = document.createRange(); r.selectNodeContents(n); rects.push(...r.getClientRects());
        }
        li.querySelectorAll(".usegain, .likely").forEach(x => rects.push(x.getBoundingClientRect()));
        return [li.dataset.topic, Math.round(Math.max.apply(null, rects.map(r => r.right)) - edge)];
      }));
      ok(Object.keys(W.tiles).every(k => !W.tiles[k].over) && fit.every(f => f[1] <= 1) && W.pageW <= w,
        "qp D/I at " + w + "px: no Quick Pick tile overflows (" + J(Object.keys(W.tiles).map(k => [k, W.tiles[k].over])) + "; text past the edge " + J(fit) + "; page " + W.pageW + ")");
      tileIs("D/I at " + w + "px", W, "Dining", { after: "Activate Flex, Freedom or Discover it: 5% · +1 pt", cond: "Citi Custom Cash 5% · conditional · +1 pt",
        condKind: "strong", condSr: ", only if restaurants is your actual top eligible category this cycle" });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    // Only one card's activation improves the answer: only it is named.
    tileIs("I", Q, "Utilities", { rate: "4%", card: "Smartly", after: "Activate Discover it: 5% · +1 pt", afterCards: ["Discover it"] });
    await parity("D/I", Q);

    // F. Preferred Rewards: with dining as the Customized Cash choice, its 3% x 1.75 = 5.25% beats the Chase 5% now;
    // after Dec 15 (50%: 4.5%) Freedom Flex leads again and the note follows the tier. Gas likewise.
    Q = await open({ choice: "dining" });
    tileIs("F", Q, "Dining", { rate: "5.25%", card: "Customized Cash", more: null, dated: null, note: BOOST, cond: "Citi Custom Cash 5% · conditional", condKind: "muted" });
    tileIs("F", Q, "Online shopping", { rate: "4%", card: "Smartly", note: null });
    await parity("F", Q);
    Q = await open({ choice: "dining" }, new Date(2026, 11, 20, 12, 0, 0));
    tileIs("F after Dec 15", Q, "Dining", { rate: "5%", card: "Freedom Flex", more: "+2 more ready", dated: Q4, note: null });
    Q = await open({ choice: "gas & EV charging stations" }, new Date(2026, 11, 20, 12, 0, 0));
    tileIs("F after Dec 15", Q, "Gas stations", { rate: "4.5%", card: "Customized Cash", more: null, note: "Incl. 50% Preferred Rewards" });
    await parity("F after Dec 15", Q);

    // Custom Cash focus on grocery stores: its conditional line moves to Grocery stores (muted: it ties the ready 5%),
    // and Dining, no longer its focus, has none.
    Q = await open({ set: { "Citi Custom Cash": { planned: "grocery stores" } } });
    tileIs("focus", Q, "Grocery stores", { rate: "5%", card: "Freedom Flex", more: "+1 more ready", cond: "Citi Custom Cash 5% · conditional", condKind: "muted" });
    tileIs("focus", Q, "Dining", { rate: "5%", card: "Freedom Flex", more: "+2 more ready", cond: null });
    await parity("focus", Q);
    // Smartly 4% ready with the Custom Cash focus on grocery stores and both Chase cards off: the strong line with +1 pt,
    // next to the activation of both Chase cards.
    Q = await open({ set: { "Citi Custom Cash": { planned: "grocery stores" }, "Freedom Flex": "not_confirmed", "Freedom": "not_confirmed" } });
    tileIs("focus", Q, "Grocery stores", { rate: "4%", card: "Smartly", more: null, after: "Activate Flex or Freedom: 5% · +1 pt",
      cond: "Citi Custom Cash 5% · conditional · +1 pt", condKind: "strong" });
    await parity("focus/C", Q);

    // G. A dated bonus that isn't a calendar quarter: "Through Nov 30", no quarter name.
    Q = await open({ set: { "Discover it": { start: "2026-11-01", end: "2026-11-30" } } });
    tileIs("G", Q, "Utilities", { rate: "5%", card: "Discover it", dated: "Through Nov 30" });
    // Dates in a tile stay on one line ("Dec 31", "Dec 15").
    ok(await page.evaluate(() => [...document.querySelectorAll("#qp .qpd, #qp .qpnote")].every(e => !/[A-Z][a-z]{2} \d/.test(e.textContent))), "qp: tile dates use a no-break space");
    ok(errs.length === 0, "qp: no page errors (" + errs.join("; ") + ")");
    await ctx5.close();
    // The Preferred Rewards switch (Dec 15 -> 16) with the tab open: a day redraw prepares the boosted rates again, so
    // the rolled-over tab shows exactly what a fresh load on Dec 16 shows. Fixture tier: 75% through Dec 15, then 50%
    // (Customized Cash online shopping 3% -> 5.25%, then 4.5%). Three tabs in one context (one clock): the home screen
    // (Quick picks), the Step 2 answer card for "temu" (an online_stores keyword) under Online, and a Bank of America
    // "10% Cash back" online-only offer whose Best offer row total is 10% + the boosted 5.25% (then 4.5%).
    const ROLL_OFFER = Object.assign(fx("roll", "Zqroll Shop", "Marketplaces & Department Stores", "online"),
      { id: "test/qp-roll", card: "Bank of America", bonus: "10% Cash back", activation: "already_activated" });
    const rollRoutes = async p => {
      for (const k of Object.keys(ROUTES)) await p.route("**/data/" + k, k === "offers.json" ?
        r => r.fulfill({ json: Object.assign({}, real, { offers: FX.concat([ROLL_OFFER]) }) }) : ROUTES[k]);
    };
    // One tab's view: the Online shopping tile, or the answer card (lines, Likely, notes) and the row totals.
    const rollView = p => p.evaluate(() => {
      const q = document.getElementById("qp"), u = document.getElementById("use");
      const tile = q.hidden ? null : q.querySelector("li.qpt[data-topic='Online shopping']");
      const plain = e => { const c = e.cloneNode(true); c.querySelectorAll(".sr, .sr-only").forEach(x => x.remove()); return c.textContent.replace(/ /g, " ").trim(); };
      return {
        tile: tile ? { rate: plain(tile.querySelector(".qpr")), card: plain(tile.querySelector(".qpc")),
          note: tile.querySelector(".qpnote") ? plain(tile.querySelector(".qpnote")) : null, likely: !!tile.querySelector(".qpw .likely") } : null,
        tiles: q.hidden ? null : [...q.querySelectorAll("li.qpt")].map(plain),
        use: u.hidden ? null : [...u.children].filter(c => !c.matches(".chansel, details.rates")).map(plain),
        rates: u.hidden || !u.querySelector("details.rates > summary") ? null : plain(u.querySelector("details.rates > summary")),
        strip: [...document.querySelectorAll("#blist li[data-eid]")].map(plain),
        totals: [...document.querySelectorAll("#main > ul.results li.offer")].map(li => li.dataset.oid + " " + plain(li.querySelector(".obig") || li) + " " + plain(li.querySelector(".obreak") || li))
      };
    });
    const rollOpen = async (ctx, q) => {
      const p = await ctx.newPage();
      p.on("pageerror", e => errs.push(e.message));
      await rollRoutes(p);
      await p.goto(base);
      await p.waitForFunction(() => window.__cardsReady && window.__bonusReady && !document.getElementById("qp").hidden);
      if (q) {
        await p.fill("#q", q);
        await p.waitForTimeout(150);
        await p.click("#use .chansel button[data-ch=online]");
        await p.waitForTimeout(100);
      }
      return p;
    };
    const rollTabs = async ctx => ({ home: await rollOpen(ctx, null), temu: await rollOpen(ctx, "temu"), roll: await rollOpen(ctx, "zqroll") });
    const rollAll = async T => ({ home: await rollView(T.home), temu: await rollView(T.temu), roll: await rollView(T.roll) });
    const BOOST50 = "Incl. 50% Preferred Rewards";
    CASE = {};
    // A fresh load on Dec 16: what every rolled-over tab must equal.
    const ctxF = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    await ctxF.clock.install({ time: new Date(2026, 11, 16, 0, 0, 30) });
    const fresh = await rollAll(await rollTabs(ctxF));
    await ctxF.close();
    ok(J(fresh.home.tile) === J({ rate: "4.5%", card: "Customized Cash", note: BOOST50, likely: true }),
      "qp rollover: fresh load on Dec 16, Online shopping tile Customized Cash 4.5%, " + BOOST50 + " (" + J(fresh.home.tile) + ")");
    ok(/^Ready now: Customized Cash 4\.5%/.test((fresh.temu.use || [])[0] || "") && (fresh.temu.use || []).some(l => /50% Preferred Rewards boost\.$/.test(l)) &&
      !(fresh.temu.use || []).some(l => /75%/.test(l)),
      "qp rollover: fresh load on Dec 16, Step 2 \"temu\" (Online) Ready now Customized Cash 4.5%, 50% boost note (" + J(fresh.temu.use) + ")");
    ok(fresh.roll.totals.some(t => /^test\/qp-roll 14\.5% /.test(t)), "qp rollover: fresh load on Dec 16, the 10% BofA online offer's row total is 14.5% (" + J(fresh.roll.totals) + ")");
    for (const how of ["midnight timer", "focus", "visibilitychange", "bfcache pageshow"]) {
      const ctx6 = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
      await ctx6.clock.install({ time: new Date(2026, 11, 15, 23, 59, 0) });
      const T = await rollTabs(ctx6);
      await ctx6.clock.pauseAt(new Date(2026, 11, 15, 23, 59, 50));
      const before = await rollAll(T);
      ok(J(before.home.tile) === J({ rate: "5.25%", card: "Customized Cash", note: BOOST, likely: true }),
        "qp rollover " + how + ": at 23:59 on Dec 15 the Online shopping tile is Customized Cash 5.25%, " + BOOST + " (" + J(before.home.tile) + ")");
      ok(/^Ready now: Customized Cash 5\.25%/.test((before.temu.use || [])[0] || "") && (before.temu.use || []).some(l => /75% Preferred Rewards boost \(50% after Dec 15\)\.$/.test(l)),
        "qp rollover " + how + ": at 23:59 on Dec 15 Step 2 \"temu\" (Online) Ready now Customized Cash 5.25%, 75% boost note (" + J(before.temu.use) + ")");
      ok(before.roll.totals.some(t => /^test\/qp-roll 15\.25% /.test(t)), "qp rollover " + how + ": at 23:59 the 10% BofA online offer's row total is 15.25% (" + J(before.roll.totals) + ")");
      const renders = async () => Promise.all([T.home, T.temu, T.roll].map(p => p.evaluate(() => window.__renders)));
      const r0 = await renders();
      if (how === "midnight timer") await ctx6.clock.runFor(15000);
      else {
        await ctx6.clock.setSystemTime(new Date(2026, 11, 16, 0, 0, 30)); // no timer runs
        const mid = await rollAll(T);
        ok(J(mid) === J(before), how + ": nothing redrawn before the event");
        for (const p of [T.home, T.temu, T.roll]) await p.evaluate(h => {
          if (h === "focus") window.dispatchEvent(new Event("focus"));
          else if (h === "bfcache pageshow") window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
          else {
            Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
            Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
            document.dispatchEvent(new Event("visibilitychange"));
          }
        }, how);
      }
      const after = await rollAll(T), r1 = await renders();
      ok(J(after.home.tile) === J({ rate: "4.5%", card: "Customized Cash", note: BOOST50, likely: true }),
        "qp rollover " + how + ": after midnight, no reload, the Online shopping tile is Customized Cash 4.5%, " + BOOST50 + " (" + J(after.home.tile) + ")");
      ok(/^Ready now: Customized Cash 4\.5%/.test((after.temu.use || [])[0] || "") && !(after.temu.use || []).some(l => /75%|5\.25/.test(l)),
        "qp rollover " + how + ": after midnight, no reload, Step 2 \"temu\" (Online) Ready now Customized Cash 4.5% (" + J(after.temu.use) + ")");
      ok(r1.every((n, i) => n - r0[i] === 1), how + ": one redraw per tab (" + J([r0, r1]) + ")");
      ok(J(after) === J(fresh), "qp rollover " + how + ": every tab equals a fresh load on Dec 16 (tiles, answer card, Card rates here, row totals)" +
        (J(after) === J(fresh) ? "" : " (" + J(after) + " vs " + J(fresh) + ")"));
      // Repeated comebacks the same day draw nothing more and change nothing.
      for (const p of [T.home, T.temu, T.roll]) await p.evaluate(() => {
        document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });
      ok(J(await renders()) === J(r1) && J(await rollAll(T)) === J(fresh), how + ": later focus, visibilitychange and pageshow the same day redraw nothing, values unchanged");
      // Clearing the search on the rolled-over tab: Quick picks drawn from the recomputed rates too.
      await T.temu.fill("#q", "");
      await T.temu.waitForTimeout(100);
      const cleared = (await rollView(T.temu)).tile;
      ok(J(cleared) === J(fresh.home.tile), how + ": the searched tab, cleared, shows the Dec 16 Online shopping tile (" + J(cleared) + ")");
      await ctx6.close();
    }
    // A save that ends just after midnight, before the midnight timer (00:00:00.5): its redraw must not use up the new
    // day without preparing the rates again. Signed in (GitHub blocked, CardStore.save stubbed), a Focus pick saved at
    // 00:00:00.2; then the timer and later comebacks. The tiles and strip must equal a fresh load on Dec 16.
    {
      const ctx7 = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
      await ctx7.clock.install({ time: new Date(2026, 11, 15, 23, 59, 0) });
      const p = await ctx7.newPage();
      p.on("pageerror", e => errs.push(e.message));
      await rollRoutes(p);
      await p.route("https://api.github.com/**", r => r.abort());
      await p.goto(base);
      await p.evaluate(() => { try { localStorage.setItem("cardselector.token", "test"); } catch (e) {} });
      await p.goto(base);
      await p.waitForFunction(() => window.__cardsReady && window.__bonusReady && !document.getElementById("qp").hidden);
      await p.evaluate(() => {
        window.__pend = [];
        CardStore.save = change => new Promise(res => window.__pend.push(() => res({ status: "saved", message: "Focus: " + change.to,
          undo: { type: change.type, id: change.id, from: change.to, to: change.from },
          record: { activation: "not_needed", planned: change.type === "bonus.planned" ? change.to : null, choice: change.type === "bonus.choice" ? change.to : null } })));
        CardStore.liveStatus = () => Promise.resolve({ state: "live" });
      });
      await p.click("#bstrip > summary");
      const sel = "#blist li[data-eid='citi-custom-cash/standing'] .bfocus select";
      await p.selectOption(sel, "gas stations");
      await p.evaluate(() => document.activeElement && document.activeElement.blur());
      await ctx7.clock.pauseAt(new Date(2026, 11, 15, 23, 59, 59, 900));
      const b7 = await rollView(p);
      await ctx7.clock.runFor(300); // 00:00:00.2: the midnight timer hasn't run
      await p.locator("#blist li[data-eid='citi-custom-cash/standing'] .bfocus button", { hasText: /^Save$/ }).click();
      await p.evaluate(() => window.__pend.shift()());
      await p.waitForTimeout(50);
      await ctx7.clock.runFor(15000);
      await p.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
      const a7 = await rollView(p);
      await ctx7.close();
      // The fresh load: Dec 16, the same Focus (gas stations) saved in the file.
      const ctx8 = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
      await ctx8.clock.install({ time: new Date(2026, 11, 16, 0, 0, 30) });
      CASE = { set: { "Citi Custom Cash": { planned: "gas stations" } } };
      const f8 = await rollView(await rollOpen(ctx8, null));
      await ctx8.close();
      CASE = {};
      const cc = v => (v.strip.find(x => /^Customized Cash:/.test(x)) || "").slice(0, 60);
      ok(b7.tile.rate === "5.25%" && a7.tile.rate === "4.5%" && J(a7.tiles) === J(f8.tiles) && cc(a7) === cc(f8) && /4\.5% online shopping/.test(cc(a7)),
        "qp rollover, a save just after midnight: tiles and the strip's Customized Cash equal a fresh load on Dec 16 (" + J([b7.tile.rate, a7.tile, cc(a7), cc(f8)]) + ")");
    }
    ok(errs.length === 0, "qp rollover: no page errors (" + errs.join("; ") + ")");
    page = mainPage;
  }

  // Search box shadow: off at the top, on once scrolled, off again back at the top.
  await setup("pizza");
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  const frames = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const shadow = async y => { await page.evaluate(y => window.scrollTo(0, y), y); await frames(); return page.$eval(".searchbar", b => ({ y: window.scrollY, on: b.classList.contains("scrolled") })); };
  const s0 = await shadow(0), s1 = await shadow(400), s2 = await shadow(0);
  ok(!s0.on && s1.y > 0 && s1.on && !s2.on, "search box shadow: off at 0, on at " + s1.y + ", off back at 0 (" + JSON.stringify([s0, s1, s2]) + ")");

  await browser.close();
  server.close();
  console.log(failed ? failed + " check(s) failed" : "All sort checks passed");
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exit(1); });

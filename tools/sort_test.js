// Headless sort checks at phone width (390 x 844), run against the site/ folder:
//   node tools/sort_test.js
// Needs Playwright (npm i playwright). CHROMIUM_PATH picks a browser binary if Playwright's own isn't installed.
// The checks use the live data where they can; "shell" adds one test-only Shell offer in the browser, because
// no Shell offer is active today. Nothing is written to the data files.
const http = require("http"), fs = require("fs"), path = require("path");
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
// Whole-word grouping, as the page's wholeLevel(): the matches with the "s" rule when they are 1 to 3 merchants
// (name without " - Location"); when more than 3, the exact-word matches when those are 1 to 3; else none.
// Returns false (no grouping) or the strict flag to use. `rows` must be the full result list.
function grouped(rows, query) {
  if (!query) return false;
  const count = strict => new Set(rows.filter(r => whole(r.merchant, query, strict)).map(r => spaced(r.merchant.replace(/\s+-\s+.*$/, "")).replace(/ /g, ""))).size;
  const n = count(false);
  if (n >= 1 && n <= 3) return { strict: false };
  if (n > 3) { const m = count(true); if (m >= 1 && m <= 3) return { strict: true }; }
  return false;
}
// Best offer order: (whole-word matches first, when grouped), then tier high to low, then amount high to low.
// A percent offer's amount is its total with its card ("· 15% with Freedom") when the row shows one.
function bestOrderBreak(rows, query) {
  const g = grouped(rows, query);
  const amt = r => { const k = rank(r.bonus); return (k[0] === 5 || k[0] === 4) && r.total != null ? r.total : k[1]; };
  const key = r => [g && !whole(r.merchant, query, g.strict) ? 1 : 0, -rank(r.bonus)[0], -amt(r)];
  for (let i = 1; i < rows.length; i++) {
    const a = key(rows[i - 1]), b = key(rows[i]);
    for (let k = 0; k < 3; k++) { if (a[k] < b[k]) break; if (a[k] > b[k]) return i; }
  }
  return -1;
}
const label = r => r.merchant + " | " + r.card + " | " + r.bonus;

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
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  const rows = () => page.$$eval("#main > ul.results > li.offer", ls => ls.map(li => ({
    merchant: li.querySelector(".merchant").textContent,
    card: li.querySelector(".mcard").textContent,
    bonus: li.querySelector(".bonus").firstChild.textContent,
    total: (t => t ? +/([\d.]+)%/.exec(t.textContent)[1] : null)(li.querySelector(".bonus .total")),
    totalText: (li.querySelector(".bonus .total") || { textContent: "" }).textContent
  })));
  // Merchants the per-merchant "Use:" headline names (none for the category headline).
  const useNames = () => page.$$eval("#use .usemname, #use .useat", es => es.map(e => e.textContent.replace(/:\s*$/, "").replace(/^At /, "")).sort());
  const useText = () => page.$eval("#use", e => e.hidden ? "" : e.innerText);
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
  ok(pz.length > 0 && !grouped(pz, "pizza") && bestOrderBreak(pz, "pizza") === -1, "pizza, Best offer: plain reward order, no whole-word grouping (" + pz.length + " rows)");
  ok(JSON.stringify(pz.map(label)) === JSON.stringify(pzD.map(label)), "pizza: same order with and without the Dining filter");
  const rt = pz.findIndex(r => r.merchant === "Round Table Pizza" && /^10%/.test(r.bonus)), low = pz.findIndex(r => /^1\.92%/.test(r.bonus));
  if (rt === -1 || low === -1) skip("pizza: Round Table Pizza 10% or a 1.92% offer is no longer active");
  else ok(rt < low, "pizza: Round Table Pizza 10% (row " + (rt + 1) + ") above 1.92% (row " + (low + 1) + ")");
  const gr = pz.findIndex(r => /^Greco's New York Pizzeria$/.test(r.merchant) && /^5%/.test(r.bonus)), p4 = pz.findIndex(r => /^4%/.test(r.bonus));
  if (gr === -1 || p4 === -1) skip("pizza: Greco's New York Pizzeria 5% or a 4% offer is no longer active");
  else ok(gr < p4, "pizza: Greco's New York Pizzeria 5% (row " + (gr + 1) + ") above the first 4% (row " + (p4 + 1) + ")");

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
  const pct = na.filter(r => /\d\s*%/.test(r.bonus) && !/^\s*save\b/i.test(r.bonus));
  const firstUp = pct.findIndex(r => /^\s*up to\b/i.test(r.bonus)), lastDef = pct.map(r => !/^\s*up to\b/i.test(r.bonus)).lastIndexOf(true);
  ok(pct.length > 0 && (firstUp === -1 || lastDef < firstUp), "Needs activation, Highest percent: definite percents (" + (lastDef + 1) + ") all above \"Up to\" percents (" + na.length + " rows)");
  const yt = na.findIndex(r => /^50%/.test(r.bonus)), up50 = na.findIndex(r => /^up to (\d+)/i.test(r.bonus) && +/^up to (\d+)/i.exec(r.bonus)[1] >= 50);
  if (yt === -1 || up50 === -1) skip("Needs activation: no definite 50% or no \"Up to 50%\"-or-more offer is active");
  else ok(yt < up50, "Needs activation, Highest percent: definite 50% (row " + (yt + 1) + ") above \"Up to\" 50%+ (row " + (up50 + 1) + ")");
  const nb = await setup("", { act: "Needs activation" });
  ok(bestOrderBreak(nb, "") === -1, "Needs activation, Best offer: first page in tier order (definite % before \"Up to\" %)");
  const nr = await setup("", { act: "Needs activation", sort: "rate", all: true });
  const ru = nr.findIndex(r => /^\s*up to\b.*%/i.test(r.bonus)), rd = nr.map(r => /\d\s*%/.test(r.bonus) && !/^\s*(up to|save)\b/i.test(r.bonus)).lastIndexOf(true);
  ok(ru !== -1 && rd !== -1 && rd < ru, "Needs activation, Best rate: definite percents (last at row " + (rd + 1) + ") above \"Up to\" percents (first at row " + (ru + 1) + ")");

  // Ties break by merchant A to Z, then card, in every reward sort: 021 Originals and 1Password (both 30%) keep
  // one order in Best offer and Highest percent.
  const tie = (list, m) => list.findIndex(r => r.merchant === m);
  const [b021, b1p, p021, p1p] = [tie(nb, "021 Originals"), tie(nb, "1Password"), tie(na, "021 Originals"), tie(na, "1Password")];
  if ([b021, b1p, p021, p1p].includes(-1)) skip("ties: 021 Originals or 1Password is not on the Needs activation lists");
  else ok((b021 < b1p) === (p021 < p1p), "ties: 021 Originals / 1Password in the same order in Best offer and Highest percent");

  // 4. "cafe" Show more continues the same order with no repeats.
  const cf0 = await setup("cafe");
  await moreAll();
  const cf = await rows();
  ok(cf.length > cf0.length, "cafe: Show more added rows (" + cf0.length + " -> " + cf.length + ")");
  ok(JSON.stringify(cf.slice(0, cf0.length).map(label)) === JSON.stringify(cf0.map(label)), "cafe: the first page is unchanged after Show more");
  ok(new Set(cf.map(label)).size === cf.length, "cafe: no repeated rows");
  ok(bestOrderBreak(cf, "cafe") === -1, "cafe: Best offer order holds across the pages");

  // 5. Save offers rank last under Best offer (Bank of America has them).
  const bo = await setup("", { card: "Bank of America", all: true });
  const firstSave = bo.findIndex(r => /^\s*save\b/i.test(r.bonus)), saves = bo.filter(r => /^\s*save\b/i.test(r.bonus)).length;
  if (firstSave === -1) skip("Bank of America: no Save offers are active");
  else ok(firstSave === bo.length - saves && bestOrderBreak(bo, "") === -1, "Bank of America, Best offer: all " + saves + " Save offers last, Save Now at the very end (" + bo.length + " rows)");

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
  for (const [q, bad] of [["shell", /Shelly|Bombshell/], ["bp", /NBPure/]]) {
    const r = await setup(q), names = await useNames(), t = await useText();
    ok(!names.some(n => bad.test(n)) && !bad.test(t), q + ": headline leaves out " + bad.source.replace(/\|/g, " and ") + " (" + (names.join(", ") || t.split("\n")[0]) + ")");
    const part = [...new Set(r.filter(x => bad.test(x.merchant)).map(x => x.merchant))];
    if (part.length) ok(part.every(m => !whole(m, q)), q + ": " + part.join(", ") + " not whole-word matches");
  }

  await browser.close();
  server.close();
  console.log(failed ? failed + " check(s) failed" : "All sort checks passed");
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exit(1); });

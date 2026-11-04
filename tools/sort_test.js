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
// Whole-word grouping, as the page's wholeLevel(): the matches with the "s" rule when they are 1 to 3 merchants
// (the full name, as the page's merchant identity with no location groups); when more than 3, the exact-word
// matches when those are 1 to 3; else none.
// Returns false (no grouping) or the strict flag to use. `rows` must be the full result list.
function grouped(rows, query) {
  if (!query) return false;
  const count = strict => new Set(rows.filter(r => whole(r.merchant, query, strict)).map(r => spaced(r.merchant.replace(/\.(com|net|org)\b/gi, "")).replace(/ /g, ""))).size;
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
  let page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  const rows = () => page.$$eval("#main > ul.results > li.offer", ls => ls.map(li => ({
    merchant: li.querySelector(".merchant").textContent,
    card: li.querySelector(".mcard").textContent,
    bonus: li.querySelector(".bonus").firstChild.textContent,
    total: (t => t ? +/([\d.]+)%/.exec(t.textContent)[1] : null)(li.querySelector(".bonus .total")),
    totalText: (li.querySelector(".bonus .total") || { textContent: "" }).textContent
  })));
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
      const m = li.querySelector(".meta"), kids = [...m.children], soon = m.querySelector(".badge.soon");
      out[li.querySelector(".merchant").textContent] = { gone: li.classList.contains("gone"), text: soon ? soon.textContent : null,
        icon: soon ? !!soon.querySelector("svg.bico[aria-hidden='true'] circle") : null,
        after: soon ? kids.indexOf(soon) > kids.indexOf(m.querySelector(".badge.act")) && kids.indexOf(m.querySelector(".badge.act")) !== -1 : null,
        before: soon ? kids.indexOf(soon) < kids.indexOf(m.querySelector(".badge.chan")) : null };
    });
    return out;
  });
  await page.unroute("**/data/offers.json");
  for (const [m, , want] of EXP) {
    const x = exp[m];
    ok(x && !x.gone && x.text === want && (!want || (x.icon && x.after && x.before)),
      m + ": " + (want ? "\"" + want + "\" with a clock, after activation, before channel" : "no ends-soon badge") + " (" + JSON.stringify(x) + ")");
  }
  ok(exp["Zzexp Gone"] && exp["Zzexp Gone"].gone && exp["Zzexp Gone"].text === null, "Zzexp Gone (Recently unavailable, ends tomorrow): no ends-soon badge (" + JSON.stringify(exp["Zzexp Gone"]) + ")");
  // The badge is display only: the first 10 rows of 12 searches, on the same fixed day, match the base branch's
  // app.js (BASE_REF, else origin/main, else main, else main fetched from origin), when git can get it.
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
    for (const q of SEARCHES) {
      const mine = (await setup(q)).slice(0, 10).map(label);
      soonSeen += await page.locator("#main .badge.soon").count();
      await page.route("**/js/app.js", route => route.fulfill({ body: baseApp, contentType: "text/javascript" }));
      const theirs = (await setup(q)).slice(0, 10).map(label);
      await page.unroute("**/js/app.js");
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
    const q = document.getElementById("q"), f = document.activeElement, li = f && f.closest("li[data-oid]");
    const pressed = id => [...document.querySelectorAll("#" + id + " button[aria-pressed=true]")].map(b => b.textContent.replace(/\s*\(?\d+\)?$/, "").trim());
    const rowOf = m => [...document.querySelectorAll("li.offer")].find(l => l.querySelector(".merchant").textContent === m);
    const soon = m => { const l = rowOf(m); const b = l && l.querySelector(".badge.soon"); return b ? b.textContent : null; };
    return {
      renders: window.__renders, y: Math.round(window.scrollY), q: q.value, caret: [q.selectionStart, q.selectionEnd],
      focus: f === q ? "input" : li ? li.getAttribute("data-oid") + " " + f.tagName + "." + f.className : f ? f.tagName + "#" + f.id + "." + f.className : null,
      cats: pressed("cats"), cards: pressed("cards"), cuis: pressed("cuis"), chans: pressed("chans"), acts: pressed("acts"), sort: document.getElementById("sort").value,
      open: [...document.querySelectorAll("li.offer button.toggle[aria-expanded=true]")].map(b => b.closest("li").querySelector(".merchant").textContent),
      filters: document.getElementById("filters").classList.contains("open"), strip: document.getElementById("bstrip").open,
      more: [...document.querySelectorAll("#blist li[data-eid] > details.bmore[open]")].map(d => d.parentNode.getAttribute("data-eid")),
      rates: (document.querySelector("#use details.rates") || {}).open,
      rows: [...document.querySelectorAll("#use details.bonusrow[open]")].map(d => d.getAttribute("data-topic")),
      leads: [...document.querySelectorAll("#use details.bonusrow[open] .bhead")].map(h => h.textContent),
      expired: (document.querySelector("#main details.expired") || {}).open,
      fresh: document.getElementById("foot").open, edit: document.getElementById("editmode").open,
      gone: [...document.querySelectorAll("#main details.expired li.offer .merchant")].map(e => e.textContent),
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
    await page.locator("li.offer:has(.merchant:text-is('Zzday Ends Tomorrow')) button.toggle").first().click();
    await page.click("#bstrip > summary");
    await page.locator("#blist li[data-eid='citi-custom-cash/standing'] > details.bmore > summary").click();
    await page.click("#use details.rates > summary");
    await page.locator("#use details.bonusrow > summary").first().click();
    await page.locator("#main details.expired > summary").click(); // closed (it opens under a search)
    await page.evaluate(() => { document.getElementById("foot").open = true; document.getElementById("editmode").open = true; });
    await page.evaluate(() => { const q = document.getElementById("q"); q.setSelectionRange(2, 2); });
    await page.evaluate(() => document.querySelector("li.offer:not(.gone) button.toggle[aria-expanded=true]").focus({ preventScroll: true }));
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
        groups, rows: [...document.querySelectorAll("#main li.offer")].map(li => li.querySelector(".merchant").textContent + " | " + li.querySelector(".mcard").textContent +
          (li.querySelector(".dropped") ? " | " + li.querySelector(".dropped").textContent : "")),
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
      return { row: li.querySelector(".merchant").textContent + " | " + li.querySelector(".mcard").textContent, tag: !!t,
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
      const ic = await page.$$eval("#main details.expired li.offer.gone", ls => ls.map(li => [getComputedStyle(li.querySelector("a.glink svg")).color, getComputedStyle(li.querySelector("a.cardlink svg")).color]));
      const live = await page.$eval("#main > ul.results li.offer:not(.gone) a.glink svg", e => getComputedStyle(e).color);
      ok(ic.length && ic.every(c => c[0] === c[1] && c[0] !== live), "Recently unavailable: the Google icon is grey like the card icon, blue on live rows (" + JSON.stringify([ic[0], live]) + ")");
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
      return { m: li.querySelector(".merchant").textContent, text: so ? so.textContent : null, dots: so ? [...so.querySelectorAll(".idot")].map(d => d.className.replace("idot ", "")) : [] };
    }));
    const fox = still.find(x => x.m === "Zq Foxtrot Pulled");
    ok(fox && fox.text === "Still on Bank of America and Capital One" && JSON.stringify(fox.dots) === JSON.stringify(["i-boa", "i-cap1"]),
      "what changed: Still on Bank of America and Capital One, each with its dot (names compared ignoring case, accents and punctuation; a missing U.S. Bank offer left out) (" + JSON.stringify(fox) + ")");
    ok(still.filter(x => x.m !== "Zq Foxtrot Pulled").every(x => x.text === null), "what changed: no Still on line where no other card has the merchant live");
    // Gone rows: the Google icon is grey like the card icon (its own blue .ext color doesn't win).
    const iconColors = () => page.$$eval("li.offer.gone", ls => ls.map(li => [getComputedStyle(li.querySelector("a.glink svg")).color, getComputedStyle(li.querySelector("a.cardlink svg")).color, getComputedStyle(li.querySelector(".meta")).color]));
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
    ok((await page.textContent("#count")) === "4 hidden by the In store filter", "what changed: the count line names what the In store filter hides (\"" + (await page.textContent("#count")) + "\")");
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
    await page.locator("#main li.offer").filter({ has: page.locator(".merchant", { hasText: /^Round Table Pizza - Newport Beach$/ }) })
      .filter({ has: page.locator(".bonus", { hasText: /^20%/ }) }).locator("button.toggle").click();
    const terms = await page.$eval("#main li.offer button.toggle[aria-expanded=true]", b => b.closest("li").innerText);
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
      fx("amf", "U.S. Bank", "Amazon Fresh", "Groceries & Food Delivery", "5% cash back", { channel: "in_store" })
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
        rows: [...document.querySelectorAll("#main > ul.results > li.offer")].map(li => li.getAttribute("data-oid").replace(/^test\/s2-/, "")),
        rowText: [...document.querySelectorAll("#main > ul.results > li.offer")].map(li => li.innerText),
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

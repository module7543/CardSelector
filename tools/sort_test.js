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

  // Bonus rows open and close, closed on every render. Closed, one line of whole entries then "+N" for the rest
  // (entries left off plus the ones below the everyday rate); open, every entry on its own line, then the notes.
  const bonusRows = () => page.$$eval("#main .bonusrows > details.bonusrow", ds => ds.map(d => {
    const line = d.querySelector(".bline"), lr = line.getBoundingClientRect();
    const shown = [...line.querySelectorAll(".bent")].filter(e => getComputedStyle(e).display !== "none");
    const more = line.querySelector(".bmore"), moreOn = getComputedStyle(more).display !== "none";
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
      const br = await bonusRows();
      const name = (q || o.cat) + " @" + w;
      if (!br.length) { skip(name + ": no bonus row"); continue; }
      seen.push(name);
      ok(br.every(r => !r.open && r.bodyHidden), name + ": " + br.length + " bonus row(s) render closed");
      ok(br.every(r => !r.cut.length), name + ": closed line cuts off no name" + (br.some(r => r.cut.length) ? " (cut: " + br.map(r => r.cut.join(", ")).join("; ") + ")" : ""));
      ok(br.every(r => r.shown + r.n === r.total && (r.n > 0 || r.shown === r.total)),
        name + ": +N counts every entry not on the line (" + br.map(r => r.shown + " shown +" + r.n + " of " + r.total).join("; ") + ")");
      ok(br.every(r => r.sumH >= 44 && Math.abs(r.sumW - r.rowW) <= 1 && r.rowW <= w - 32), name + ": summary is a full-width 44px+ tap target (" + br.map(r => r.sumW + "x" + r.sumH).join("; ") + ")");
      if (q === "round table" || o) {
        await page.locator("#main details.bonusrow > summary").first().click();
        const op = await page.$eval("#main details.bonusrow", d => ({ open: d.open,
          lis: [...d.querySelectorAll(".blist > li")].map(li => li.checkVisibility() ? li.textContent : null),
          notes: [...d.querySelectorAll(".bnote")].map(n => n.checkVisibility() ? n.textContent : null),
          lineHidden: !d.querySelector(".bline").checkVisibility() }));
        ok(op.open && op.lineHidden && op.lis.length === br[0].total && op.lis.every(Boolean) && op.notes.length && op.notes.every(Boolean) &&
          op.notes.some(n => /^Likely, not certain/.test(n)),
          name + ": opening the first row shows all " + op.lis.length + " entries and " + op.notes.length + " notes, line 2 hidden");
        await page.locator("#main details.bonusrow > summary").first().click();
        ok(!(await page.$eval("#main details.bonusrow", d => d.open)), name + ": tapping again closes it");
      }
    }
    ok(seen.length >= 4, "bonus rows checked at " + w + "px (" + seen.join(", ") + ")");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  // The round table row squeezed to 150px refits and still shows only whole names.
  await setup("round table");
  const fitNarrow = await page.evaluate(() => {
    const d = document.querySelector("#main details.bonusrow"); d.parentNode.style.width = "150px";
    return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => {
      const line = d.querySelector(".bline"), lr = line.getBoundingClientRect();
      const shown = [...line.querySelectorAll(".bent")].filter(e => getComputedStyle(e).display !== "none");
      const more = line.querySelector(".bmore");
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

  await browser.close();
  server.close();
  console.log(failed ? failed + " check(s) failed" : "All sort checks passed");
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exit(1); });

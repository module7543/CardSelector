// Compare result/recommendation output with a Git baseline, using identical data and a fixed clock.
// node tools/filter_presentation_compare.js [baseline-ref] (defaults to origin/main)
// Needs Playwright; CHROMIUM_PATH optionally selects Chromium. Does not modify either checkout.
const fs = require("fs"), path = require("path"), http = require("http");
const { execFileSync } = require("child_process"), { chromium } = require("playwright");
const root = path.join(__dirname, ".."), ref = process.argv[2] || "origin/main";
const baseline = execFileSync("git", ["rev-parse", "--verify", ref + "^{commit}"], { cwd: root, encoding: "utf8" }).trim();
const files = new Map();
for (const name of execFileSync("git", ["ls-tree", "-r", "--name-only", baseline, "site"], { cwd: root, encoding: "utf8" }).trim().split("\n")) {
  files.set(name.slice(5), execFileSync("git", ["show", baseline + ":" + name], { cwd: root, maxBuffer: 20 * 1024 * 1024 }));
}
const queries = ["amazon", "pizza", "shell", "bp", "costco", "costco gas", "netflix", "chipotle", "jetblue", "kitchenaid", "la colombe", "round table", "persian", "target", "instacart", ""];
(async () => {
  const server = http.createServer((req, res) => {
    const m = /^\/(main|branch)\/(.*)$/.exec(decodeURIComponent(req.url.split("?")[0]));
    if (!m) { res.writeHead(404); return res.end(); }
    const name = m[2] || "index.html";
    if (!files.has(name)) { res.writeHead(404); return res.end(); }
    // Both pages use baseline data. Only the branch's page code differs.
    const body = m[1] === "branch" && !name.startsWith("data/") ? fs.readFileSync(path.join(root, "site", name)) : files.get(name);
    res.writeHead(200, { "Content-Type": name.endsWith(".html") ? "text/html" : name.endsWith(".js") ? "text/javascript" : "application/json" });
    res.end(body);
  }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  let browser, differences = 0, views = 0, rows = 0;
  try {
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    for (const width of [390, 1000]) {
      const contexts = [], pages = [];
      for (const kind of ["main", "branch"]) {
        const ctx = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: "block" });
        contexts.push(ctx);
        const page = await ctx.newPage(); pages.push(page);
        await page.clock.install({ time: new Date(2026, 10, 5, 12) });
        await page.goto("http://127.0.0.1:" + server.address().port + "/" + kind + "/");
        await page.waitForFunction(() => window.__bonusReady && window.__cardsReady && window.__cuisinesReady && document.querySelectorAll("#cards button").length > 1);
      }
      for (const query of queries) for (const channel of ["any", "store", "online"]) {
        const snapshots = [];
        for (const page of pages) {
          await page.fill("#q", query);
          // Exercise the same existing click handlers, independent of the controls' responsive placement.
          await page.evaluate(channel => document.querySelector('#chans button[data-v="' + channel + '"]').click(), channel);
          snapshots.push(await page.evaluate(() => {
            const text = e => e ? e.textContent.replace(/\s+/g, " ").trim() : "";
            return {
              answer: text(document.getElementById("use")), rates: text(document.querySelector("#use .rates")), count: text(document.getElementById("count")),
              containers: [...document.querySelectorAll("#main .mc")].map(c => ({ key: c.dataset.ck, header: text(c.querySelector(".mchead")),
                rows: [...c.querySelectorAll("li.offer")].map(r => ({ id: r.dataset.oid, content: text(r), total: text(r.querySelector(".obig")) })) }))
            };
          }));
        }
        views++; rows += snapshots[0].containers.reduce((n, c) => n + c.rows.length, 0);
        if (JSON.stringify(snapshots[0]) !== JSON.stringify(snapshots[1])) {
          differences++;
          console.error("DIFF", { width, query, channel, fields: Object.keys(snapshots[0]).filter(k => JSON.stringify(snapshots[0][k]) !== JSON.stringify(snapshots[1][k])) });
        }
      }
      await Promise.all(contexts.map(c => c.close()));
    }
    console.log(JSON.stringify({ baseline, views, rows, differences }));
    process.exitCode = differences ? 1 : 0;
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });

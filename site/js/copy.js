// The saved copy as the page sees it. The worker (sw.js) keeps the page and its data on the phone and answers
// from that copy; app.js registers it, this file asks it to check for a newer deploy, and reads data files so that
// offers.json and phone-edits.json always come from the same saved set (each answer from the copy names its set
// in the X-Saved-Copy header). It knows nothing about GitHub (store.js) or what the data means (app.js).
//   CardCopy.start(registering)           takes app.js's register() promise (no-op where service workers aren't available)
//   CardCopy.check({ throttle, force })   -> Promise of null (skipped) or { status, set, savedAt, offline, code }
//   CardCopy.fetchTogether(paths)         -> Promise of { set, items: [{ path, ok, status, text }] }, one set
//   CardCopy.readSet(paths)               -> the same from the current saved set in Cache Storage, or null
(function (root) {
  "use strict";
  var THROTTLE = 30000; // checks when the page comes back on screen: at most one per 30 seconds
  var TIMEOUT = 180000; // a check the worker never answers (it was stopped mid-download) counts as failed
  var HEADER = "X-Saved-Copy";
  var CODE = ["index.html", "js/edits.js", "js/store.js", "js/recent.js", "js/copy.js", "js/app.js"];
  var nav = root.navigator;
  var on = !!(nav && nav.serviceWorker && root.isSecureContext);
  var reg = null; // Promise of the registration, or of null when registering failed
  var booted = false, bootSet = null, bootFiles = null; // the set the page itself (its code) came from
  var lastCheck = 0, running = null;

  // registering: the promise of app.js's navigator.serviceWorker.register() call.
  function start(registering) {
    if (!on) return Promise.resolve(null);
    if (!reg && registering) reg = Promise.resolve(registering).catch(function () { on = false; return null; });
    return reg || Promise.resolve(null);
  }

  function ask(msg) {
    return start().then(function (r) {
      if (!r) return { status: "none" };
      // ready never settles when the worker unregisters itself (the off switch): give up after a while.
      var gone = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 20000); });
      return Promise.race([nav.serviceWorker.ready, gone]).then(function (ready) {
        var w = ready && ready.active;
        if (!w) return { status: "none" };
        return new Promise(function (resolve) {
          var ch = new MessageChannel(), done = false;
          var t = setTimeout(function () { if (!done) { done = true; resolve({ status: "failed", reason: "no answer" }); } }, TIMEOUT);
          ch.port1.onmessage = function (e) { if (!done) { done = true; clearTimeout(t); resolve(e.data || { status: "failed" }); } };
          w.postMessage(msg, [ch.port2]);
        });
      });
    }).catch(function () { return { status: "none" }; });
  }

  // What a check answer means for this page. code: index.html or a js file differs from the set the page's own
  // code came from (unknown counts as changed: the page then reloads once, the next time it comes back on screen).
  function read(r) {
    var out = { status: r.status, set: r.set || null, savedAt: r.savedAt || null, offline: r.status === "offline", code: false, reason: r.reason || null };
    if (r.set && r.files) {
      if (booted && !bootSet && !bootFiles) { bootSet = r.set; bootFiles = r.files; } // first visit: the page came from the network
      if (!bootFiles && bootSet === r.set) bootFiles = r.files;
      if (!bootFiles && r.known && r.known[bootSet]) bootFiles = r.known[bootSet];
      out.code = !bootFiles || CODE.some(function (p) { return bootFiles[p] !== r.files[p]; });
    }
    return out;
  }

  // throttle: skip when the last check started under 30 seconds ago. force: download the whole set even when
  // version.json says the copy is current (a save was refused as "reload"); it runs after a check in progress.
  function check(opts) {
    opts = opts || {};
    if (!on) return Promise.resolve(null);
    if (running) return opts.force ? running.then(function () { return check({ force: true }); }) : running;
    if (opts.throttle && Date.now() - lastCheck < THROTTLE) return Promise.resolve(null);
    lastCheck = Date.now();
    // No registration.update() here: racing a swap, it left the new worker stuck in Chromium (every later open
    // hung). app.js asks for one once the check and its swap are done.
    var p = ask({ type: "check", force: !!opts.force, sets: bootSet ? [bootSet] : [] }).then(function (r) {
      if (r.status === "none" || r.status === "off") return null;
      return read(r);
    });
    running = p;
    p.then(function () { running = null; }, function () { running = null; });
    return p;
  }

  function one(path, skip) {
    var opts = { cache: "no-cache" };
    if (skip) opts.headers = { "X-Saved-Copy": "skip" }; // straight to the network (sw.js leaves it alone)
    return fetch(path, opts).then(function (r) {
      var set = r.headers.get(HEADER);
      return r.text().then(function (t) { return { path: path, ok: r.ok, status: r.status, text: r.ok ? t : null, set: set }; });
    }, function () { return { path: path, ok: false, status: 0, text: null, set: null }; });
  }

  // Fetches the files as one set: every answer from the same saved set, or every one from the network. A mix
  // (the copy was replaced between two requests) is fetched again; if it stays mixed, all of them come from
  // the network instead, as they did before the saved copy existed.
  function fetchTogether(paths, tries) {
    tries = tries === undefined ? 3 : tries;
    return Promise.all(paths.map(function (p) { return one(p, tries < 0); })).then(function (items) {
      var sets = [];
      items.forEach(function (it) { if (sets.indexOf(it.set) === -1) sets.push(it.set); });
      if (sets.length > 1) return fetchTogether(paths, tries > 1 ? tries - 1 : -1);
      var res = { set: sets[0] || null, items: items };
      if (!booted) { booted = true; bootSet = res.set; }
      return res;
    });
  }

  // The current saved set, read straight from Cache Storage (the layout sw.js writes), without a request through
  // the worker: a read through the old worker while a new one installed left the new one stuck in Chromium
  // (every later open hung). Same answer shape as fetchTogether; null when there is no saved set to read.
  // Must match the names in sw.js (META, CURRENT_KEY; PREFIX + VERSION): change both together.
  var META = "cardselector-copy-v1-meta", CURRENT = "__saved-copy__/current";
  function readSet(paths) {
    if (!root.caches) return Promise.resolve(null);
    var at = function (p) { return new URL(p, root.location.href).href; };
    // caches.match with a cacheName creates no cache (caches.open would leave an empty one after the off switch).
    var get = function (key, name) { return root.caches.match(at(key), { cacheName: name }); };
    return get(CURRENT, META).then(function (r) {
      return r ? r.json() : null;
    }).then(function (m) {
      if (!m || !m.name || !m.files || !paths.every(function (p) { return m.files[p]; })) return null;
      return Promise.all(paths.map(function (p) {
        return get(p, m.name).then(function (r) {
          if (!r) return null;
          return r.text().then(function (t) { return { path: p, ok: true, status: 200, text: t, set: m.name }; });
        });
      })).then(function (items) { return items.every(Boolean) ? { set: m.name, items: items } : null; });
    }).catch(function () { return null; });
  }

  var api = { start: start, check: check, fetchTogether: fetchTogether, readSet: readSet, get enabled() { return on; } };
  root.CardCopy = api;
})(typeof window !== "undefined" ? window : globalThis);

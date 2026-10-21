// The saved copy: this service worker keeps the page and its data on the phone, so the page opens from the copy
// with no network wait, and replaces the copy in the background when a newer deploy is live (CLAUDE.md, Saved copy).
//
// It answers only same-origin GET requests for the files in FILES (and "/" for index.html), from the current set.
// Everything else (api.github.com, version.json, any request with an Authorization header) is not touched: no
// respondWith, so the browser sends it to the network as if there were no worker, and nothing of it is stored.
//
// A set is one Cache Storage cache holding every file in FILES from one deploy. The page asks for a check
// ({ type: "check", force, sets }); the worker reads version.json (the deployed commit and each file's SHA-256,
// written by both deploy workflows), downloads a changed deploy into a new cache (conditional requests, so an
// unchanged offers.json is not downloaded again), checks every file (HTTP 200 or 304, JSON parses, hash matches
// version.json), reads version.json again, and only then points "current" at the new set. offers.json and
// phone-edits.json therefore always come from the same deploy: a fold rewrites one and empties the other.
//
// Off switch: set ON to false and deploy. On the next open the worker deletes the saved copy and unregisters
// itself, so the page loads from the network exactly as it did before the saved copy existed.
"use strict";
var ON = true;

var PREFIX = "cardselector-copy-";
var VERSION = "v1"; // the format of the caches below; another value deletes them at activation. js/copy.js
                    // (readSet) reads META and CURRENT_KEY directly: change its names with these.
var META = PREFIX + VERSION + "-meta";
var SET = PREFIX + VERSION + "-set-";
var CODE = ["index.html", "js/edits.js", "js/store.js", "js/recent.js", "js/copy.js", "js/app.js"];
var DATA = ["data/offers.json", "data/phone-edits.json", "data/bonus-categories.json", "data/cuisines.json",
            "data/cards.json", "data/card-links.json"];
var FILES = CODE.concat(DATA);
var HEADER = "X-Saved-Copy"; // on every answer from the copy: the set it came from
var KNOWN = 30; // sets whose file hashes are kept, so a page can tell whether its own code is still current

function url(p) { return new URL(p, self.registration.scope).href; }
var CURRENT_KEY = "__saved-copy__/current", KNOWN_KEY = "__saved-copy__/known";

// The file a request is for, or null when the worker leaves the request alone.
function fileOf(request) {
  if (request.method !== "GET" || request.headers.has("Authorization")) return null;
  if (request.headers.get(HEADER) === "skip") return null; // the page asked for the network (js/copy.js)
  var u = new URL(request.url), scope = new URL(self.registration.scope);
  if (u.origin !== scope.origin || u.pathname.indexOf(scope.pathname) !== 0) return null;
  var rel = u.pathname.slice(scope.pathname.length) || "index.html";
  return FILES.indexOf(rel) !== -1 ? rel : null;
}

function readJson(cacheName, key) {
  return caches.open(cacheName).then(function (c) { return c.match(url(key)); }).then(function (r) {
    return r ? r.json() : null;
  }).catch(function () { return null; });
}
function writeJson(cacheName, key, obj) {
  return caches.open(cacheName).then(function (c) {
    return c.put(url(key), new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" } }));
  });
}
function current() { return readJson(META, CURRENT_KEY); }

self.addEventListener("install", function () { self.skipWaiting(); });

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (names) {
    // Off: drop every saved copy, then leave. Otherwise drop only caches of another format.
    return Promise.all(names.filter(function (n) {
      return n.indexOf(PREFIX) === 0 && (!ON || n.indexOf(PREFIX + VERSION + "-") !== 0);
    }).map(function (n) { return caches.delete(n); }));
  }).then(function () {
    return ON ? self.clients.claim() : self.registration.unregister();
  }));
});

self.addEventListener("fetch", function (e) {
  if (!ON) return;
  var p = fileOf(e.request);
  if (!p) return; // not ours: straight to the network, untouched and not stored
  var req = e.request;
  e.respondWith(fromCopy(p).catch(function () { return null; }).then(function (res) { return res || fetch(req); }));
});

// The file from the current set, marked with the set's name; null when there is no copy of it.
function fromCopy(p) {
  return current().then(function (m) {
    if (!m || !m.files || !m.files[p]) return null;
    return caches.open(m.name).then(function (c) { return c.match(url(p)); }).then(function (r) {
      if (!r) return null;
      var h = new Headers(r.headers);
      h.set(HEADER, m.name);
      return new Response(r.body, { status: 200, statusText: "OK", headers: h });
    });
  });
}

self.addEventListener("message", function (e) {
  var msg = e.data || {}, port = e.ports && e.ports[0];
  if (!port) return;
  if (!ON) { port.postMessage({ status: "off" }); return; }
  if (msg.type !== "check") return;
  e.waitUntil(locked(function () { return check(!!msg.force, msg.sets || []); }).catch(function (err) {
    return { status: "failed", reason: String(err && err.message || err) };
  }).then(function (r) { port.postMessage(r); }));
});

// One check at a time, also across two copies of this worker during an update.
var chain = Promise.resolve();
function locked(fn) {
  if (self.navigator && self.navigator.locks && self.navigator.locks.request) return self.navigator.locks.request("cardselector-copy", fn);
  var p = chain.then(fn, fn);
  chain = p.catch(function () {});
  return p;
}

function Offline(m) { this.message = m; }
function Bad(m) { this.message = m; }

function fetchNet(u, opts) {
  return fetch(u, opts).catch(function (err) { throw new Offline(String(err && err.message || err)); });
}

// version.json: { commit, files: { path: sha256 } }, or null when the site has none (404: an older deploy, local
// tests). Any other answer (503, a broken file) fails the check: without it the files couldn't be checked
// against one deploy, and an old offers.json with a new, empty phone-edits.json would bring used offers back.
function version() {
  return fetchNet(url("version.json") + "?t=" + Date.now(), { cache: "no-store" }).then(function (r) {
    if (r.status === 404) return null;
    if (!r.ok) throw new Bad("version.json: HTTP " + r.status);
    return r.json().catch(function () { return null; }).then(function (v) {
      if (!v || typeof v.commit !== "string" || !v.commit || !v.files || typeof v.files !== "object") throw new Bad("version.json: not a version stamp");
      return { commit: v.commit, files: v.files };
    });
  });
}
function commitOf(v) { return v ? v.commit : null; }

function hex(buf) {
  return Array.prototype.map.call(new Uint8Array(buf), function (b) { return (b < 16 ? "0" : "") + b.toString(16); }).join("");
}
function sha256(buf) { return crypto.subtle.digest("SHA-256", buf).then(hex); }

// The saved copy of one file, unchanged: { buf, type, etag, lm, fresh: false }.
function reuse(p, meta, old, r) {
  return caches.open(meta.name).then(function (c) { return c.match(url(p)); }).then(function (cr) {
    if (!cr) throw new Bad(p + ": the saved copy has no such file");
    return cr.arrayBuffer().then(function (buf) {
      return { buf: buf, type: old.type, etag: r && r.headers.get("ETag") || old.etag, lm: r && r.headers.get("Last-Modified") || old.lm, fresh: false };
    });
  });
}

// One file for the staging set: { path, buf, type, etag, lm, hash, fresh } (fresh = downloaded, not reused).
// A file whose hash in version.json is the saved one's is reused with no request at all (a deploy gives every
// file a new ETag, so a conditional request alone would download an unchanged offers.json again).
function download(p, meta, v) {
  var old = meta && meta.files && meta.files[p];
  if (old && v && v.files[p] && v.files[p] === old.hash) {
    return reuse(p, meta, old, null).then(function (f) { f.path = p; return sha256(f.buf).then(function (h) {
      if (h !== old.hash) throw new Bad(p + ": the saved copy is damaged");
      f.hash = h;
      return f;
    }); });
  }
  var headers = {}, opts = { cache: "no-store" };
  if (old && old.etag) headers["If-None-Match"] = old.etag;
  if (old && old.lm) headers["If-Modified-Since"] = old.lm;
  if (old && (old.etag || old.lm)) opts.headers = headers;
  else opts.cache = "no-cache"; // no validators of our own yet: let the HTTP cache revalidate what the page just loaded
  return fetchNet(url(p), opts).then(function (r) {
    if (r.status === 304 && old) return reuse(p, meta, old, r);
    if (r.status !== 200 || (r.type !== "basic" && r.type !== "default")) throw new Bad(p + ": HTTP " + r.status);
    return r.arrayBuffer().then(function (buf) {
      return { buf: buf, type: r.headers.get("Content-Type") || "", etag: r.headers.get("ETag"), lm: r.headers.get("Last-Modified"), fresh: true };
    });
  }).then(function (f) {
    f.path = p;
    if (!f.buf.byteLength) throw new Bad(p + ": empty");
    if (/\.json$/.test(p)) {
      try { JSON.parse(new TextDecoder().decode(f.buf)); } catch (err) { throw new Bad(p + ": not JSON"); }
    }
    return sha256(f.buf).then(function (h) {
      f.hash = h;
      var want = v && v.files[p];
      if (want && want !== h) throw new Bad(p + ": does not match version.json (the site may still be updating)");
      return f;
    });
  });
}

function hashes(meta) {
  var out = {};
  if (meta && meta.files) Object.keys(meta.files).forEach(function (p) { out[p] = meta.files[p].hash; });
  return out;
}

function answer(status, meta, known, extra) {
  var r = { status: status, set: meta ? meta.name : null, version: meta ? meta.version : null,
            savedAt: meta ? meta.savedAt : null, files: hashes(meta), known: {} };
  (known.asked || []).forEach(function (n) { if (known.map[n]) r.known[n] = known.map[n]; });
  Object.keys(extra || {}).forEach(function (k) { r[k] = extra[k]; });
  return r;
}

// The check. status: current (the copy is the live deploy), updated (a new set is now current), offline (the site
// couldn't be reached), raced (version.json changed during the download; nothing replaced), failed (a file was
// missing, not JSON or didn't match; nothing replaced). force: download even when version.json matches the copy.
function check(force, asked) {
  var meta, v, files, known;
  return Promise.all([current(), readJson(META, KNOWN_KEY)]).then(function (a) {
    meta = a[0];
    known = { map: a[1] || {}, asked: asked };
    return version();
  }).then(function (got) {
    v = got;
    var whole = meta && FILES.every(function (p) { return meta.files && meta.files[p]; });
    if (!force && whole && v && meta.version === v.commit) return "current";
    return Promise.all(FILES.map(function (p) { return download(p, meta, v); })).then(function (list) {
      files = list;
      return version();
    }).then(function (again) {
      if (commitOf(again) !== commitOf(v)) return "raced";
      var same = whole && files.every(function (f) { return meta.files[f.path].hash === f.hash; });
      if (same) {
        // Nothing changed: keep the set, note the new commit and the fresher validators.
        files.forEach(function (f) { meta.files[f.path].etag = f.etag; meta.files[f.path].lm = f.lm; });
        meta.version = commitOf(v);
        return writeJson(META, CURRENT_KEY, meta).then(function () { return "current"; });
      }
      return save(files, v, known).then(function (m) { meta = m; return "updated"; });
    });
  }).then(function (status) {
    return answer(status, meta, known);
  }, function (err) {
    if (err instanceof Offline) return answer("offline", meta, known || { map: {}, asked: asked });
    if (err instanceof Bad) return answer("failed", meta, known || { map: {}, asked: asked }, { reason: err.message });
    throw err;
  });
}

// Writes the staging set, then makes it current in one write; a failure before that leaves the old set as it was.
function save(files, v, known) {
  var name = SET + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  var prev = null;
  var meta = { name: name, version: commitOf(v), savedAt: Date.now(), files: {} };
  return caches.open(name).then(function (c) {
    return Promise.all(files.map(function (f) {
      meta.files[f.path] = { hash: f.hash, etag: f.etag || null, lm: f.lm || null, type: f.type || "" };
      var h = { "Content-Type": f.type || "application/octet-stream" };
      return c.put(url(f.path), new Response(f.buf, { headers: h }));
    }));
  }).then(function () {
    return current();
  }).then(function (old) {
    prev = old && old.name;
    known.map[name] = hashes(meta);
    var names = Object.keys(known.map).sort(function (a, b) { return a < b ? 1 : -1; }).slice(0, KNOWN);
    var keep = {};
    names.forEach(function (n) { keep[n] = known.map[n]; });
    known.map = keep;
    return writeJson(META, KNOWN_KEY, keep);
  }).then(function () {
    return writeJson(META, CURRENT_KEY, meta); // the switch to the new set
  }).then(function () {
    // Keep the new set and the one before it (a page may be reading from it right now); drop the rest.
    return caches.keys().then(function (names) {
      return Promise.all(names.filter(function (n) { return n.indexOf(SET) === 0 && n !== name && n !== prev; })
        .map(function (n) { return caches.delete(n); }));
    });
  }).then(function () { return meta; }, function (err) {
    return caches.delete(name).then(function () { throw new Bad("couldn’t save the copy (" + (err && err.message || err) + ")"); });
  });
}

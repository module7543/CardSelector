// Saving phone edits. This is the only file that knows the data lives in a GitHub repo; the page calls
//   CardStore.canEdit(), signIn(token), signOut(), save(change), liveStatus(saved), lastDeploy(),
//   setOffersBase(text) (once, with the text of offers.json as loaded)
// and never talks to GitHub itself. Replacing the backend (a hosted database, say) means replacing this
// file and keeping those calls. What a change does to the data is in edits.js.
//
// How a save works: read the newest commit on main and the data file as it is in that commit, apply the change
// there (edits.js refuses it if the record no longer looks the way the owner saw it), then write the file as a
// new commit whose parent is that same commit, and move main to it only as a fast-forward. If main moved in
// between (another save, or a merged pull request), nothing is overwritten: the save starts again from the new
// main, where the record check runs again.
//
// Offer edits (used, restore, activation) never read or write offers.json (4+ MB): they write only the small
// site/data/phone-edits.json (pending edits keyed by offer id; edits.js). The offer as it is on main is the
// page's own copy of offers.json plus main's pending edit. That copy is checked against main by its git blob
// hash (from a listing of site/data), so a save from a page loaded before offers.json changed on main is refused
// with "reload". Bonus edits read and write bonus-categories.json as before.
(function (root) {
  "use strict";
  var E = root.CardEdits;
  var API = "https://api.github.com";
  var REPO = "/repos/module7543/CardSelector";
  var BRANCH = "main";
  var WORKFLOW = "pages.yml"; // checks (validate.py) and deploys main
  var DATA_DIR = "site/data";
  var PATHS = { offers: "site/data/offers.json", bonus: "site/data/bonus-categories.json", edits: "site/data/phone-edits.json" };
  var TOKEN_KEY = "cardselector.token";
  var ATTEMPTS = 3;

  function token() { try { return root.localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; } }
  function canEdit() { return !!token(); }
  function signOut() { try { root.localStorage.removeItem(TOKEN_KEY); } catch (e) {} }

  // The data files are written exactly as the repo's Python tools write them (2-space JSON plus a final
  // newline), so a save changes only the edited lines.
  function serialize(obj) { return JSON.stringify(obj, null, 2) + "\n"; }

  function Fail(kind, message) { this.kind = kind; this.message = message; }

  function call(method, path, opts) {
    opts = opts || {};
    var headers = { Accept: opts.accept || "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    var t = opts.token !== undefined ? opts.token : token();
    if (t) headers.Authorization = "Bearer " + t;
    if (opts.body) headers["Content-Type"] = "application/json";
    return fetch(API + path, {
      method: method, headers: headers, cache: "no-store",
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).catch(function () {
      throw new Fail("network", "Couldn’t reach GitHub. Check your connection, then retry.");
    });
  }

  function httpFail(r, what) {
    if (r.status === 401) return new Fail("auth", "The password was refused (expired or revoked). Sign out and sign in again.");
    if (r.status === 403 && r.headers.get("x-ratelimit-remaining") === "0") return new Fail("network", "GitHub’s rate limit was hit. Retry in a few minutes.");
    if (r.status === 403 || r.status === 404) {
      return new Fail("auth", "This password can’t " + what + ". It needs read and write access to the site’s data.");
    }
    return new Fail("network", "GitHub answered " + r.status + " while trying to " + what + ". Retry in a moment.");
  }

  function json(method, path, what, body) {
    return call(method, path, { body: body }).then(function (r) {
      if (!r.ok) throw httpFail(r, what);
      return r.json();
    });
  }

  function errorResult(e) {
    if (e instanceof Fail) return { status: "error", kind: e.kind, message: e.message };
    return { status: "error", kind: "bug", message: "Something went wrong while saving (" + (e && e.message || e) + "). Nothing was saved." };
  }

  // Checks the token can see the repository before keeping it on this device.
  function signIn(tok) {
    tok = String(tok || "").trim();
    if (!tok) return Promise.resolve({ ok: false, message: "Enter the password." });
    return call("GET", REPO, { token: tok }).then(function (r) {
      if (r.status === 401) return { ok: false, message: "Sign-in failed: wrong or expired password." };
      if (r.status === 403 || r.status === 404) return { ok: false, message: "Sign-in failed: no access to the data." };
      if (!r.ok) return { ok: false, message: "Sign-in failed. Try again in a moment." };
      try { root.localStorage.setItem(TOKEN_KEY, tok); } catch (e) {
        return { ok: false, message: "Sign-in failed: this browser blocks saving it." };
      }
      return { ok: true };
    }, function () { return { ok: false, message: "Sign-in failed: no connection." }; });
  }

  // The page's copy of offers.json, as loaded: kept as text and only worked out on the first save (or just
  // after the first render when edit mode is already on), so visitors who never edit pay nothing for it:
  // per offer id, the fields a phone edit reads from before the pending edits went on, and the git blob hash.
  var baseText = null, base = null;
  function setOffersBase(text) {
    baseText = text; base = null;
    if (canEdit()) setTimeout(loadBase, 0);
  }
  function loadBase() {
    if (!base && baseText !== null) {
      var snap = {};
      JSON.parse(baseText).offers.forEach(function (o) {
        snap[o.id] = { id: o.id, merchant: o.merchant, card: o.card, status: o.status, status_since: o.status_since,
                       activation: o.activation, other_details: (o.other_details || []).slice() };
      });
      base = { offers: snap, sha: Promise.resolve(blobSha(baseText)) };
    }
    return base;
  }
  function blobSha(text) {
    var c = root.crypto && root.crypto.subtle;
    if (!c || typeof TextEncoder === "undefined") return null;
    var enc = new TextEncoder(), body = enc.encode(text), head = enc.encode("blob " + body.length + "\0");
    var all = new Uint8Array(head.length + body.length);
    all.set(head); all.set(body, head.length);
    return c.digest("SHA-1", all).then(function (h) {
      return Array.prototype.map.call(new Uint8Array(h), function (b) { return (b < 16 ? "0" : "") + b.toString(16); }).join("");
    }, function () { return null; });
  }

  // A data file at a commit, parsed; refused unless it is in the standard layout.
  function readFile(path, head) {
    return call("GET", REPO + "/contents/" + path + "?ref=" + head, { accept: "application/vnd.github.raw+json" }).then(function (r) {
      if (!r.ok) throw httpFail(r, "read " + path);
      return r.text();
    }).then(function (t) {
      var obj = JSON.parse(t);
      if (serialize(obj) !== t) {
        throw new Fail("format", path + " isn’t in the standard layout, so saving would rewrite the whole file. Nothing was saved. Ask Claude to reformat it.");
      }
      return obj;
    });
  }

  // Offer edits: main's pending edits (phone-edits.json; none when the file is absent), once the listing of
  // site/data shows main's offers.json is the copy this page loaded.
  function readEdits(head) {
    return json("GET", REPO + "/contents/" + DATA_DIR + "?ref=" + head, "read " + DATA_DIR).then(function (list) {
      var sha = {};
      (Array.isArray(list) ? list : []).forEach(function (f) { sha[f.path] = f.sha; });
      var b = loadBase();
      if (!b) throw new Fail("reload", "The offer list hasn’t loaded. Reload the page, then try again. Nothing was saved.");
      return b.sha.then(function (mine) {
        if (!mine) throw new Fail("format", "This browser can’t check the offer list (it needs the https page). Nothing was saved.");
        if (mine !== sha[PATHS.offers]) {
          // main has a newer offers.json than this page: after a reload, or once the site finishes updating
          // (the deploy takes a few minutes), the page has it too.
          throw new Fail("reload", "The offer list was updated and the site may still be catching up. Wait a minute, reload the page, then try again. Nothing was saved.");
        }
        return sha[PATHS.edits] ? readFile(PATHS.edits, head) : {};
      });
    }).then(function (edits) {
      if (!edits || typeof edits !== "object" || Array.isArray(edits)) {
        throw new Fail("format", PATHS.edits + " isn’t a list of edits by offer id. Nothing was saved. Ask Claude to fix it.");
      }
      return edits;
    });
  }

  // Reads the file a change goes to and applies the change there: { path, text, applied, files } or a result.
  function prepare(change, head) {
    if (E.fileOf(change) === "bonus") {
      return readFile(PATHS.bonus, head).then(function (obj) {
        var files = { bonus: obj }, applied = E.apply(files, change, E.pacificToday());
        return { path: PATHS.bonus, text: applied.ok && serialize(obj), applied: applied, files: files };
      });
    }
    return readEdits(head).then(function (edits) {
      var has = Object.prototype.hasOwnProperty.call(edits, change.id);
      var b = base.offers[change.id]; // loaded by readEdits
      var files = { offers: { offers: b ? [E.withEdit(b, has ? edits[change.id] : null)] : [] } };
      var applied = E.apply(files, change, E.pacificToday());
      if (applied.ok) {
        var entry = E.editFor(b, files.offers.offers[0]);
        if (entry) edits[change.id] = entry; else delete edits[change.id];
      }
      return { path: PATHS.edits, text: applied.ok && serialize(edits), applied: applied, files: files };
    });
  }

  // One attempt: read main, apply, commit, fast-forward main. Returns a result, or null when main moved.
  function attempt(change) {
    var head, treeSha, files, applied, text, path;
    return json("GET", REPO + "/git/ref/heads/" + BRANCH, "read the main branch").then(function (ref) {
      head = ref.object.sha;
      return json("GET", REPO + "/git/commits/" + head, "read the latest commit");
    }).then(function (c) {
      treeSha = c.tree.sha;
      return prepare(change, head);
    }).then(function (p) {
      files = p.files; applied = p.applied; text = p.text; path = p.path;
      if (!applied.ok) return { status: applied.kind, message: applied.message, now: applied.now, record: E.findRecord(files, change) };
      return json("POST", REPO + "/git/blobs", "write " + path, { content: text, encoding: "utf-8" }).then(function (blob) {
        return json("POST", REPO + "/git/trees", "write " + path, {
          base_tree: treeSha, tree: [{ path: path, mode: "100644", type: "blob", sha: blob.sha }]
        });
      }).then(function (tree) {
        return json("POST", REPO + "/git/commits", "save a commit", {
          message: applied.summary + "\n\nSaved from the phone page.", tree: tree.sha, parents: [head]
        });
      }).then(function (commit) {
        return call("PATCH", REPO + "/git/refs/heads/" + BRANCH, { body: { sha: commit.sha, force: false } }).then(function (r) {
          if (r.ok) {
            return { status: "saved", message: applied.summary, commit: commit.sha, record: E.findRecord(files, change),
                     undo: E.inverse(change, applied.before) };
          }
          if (r.status === 422 || r.status === 409) return null; // not a fast-forward: main moved
          throw httpFail(r, "update the main branch");
        });
      });
    });
  }

  // save(change) -> Promise of one of:
  //   { status: "saved",    message, commit, record, undo }   record = the record as saved; undo = the change that reverses it
  //   { status: "conflict", message, now, record }             the record changed elsewhere; record = how it is now
  //   { status: "done",     message, now, record }             it already had the wanted value
  //   { status: "invalid",  message, record }
  //   { status: "error",    kind, message }                    kind: network | auth | format | reload | busy | bug
  function save(change) {
    if (!canEdit()) return Promise.resolve({ status: "error", kind: "auth", message: "Sign in first (Edit mode, at the bottom of the page)." });
    var n = 0;
    function next() {
      n++;
      return attempt(change).then(function (res) {
        if (res) return res;
        if (n < ATTEMPTS) return next();
        return { status: "error", kind: "busy", message: "The data kept changing while saving. Nothing was saved. Retry in a moment." };
      });
    }
    return next().catch(errorResult);
  }

  // date: when the run started, so the footer's "Last deploy" can show the same run as the save bar.
  function runState(run) {
    if (run.status !== "completed") return { state: "pending", message: "Checking and deploying…", url: run.html_url, date: run.created_at };
    if (run.conclusion === "success") return { state: "live", message: "Live on the site.", url: run.html_url, date: run.created_at };
    return { state: "failed", url: run.html_url, date: run.created_at,
             message: "Deploy failed: the data check or the deploy step failed, so the live site stays on the last good version. Tell Claude." };
  }

  function runs(query) {
    return call("GET", REPO + "/actions/workflows/" + WORKFLOW + "/runs?" + query).then(function (r) {
      if (r.status === 401 || r.status === 403 || r.status === 404) throw new Fail("noactions", "Saved. Deploy status unavailable.");
      if (!r.ok) throw new Fail("network", "Couldn’t check the deploy (GitHub answered " + r.status + ").");
      return r.json();
    }).then(function (j) { return j.workflow_runs || []; });
  }

  // Whether a saved change is live yet: { state: pending | live | failed | unknown, message, url }.
  // A deploy cancelled by a newer save is followed through the newer run (which includes this change).
  function liveStatus(saved) {
    return runs("head_sha=" + saved.commit + "&per_page=5").then(function (list) {
      if (!list.length) return { state: "pending", message: "Waiting for the deploy to start…" };
      var st = runState(list[0]);
      if (st.state !== "failed" || list[0].conclusion !== "cancelled") return st;
      return runs("branch=" + BRANCH + "&event=push&per_page=1").then(function (l) {
        return l.length && l[0].head_sha !== saved.commit ? runState(l[0]) : st;
      });
    }).catch(function (e) { return { state: "unknown", message: e.message || "Couldn’t check the deploy." }; });
  }

  // The newest deploy of main: { state, message, url, date } or null when it can't be read.
  function lastDeploy() {
    if (!canEdit()) return Promise.resolve(null);
    return runs("branch=" + BRANCH + "&per_page=1").then(function (l) {
      if (!l.length) return null;
      return runState(l[0]);
    }).catch(function () { return null; });
  }

  var api = { canEdit: canEdit, signIn: signIn, signOut: signOut, save: save, liveStatus: liveStatus, lastDeploy: lastDeploy,
              setOffersBase: setOffersBase };
  root.CardStore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

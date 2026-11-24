# CardSelector

Personal phone page for searching credit card merchant bonuses.

- `site/` — the only folder published to GitHub Pages (see `.github/workflows/pages.yml`).
- `screenshots/` — local only, git-ignored, never published.

## Regression tests

Use Node.js 22 and Python 3. Install Playwright with `npm install --no-save playwright@1.56.1` and Chromium with `npx playwright install --with-deps chromium` on Ubuntu 24.04, the browser job's runner. For an existing local Chromium binary, set `CHROMIUM_PATH` to its executable.

Run the validator, importer checks, and browser suites:

```sh
python3 tools/validate.py
python3 tools/refresh_test.py
node tools/sort_test.js
node tools/phone_edits_test.js
node tools/offline_test.js
```

`tools/fixtures/browser-offers.js` provides synthetic inventories for phone edits and saved copies, and synthetic records for the Likely headline cases. The phone suite shares its served offer bytes with the mock GitHub API and temporary validation and fold copies. The saved-copy suite uses its local server's offer bytes for both version and mock GitHub hashes. The sort suite also checks live data and reports skips when a named smoke-test prerequisite is absent.

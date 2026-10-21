#!/usr/bin/env bash
# Folds pending phone edits into offers.json on main and pushes the result as a fast-forward. Run by
# .github/workflows/fold-phone-edits.yml only (sessions never fold). Each try starts from the newest main: no
# pending edits -> nothing to do; otherwise validate, fold, validate again, commit, push. A push refused because main moved (a
# phone save, a merged pull request) starts over from the new main, up to FOLD_TRIES times. Never forces.
# Writes folded=true|false and sha=<fold commit> to $GITHUB_OUTPUT when set.
# FOLD_BRANCH (default main) exists only so the script can be tested against a throwaway branch.
set -euo pipefail
# It switches to main and resets the checkout, so it must never run in a session's working copy.
if [ "${GITHUB_ACTIONS:-}" != true ]; then echo "Runs only in the Fold phone edits workflow (GitHub Actions); sessions never fold." >&2; exit 1; fi
cd "$(dirname "$0")/.."
BRANCH="${FOLD_BRANCH:-main}"
TRIES="${FOLD_TRIES:-4}"
EDITS=site/data/phone-edits.json
out() { echo "$1"; if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1" >> "$GITHUB_OUTPUT"; fi; }

for try in $(seq 1 "$TRIES"); do
  git fetch -q origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
  git checkout -q -B "$BRANCH" "origin/$BRANCH"
  git reset -q --hard "origin/$BRANCH"
  pending=$(python3 -c 'import json, pathlib, sys; p = pathlib.Path(sys.argv[1]); print(len(json.loads(p.read_text())) if p.exists() else 0)' "$EDITS")
  if [ "$pending" = 0 ]; then
    echo "No pending phone edits on $BRANCH: nothing to do."
    out "folded=false"
    exit 0
  fi
  python3 -B tools/validate.py # the pending edits themselves (once folded, a bad one would no longer show)
  FOLD_PHONE_EDITS=1 python3 -B tools/fold_phone_edits.py
  python3 -B tools/validate.py # the folded offers.json
  git add site/data/offers.json "$EDITS"
  git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
    commit -q -m "Fold $pending phone edit(s) into offers.json" -m "Folded by the Fold phone edits workflow."
  if git push -q origin "HEAD:refs/heads/$BRANCH"; then
    echo "Pushed $(git rev-parse --short HEAD) to $BRANCH (try $try)."
    out "folded=true"
    out "sha=$(git rev-parse HEAD)"
    exit 0
  fi
  echo "$BRANCH moved while folding (try $try of $TRIES); starting over from the new $BRANCH."
  sleep "$try"
done
echo "Gave up: $BRANCH kept moving (or the push was refused) for $TRIES tries. Nothing was pushed; run the workflow again."
exit 1

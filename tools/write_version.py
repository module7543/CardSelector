"""Writes site/version.json for the saved copy (site/sw.js): the deployed commit and the SHA-256 of every file
under site/. Both deploy workflows run it just before the upload step; the phone's worker reads it to tell a
newer deploy from its copy, and refuses a download whose files don't match it (a half-updated site).

site/version.json is git-ignored: only the deploy writes it, never a session.
    python3 tools/write_version.py
"""
import hashlib
import json
import os
import subprocess
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent / "site"
OUT = SITE / "version.json"


def main():
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=SITE, text=True).strip()
    files = {}
    for root, _dirs, names in os.walk(SITE):
        for n in names:
            p = Path(root) / n
            rel = p.relative_to(SITE).as_posix()
            if rel == "version.json":
                continue
            files[rel] = hashlib.sha256(p.read_bytes()).hexdigest()
    OUT.write_text(json.dumps({"commit": commit, "files": dict(sorted(files.items()))}, indent=2) + "\n")
    print("site/version.json: commit " + commit + ", " + str(len(files)) + " files")


if __name__ == "__main__":
    main()

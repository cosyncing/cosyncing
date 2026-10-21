#!/usr/bin/env python3
"""Freeze tracked and nonignored source for an isolated review build.

Run from the project root with --out output/review/<new-directory>.
The archive contains current file bytes, including new implementation files;
the manifest records the base revision and dirty status without checksums.
"""
import argparse
import datetime
import json
from pathlib import Path
import subprocess
import tarfile


def git(*args: str) -> bytes:
    return subprocess.check_output(["git", *args])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    options = parser.parse_args()
    root = Path(git("rev-parse", "--show-toplevel").decode().strip())
    if Path.cwd().resolve() != root.resolve():
        parser.error("Run from the project root")
    destination = options.out.resolve()
    if destination.exists():
        parser.error("Output already exists; choose a new review directory")
    if not destination.is_relative_to(root / "output"):
        parser.error("Review snapshots belong under output/")
    paths = sorted(set(git("ls-files", "-z", "--cached", "--others", "--exclude-standard")
                       .decode().strip("\0").split("\0")))
    files = [name for name in paths if name and (root / name).is_file()]
    if any(name.startswith((".api_keys/", "output/", "docs-internal/")) for name in files):
        parser.error("Review source unexpectedly contains private keys or generated/internal state")
    status = git("status", "--porcelain=v1").decode()
    destination.mkdir(parents=True)
    with tarfile.open(destination / "source.tar.gz", "w:gz") as archive:
        for name in files:
            archive.add(root / name, arcname=name, recursive=False)
    (destination / "snapshot.json").write_text(json.dumps({
        "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "base": git("rev-parse", "HEAD").decode().strip(),
        "branch": git("branch", "--show-current").decode().strip(),
        "dirty": bool(status),
        "status": status,
        "files": files,
    }, indent=2) + "\n")
    print(destination)


if __name__ == "__main__":
    main()

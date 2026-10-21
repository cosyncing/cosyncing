#!/usr/bin/env python3
"""Summarize retained review samples; this is descriptive evidence, not a CI gate.

Run from the project root after verify-settings-storage-routes.sh completes.
Keep the raw JSON beside this summary. In particular, n=20 does not establish a
precise tail percentile or native/mobile/energy parity.
"""
import argparse
import json
import math
from pathlib import Path
import random
import statistics


def distribution(values):
    ordered = sorted(values)
    rank = math.ceil(len(ordered) * .95) - 1
    randomizer = random.Random(20261019)
    tails = sorted(sorted(randomizer.choices(ordered, k=len(ordered)))[rank]
                   for _ in range(10000))
    return {
        "n": len(ordered),
        "median": statistics.median(ordered),
        "p95": ordered[rank],
        "p95EmpiricalBootstrap95Interval": [tails[249], tails[9749]],
        "minimum": ordered[0],
        "maximum": ordered[-1],
    }


def paired_delta(first, second):
    if len(first) != len(second) or not first:
        raise ValueError("Comparison requires equal, nonempty paired samples")
    delta = [b - a for a, b in zip(first, second)]
    randomizer = random.Random(20261019)
    medians = sorted(statistics.median(randomizer.choices(delta, k=len(delta)))
                     for _ in range(10000))
    return {
        **distribution(delta),
        "medianBootstrap95Interval": [medians[249], medians[9749]],
        "absoluteDelta": distribution([abs(value) for value in delta]),
    }


def comparison(control, candidate, field):
    def values(runs):
        by_name = {run["name"]: run for run in runs}
        return [[sample[field] for sample in by_name[name]["samples"]]
                for name in ["baseline", "candidate"]]
    control_a, control_b = values(control)
    before, after = values(candidate)
    return {
        "baselineRepeatability": {
            "first": distribution(control_a),
            "second": distribution(control_b),
            "pairedDelta": paired_delta(control_a, control_b),
        },
        "baseline": distribution(before),
        "candidate": distribution(after),
        "pairedDelta": paired_delta(before, after),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path,
                        default=Path("output/review/settings-storage-routes/performance"))
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--browser-only", action="store_true",
                        help="Summarize a navigation campaign without transfer/scale files")
    args = parser.parse_args()
    def read(stem):
        return json.loads((args.root / f"{stem}-{args.run_id}.json").read_text())
    repeatability = read("browser-repeatability")
    browser = read("browser-comparison")
    transfers = {"runs": []} if args.browser_only else read("transfers")
    storage = {"results": []} if args.browser_only else read("storage-scale")
    interactive = {
        key: comparison(repeatability["results"], browser["results"], key)
        for key in ["openMs", "closeMs", "generalMs", "storageMs", "generalReadyMs", "storageReadyMs", "typingMs", "streamMs"]
        if key in browser["results"][0]["samples"][0]
    }
    startup = {
        key: comparison(repeatability["startup"], browser["startup"], key)
        for key in ["coldMs", "warmMs", "coldReadyMs", "warmReadyMs"]
        if key in browser["startup"][0]["samples"][0]
    }
    transfer_summary = []
    for run in transfers["runs"]:
        samples = run["samples"]
        transfer_summary.append({
            "name": run["name"],
            "fullMs": distribution([sample["full"]["milliseconds"] for sample in samples]),
            "rangeMs": distribution([sample["ranged"]["milliseconds"] for sample in samples]),
            "healthMs": distribution([value for sample in samples for value in sample["healthMs"]]),
            "streamMs": distribution([sample["streamMs"] for sample in samples]),
            "resourcesFirst": samples[0]["before"],
            "resourcesLast": samples[-1]["after"],
        })
    storage_summary = []
    for run in storage["results"]:
        def latency(samples):
            return {key: distribution([sample[key] for sample in samples])
                    for key in ["healthMs", "streamMs"]}
        storage_summary.append({
            "count": run["count"],
            "scanMs": distribution([scan["ms"] for scan in run["scans"]]),
            "cleanupMs": run["removed"]["ms"],
            "quiet": latency(run["quietLatency"]),
            "scanning": latency([sample for scan in run["scans"] for sample in scan["latency"]]),
            "cleaning": latency(run["cleanupLatency"]),
            "resourcesBefore": run["before"],
            "resourcesAfter": run["after"],
        })
    result = {
        "runId": args.run_id,
        "browser": browser["browser"],
        "startup": startup,
        "interactive": interactive,
        "transfers": transfer_summary,
        "storage": storage_summary,
        "limits": [
            "All durations are milliseconds; paired deltas are candidate minus baseline.",
            "Paired-median intervals are separate from empirical p95 intervals; neither is a simultaneous multiple-metric test.",
            "Empirical p95 intervals resample observed values and cannot bound an unseen tail; retain sample counts and raw values.",
            "Nearest-rank p95 with 20 samples is the 19th observation and remains imprecise.",
            "The startup cold sample includes first-use schema setup; warm reload uses the same saved state.",
            "Loopback Direct broker transfers and headless desktop web cannot establish native proxy, physical mobile, or energy parity.",
            "Review the distributions and repeat any suspected regression before acceptance; no automatic pass is assigned.",
        ],
    }
    destination = args.root / f"summary-{args.run_id}.json"
    destination.write_text(json.dumps(result, indent=2) + "\n")
    print(destination)


if __name__ == "__main__":
    main()

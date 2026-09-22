#!/usr/bin/env python3
"""Capture real isolated stdio protocol evidence; never connects to a daemon.

Run from the checkout root. Default: schemas and idle-thread negotiation only.
--live requests two bounded commands from the real model (requires credentials).
Generated evidence is private local output, not a product capability assertion.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time


async def capture(args, out, binary, experimental):
    lane = out / ("experimental" if experimental else "standard")
    lane.mkdir()
    home = lane / "home"
    home.mkdir()
    if args.live and args.auth_file:
        (home / "auth.json").symlink_to(Path(args.auth_file).resolve(strict=True))
    env = dict(os.environ, CODEX_HOME=str(home))
    # HOME also isolates shell startup, caches, and accidental user config reads.
    env["HOME"] = str(home)
    journal = (lane / "wire.jsonl").open("w")
    stderr = (lane / "stderr.log").open("w")
    proc = await asyncio.create_subprocess_exec(
        binary, "app-server", "--stdio", cwd=home, env=env,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=stderr, start_new_session=True, limit=4 * 1024 * 1024,
    )
    sequence = 0
    pending = {}
    completed = asyncio.Event()

    def record(direction, message):
        journal.write(json.dumps({"observedAtMs": int(time.time() * 1000),
                                  "direction": direction, "message": message}) + "\n")
        journal.flush()

    async def send(message):
        record("request", message)
        proc.stdin.write((json.dumps(message) + "\n").encode())
        await proc.stdin.drain()

    async def read():
        while line := await proc.stdout.readline():
            message = json.loads(line)
            record("server", message)
            if "id" in message and ("result" in message or "error" in message):
                future = pending.pop(message["id"], None)
                if future and not future.done():
                    future.set_result(message)
            elif "id" in message:
                # No approvals or tool execution on behalf of the server.
                await send({"id": message["id"], "error": {
                    "code": -32601, "message": "Probe does not handle server requests"}})
            if message.get("method") == "turn/completed":
                completed.set()
        for future in pending.values():
            if not future.done():
                future.set_exception(RuntimeError("Server closed stdout"))

    reader = asyncio.create_task(read())

    async def rpc(method, params):
        nonlocal sequence
        sequence += 1
        future = asyncio.get_running_loop().create_future()
        pending[sequence] = future
        await send({"id": sequence, "method": method, "params": params})
        try:
            return await asyncio.wait_for(future, 20)
        finally:
            pending.pop(sequence, None)

    async def snapshot(thread):
        cursor = None
        seen = set()
        for _ in range(8):
            response = await rpc("thread/backgroundTerminals/list", {
                "threadId": thread, "limit": 1, "cursor": cursor})
            result = response.get("result")
            if not isinstance(result, dict) or not isinstance(result.get("data"), list):
                return
            cursor = result.get("nextCursor")
            if cursor is None:
                return
            if not isinstance(cursor, str) or cursor in seen:
                raise RuntimeError("Malformed or repeated pagination cursor")
            seen.add(cursor)
        raise RuntimeError("Snapshot exceeded the eight-page probe budget")

    try:
        initialized = await rpc("initialize", {
            "clientInfo": {"name": "cosyncing_background_probe", "version": "0.1.0"},
            "capabilities": {"experimentalApi": experimental},
        })
        if "error" in initialized:
            return
        await send({"method": "initialized", "params": {}})
        await rpc("thread/backgroundTerminals/list", {"threadId": "00000000-0000-4000-8000-000000000000", "limit": 1})
        started = await rpc("thread/start", {
            "cwd": str(home), "approvalPolicy": "never", "sandbox": "workspace-write",
            "baseInstructions": "Follow the user's bounded protocol experiment precisely.",
        })
        if "error" in started:
            return
        thread = started["result"]["thread"]["id"]
        await rpc("thread/backgroundTerminals/list", {"threadId": thread, "limit": 1})
        if args.live and experimental:
            result = await rpc("turn/start", {"threadId": thread, "input": [{
                "type": "text", "text": "Run exactly two exec_command calls, each with yield_time_ms=1000. "
                "First command: python3 -c 'import time; print(\"probe-success-start\", flush=True); "
                "time.sleep(8); print(\"probe-success-end\", flush=True)'. "
                "Second command: python3 -c 'import time; print(\"probe-failure-start\", flush=True); "
                "time.sleep(10); print(\"probe-failure-end\", flush=True); raise SystemExit(7)'. "
                "Do not use shell backgrounding, write_stdin, wait, or any other tools. "
                "After both calls yield, finish your turn immediately with the text probe-launched.",
            }]})
            if "error" not in result:
                await asyncio.wait_for(completed.wait(), 120)
                await snapshot(thread)
                # Fixed observation window, not repeated process-status polling.
                await asyncio.sleep(15)
                await snapshot(thread)
                await rpc("thread/read", {"threadId": thread, "includeTurns": True})
    finally:
        # Only this probe's process group; never clean/terminate a thread or daemon.
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(proc.wait(), 5)
        except asyncio.TimeoutError:
            os.killpg(proc.pid, signal.SIGKILL)
            await proc.wait()
        reader.cancel()
        await asyncio.gather(reader, return_exceptions=True)
        (home / "auth.json").unlink(missing_ok=True)
        journal.close()
        stderr.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", default=os.environ.get("CODEX_BIN", "codex"))
    parser.add_argument("--output", default=os.environ.get("PROBE_OUTPUT", "output/codex-background-terminals/p0-run"))
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--auth-file", help="Optional existing auth file, linked temporarily without copying")
    args = parser.parse_args()
    binary = shutil.which(args.codex)
    if not binary:
        parser.error("Codex executable not found")
    binary = str(Path(binary).resolve())
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=False)
    os.chmod(out, 0o700)
    version = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=20)
    inventory = {"binary": binary, "cliVersion": version.stdout.strip(), "schemaExitCode": None,
                 "transport": "isolated-stdio", "liveRequested": args.live}
    schema = subprocess.run([binary, "app-server", "generate-ts", "--experimental", "--out", str(out / "schema")],
                            capture_output=True, text=True, timeout=30)
    inventory["schemaExitCode"] = schema.returncode
    (out / "schema-generator.log").write_text(schema.stdout + schema.stderr)
    (out / "inventory.json").write_text(json.dumps(inventory, indent=2) + "\n")
    failures = []
    for experimental in (False, True):
        try:
            asyncio.run(capture(args, out, binary, experimental))
        except Exception as exc:
            failures.append({"experimental": experimental, "error": type(exc).__name__, "detail": str(exc)})
    (out / "capture-result.json").write_text(json.dumps({"failures": failures}, indent=2) + "\n")
    print(f"Evidence captured in {out}")
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()

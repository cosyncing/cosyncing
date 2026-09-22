#!/usr/bin/env python3
"""Capture reconnect on an isolated server, or an explicitly authorized existing socket.

--existing-socket creates one real fixture thread; it requires owner authorization.
That mode never starts, stops, or restarts the existing runtime.
"""
import argparse
import asyncio
import json
from pathlib import Path
import time
import os
import signal
import shutil
import socket
import stat
import websockets


async def main(args):
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=False)
    out.chmod(0o700)
    home = None
    proc = None
    stderr = None
    if args.existing_socket:
        args.socket = str(Path(args.existing_socket).resolve(strict=True))
        if not stat.S_ISSOCK(Path(args.socket).stat().st_mode):
            raise RuntimeError('The explicitly selected control socket is not a socket')
    else:
        if not args.auth_file and not args.history_from:
            raise RuntimeError('The isolated live probe requires --auth-file')
        binary = shutil.which(args.codex)
        if not binary:
            raise RuntimeError('Codex binary not found')
        if args.history_from:
            evidence = Path(args.history_from).resolve(strict=True)
            if not (evidence / 'complete.json').exists():
                raise RuntimeError('History replay requires a completed owned probe capture')
            home = evidence / 'home'
            if not home.is_dir() or (home / 'auth.json').exists():
                raise RuntimeError('Previous isolated probe is not cleanly closed')
        else:
            home = out / 'home'
            home.mkdir()
        if args.auth_file:
            (home / 'auth.json').symlink_to(Path(args.auth_file).resolve(strict=True))
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        args.socket = f'ws://127.0.0.1:{port}'
        stderr = (out / 'stderr.log').open('w')
        try:
            proc = await asyncio.create_subprocess_exec(
                binary, 'app-server', '--listen', args.socket,
                cwd=home, env=dict(os.environ, HOME=str(home), CODEX_HOME=str(home)),
                stdout=stderr, stderr=stderr, start_new_session=True)
        except BaseException:
            (home / 'auth.json').unlink(missing_ok=True)
            stderr.close()
            raise
        (out / 'server.json').write_text(json.dumps(dict(binary=binary, pid=proc.pid, socket=args.socket))+'\n')
    journal = (out / 'wire.jsonl').open('w')
    thread = None
    connections = []

    def record(lane, direction, message):
        journal.write(json.dumps(dict(lane=lane, direction=direction,
                                     observedAtMs=int(time.time()*1000), message=message))+'\n')
        journal.flush()

    async def connect(lane):
        connector = websockets.unix_connect if args.existing_socket else websockets.connect
        # Match the product's minimal handshake. Optional Python compression / UA
        # headers are not required and can be refused by the managed Unix listener.
        ws = await connector(args.socket, max_size=8*1024*1024, open_timeout=10,
                             compression=None, user_agent_header=None)
        connections.append(ws)
        pending = {}
        completed = asyncio.Event()
        sequence = 0

        async def read():
            async for raw in ws:
                message = json.loads(raw)
                if message.get('id') in pending and ('result' in message or 'error' in message):
                    record(lane, 'server', message)
                    pending.pop(message['id']).set_result(message)
                elif thread and message.get('params', {}).get('threadId') == thread:
                    record(lane, 'server', message)
                    if message.get('method') == 'turn/completed':
                        completed.set()

        task = asyncio.create_task(read())

        async def rpc(method, params):
            nonlocal sequence
            sequence += 1
            ident = sequence
            future = asyncio.get_running_loop().create_future()
            pending[ident] = future
            message = dict(id=ident, method=method, params=params)
            record(lane, 'request', message)
            await ws.send(json.dumps(message))
            try:
                result = await asyncio.wait_for(future, 15)
                if 'error' in result:
                    return result
                return result['result']
            finally:
                pending.pop(ident, None)

        await rpc('initialize', dict(clientInfo=dict(name='cosyncing_background_recovery_probe', version='0.1'),
                                     capabilities=dict(experimentalApi=True)))
        await ws.send(json.dumps(dict(method='initialized', params={})))
        return ws, rpc, completed, task

    tasks = []
    try:
        if proc is not None:
            await asyncio.sleep(2)
            if proc.returncode is not None:
                raise RuntimeError('Isolated server exited before connection; refusing to connect to a different listener')
        owner, rpc, completed, task = await connect('owner')
        tasks.append(task)
        if args.history_from:
            thread = json.loads((Path(args.history_from) / 'fixture.json').read_text())['threadId']
            await rpc('thread/backgroundTerminals/list', dict(threadId=thread, limit=32))
            await rpc('thread/items/list', dict(threadId=thread, limit=32, sortDirection='desc'))
            turns = await rpc('thread/turns/list', dict(threadId=thread, limit=4, sortDirection='desc', itemsView='summary'))
            for turn in turns.get('data', [])[:4]:
                await rpc('thread/turns/items/list', dict(threadId=thread, turnId=turn['id'], limit=32, sortDirection='desc'))
            (out / 'complete.json').write_text(json.dumps(dict(threadId=thread, captureComplete=True))+'\n')
            print('Cold history capture complete:', out)
            return
        started = await rpc('thread/start', dict(cwd=str(out), approvalPolicy='never', sandbox='workspace-write',
            baseInstructions='Run only the two bounded fixture commands requested by the user.'))
        thread = started['thread']['id']
        (out / 'fixture.json').write_text(json.dumps(dict(threadId=thread, socket=args.socket))+'\n')
        await rpc('turn/start', dict(threadId=thread, input=[dict(type='text', text=
            "Run two exec_command calls with yield_time_ms=1000. First: python3 -c 'import time; "
            "print(\"recovery-start-0\",flush=True); time.sleep(25); print(\"recovery-end-0\",flush=True)'. "
            "Second: python3 -c 'import time; print(\"recovery-start-7\",flush=True); time.sleep(30); "
            "print(\"recovery-end-7\",flush=True); raise SystemExit(7)'. "
            "Do not use shell backgrounding, wait, write_stdin, or any other tools. "
            "Immediately finish your turn after both calls yield. Say recovery-launched.")]))
        await asyncio.wait_for(completed.wait(), 120)
        await rpc('thread/backgroundTerminals/list', dict(threadId=thread, limit=100))
        observer, query, _, task = await connect('observer-after-yield')
        tasks.append(task)
        # This is only the fixture thread we just created, never an unrelated thread.
        await query('thread/resume', dict(threadId=thread, excludeTurns=True))
        await query('thread/backgroundTerminals/list', dict(threadId=thread, limit=100))
        await owner.close()
        await observer.close()
        # One fixed disconnected window; no status polling.
        await asyncio.sleep(35)
        recovered, query, _, task = await connect('recovered')
        tasks.append(task)
        await query('thread/backgroundTerminals/list', dict(threadId=thread, limit=100))
        await query('thread/turns/list', dict(threadId=thread, limit=8, sortDirection='desc', itemsView='full'))
        await query('thread/items/list', dict(threadId=thread, limit=32, sortDirection='desc'))
        await query('thread/read', dict(threadId=thread, includeTurns=True))
        (out / 'complete.json').write_text(json.dumps(dict(threadId=thread, captureComplete=True))+'\n')
        print('Recovery capture complete:', out)
    finally:
        for ws in connections:
            await ws.close()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        journal.close()
        if proc is not None:
            if proc.returncode is None:
                os.killpg(proc.pid, signal.SIGTERM)
            try:
                await asyncio.wait_for(proc.wait(), 5)
            except asyncio.TimeoutError:
                os.killpg(proc.pid, signal.SIGKILL)
                await proc.wait()
        if home is not None:
            (home / 'auth.json').unlink(missing_ok=True)
        if stderr is not None:
            stderr.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--codex', default='codex')
    parser.add_argument('--auth-file')
    parser.add_argument('--existing-socket', help='Owner-authorized fixture on an existing daemon; no lifecycle controls')
    parser.add_argument('--history-from', help='Read a previously completed isolated fixture after server restart; no model turn')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    if args.existing_socket and args.history_from:
        parser.error('--history-from cannot access an existing daemon')
    asyncio.run(main(args))

/**
 * Getting a file from the app to the agent, and cleaning up after it.
 *
 * Large files go up in resumable chunks over HTTP (`/uploads`) and finish as
 * an opaque staged reference; small ones ride the prompt inline. Either way
 * the agent is handed a path inside the session's workspace inbox
 * (`<cwd>/.cosyncing/inbox`), and a periodic sweep later collects what was
 * delivered there. A Pi session, driven over its bridge, is the agent: the
 * prompt it is handed is exactly what the extension would receive.
 *
 * The brokers run with a fast sweep (a source-only test knob) so retention is
 * observable in milliseconds. A "sweep barrier" proves that a whole sweep ran
 * after a test arranged its files, which is what lets a test say a file
 * SURVIVED rather than "was not deleted yet".
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type Broker,
  BrokerClient,
  eventually,
  type SessionStream,
  startBroker,
} from '../harness/index.ts';
import { PiBridgeSession } from '../harness/fakes/pi-bridge-driver.ts';

const KiB = 1024;
const MiB = 1024 * KiB;
const DAY_MS = 24 * 60 * 60 * 1000;
const POSIX = process.platform !== 'win32';

const b64 = (bytes: string | Buffer): string => Buffer.from(bytes).toString('base64');

/** The app's client: the broker binds staged uploads to the credential AND this profile incarnation. */
class ProfiledClient extends BrokerClient {
  readonly profile: string;
  readonly incarnation: string;

  constructor(base: BrokerClient, profile: string, incarnation: string) {
    super(base.url, base.wsUrl, base.auth);
    this.profile = profile;
    this.incarnation = incarnation;
  }

  override credentialHeaders(): Record<string, string> {
    return {
      ...super.credentialHeaders(),
      'x-cosyncing-client-profile': this.profile,
      'x-cosyncing-client-incarnation': this.incarnation,
    };
  }
}

const uploadsPath = (pi: PiBridgeSession): string => `/api/sessions/pi/${encodeURIComponent(pi.id)}/uploads`;

async function begin(client: BrokerClient, pi: PiBridgeSession, name: string, size?: number): Promise<string> {
  const init = await client.post(uploadsPath(pi), {
    name,
    mimeType: 'text/plain',
    ...(size === undefined ? {} : { size }),
  });
  expect(init.status).toBe(200);
  expect(init.body.offset).toBe(0);
  return String(init.body.uploadId);
}

function patch(client: BrokerClient, pi: PiBridgeSession, uploadId: string, offset: number, bytes: Uint8Array) {
  return client.request('PATCH', `${uploadsPath(pi)}/${encodeURIComponent(uploadId)}`, bytes, {
    'x-cosyncing-upload-offset': String(offset),
  });
}

/** Upload `bytes` in chunks and complete it; returns the completion body. */
async function stage(client: BrokerClient, pi: PiBridgeSession, name: string, bytes: Buffer, chunk = Math.max(1, bytes.length)): Promise<any> {
  const uploadId = await begin(client, pi, name, bytes.length);
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    const response = await patch(client, pi, uploadId, offset, bytes.subarray(offset, offset + chunk));
    expect(response.status).toBe(200);
  }
  const complete = await client.post(`${uploadsPath(pi)}/${encodeURIComponent(uploadId)}/complete`);
  expect(complete.status).toBe(200);
  return complete.body;
}

const inboxOf = (cwd: string): string => join(cwd, '.cosyncing', 'inbox');
const listInbox = (cwd: string): string[] => (existsSync(inboxOf(cwd)) ? readdirSync(inboxOf(cwd)).sort() : []);

/** The paths a prompt handed to the agent, in order. */
const attachedPaths = (command: any): string[] =>
  [...String(command?.text ?? '').matchAll(/→ `([^`]+)`/g)].map((match) => match[1]!);

/** Every prompt the agent has been handed, after waiting for the one with `text`. */
async function promptsThrough(pi: PiBridgeSession, text: string): Promise<string[]> {
  await pi.nextCommand((command) => command.kind === 'prompt' && String(command.text).startsWith(text), { what: `the "${text}" prompt` });
  return pi.commands.filter((command) => command.kind === 'prompt').map((command) => String(command.text).split('\n')[0]!);
}

function filesBelow(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** The broker's own staging record for an upload, rewritten as if its lifetime had passed. */
function expireStagingRecord(broker: Broker, uploadId: string): void {
  const record = filesBelow(join(broker.paths.cosyncingHome, 'uploads')).find((path) => path.endsWith(`${uploadId}.json`));
  if (!record) throw new Error(`no staging record for ${uploadId}`);
  writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, 'utf8')), expiresAt: Date.now() - 1000 }));
}

interface SeedFile {
  name: string;
  bytes: number;
  /** How long ago the file was last modified. */
  ageMs: number;
}

function writeAged(path: string, bytes: number, ageMs: number): void {
  writeFileSync(path, Buffer.alloc(bytes, 0x61));
  const when = (Date.now() - ageMs) / 1000;
  utimesSync(path, when, when);
}

/**
 * Give `cwd` a whole `.cosyncing/inbox` in one rename, so no sweep ever sees
 * half of it. Files are built beside the workspace (same filesystem).
 */
function placeInbox(cwd: string, files: SeedFile[]): void {
  const arranged = mkdtempSync(join(dirname(cwd), 'arrange-'));
  mkdirSync(join(arranged, 'inbox'));
  for (const file of files) writeAged(join(arranged, 'inbox', file.name), file.bytes, file.ageMs);
  renameSync(arranged, join(cwd, '.cosyncing'));
}

/** Files named `prefix-NN` from oldest to newest, a minute apart, the newest `newestAgeMs` old. */
function series(prefix: string, sizes: number[], newestAgeMs: number): SeedFile[] {
  return sizes.map((bytes, index) => ({
    name: `${prefix}-${String(index).padStart(2, '0')}`,
    bytes,
    ageMs: newestAgeMs + (sizes.length - 1 - index) * 60_000,
  }));
}
const names = (files: SeedFile[]): string[] => files.map((file) => file.name);

/**
 * Proof that a complete sweep ran after this call began. Each pulse is an
 * aged file in a live workspace's inbox, which any sweep collects. The first
 * vanishing pulse proves a sweep reached the inbox after the call began; the
 * second, a later sweep that started after that one; the third, that the
 * second finished — and a sweep visits every inbox once.
 */
class SweepBarrier {
  private pulses = 0;
  constructor(private readonly cwd: string) {}

  async pass(): Promise<void> {
    for (let step = 0; step < 3; step += 1) {
      const pulse = join(this.cwd, '.cosyncing', 'inbox', `pulse-${++this.pulses}`);
      const arranged = join(this.cwd, `pulse-${this.pulses}`);
      writeAged(arranged, 1, 30 * DAY_MS);
      renameSync(arranged, pulse);
      await eventually(() => !existsSync(pulse), { what: `sweep pulse ${this.pulses} to be collected` });
    }
  }
}

/** Expired staging records are swept too: an expiring upload is the pulse when the inbox sweep is off. */
class StagingSweepBarrier {
  constructor(private readonly broker: Broker, private readonly client: BrokerClient, private readonly pi: PiBridgeSession) {}

  async pass(): Promise<void> {
    for (let step = 0; step < 3; step += 1) {
      const uploadId = await begin(this.client, this.pi, `pulse-${step}.txt`);
      const root = join(this.broker.paths.cosyncingHome, 'uploads');
      // Created before `begin` returned; nothing but the timer's sweep touches it after.
      await eventually(() => filesBelow(root).every((path) => !path.includes(uploadId)), {
        what: `expired upload ${uploadId} to be swept`,
      });
    }
  }
}

test('owner storage measures staged and delivered attachments and removes only expired owned bytes', async () => {
  const broker=await startBroker({name:'upload-storage-review',token:true,env:{COSYNCING_TEST_UPLOAD_SWEEP_MS:'86400000'}});
  const client=broker.client();
  try {
    const cwd=join(broker.paths.root,'workspace');mkdirSync(cwd);
    const pi=await PiBridgeSession.open(client,{cwd,title:'Storage review'});
    const live=await stage(client,pi,'waiting.txt',Buffer.from('waiting'));
    const expired=await begin(client,pi,'abandoned.txt',9);
    expect((await patch(client,pi,expired,0,Buffer.from('abandoned'))).status).toBe(200);
    expireStagingRecord(broker,expired);
    const stream=await client.attach('pi',pi.id,{mode:'resume'});
    await stream.waitForKind('history');
    expect((await stream.sendAndAwait({kind:'prompt',text:'Keep the attachment',files:[
      {name:'delivered.txt',mimeType:'text/plain',data:b64('delivered')},
    ]})).kind).toBe('ack');
    const delivered=join(inboxOf(cwd),'delivered.txt');
    const aged=(Date.now()-90*DAY_MS)/1000;utimesSync(delivered,aged,aged);
    const outside=join(cwd,'workspace-original.txt');writeFileSync(outside,'original');
    const started=await client.post('/api/storage/scans');
    let progress=started.body;
    for(let i=0;progress.state==='running'&&i<10;i++)progress=(await client.get(`/api/storage/scans/${started.body.scanId}?waitMs=10000`)).body;
    expect(progress.state).toBe('completed');
    const inventory=(await client.get('/api/storage')).body;
    const staging=await client.get(`/api/storage/items?inventoryId=${inventory.inventoryId}&category=staging`);
    expect(staging.body.items.find((item:any)=>item.label==='waiting.txt')).toMatchObject({eligible:false,reason:'RETENTION',size:7});
    expect(staging.body.items.find((item:any)=>item.label==='abandoned.txt')).toMatchObject({eligible:true,size:9});
    const stored=await client.get(`/api/storage/items?inventoryId=${inventory.inventoryId}&category=stored-files`);
    expect(stored.body.items).toHaveLength(1);
    expect(stored.body.items[0]).toMatchObject({label:'delivered.txt',eligible:true,size:9});
    for(const category of ['staging','stored-files']) {
      const plan=(await client.post('/api/storage/cleanup-plans',{inventoryId:inventory.inventoryId,
        mode:category==='staging'?'cache':'stored-files',filter:{category},selectAll:true})).body;
      expect(plan.itemCount).toBe(1);
      if(category==='staging')expect(plan.skippedCount).toBe(1);
      const accepted=(await client.post('/api/storage/cleanup-jobs',{planId:plan.planId,idempotencyKey:`storage-upload-${category}-001`})).body;
      let job=accepted;
      for(let i=0;!['completed','partial','canceled'].includes(job.state)&&i<10;i++)job=(await client.get(`/api/storage/cleanup-jobs/${accepted.jobId}?waitMs=10000`)).body;
      expect(job).toMatchObject({state:'completed',removed:1,failed:0,reclaimedBytes:9});
    }
    expect(readFileSync(join(inboxOf(cwd),live.name),'utf8')).toBe('waiting');
    expect((await client.get(`${uploadsPath(pi)}/${live.uploadId}`)).status).toBe(200);
    expect((await client.get(`${uploadsPath(pi)}/${expired}`)).status).toBe(404);
    expect(existsSync(delivered)).toBe(false);
    expect(readFileSync(outside,'utf8')).toBe('original');
    stream.close();
  } finally {client.closeAll();await broker.stop();}
});

describe('chunked uploads, staged attachments and inbox collection', () => {
  let broker: Broker;
  let owner: BrokerClient;
  let phone: ProfiledClient;
  let barrier: SweepBarrier;
  const live: PiBridgeSession[] = [];

  function workspace(name: string): string {
    const cwd = join(broker.paths.home, name);
    mkdirSync(cwd);
    return cwd;
  }

  async function session(name: string, setup?: (cwd: string) => void): Promise<PiBridgeSession> {
    const cwd = workspace(name);
    setup?.(cwd);
    const pi = await PiBridgeSession.open(owner, { cwd, title: name });
    live.push(pi);
    return pi;
  }

  async function attach(client: BrokerClient, pi: PiBridgeSession): Promise<SessionStream> {
    const stream = await client.attach('pi', pi.id, { mode: 'resume' });
    await stream.waitForKind('history');
    return stream;
  }

  beforeAll(async () => {
    broker = await startBroker({
      name: 'uploads',
      token: true,
      env: {
        COSYNCING_UPLOAD_MAX_BYTES: String(40 * MiB),
        COSYNCING_UPLOAD_CHUNK_MAX_BYTES: String(8 * MiB),
        COSYNCING_TEST_UPLOAD_SWEEP_MS: '100',
        COSYNCING_INBOX_MAX_FILES: '10',
        COSYNCING_INBOX_MAX_BYTES: '2048',
      },
    });
    owner = broker.client();
    phone = new ProfiledClient(owner, 'phone', 'phone-install-1');
    const barrierSession = await session('barrier', (cwd) => placeInbox(cwd, []));
    barrier = new SweepBarrier(barrierSession.cwd);
  });
  afterAll(() => broker?.stop());

  test('a chunked upload resumes from the broker\'s offset and lands byte-exact in the session inbox', async () => {
    const pi = await session('chunked');
    const payload = Buffer.from('chunked-upload-'.repeat(4));
    const uploadId = await begin(phone, pi, 'payload.bin', payload.length);
    const first = await patch(phone, pi, uploadId, 0, payload.subarray(0, 20));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ uploadId, offset: 20 });
    expect(typeof first.body.progress).toBe('number');

    // The connection dropped; the app asks where to resume.
    const status = await phone.get(`${uploadsPath(pi)}/${uploadId}`);
    expect(status.body).toMatchObject({ offset: 20, size: payload.length, name: 'payload.bin' });
    const stale = await patch(phone, pi, uploadId, 0, payload.subarray(0, 20));
    expect([stale.status, stale.body.code, stale.body.offset]).toEqual([409, 'UPLOAD_OFFSET_MISMATCH', 20]);
    const early = await phone.post(`${uploadsPath(pi)}/${uploadId}/complete`);
    expect([early.status, early.body.code]).toEqual([409, 'UPLOAD_SIZE_MISMATCH']);

    expect((await patch(phone, pi, uploadId, 20, payload.subarray(20))).body.offset).toBe(payload.length);
    const complete = await phone.post(`${uploadsPath(pi)}/${uploadId}/complete`);
    expect(complete.status).toBe(200);
    expect(complete.body).toMatchObject({ uploadId, name: 'payload.bin', size: payload.length });
    expect(complete.body.stagedRef).toMatch(/^stg1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(complete.text).not.toContain(pi.cwd);
    expect('path' in complete.body).toBe(false);
    expect(readFileSync(join(inboxOf(pi.cwd), 'payload.bin')).equals(payload)).toBe(true);
    // Completing again answers with the same reference.
    expect((await phone.post(`${uploadsPath(pi)}/${uploadId}/complete`)).body.stagedRef).toBe(complete.body.stagedRef);

    // A second file of the same name never overwrites the first.
    const second = await stage(phone, pi, 'payload.bin', Buffer.from('second'));
    expect(second.name).not.toBe('payload.bin');
    expect(readFileSync(join(inboxOf(pi.cwd), second.name), 'utf8')).toBe('second');
    expect(readFileSync(join(inboxOf(pi.cwd), 'payload.bin')).equals(payload)).toBe(true);

    // A discarded upload is gone.
    const discarded = await begin(phone, pi, 'discard.txt', 4);
    expect((await phone.delete(`${uploadsPath(pi)}/${discarded}`)).body.removed).toBe(true);
    expect((await phone.get(`${uploadsPath(pi)}/${discarded}`)).status).toBe(404);
  });

  test('a file larger than the old 32 MB WebSocket frame cap uploads in 8 MiB chunks', async () => {
    const pi = await session('large');
    const payload = Buffer.alloc(33 * MiB);
    for (let index = 0; index < payload.length; index += 4096) payload.writeUInt32LE(index, index);
    const complete = await stage(phone, pi, 'large.bin', payload, 8 * MiB);
    expect(complete.size).toBe(payload.length);
    expect(readFileSync(join(inboxOf(pi.cwd), 'large.bin')).equals(payload)).toBe(true);
  });

  test('uploads need a credential, a safe file name, and a broker-issued id', async () => {
    const pi = await session('guarded');
    const anonymous = owner.as({ kind: 'none' });
    const uploadId = await begin(phone, pi, 'guarded.txt', 3);
    const statuses = [
      (await anonymous.post(uploadsPath(pi), { name: 'x.txt', size: 1 })).status,
      (await anonymous.get(`${uploadsPath(pi)}/${uploadId}`)).status,
      (await patch(anonymous, pi, uploadId, 0, Buffer.from('abc'))).status,
      (await anonymous.post(`${uploadsPath(pi)}/${uploadId}/complete`)).status,
      (await anonymous.delete(`${uploadsPath(pi)}/${uploadId}`)).status,
    ];
    expect(statuses).toEqual([401, 401, 401, 401, 401]);
    expect((await phone.get(`${uploadsPath(pi)}/${uploadId}`)).body.offset).toBe(0);

    const traversal = encodeURIComponent('../escape');
    const lookup = await phone.get(`${uploadsPath(pi)}/${traversal}`);
    const write = await phone.request('PATCH', `${uploadsPath(pi)}/${traversal}`, Buffer.from('abc'), { 'x-cosyncing-upload-offset': '0' });
    expect([lookup.status, lookup.body.code, write.status, write.body.code]).toEqual([400, 'BAD_PARAM', 400, 'BAD_PARAM']);
    for (const name of ['../evil.txt', '.', 'dir/evil.txt']) {
      const refused = await phone.post(uploadsPath(pi), { name, size: 1 });
      expect([name, refused.status, refused.body.code]).toEqual([name, 400, 'BAD_PARAM']);
    }
    expect(listInbox(pi.cwd)).toEqual([]);
  });

  test.skipIf(!(process.platform === 'linux' && existsSync('/dev/shm')))(
    'completion moves the bytes into a workspace on another filesystem',
    async () => {
      const cwd = mkdtempSync(join('/dev/shm', 'cosyncing-e2e-uploads-'));
      try {
        if (statSync(cwd).dev === statSync(broker.paths.cosyncingHome).dev) return; // nothing to cross
        const pi = await PiBridgeSession.open(owner, { cwd, title: 'other-filesystem' });
        const payload = Buffer.from('cross-device bytes');
        const complete = await stage(phone, pi, 'cross.bin', payload);
        expect(readFileSync(join(inboxOf(cwd), complete.name)).equals(payload)).toBe(true);
        const staging = filesBelow(join(broker.paths.cosyncingHome, 'uploads'));
        expect(staging.filter((path) => path.includes(complete.uploadId) && path.endsWith('.bin'))).toEqual([]);
        await pi.bye();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  test('the agent receives inline and staged files in prompt order, as inbox paths, and a staged reference is consumed once', async () => {
    const pi = await session('prompt');
    const staged = await stage(phone, pi, 'notes.txt', Buffer.from('abcdef'));
    const stream = await attach(phone, pi);
    const clientMessageId = crypto.randomUUID();
    const prompt = {
      kind: 'prompt',
      text: 'read these',
      clientMessageId,
      files: [
        { name: 'inline.txt', mimeType: 'text/plain', data: b64('inline-bytes'), size: 12 },
        { stagedRef: staged.stagedRef, size: 6 },
      ],
    };
    expect((await stream.sendAndAwait(prompt)).kind).toBe('ack');

    const command = await pi.nextCommand((candidate) => String(candidate.text).startsWith('read these'));
    const paths = attachedPaths(command);
    expect(paths).toEqual([join(inboxOf(pi.cwd), 'inline.txt'), join(inboxOf(pi.cwd), 'notes.txt')]);
    expect(paths.map((path) => readFileSync(path, 'utf8'))).toEqual(['inline-bytes', 'abcdef']);
    expect(command.text).toContain('- inline.txt (text/plain) →');
    expect(command.clientKey).toBe(clientMessageId);
    expect(JSON.stringify(command)).not.toContain(b64('inline-bytes'));
    expect(JSON.stringify(command)).not.toContain(staged.stagedRef);

    // A resend of the same message is answered from the journal; the agent is not prompted twice.
    const resend = await stream.sendAndAwait(prompt);
    expect([resend.kind, resend.duplicate]).toEqual(['ack', true]);
    // A new message cannot spend the reference again.
    const respend = await stream.sendAndAwait({ kind: 'prompt', text: 'again', files: [{ stagedRef: staged.stagedRef }] });
    expect([respend.kind, respend.code]).toEqual(['nack', 'STAGED_ATTACHMENT_NOT_FOUND']);
    expect((await stream.sendAndAwait({ kind: 'prompt', text: 'sentinel' })).kind).toBe('ack');
    expect(await promptsThrough(pi, 'sentinel')).toEqual(['read these', 'sentinel']);
    // Delivered files stay for the agent to read.
    expect(listInbox(pi.cwd)).toEqual(['inline.txt', 'notes.txt']);
    stream.close();
  });

  test('a staged reference belongs to the credential and app installation that uploaded it', async () => {
    const pi = await session('identity');
    const staged = await stage(phone, pi, 'private.txt', Buffer.from('mine'));
    const tablet = new ProfiledClient(owner, 'tablet', 'tablet-install-1');
    const reinstalled = new ProfiledClient(owner, 'phone', 'phone-install-2');
    for (const other of [tablet, reinstalled, owner]) {
      const status = await other.get(`${uploadsPath(pi)}/${staged.uploadId}`);
      expect([status.status, status.body.code]).toEqual([403, 'UPLOAD_SCOPE_MISMATCH']);
      const stream = await attach(other, pi);
      const reply = await stream.sendAndAwait({ kind: 'prompt', text: 'not yours', files: [{ stagedRef: staged.stagedRef }] });
      expect([reply.kind, reply.code]).toEqual(['nack', 'STAGED_ATTACHMENT_SCOPE_MISMATCH']);
      stream.close();
    }
    const mine = await attach(phone, pi);
    expect((await mine.sendAndAwait({ kind: 'prompt', text: 'mine', files: [{ stagedRef: staged.stagedRef }] })).kind).toBe('ack');
    expect(await promptsThrough(pi, 'mine')).toEqual(['mine']);
    mine.close();
  });

  test('a prompt the agent refuses rolls its files back, and the staged reference can be sent again', async () => {
    const pi = await session('rollback');
    const original = pi.cwd;
    const staged = await stage(phone, pi, 'retry.txt', Buffer.from('retry bytes'));
    const stream = await attach(phone, pi);
    // The terminal moved to another directory: the staged file is no longer in the agent's inbox.
    const moved = workspace('rollback-moved');
    await pi.rehello({ cwd: moved });
    const refused = await stream.sendAndAwait({
      kind: 'prompt',
      text: 'refused',
      files: [{ name: 'rolled-back.txt', mimeType: 'text/plain', data: b64('gone') }, { stagedRef: staged.stagedRef }],
    });
    expect([refused.kind, refused.code]).toEqual(['nack', 'ATTACHMENT_DELIVERY_FAILED']);
    expect(listInbox(moved)).toEqual([]);

    await pi.rehello({ cwd: original });
    expect((await stream.sendAndAwait({ kind: 'prompt', text: 'retried', files: [{ stagedRef: staged.stagedRef }] })).kind).toBe('ack');
    const command = await pi.nextCommand((candidate) => String(candidate.text).startsWith('retried'));
    expect(attachedPaths(command)).toEqual([join(inboxOf(original), 'retry.txt')]);
    expect(await promptsThrough(pi, 'retried')).toEqual(['retried']);
    stream.close();
  });

  test('malformed or oversized attachments are refused before anything reaches the agent or the inbox', async () => {
    const pi = await session('refusals');
    const stream = await attach(phone, pi);
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
    const inline = (bytes: number, name = 'f.bin') => ({ name, mimeType: 'application/octet-stream', data: b64(Buffer.alloc(bytes, 0x61)) });
    const refusals: Array<[string, Record<string, unknown>, string]> = [
      ['a client-chosen path', { files: [{ name: 'passwd', path: '/etc/passwd' }] }, 'STAGED_ATTACHMENT_SCOPE_MISMATCH'],
      ['files that are not a list', { files: { name: 'x' } }, 'ATTACHMENT_INVALID'],
      ['both bytes and a reference', { files: [{ ...inline(1), stagedRef: 'stg1.x' }] }, 'ATTACHMENT_INVALID'],
      ['an unknown reference', { files: [{ stagedRef: `stg1.${crypto.randomUUID()}.${'A'.repeat(43)}` }] }, 'STAGED_ATTACHMENT_NOT_FOUND'],
      ['nine files', { files: Array.from({ length: 9 }, (_, index) => inline(1, `f${index}.bin`)) }, 'ATTACHMENT_LIMIT_EXCEEDED'],
      ['one inline file over 256 KiB', { files: [inline(256 * KiB + 1)] }, 'ATTACHMENT_LIMIT_EXCEEDED'],
      ['inline files over 1 MiB together', { files: Array.from({ length: 5 }, (_, index) => inline(250 * KiB, `f${index}.bin`)) }, 'ATTACHMENT_LIMIT_EXCEEDED'],
      ['an image over the inline bound', { images: [{ data: b64(Buffer.alloc(MiB + 3, 0x61)), mimeType: 'image/png' }] }, 'ATTACHMENT_LIMIT_EXCEEDED'],
      ['images over the inline budget together', { images: Array.from({ length: 8 }, () => ({ data: b64(Buffer.alloc(MiB - 3, 0x62)), mimeType: 'image/png' })) }, 'ATTACHMENT_LIMIT_EXCEEDED'],
      ['an image naming a broker path', { images: [{ data: png, mimeType: 'image/png', brokerPath: '/etc/passwd' }] }, 'ATTACHMENT_INVALID'],
      ['an image without a type', { images: [{ data: png }] }, 'ATTACHMENT_INVALID'],
      ['an image as a data: URL', { images: [{ data: `data:image/png;base64,${png}`, mimeType: 'image/png' }] }, 'ATTACHMENT_INVALID'],
      ['an image that is not base64', { images: [{ data: 'not!base64', mimeType: 'image/png' }] }, 'ATTACHMENT_INVALID'],
    ];
    for (const [what, fields, code] of refusals) {
      const reply = await stream.sendAndAwait({ kind: 'prompt', text: `refused: ${what}`, ...fields });
      expect([what, reply.kind, reply.code]).toEqual([what, 'nack', code]);
    }
    // Attachments need a message id the broker can deduplicate on.
    const after = stream.frames.length;
    stream.send({ kind: 'prompt', text: 'refused: no message id', files: [inline(1)] });
    expect((await stream.waitForFrame((frame) => frame.kind === 'nack', { after })).code).toBe('ATTACHMENT_INVALID');

    expect((await stream.sendAndAwait({ kind: 'prompt', text: 'a well-formed image', images: [{ data: png, mimeType: 'image/png' }] })).kind).toBe('ack');
    expect(await promptsThrough(pi, 'a well-formed image')).toEqual(['a well-formed image']);
    expect(listInbox(pi.cwd)).toEqual([]);
    stream.close();
  });

  test('the agents that take files say so', async () => {
    const agents = new Map((await owner.agents()).map((agent) => [agent.id, agent]));
    for (const id of ['codex', 'claude', 'opencode', 'pi']) {
      expect([id, agents.get(id)?.capabilities?.supportsNativeFileInput]).toEqual([id, true]);
    }
    for (const id of ['grok', 'cline', 'kilocode', 'reasonix']) {
      if (agents.has(id)) expect([id, agents.get(id).capabilities?.supportsNativeFileInput]).toEqual([id, false]);
    }
  });

  test('a delivered attachment is collected once it is older than the retention age, staged or inline', async () => {
    const pi = await session('retention');
    const staged = await stage(phone, pi, 'staged.txt', Buffer.from('staged'));
    const stream = await attach(phone, pi);
    expect((await stream.sendAndAwait({
      kind: 'prompt',
      text: 'deliver',
      files: [{ name: 'inline.txt', mimeType: 'text/plain', data: b64('inline') }, { stagedRef: staged.stagedRef }],
    })).kind).toBe('ack');
    stream.close();
    await barrier.pass();
    expect(listInbox(pi.cwd)).toEqual(['inline.txt', 'staged.txt']);
    for (const name of ['inline.txt', 'staged.txt']) {
      const when = (Date.now() - 15 * DAY_MS) / 1000;
      utimesSync(join(inboxOf(pi.cwd), name), when, when);
    }
    await eventually(() => listInbox(pi.cwd).length === 0, { what: 'the aged attachments to be collected' });
  });

  test('a staged file the agent has not been given yet is kept, however old, until its prompt commits', async () => {
    const pi = await session('protected');
    const staged = await stage(phone, pi, 'waiting.txt', Buffer.from('waiting'));
    const path = join(inboxOf(pi.cwd), 'waiting.txt');
    const when = (Date.now() - 30 * DAY_MS) / 1000;
    utimesSync(path, when, when);
    await barrier.pass();
    expect(existsSync(path)).toBe(true);
    const stream = await attach(phone, pi);
    expect((await stream.sendAndAwait({ kind: 'prompt', text: 'now', files: [{ stagedRef: staged.stagedRef }] })).kind).toBe('ack');
    stream.close();
    await eventually(() => !existsSync(path), { what: 'the delivered aged file to be collected' });
  });

  test('new files are kept while a session works in the workspace; once it ends the inbox is trimmed to its cap, oldest first', async () => {
    const files = series('fresh', Array(12).fill(1), 60_000);
    const pi = await session('grace', (cwd) => placeInbox(cwd, files));
    await barrier.pass();
    expect(listInbox(pi.cwd)).toEqual(names(files));
    await pi.bye();
    await eventually(() => listInbox(pi.cwd).length === 10, { what: 'the ended workspace to be trimmed' });
    await barrier.pass();
    expect(listInbox(pi.cwd)).toEqual(names(files.slice(2)));
  });

  test('over the byte cap the oldest go first, and the newest eight always stay', async () => {
    // Older than the grace window, younger than the retention age: only the caps apply.
    const byBytes = series('bytes', [1000, 1000, ...Array(8).fill(10)], 2 * DAY_MS);
    const floor = series('floor', Array(10).fill(300), 2 * DAY_MS);
    const bytesSession = await session('cap-bytes', (cwd) => placeInbox(cwd, byBytes));
    const floorSession = await session('cap-floor', (cwd) => placeInbox(cwd, floor));
    await eventually(() => listInbox(bytesSession.cwd).length === 9 && listInbox(floorSession.cwd).length === 8, {
      what: 'both inboxes to be trimmed',
    });
    await barrier.pass();
    expect(listInbox(bytesSession.cwd)).toEqual(names(byBytes.slice(1))); // 1080 bytes: under the cap
    expect(listInbox(floorSession.cwd)).toEqual(names(floor.slice(2))); // 2400 bytes: over, but at the floor
  });

  test.skipIf(!POSIX)('links in an inbox are never followed or removed, and a linked .cosyncing is not swept at all', async () => {
    const outside = workspace('outside');
    writeAged(join(outside, 'precious.txt'), 8, 30 * DAY_MS);
    const linked = await session('linked-entries', (cwd) => {
      placeInbox(cwd, [{ name: 'aged.txt', bytes: 4, ageMs: 30 * DAY_MS }]);
      symlinkSync(join(outside, 'precious.txt'), join(inboxOf(cwd), 'link.txt'));
    });
    const elsewhere = workspace('elsewhere');
    placeInbox(elsewhere, [{ name: 'aged.txt', bytes: 4, ageMs: 30 * DAY_MS }]);
    const linkedMarker = await session('linked-marker', (cwd) => symlinkSync(join(elsewhere, '.cosyncing'), join(cwd, '.cosyncing')));
    await eventually(() => !existsSync(join(inboxOf(linked.cwd), 'aged.txt')), { what: 'the aged file beside the link' });
    await barrier.pass();
    expect(listInbox(linked.cwd)).toEqual(['link.txt']);
    expect(readFileSync(join(outside, 'precious.txt')).length).toBe(8);
    expect(listInbox(linkedMarker.cwd)).toEqual(['aged.txt']);
    expect(listInbox(elsewhere)).toEqual(['aged.txt']);
  });

  test('a live workspace without an inbox is never given one', async () => {
    const pi = await session('no-inbox');
    await barrier.pass();
    expect(existsSync(join(pi.cwd, '.cosyncing'))).toBe(false);
  });

  test('the broker remembers which inboxes to collect across a restart, and forgets deleted workspaces', async () => {
    const registry = join(broker.paths.cosyncingHome, 'uploads', 'inbox-roots.json');
    const remembered = live.find((pi) => pi.title === 'cap-bytes')!.cwd;
    const deleted = live.find((pi) => pi.title === 'cap-floor')!.cwd;
    const deletedRoot = realpathSync(deleted);
    expect(JSON.parse(readFileSync(registry, 'utf8')).roots).toContain(deletedRoot);
    await broker.restart();
    // No session is live after a restart: only the remembered list reaches this inbox.
    const pulse = join(remembered, 'late');
    writeAged(pulse, 1, 30 * DAY_MS);
    renameSync(pulse, join(inboxOf(remembered), 'late'));
    rmSync(deleted, { recursive: true, force: true });
    await eventually(() => !existsSync(join(inboxOf(remembered), 'late')), { what: 'the remembered inbox to be swept' });
    await eventually(() => !JSON.parse(readFileSync(registry, 'utf8')).roots.includes(deletedRoot), {
      what: 'the deleted workspace to leave the list',
    });
  });
});

describe('with small upload limits', () => {
  let broker: Broker;
  let phone: ProfiledClient;
  let pi: PiBridgeSession;

  beforeAll(async () => {
    broker = await startBroker({
      name: 'uploads-limits',
      token: true,
      env: {
        COSYNCING_UPLOAD_MAX_BYTES: '16',
        COSYNCING_UPLOAD_CHUNK_MAX_BYTES: '8',
        // Nothing is swept behind these tests' backs.
        COSYNCING_TEST_UPLOAD_SWEEP_MS: '600000',
      },
    });
    phone = new ProfiledClient(broker.client(), 'phone', 'phone-install-1');
    const cwd = join(broker.paths.home, 'limits');
    mkdirSync(cwd);
    pi = await PiBridgeSession.open(broker.client(), { cwd, title: 'limits' });
  });
  afterAll(() => broker?.stop());

  test('the file, each chunk and the advertised size are all bounded', async () => {
    const tooLarge = await phone.post(uploadsPath(pi), { name: 'big.bin', size: 32 });
    expect([tooLarge.status, tooLarge.body.code]).toEqual([413, 'UPLOAD_TOO_LARGE']);

    const open = await begin(phone, pi, 'open.bin');
    const fat = await patch(phone, pi, open, 0, Buffer.alloc(9));
    expect([fat.status, fat.body.code]).toEqual([413, 'UPLOAD_TOO_LARGE']);
    expect((await phone.get(`${uploadsPath(pi)}/${open}`)).body.offset).toBe(0);
    expect((await patch(phone, pi, open, 0, Buffer.alloc(8))).status).toBe(200);
    expect((await patch(phone, pi, open, 8, Buffer.alloc(8))).status).toBe(200);
    const over = await patch(phone, pi, open, 16, Buffer.alloc(1));
    expect([over.status, over.body.code]).toEqual([413, 'UPLOAD_TOO_LARGE']);

    const sized = await begin(phone, pi, 'sized.bin', 4);
    const past = await patch(phone, pi, sized, 0, Buffer.alloc(5));
    expect([past.status, past.body.code]).toEqual([409, 'UPLOAD_SIZE_MISMATCH']);
  });

  test('one app installation may hold sixteen unfinished uploads per session', async () => {
    const tablet = new ProfiledClient(broker.client(), 'tablet', 'tablet-install-1');
    for (let index = 0; index < 16; index += 1) await begin(tablet, pi, `held-${index}.txt`, 1);
    const seventeenth = await tablet.post(uploadsPath(pi), { name: 'one-more.txt', size: 1 });
    expect([seventeenth.status, seventeenth.body.code]).toEqual([429, 'UPLOAD_CAPACITY']);
    const laptop = new ProfiledClient(broker.client(), 'laptop', 'laptop-install-1');
    await begin(laptop, pi, 'someone-else.txt', 1);
  });

  test('an upload past its lifetime is refused and its bytes are removed', async () => {
    const uploadId = await begin(phone, pi, 'late.bin', 4);
    expect((await patch(phone, pi, uploadId, 0, Buffer.from('ab'))).status).toBe(200);
    expireStagingRecord(broker, uploadId);
    const late = await patch(phone, pi, uploadId, 2, Buffer.from('cd'));
    expect([late.status, late.body.code]).toEqual([410, 'UPLOAD_EXPIRED']);
    expect((await phone.get(`${uploadsPath(pi)}/${uploadId}`)).status).toBe(404);
    expect(filesBelow(join(broker.paths.cosyncingHome, 'uploads')).filter((path) => path.includes(uploadId))).toEqual([]);
  });

  test('a staged reference past its lifetime is refused at send time and its file is removed', async () => {
    const staged = await stage(phone, pi, 'expired.txt', Buffer.from('expired'));
    expect(listInbox(pi.cwd)).toContain('expired.txt');
    expireStagingRecord(broker, staged.uploadId);
    const stream = await phone.attach('pi', pi.id, { mode: 'resume' });
    await stream.waitForKind('history');
    const reply = await stream.sendAndAwait({ kind: 'prompt', text: 'too late', files: [{ stagedRef: staged.stagedRef }] });
    expect([reply.kind, reply.code]).toEqual(['nack', 'STAGED_ATTACHMENT_EXPIRED']);
    expect(listInbox(pi.cwd)).not.toContain('expired.txt');
    expect((await stream.sendAndAwait({ kind: 'prompt', text: 'sentinel' })).kind).toBe('ack');
    expect(await promptsThrough(pi, 'sentinel')).toEqual(['sentinel']);
    stream.close();
  });
});

describe('with inbox collection turned off', () => {
  let broker: Broker;
  let pi: PiBridgeSession;

  beforeAll(async () => {
    broker = await startBroker({
      name: 'uploads-no-retention',
      token: true,
      env: {
        COSYNCING_INBOX_RETENTION_MS: '0',
        COSYNCING_UPLOAD_TTL_MS: '1',
        COSYNCING_TEST_UPLOAD_SWEEP_MS: '100',
      },
    });
    const cwd = join(broker.paths.home, 'kept');
    mkdirSync(cwd);
    placeInbox(cwd, [{ name: 'aged.txt', bytes: 4, ageMs: 30 * DAY_MS }]);
    pi = await PiBridgeSession.open(broker.client(), { cwd, title: 'kept' });
  });
  afterAll(() => broker?.stop());

  test('expired uploads are still swept, but delivered files are left alone', async () => {
    await new StagingSweepBarrier(broker, broker.client(), pi).pass();
    expect(listInbox(pi.cwd)).toEqual(['aged.txt']);
  });
});

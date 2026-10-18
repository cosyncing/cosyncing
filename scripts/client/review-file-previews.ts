#!/usr/bin/env bun
/** Optional headed-browser review. Run from the project root with xvfb-run. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startBroker } from '../../e2e/harness/broker.ts';
import { PiBridgeSession } from '../../e2e/harness/fakes/pi-bridge-driver.ts';
import { waitForFlutter } from '../../e2e/harness/browser.ts';
import { writeMediaFixtures } from '../../e2e/harness/media-fixtures.ts';
import { eventually } from '../../e2e/harness/wait.ts';

const out = resolve(process.env.FILE_REVIEW_OUT ?? 'output/review/file-previews/headed-review');
const scope = Bun.argv.includes('--phone-video') ? 'phone-video' : Bun.argv.includes('--phone') ? 'phone' : Bun.argv.includes('--remaining-desktop') ? 'remaining-desktop' : 'all';
mkdirSync(out, { recursive: true });
const claims = [
  'headed Chromium boots candidate', 'session navigation loads no media',
  'desktop image render and zoom/fit', 'desktop PDF two pages light/dark',
  'video no autoplay/play/pause/seek/mute', 'video close removes element and revokes URL',
  'delivered image opens', 'hidden session releases media',
  'phone image light/dark and fit', 'phone PDF two pages light/dark',
  'phone video controls', 'closed previews revoke access',
  'phone notification offer stays clear of playback controls',
].map(name => ({ name, status: 'pending', evidence: '' }));
const report = { browser: 'headed /usr/bin/google-chrome under Xvfb', startedAt: new Date().toISOString(),
  claims, screenshots: [] as string[], errors: [] as string[], nativePhoneHandoff: 'not tested by browser' };
const sanitize = (value: unknown) => String(value).replace(/\/api\/media-previews\/[A-Za-z0-9_-]+/g, '/api/media-previews/[REDACTED]').replace(/([?&](?:token|sig|credential|ticket)=)[^&\s]+/gi, '$1[REDACTED]');
const save = () => writeFileSync(join(out, scope === 'all' ? 'claims.json' : `claims-${scope}.json`), JSON.stringify(report, null, 2));
save(); // Claim matrix exists before any browser interaction.
let current = '';
async function claim(name: string, work: () => Promise<void>) {
  current = name;
  await work();
  Object.assign(claims.find(row => row.name === name)!, { status: 'pass', evidence: 'Observed through real built Flutter UI and browser media/network state' });
  save();
}
const broker = await startBroker({ name: 'headed-file-review', env: {
  COSYNCING_WEB_DIR: resolve('apps/client/build/web'), COSYNCING_FS_REMOTE_ENABLED: '1',
} });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: false,
  args: ['--disable-gpu', '--disable-features=Vulkan,VizDisplayCompositor'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce' });
const page = await context.newPage();
page.setDefaultTimeout(15_000);
const urls: string[] = [];
const released: string[] = [];
page.on('request', request => {
  if (request.url().includes('/api/media-preview')) urls.push(request.url());
  if (request.method() === 'DELETE' && request.url().includes('/api/media-previews/')) released.push(request.url());
});
page.on('pageerror', error => { report.errors.push(sanitize(error.message)); save(); });
async function screenshot(name: string) {
  await page.screenshot({ path: join(out, `${name}.png`), timeout: 8000 });
  report.screenshots.push(`${name}.png`); save();
}
async function view(name: string) {
  await page.getByRole('button', { name: 'Views and display options', exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
async function preview(name: string) {
  const index = ['clip.webm', 'document.pdf', 'picture.png', 'report.txt'].indexOf(name);
  await page.getByRole('button', { name: 'Preview file', exact: true }).nth(index).click();
}
async function close() {
  const before = released.length;
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.waitForFunction(() => !document.querySelector('video'));
  await eventually(() => released.length > before, { what: 'preview close revocation request' });
  await eventually(async () => (await fetch(released.at(-1)!)).status === 403, { what: 'closed preview URL denied' });
}
async function image(name: string) {
  await page.getByRole('img', { name: 'picture.png', exact: true }).waitFor();
  const image = page.getByRole('img', { name: 'picture.png', exact: true });
  const box = await image.boundingBox();
  if (!box || box.width < 1 || box.height < 1) throw new Error('Image has no visible area');
  await screenshot(`${name}-before-zoom`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await screenshot(`${name}-zoom`);
  await page.getByRole('button', { name: 'Fit to view', exact: true }).click();
  await screenshot(`${name}-fit`);
}
async function pdf(name: string) {
  await page.getByRole('group', { name: /Page 1 of 2$/ }).waitFor();
  await screenshot(`${name}-light-page1`);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await page.getByRole('group', { name: /Page 2 of 2$/ }).waitFor();
  await screenshot(`${name}-dark-page2`);
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await page.getByRole('group', { name: /Page 1 of 2$/ }).waitFor();
}
async function video(name: string) {
  await page.getByRole('button', { name: 'Play', exact: true }).waitFor();
  if (!await page.locator('video').evaluate((node: HTMLVideoElement) => node.paused)) throw new Error('Video autoplayed');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.currentTime > 0 && !v.paused; });
  await page.getByRole('button', { name: /^Pause(?: Pause)?$/ }).click();
  await page.waitForFunction(() => document.querySelector('video')?.paused === true);
  await page.getByRole('button', { name: /^Mute(?: Mute)?$/ }).click();
  await page.waitForFunction(() => { const v = document.querySelector('video'); return v && (v.muted || v.volume === 0); });
  await page.getByRole('button', { name: /^Unmute(?: Unmute)?$/ }).click();
  await page.waitForFunction(() => { const v = document.querySelector('video'); return v && !v.muted && v.volume === 1; });
  // Flutter's video progress bar paints in canvas and has no slider semantics.
  const mute = await page.getByRole('button', { name: /^Mute(?: Mute)?$/ }).boundingBox();
  const play = await page.getByRole('button', { name: 'Play', exact: true }).boundingBox();
  if (!mute || !play) throw new Error('Video control geometry unavailable');
  await page.mouse.click((play.x + play.width + mute.x) / 2, mute.y + mute.height / 2);
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 10);
  await screenshot(name);
}
try {
  const cwd = join(broker.paths.root, 'workspace'); mkdirSync(cwd); writeMediaFixtures(cwd);
  const grid = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 800;
    const ctx = canvas.getContext('2d')!;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 12; x++) {
      ctx.fillStyle = (x + y) % 2 ? '#e3edf8' : '#fafcff'; ctx.fillRect(x * 100, y * 100, 100, 100);
      ctx.strokeStyle = '#456'; ctx.strokeRect(x * 100, y * 100, 100, 100);
      ctx.fillStyle = '#123'; ctx.font = '20px sans-serif'; ctx.fillText(`${x},${y}`, x * 100 + 12, y * 100 + 35);
    }
    ctx.fillStyle = '#b21'; ctx.font = 'bold 36px sans-serif'; ctx.fillText('IMAGE ZOOM REVIEW', 360, 400);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  writeFileSync(join(cwd, 'picture.png'), Buffer.from(grid, 'base64'));
  writeFileSync(join(cwd, 'report.txt'), 'Headed review report\n');
  await page.goto(`${broker.url}/cosy/#/sessions`, { waitUntil: 'domcontentloaded' });
  await waitForFlutter(page);
  await page.getByRole('button', { name: 'Refresh', exact: true }).waitFor();
  const drivers: PiBridgeSession[] = [];
  for (const title of ['Media review owner', 'Media review peer']) {
    const sessionFile = join(broker.paths.root, `${title}.jsonl`);
    writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: title, cwd })}\n`);
    drivers.push(await PiBridgeSession.open(broker.client(), { cwd, title, sessionFile,
      hello: { history: [{ t: 'user', key: title, text: `${title} transcript ready` }] } }));
  }
  const project = page.getByRole('button', { name: 'workspace', exact: true }); await project.waitFor();
  if (await project.getAttribute('aria-expanded') !== 'true') await project.click();
  await claim('headed Chromium boots candidate', async () => {
    await page.getByRole('button', { name: 'Media review owner', exact: false }).first().click();
    await page.getByText('Media review owner transcript ready', { exact: true }).first().waitFor();
    await screenshot('desktop-session');
  });
  await claim('session navigation loads no media', async () => {
    await page.getByRole('button', { name: 'Media review peer', exact: false }).first().click();
    await page.getByText('Media review peer transcript ready', { exact: true }).first().waitFor();
    await page.locator('[role="group"][aria-label="Media review owner"]').first().click();
    await view('Files'); await page.getByRole('button', { name: 'Preview file', exact: true }).nth(3).waitFor();
    if (urls.length) throw new Error('Navigation/listing loaded media');
    await screenshot('desktop-files');
  });
  if (scope === 'all') {
  await claim('desktop image render and zoom/fit', async () => { await preview('picture.png'); await image('desktop-image'); });
  await close();
  }
  if (scope !== 'phone' && scope !== 'phone-video') {
  await claim('desktop PDF two pages light/dark', async () => { await preview('document.pdf'); await pdf('desktop-pdf'); });
  await close();
  await claim('video no autoplay/play/pause/seek/mute', async () => { await preview('clip.webm'); await video('desktop-video'); });
  await claim('video close removes element and revokes URL', close);
  await drivers[0]!.sendFile(join(cwd, 'picture.png'));
  await claim('delivered image opens', async () => {
    await view('Chat');
    await page.getByRole('group', { name: /^picture\.png\s+Sent to you\b/ }).first().getByRole('button', { name: 'Open file', exact: true }).click();
    await page.getByRole('img', { name: 'picture.png', exact: true }).waitFor(); await screenshot('desktop-delivered-image');
  });
  await claim('hidden session releases media', async () => {
    const before = released.length;
    await page.locator('[role="group"][aria-label="Media review peer"]').first().click();
    await page.getByText('Media review peer transcript ready', { exact: true }).first().waitFor();
    await eventually(() => released.length > before, { what: 'hidden preview revocation request' });
    await eventually(async () => (await fetch(released.at(-1)!)).status === 403, { what: 'hidden preview URL denied' });
    await page.locator('[role="group"][aria-label="Media review owner"]').first().click();
    await page.getByRole('img', { name: 'picture.png', exact: true }).waitFor();
  });
  await close();
  }
  if (scope !== 'remaining-desktop') {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'light' });
  if (scope !== 'phone-video') {
  await claim('phone image light/dark and fit', async () => {
    await view('Files'); await preview('picture.png'); await image('phone-image-light');
    await page.emulateMedia({ colorScheme: 'dark' }); await screenshot('phone-image-dark');
  });
  await close(); await page.emulateMedia({ colorScheme: 'light' });
  await claim('phone PDF two pages light/dark', async () => { await preview('document.pdf'); await pdf('phone-pdf'); });
  await close();
  }
  if (scope === 'phone-video') await view('Files');
  await page.emulateMedia({ colorScheme: 'dark' });
  await claim('phone video controls', async () => { await preview('clip.webm'); await video('phone-video'); });
  await claim('phone notification offer stays clear of playback controls', async () => {
    const dismiss = page.getByRole('button', { name: 'Not now', exact: true });
    const muteBox = await page.getByRole('button', { name: /^Mute(?: Mute)?$/ }).boundingBox();
    const dismissBox = await dismiss.boundingBox();
    if (!muteBox || !dismissBox || muteBox.y + muteBox.height > dismissBox.y) {
      throw new Error('Notification offer overlaps video controls');
    }
    await screenshot('phone-onboarding-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await screenshot('phone-onboarding-light');
    await dismiss.click();
    await dismiss.waitFor({ state: 'detached' });
    await screenshot('phone-onboarding-dismissed');
  });
  await claim('closed previews revoke access', close);
  }
} catch (error) {
  Object.assign(claims.find(row => row.name === current) ?? claims[0]!, { status: 'fail', evidence: sanitize(error) });
  report.errors.push(sanitize(error));
  await screenshot('failure').catch(() => undefined);
  writeFileSync(join(out, 'failure-semantics.txt'), sanitize(await page.locator('body').ariaSnapshot().catch(() => 'unavailable')));
  process.exitCode = 1;
} finally {
  for (const row of claims) if (row.status === 'pending') { row.status = 'blocked'; row.evidence = scope === 'all' ? 'Prior review step failed' : 'Outside this focused review pass'; }
  save();
  await context.close(); await browser.close(); await broker.stop();
  console.log(JSON.stringify({ out, claims: claims.map(({ name, status }) => ({ name, status })), errors: report.errors }));
}

/**
 * Signing in to a token-protected broker from the built web client.
 *
 * The user opens a session link, is asked for the Server token, saves it, and
 * the session opens. What the browser puts on the wire is part of the feature:
 * the long-lived token travels only in a request header to mint a short-lived
 * WebSocket ticket, and the session socket carries that ticket alone.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, Request } from 'playwright-core';
import { type Broker, eventually } from '../harness/index.ts';
import { fillFlutterTextField, launchBrowser, newScenarioContext, waitForFlutter } from '../harness/browser.ts';
import { startWebBroker } from '../harness/web-scenario.ts';
import { SecureWebRoute } from '../harness/fakes/web-proxy.ts';

describe('web sign-in with the Server token', () => {
  let broker: Broker;
  let browser: Browser;
  let sessionId: string;
  beforeAll(async () => {
    broker = await startWebBroker({ name: 'web-login', token: true });
    browser = await launchBrowser();
    const hello = await broker.client().post('/pi/bridge/hello', {
      sessionFile: `${broker.paths.root}/login.jsonl`,
      cwd: broker.paths.home,
      title: 'Login session',
      history: [{ t: 'user', key: 'login-row', text: 'hello after sign in' }],
    });
    expect(hello.status).toBe(200);
    sessionId = String(hello.body.id);
  });
  afterAll(async () => {
    await browser?.close();
    await broker?.stop();
  });

  test('the token gate opens the session; the token never appears in a URL and the socket carries only a ticket', async () => {
    const context = await newScenarioContext(browser, { viewport: { width: 1440, height: 1000 } });
    try {
      const page = await context.newPage();
      const requests: Request[] = [];
      const sockets: string[] = [];
      page.on('request', (request) => requests.push(request));
      page.on('websocket', (socket) => sockets.push(socket.url()));

      await page.goto(`${broker.url}/cosy/#/sessions/pi/${encodeURIComponent(sessionId)}`);
      await waitForFlutter(page);
      const field = page.getByRole('textbox', { name: 'Server token' });
      await field.waitFor();
      // Flutter attaches its input handler a moment after the field exists, so an
      // early entry can be dropped ("Enter a server token first."). A user types
      // again; so does the test, until the session's transcript is on screen.
      const link = `${broker.url}/cosy/#/sessions/pi/${encodeURIComponent(sessionId)}`;
      await eventually(async () => {
        if (await page.getByText('hello after sign in').count() > 0) return true;
        const save = page.getByRole('button', { name: 'Save token' });
        if (await save.count() > 0) {
          try {
            await field.click({ timeout: 5_000 });
            await page.keyboard.press('Control+A');
            await page.keyboard.insertText(broker.token!);
            await save.click({ timeout: 5_000 });
          } catch {
            // The gate repainted under us; look again.
          }
        } else if (!page.url().includes('/sessions/pi/')) {
          // The route guard settled on the roster after the gate closed.
          await page.goto(link);
        }
        return false;
      }, { timeoutMs: 90_000, intervalMs: 250, what: 'the session transcript after sign in' }).catch(async (error) => {
        throw new Error(`${error}\nURL ${page.url()}\nSOCKETS ${JSON.stringify(sockets)}\nTEXT ${(await page.locator('body').innerText()).slice(0, 1500)}`);
      });

      const stream = encodeURIComponent(sessionId);
      const ticketed = sockets.filter((url) => new URL(url).pathname === `/api/sessions/pi/${stream}/stream`);
      expect(ticketed.length).toBeGreaterThan(0);
      for (const url of sockets) {
        const keys = [...new URL(url).searchParams.keys()];
        expect(keys.every((key) => key === 'wsAuthTicket')).toBe(true);
      }
      const ticketRequests = requests.filter((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/ws-auth-tickets');
      expect(ticketRequests.length).toBeGreaterThan(0);
      for (const request of ticketRequests) {
        expect((await request.allHeaders())['x-cosyncing-token']).toBe(broker.token!);
      }
      for (const url of [...requests.map((request) => request.url()), ...sockets]) {
        expect(url).not.toContain(broker.token!);
      }
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  test('an HTTPS app verifies an alternate route and preserves its origin while browser restrictions remain enforced', async () => {
    const app = new SecureWebRoute(broker.url);
    const alternate = new SecureWebRoute(broker.url);
    const blocked = new SecureWebRoute(broker.url);
    blocked.blockedWebSockets = true;
    const deniedBroker = await startWebBroker({ name: 'web-route-denied', token: true });
    const denied = new SecureWebRoute(deniedBroker.url);
    // Trust only this fixture's ephemeral certificates. Native TLS rejection is
    // exercised by the real transport journey; browser origin policy stays on.
    const context = await browser.newContext({
      ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 },
      reducedMotion: 'reduce',
    });
    try {
      const configuration = await broker.client().get('/api/connection/configuration');
      expect((await broker.client().post('/api/connection/configuration', {
        ...configuration.body,
        advertisedOrigins: [broker.url, app.origin, alternate.origin, blocked.origin],
        trustedClientOrigins: [app.origin],
      })).status).toBe(200);
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      const drafts = new Set<string>();
      page.on('websocket', (socket) => socket.on('framesent', ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (frame.kind === 'draft' && typeof frame.text === 'string') drafts.add(frame.text);
      }));
      const documents: string[] = [];
      const requests: Request[] = [];
      page.on('request', (request) => {
        requests.push(request);
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents.push(request.url());
      });
      await page.goto(`${app.origin}/cosy/#/sessions/pi/${encodeURIComponent(sessionId)}`);
      await waitForFlutter(page);
      const token = page.getByRole('textbox', { name: 'Server token' });
      await fillFlutterTextField(page, 'Server token', broker.token!);
      await page.getByRole('button', { name: 'Save token', exact: true }).click();
      await token.waitFor({ state: 'detached' });
      await page.evaluate((id) => { location.hash = `#/sessions/pi/${encodeURIComponent(id)}`; }, sessionId);
      await page.getByText('hello after sign in', { exact: true }).waitFor();
      const editor = page.locator('textarea[data-semantics-role="text-field"]:not([disabled])');
      await page.getByRole('button', { name: /^Session status: Synced/ }).waitFor();
      await fillFlutterTextField(page, 'Send a prompt', 'Keep this draft across HTTPS routes');
      await eventually(() => drafts.has('Keep this draft across HTTPS routes'), { what: 'the original draft publication' });
      await page.evaluate(() => { location.hash = '#/settings/broker-profiles'; });
      await page.getByRole('button', { name: /^This server Owner access/ }).click();
      await page.getByRole('button', { name: 'Test all', exact: true }).click();
      await page.getByRole('button', { name: 'Approve destination', exact: true }).click();
      await page.getByRole('group', { name: / In use / }).waitFor();

      const propose = async (label: string, origin: string) => {
        await broker.client().post('/pi/bridge/events', { id: sessionId, events: [{ t: 'status', running: false }] });
        await page.getByRole('button', { name: 'Add address', exact: true }).click();
        for (const [name, value] of [['Address label', label], ['Server address', origin]]) {
          await fillFlutterTextField(page, name!, value!);
        }
        await page.getByRole('button', { name: 'Test connection', exact: true }).click();
      };
      await propose('HTTPS alternate', alternate.origin);
      await page.getByText('Available', { exact: true }).last().waitFor();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      // Each row has one accessible menu; insertion order makes the alternate
      // the second row. Choosing Fixed commits this explicitly approved path.
      await page.getByRole('button', { name: 'Manage addresses', exact: true }).nth(1).click();
      await page.getByRole('menuitem', { name: 'Fixed address', exact: true }).click();
      await eventually(() => alternate.requests.some((r) => r.path === '/api/connection/check/ws'), {
        what: 'alternate WebSocket readiness',
      });

      await propose('WS blocked', blocked.origin);
      await page.getByText('WebSocket unavailable', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await propose('Denied origin', denied.origin);
      await page.getByText('The browser could not connect. Check origin permissions, TLS, and network access.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(denied.requests.some((r) => r.authenticated)).toBe(false);
      await propose('HTTP LAN', 'http://lan.invalid:7734');
      await page.getByText('This HTTPS app cannot use an HTTP address. Use an HTTPS route.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(requests.some((r) => new URL(r.url()).hostname === 'lan.invalid')).toBe(false);

      await page.evaluate((id) => { location.hash = `#/sessions/pi/${encodeURIComponent(id)}`; }, sessionId);
      await page.getByText('hello after sign in', { exact: true }).waitFor();
      await editor.click();
      await page.waitForFunction(() =>
        (document.querySelector('textarea[data-semantics-role="text-field"]:not([disabled])') as HTMLTextAreaElement | null)?.value === 'Keep this draft across HTTPS routes');
      expect(await editor.inputValue()).toBe('Keep this draft across HTTPS routes');
      expect(new URL(page.url()).origin).toBe(app.origin);
      expect(documents).toHaveLength(1);
      // Restoring the retained draft precedes the new live socket. Wait for
      // actual reattachment rather than treating the cached transcript as it.
      await eventually(() => alternate.requests.some((r) => /\/api\/sessions\/.+\/stream/.test(r.path)), {
        what: 'session reattachment through the approved alternate',
      });
      await page.getByRole('button', { name: /^Session status: Synced/ }).waitFor();
      expect(alternate.requests.some((r) => /\/api\/sessions\/.+\/stream/.test(r.path))).toBe(true);
      for (const route of [app, alternate, blocked]) {
        expect(route.requests.filter((r) => r.path === '/api/connection/identity-proof').every((r) => !r.authenticated)).toBe(true);
      }
    } catch (error) {
      for (const page of context.pages()) {
        const state = await page.locator('body').ariaSnapshot().catch(() => 'No page semantics');
        console.error(`[HTTPS route review] ${page.url()}\n${state.replaceAll(broker.token!, '[redacted]')}`);
      }
      throw error;
    } finally {
      await context.close();
      for (const route of [app, alternate, blocked, denied]) route.stop();
      await deniedBroker.stop();
    }
  });
});

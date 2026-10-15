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
import { launchBrowser, newScenarioContext, waitForFlutter } from '../harness/browser.ts';
import { startWebBroker } from '../harness/web-scenario.ts';

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
});

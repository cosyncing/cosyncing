/**
 * cosyncing — OpenCode custom tool: `send_file`.
 *
 * Lets the coding agent deliver a file from its workspace to the user's cosyncing app
 * (phone/web). The agent just writes the file normally, then calls `send_file("report.html")`.
 *
 * This runs inside OpenCode's runtime (Bun), NOT inside our broker — it is an INSTALL ASSET.
 * OpenCode 1.16.2 auto-discovers tool files from:
 *   - global:  ~/.config/opencode/tools/send_file.ts
 *   - project: <cwd>/.opencode/tools/send_file.ts
 * The installer copies this file to the global location. The filename = the tool name.
 *
 * Its execute() POSTs to the broker, which reads the file from the session's cwd and surfaces it
 * as a file-artifact to that session's clients. We send a `fetch` to plain HTTP (no MCP layer) —
 * see docs research: a tool file is the lightest way to let an external process handle a tool call.
 *
 * (Auto-surface of deliverable-type writes also exists in the broker, so this tool is the explicit,
 *  any-type complement: "send me this exact file" — including types outside the deliverable set.)
 */
import { tool } from '@opencode-ai/plugin';
import { isAbsolute, resolve } from 'node:path';

const BROKER_URL = process.env.COSYNCING_BROKER_URL ?? 'http://127.0.0.1:7734';
// Carry the broker shared secret when one is configured (required for any non-loopback bind): the broker
// default-denies mutating routes like /api/tool/send_file unless the token is present. Loopback/no-token
// deployments leave this empty → no header, behavior unchanged.
const TOKEN = (process.env.COSYNCING_TOKEN ?? '').trim();

export default tool({
  description:
    "Send a file from the current working directory to the user's cosyncing app so they can " +
    'view or download it (image, PDF, HTML report, spreadsheet, doc, archive, etc.). Call this ' +
    "whenever the user asks you to 'send', 'share', or 'give me' a file. For an HTML report, prefer " +
    'embedding images as base64 so it is self-contained (local file references are also inlined ' +
    'automatically). Give the path to the file you want to send.',
  args: {
    path: tool.schema
      .string()
      .describe('Path to the file to send (relative to the project root, or absolute).'),
  },
  async execute(args, context) {
    const abs = isAbsolute(args.path) ? args.path : resolve(context.directory, args.path);
    try {
      const res = await fetch(`${BROKER_URL}/api/tool/send_file`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(TOKEN ? { 'x-cosyncing-token': TOKEN } : {}) },
        body: JSON.stringify({
          path: abs,
          rawPath: args.path,
          directory: context.directory,
          sessionID: context.sessionID,
          tool: 'opencode',
        }),
        signal: context.abort,
      });
      const text = await res.text();
      return res.ok ? text : `Could not send the file: ${text}`;
    } catch (e) {
      return `Could not reach the cosyncing app to send the file (${String(e)}). Is it running?`;
    }
  },
});

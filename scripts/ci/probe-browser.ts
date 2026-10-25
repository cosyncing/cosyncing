#!/usr/bin/env bun
import { chromium } from 'playwright-core';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const output = process.env.BROWSER_PROBE_OUTPUT?.trim();
const directory = output ? resolve(ROOT, output) : undefined;
const diagnostics: Record<string, unknown> = {startedAt: new Date().toISOString()};
if (directory) {
  const child = relative(join(ROOT, 'output'), directory);
  if (!child || isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) {
    throw new Error('browser probe output must be below this checkout\'s output/');
  }
  mkdirSync(directory, {recursive: true});
}

try {
  const fontTool = Bun.which('fc-list');
  const fonts: Record<string, {toolAvailable: boolean; available: boolean; families: string[]}> = {};
  for (const [language, codepoint] of Object.entries({Latin: '0041', Chinese: '4e2d', Japanese: '3042', Korean: 'ac00', Arabic: '0627', Emoji: '1f680'})) {
    const result = fontTool ? Bun.spawnSync([fontTool, '--format=%{family}\n', `:charset=${codepoint}`],
      {stdout: 'pipe', stderr: 'pipe', timeout: 5_000, maxBuffer: 1 << 20}) : undefined;
    const families = result?.success ? [...new Set(result.stdout.toString().trim().split('\n').filter(Boolean))].sort() : [];
    fonts[language] = {toolAvailable: Boolean(result?.success), available: families.length > 0, families};
  }
  diagnostics.systemFonts = fonts;
  const browser = await chromium.launch({headless: true, timeout: 30_000,
    args: ['--disable-gpu', '--disable-features=Vulkan,VizDisplayCompositor']});
  try {
    diagnostics.browserVersion = browser.version();
    const page = await browser.newPage({viewport: {width: 1000, height: 400}});
    await page.setContent('<h1>Browser rendering check</h1><p style="font:28px system-ui">Hello · 中文 · 日本語 · 한국어 · العربية · 🚀</p>', {timeout: 8_000});
    await page.screenshot({timeout: 8_000, ...(directory ? {path: join(directory, 'rendering.png')} : {})});
  } finally {
    await browser.close();
  }
  // Linux dependency setup must preserve the font coverage --with-deps supplied.
  // Launch first so hosts missing both libraries and fonts diagnose libraries first.
  const missingFonts = Object.entries(fonts).filter(([, coverage]) => !coverage.available).map(([language]) => language);
  if (process.platform === 'linux' && missingFonts.length > 0) {
    const reason = `Missing browser fonts: ${missingFonts.join(', ')}`;
    console.error(reason);
    diagnostics.status = 'fail';diagnostics.error = reason;diagnostics.missingFonts = missingFonts;
    process.exitCode = 79;
  } else {
    console.log('PASS pinned browser launch, rendering and font coverage');
    diagnostics.status = 'pass';
  }
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(reason);
  diagnostics.status = 'fail';diagnostics.error = reason;
  // Only dependency diagnostics trigger installation; unrelated browser defects
  // must not become a retry hidden behind another apt invocation.
  process.exitCode = /Host system is missing dependencies|error while loading shared libraries|cannot open shared object file/.test(reason) ? 78 : 1;
} finally {
  if (directory) {
    writeFileSync(join(directory, 'report.json'), JSON.stringify(diagnostics, null, 2) + '\n');
    appendFileSync(join(directory, 'attempts.jsonl'), JSON.stringify(diagnostics) + '\n');
  }
}

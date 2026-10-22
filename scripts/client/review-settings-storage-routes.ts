#!/usr/bin/env bun
/** Reproducible product screenshots against an isolated fixture broker. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startBroker } from "../../e2e/harness/broker.ts";
import {
  launchBrowser,
  SHELL_GONE,
  waitForFlutter,
  waitUntil,
} from "../../e2e/harness/browser.ts";
const option = (key: string, fallback: string) => {
  const index = Bun.argv.indexOf(key);
  return index < 0 ? fallback : (Bun.argv[index + 1] ?? fallback);
};
const out = resolve(
  option("--out", "output/review/settings-storage-routes/screenshots"),
);
const web = resolve(option("--web", "apps/client/build/web"));
const full = Bun.argv.includes("--full");
const locales = option('--locales', full ? 'en,zh,ja,ko,es' : 'en').split(',');
const sizes = option('--text-sizes', full ? 'normal,large' : 'normal').split(',');
const widths = option('--widths', '360,420,1440').split(',').map(Number);
const schemes = option('--schemes', 'light,dark').split(',') as ('light' | 'dark')[];
if (locales.some((locale) => !['en', 'zh', 'ja', 'ko', 'es'].includes(locale))
  || sizes.some((size) => !['normal', 'large'].includes(size))
  || schemes.some((scheme) => !['light', 'dark'].includes(scheme))
  || widths.some((width) => !Number.isInteger(width) || width < 320 || width > 2000))
  throw new Error('Invalid locale, text size, or viewport width');
mkdirSync(out, { recursive: true });
const broker = await startBroker({
  name: "settings-review",
  env: { COSYNCING_WEB_DIR: web },
});
const browser = await launchBrowser();
try {
  for (const locale of locales) {
    const copy = JSON.parse(
      readFileSync(`apps/client/lib/l10n/app_${locale}.arb`, "utf8"),
    );
    for (const size of sizes) {
      const enlarged = size === 'large';
      for (const width of widths) {
        for (const colorScheme of schemes) {
          const context = await browser.newContext({
            acceptDownloads: true,
            reducedMotion: 'reduce',
            viewport: { width, height: 1000 },
            colorScheme,
            locale,
          });
          try {
            const page = await context.newPage();
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(String(error)));
            await page.goto(`${broker.url}/cosy/#/sessions`, {
              waitUntil: "domcontentloaded",
            });
            await waitForFlutter(page);
            await page.getByRole("button", { name: copy.refresh, exact: true })
              .or(page.getByRole("button", { name: copy.workspaceShowSessionsTooltip, exact: true }))
              .first().waitFor();
            await waitUntil(page, SHELL_GONE, { what: 'the completed startup shell' });
            await page.evaluate(() => {
              location.hash = '#/settings/appearance';
            });
            await page.getByRole("heading", { name: copy.appearanceTitle, exact: true }).waitFor();
            if (enlarged) {
              // Browser zoom chords belong to Chromium; choose the app's
              // saved text scale through its accessible picker instead.
              const compactPicker = page.getByRole("button", {
                  name: `${copy.textSizeLabel} ${copy.textSizeSystem}`,
                  exact: true,
                });
              if (await compactPicker.count()) {
                await compactPicker.click();
              } else {
                // Flutter merges the wide section's labels into one named
                // group. Its controls retain row order: mode, theme, size,
                // density, language. A value such as System is not unique.
                const label = copy.textSizeLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                await page.getByRole('group', { name: new RegExp(label) })
                  .getByRole('button').nth(2).click();
              }
              await page
                .getByText(copy.textSizeExtraLarge, { exact: true })
                .last()
                .click();
              await page
                .getByRole("button", {
                  name: `${copy.textSizeLabel} ${copy.textSizeExtraLarge}`,
                  exact: true,
                })
                .or(page.getByRole("button", {
                  name: copy.textSizeExtraLarge,
                  exact: true,
                }))
                .last()
                .waitFor();
            }
            for (const [name, route] of [
              ["general", "/settings/general"],
              ["storage", "/settings/general/storage"],
            ]) {
              await page.evaluate((target) => {
                location.hash = `#${target}`;
              }, route);
              await page
                .getByText(
                  name === "general"
                    ? copy.settingsCategoryGeneralTitle
                    : copy.storageTitle,
                  { exact: true },
                )
                .last()
                .waitFor();
              if (name === "storage")
                await page
                  .getByText(copy.storageLoading, { exact: true })
                  .waitFor({ state: "hidden" });
              const stem = join(
                out,
                `${name}-${width}-${colorScheme}-${locale}-${enlarged ? "large" : "normal"}`,
              );
              writeFileSync(
                `${stem}.txt`,
                await page.locator("body").ariaSnapshot(),
              );
              await page.screenshot({ path: `${stem}.png`, fullPage: false });
              if (errors.length) throw new Error(errors.join("\n"));
            }
          } catch (error) {
            for (const page of context.pages()) {
              writeFileSync(
                join(
                  out,
                  `failure-${width}-${colorScheme}-${locale}-${enlarged}.txt`,
                ),
                await page.locator("body").ariaSnapshot(),
              );
            }
            throw error;
          } finally {
            await context.close();
          }
        }
      }
    }
  }
  console.log(`Screenshots and accessibility snapshots: ${out}`);
} finally {
  await browser.close();
  await broker.stop();
}

#!/usr/bin/env bun
/**
 * Emit the usage-report DTO exactly as the broker builds it, as a committed cross-language fixture.
 *
 * The broker assembles this DTO in TypeScript and the Flutter client decodes it in Dart, and nothing
 * in either language references the other's field names. Renaming `totals.tokens` to `totals.total`
 * would leave both sides internally consistent, both suites green, and the client rendering zeros
 * for a year of usage.
 *
 * This file is the seam. The broker regenerates it from its own module and the Dart test decodes it
 * and asserts real values, so a rename on either side fails a suite instead of shipping.
 *
 *   bun run scripts/contracts/generate-usage-report-sample.ts            # write
 *   bun run scripts/contracts/generate-usage-report-sample.ts --check    # verify
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchTokdashReport } from '../../packages/typescript/broker/src/installation/tokdash-report.ts';
import {
  SAMPLE_WINDOW,
  stubTokdash,
} from '../../packages/typescript/broker/test/fixtures/tokdash-report-fixtures.ts';

const ROOT = resolve(import.meta.dir, '../..');
const SAMPLE = resolve(ROOT, 'contracts/generated/usage-report.sample.json');

/** The serialized DTO, byte-for-byte as the route's `data` field carries it. */
export async function renderUsageReportSample(): Promise<string> {
  const { fetch: upstream } = stubTokdash();
  const report = await fetchTokdashReport(undefined, SAMPLE_WINDOW, { fetch: upstream });
  return `${JSON.stringify(report, null, 2)}\n`;
}

const rendered = await renderUsageReportSample();

if (process.argv.includes('--check')) {
  let current: string;
  try {
    current = readFileSync(SAMPLE, 'utf8');
  } catch {
    console.error(`ERROR: ${SAMPLE} is missing.`);
    console.error('Run: bun run scripts/contracts/generate-usage-report-sample.ts');
    process.exit(1);
  }
  if (current !== rendered) {
    console.error('ERROR: contracts/generated/usage-report.sample.json is stale.');
    console.error('Run: bun run scripts/contracts/generate-usage-report-sample.ts');
    console.error('If a DTO field moved, the Dart decoder in');
    console.error('packages/dart/broker_contract/lib/src/models/usage_report_models.dart moves with it.');
    process.exit(1);
  }
  console.log('PASS: usage-report DTO sample is current.');
} else {
  writeFileSync(SAMPLE, rendered);
  console.log(SAMPLE);
}

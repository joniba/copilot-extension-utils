#!/usr/bin/env node
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

const [home] = process.argv.slice(2);
if (!home || !isAbsolute(home)) throw new TypeError('Provide an absolute fixture home.');
const runtime = join(home, 'extensions', 'sample-logging');
const utility = new URL('../', import.meta.resolve('copilot-extension-utils/diagnostics/trace'));
const sources = [
  ['entry.mjs', new URL('./entry.mjs', import.meta.url)],
  ...[
    'diagnostics/context-fields.mjs',
    'diagnostics/error-fields.mjs',
    'diagnostics/operation.mjs',
    'diagnostics/trace.mjs',
    'files/lock.mjs',
    'logging/delivery.mjs',
    'logging/rotating-file.mjs',
  ].map(path => [`lib/${path}`, new URL(path, utility)]),
];
for (const [path, source] of sources) {
  const target = join(runtime, path);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

#!/usr/bin/env node
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { applyManagedFiles, backupManagedFiles, planManagedFiles, verifyManagedFiles } from 'copilot-extension-utils/install/managed-files';
import { runInstallerCli } from 'copilot-extension-utils/install/npx';
import { createInstallProgress } from 'copilot-extension-utils/install/progress';
import { runInstallation } from 'copilot-extension-utils/install/run';
import { readTextFile } from 'copilot-extension-utils/files/atomic';

const name = 'extension-utils-starter';
const { version } = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));

async function makeChild(parent, name) {
  const path = join(parent, name);
  await mkdir(path).catch(error => { if (error.code !== 'EEXIST') throw error; });
  if (await realpath(path) !== path) throw new Error('Refusing a redirected sample directory.');
  return path;
}

async function manifest(root) {
  const files = [
    ['extension.mjs', new URL('./extension.mjs', import.meta.url)],
    ['command.mjs', new URL('./command.mjs', import.meta.url)],
    ['lib/commands/slash.mjs', new URL(import.meta.resolve('copilot-extension-utils/commands/slash'))],
    ['lib/diagnostics/operation.mjs', new URL(import.meta.resolve('copilot-extension-utils/diagnostics/operation'))],
  ];
  return Promise.all(files.map(async ([target, source]) => ({
    path: join(root, target), text: await readFile(source, 'utf8'),
  })));
}

async function install({ copilotHome, update }) {
  await mkdir(copilotHome, { recursive: true });
  const home = await realpath(copilotHome);
  const root = await makeChild(await makeChild(home, 'extensions'), name);
  const lib = await makeChild(root, 'lib');
  await makeChild(lib, 'commands');
  await makeChild(lib, 'diagnostics');
  const backups = await makeChild(home, 'installation-backups');
  let backupDirectory;
  let changed;
  let attemptedPath;
  try {
    await runInstallation({
      receiptPath: join(root, 'installed.json'), version, progress: createInstallProgress(),
      preflight: async () => planManagedFiles({ root, files: await manifest(root), update }),
      async prepare(plan) {
        try {
          ({ directory: backupDirectory } = await backupManagedFiles(plan, backups));
        } catch (error) {
          backupDirectory = error?.backupDirectory;
          throw error;
        }
        return plan;
      },
      async activate(plan) {
        try {
          const result = await applyManagedFiles(plan);
          changed = result.changed;
          return result;
        } catch (error) {
          ({ changed, attemptedPath } = error ?? {});
          throw error;
        }
      },
      verify: plan => verifyManagedFiles(plan),
    });
  } catch (error) {
    if (error.stage) console.error(`Activation: ${error.activation}; version receipt: ${error.receipt}.`);
    if (backupDirectory) console.error(`Backup directory retained: ${JSON.stringify(backupDirectory)}`);
    if (Array.isArray(changed)) console.error(`Known replaced files: ${JSON.stringify(changed)}`);
    if (attemptedPath) console.error(`Last attempted file: ${JSON.stringify(attemptedPath)}`);
    throw error;
  }
}

async function doctor({ copilotHome }) {
  const root = join(await realpath(copilotHome), 'extensions', name);
  const current = await readTextFile(join(root, 'installed.json'), { maxBytes: 16_384 });
  if (current === null || JSON.parse(current).version !== version) return { ok: false };
  const plan = await planManagedFiles({ root, files: await manifest(root), update: true });
  await verifyManagedFiles(plan);
  console.log('Installed sample files and version verified.');
  return { ok: true };
}

try {
  await runInstallerCli(process.argv.slice(2), { name, version, install, doctor });
} catch (error) {
  console.error(`Sample installer stopped: ${error.message}`);
  process.exitCode = 1;
}

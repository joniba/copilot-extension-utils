import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'extension-utils-'));
  t.after(() => rm(directory, { recursive: true }));
  return directory;
}

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createStatusPublisher } from 'copilot-extension-utils/status/contributions';
import { withStatusLock } from '../../src/status/lock.mjs';

const [directory, text] = process.argv.slice(2);
const sessionId = 'session-1';
const provider = 'sample';
if (text === 'crash') {
  const parent = join(directory, sessionId);
  await mkdir(parent);
  await withStatusLock(join(parent, `${provider}.json.lock`), () => {
    process.stdout.write('lock-acquired\n', () => process.exit(23));
    return new Promise(() => {});
  });
} else {
  const publisher = createStatusPublisher({
    directory, sessionId, provider, lifetimeMs: 120_000, lock: { timeoutMs: 30_000 },
  });
  console.log(await publisher.publish(text));
}

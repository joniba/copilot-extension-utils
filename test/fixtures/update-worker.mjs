import { updateTextFile } from 'copilot-extension-utils/files/atomic';

for (let index = 0; index < 8; index++) {
  // Exercise serialization without imposing the production deadline on a loaded runner.
  await updateTextFile(process.argv[2], current => String(Number(current ?? 0) + 1), { timeoutMs: 30_000 });
}

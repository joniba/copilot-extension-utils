import { updateTextFile } from 'copilot-extension-utils/files/atomic';

for (let index = 0; index < 8; index++) {
  await updateTextFile(process.argv[2], current => String(Number(current ?? 0) + 1));
}

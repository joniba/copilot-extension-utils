import { updateTextFile } from '../files/atomic.mjs';
import { patchSettings } from './jsonc.mjs';
import { observeOperation } from '../diagnostics/operation.mjs';

export async function updateSettings(path, edits, { validate, ...options } = {}) {
  return observeOperation('settings.update', options.diagnostics, async () => {
    if (validate !== undefined && typeof validate !== 'function') throw new TypeError('Settings validator must be a function.');
    return updateTextFile(path, async current => {
      const next = patchSettings(current ?? '{}\n', edits);
      if (validate && await validate(next.value) === false) throw new Error('Settings validation rejected the update.');
      return next.text;
    }, options);
  });
}

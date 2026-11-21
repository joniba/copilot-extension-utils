import { isAbsolute } from 'node:path';
import { observeOperation } from '../diagnostics/operation.mjs';
import { withFileLock } from '../files/lock.mjs';
import { readTextFile, updateTextFile } from '../files/atomic.mjs';

export async function runInstallation({
  receiptPath, version, preflight, prepare, activate, verify, progress, diagnostics,
  lock: { timeoutMs, retryMs, signal } = {},
}) {
  if (!isAbsolute(receiptPath) || typeof version !== 'string' || !version.trim() || version.length > 256
    || [preflight, prepare, activate, verify].some(hook => typeof hook !== 'function')
    || (progress !== undefined && typeof progress !== 'function')) throw new TypeError('Invalid installation options.');

  let stage = 'lock';
  let activation = 'not-started';
  let receipt = 'not-attempted';
  let progressFailures = 0;
  let result;
  const report = async (value, trace) => {
    try { await progress?.({ stage: value }); }
    catch {
      progressFailures++;
      trace('progress_delivery_failed', { attempts: progressFailures }, 'warn');
    }
  };
  const next = async (value, trace) => {
    stage = value;
    trace(value);
    await report(value, trace);
  };
  try {
    await observeOperation('installer.run', diagnostics, async trace => {
      await withFileLock(`${receiptPath}.install.lock`, async () => {
        await next('preflight', trace);
        const expected = await readTextFile(receiptPath, { maxBytes: 16_384 });
        if (expected !== null) {
          const previous = JSON.parse(expected);
          if (typeof previous?.version !== 'string' || !previous.version.trim()) throw new Error('Invalid installed version receipt.');
        }
        const plan = await preflight();
        await next('prepare', trace);
        const prepared = await prepare(plan);
        await next('activate', trace);
        if (await readTextFile(receiptPath, { maxBytes: 16_384 }) !== expected) {
          throw Object.assign(new Error('Version receipt changed during preparation.'), { code: 'ERR_INSTALL_CONFLICT' });
        }
        activation = 'attempted';
        result = await activate(prepared);
        activation = 'completed';
        await next('verify', trace);
        if (await verify(prepared, result) === false) throw new Error('Installed extension did not pass verification.');
        await next('receipt', trace);
        receipt = 'uncertain';
        const committed = await updateTextFile(receiptPath, current => {
          if (current !== null && JSON.parse(current).version === version) return current;
          return `${JSON.stringify({ version })}\n`;
        }, { timeoutMs, retryMs, expectedText: expected, maxBytes: 16_384 }).catch(error => {
          if (error?.fileCommitted) receipt = 'published';
          else if (error?.code === 'ERR_FILE_CONFLICT') receipt = 'conflict';
          throw error;
        });
        receipt = committed.changed ? 'published' : 'unchanged';
        trace('receipt_committed', { changed: committed.changed });
      }, { timeoutMs, retryMs, signal });
      stage = 'complete';
      await report(stage, trace);
    });
  } catch (cause) {
    throw Object.assign(new Error(`Installation stopped during ${stage}.`, { cause }), {
      code: 'ERR_INSTALL_STAGE', stage, activation, receipt, result, progressFailures,
      ...(cause?.operationCompleted === true ? { operationCompleted: true } : {}),
    });
  }
  return { activation, receipt, result, progressFailures };
}

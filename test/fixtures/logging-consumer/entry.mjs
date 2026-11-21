import { setImmediate } from 'node:timers/promises';

const codes = ['EIO', -32603];
console.error('diagnostic-import-start');
async function loadDiagnostics() {
  try {
    const [{ createOperationTracer }, { createLogDelivery }, { createRotatingFileSink }] = await Promise.all([
      import('./lib/diagnostics/trace.mjs'),
      import('./lib/logging/delivery.mjs'),
      import('./lib/logging/rotating-file.mjs'),
    ]);
    const delivery = createLogDelivery({
      codes,
      destinations: [{
        name: 'file',
        write: createRotatingFileSink({ path: process.argv[2], separatePartialLine: true }),
      }],
    });
    const { run } = createOperationTracer({ submit: delivery.submit, debug: true, codes, contextKeys: ['sessionId'] });
    console.error('diagnostic-import-completed');
    return { run, delivery };
  } catch {
    console.error('diagnostic-import-unavailable');
    return null;
  }
}

const optionalDiagnostics = loadDiagnostics();
process.stdout.write(`${JSON.stringify({ result: 'operation-result' })}\n`);
void optionalDiagnostics.then(async diagnostics => {
  if (!diagnostics) return;
  const { run, delivery } = diagnostics;
  try {
    await run('request.send', () => 'traced-result', { sessionId: 'sample-session' });
    // Wait only to verify fixture evidence, never to produce the core result.
    const deadline = performance.now() + 5000;
    while (delivery.getHealth().destinations[0].delivered < 2) {
      if (performance.now() >= deadline) throw new Error('Fixture evidence was not delivered.');
      await setImmediate();
    }
  } finally {
    delivery.close();
  }
}).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

import { AsyncLocalStorage } from 'node:async_hooks';
import { isContextValue, snapshotContextKeys } from '../diagnostics/context-fields.mjs';
import { errorField, safeRecordedError, snapshotErrorCodes, summarizeError } from '../diagnostics/error-fields.mjs';

const validName = name => typeof name === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(name);
const increment = (value, amount = 1) => Math.min(value + amount, Number.MAX_SAFE_INTEGER);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const reservedContext = new Set(['code', 'errorType']);

function summarizeOrigin(record, codes, keys) {
  const fields = record.fields;
  const original = { ...safeRecordedError(fields ?? record, codes) };
  for (const key of keys) {
    const topLevelEvent = key === 'event' && Object.hasOwn(record, key);
    const source = !topLevelEvent && fields != null && Object.hasOwn(fields, key) ? fields : record;
    if (Object.hasOwn(source, key) && isContextValue(source[key])) original[key] = source[key];
  }
  return Object.keys(original).length ? original : undefined;
}

export function createLogDelivery({
  destinations, capacity = 64, maxRecordBytes = 16_384, maxPendingBytes = 1_048_576,
  suppressionMs = 0, suppressionKeys = 32, codes = [], contextKeys = [], onLoss,
}) {
  const allowedContext = snapshotContextKeys(contextKeys, reservedContext);
  const acceptedCodes = snapshotErrorCodes(codes);
  if (!Array.isArray(destinations) || destinations.length < 1 || destinations.length > 16
    || !integer(capacity, 1, 1024) || !integer(maxRecordBytes, 1, 65_536)
    || !integer(maxPendingBytes, 1, 16_777_216)
    || !integer(suppressionMs, 0, 86_400_000) || !integer(suppressionKeys, 1, 1024)
    || !acceptedCodes || !allowedContext
    || (onLoss !== undefined && typeof onLoss !== 'function')) {
    throw new TypeError('Invalid log delivery options.');
  }
  const names = new Set();
  const sinks = Array.from(destinations, ({ name, write } = {}) => {
    if (!validName(name) || typeof write !== 'function' || names.has(name)) {
      throw new TypeError('Provide unique destination names and write functions.');
    }
    names.add(name);
    return {
      name, write, queue: [], pendingBytes: 0, recent: new Map(), immediate: null, active: false,
      queued: 0, delivered: 0, suppressed: 0, overflow: 0, failed: 0, uncertain: 0, postDeliveryFailures: 0, discarded: 0,
    };
  });
  const writers = new AsyncLocalStorage();
  let closed = false;
  let invalid = 0;
  let reentrant = 0;
  let afterClose = 0;
  let formatting = false;
  let lossImmediate;
  let lossActive = false;
  let lossPending = false;
  let lossReportFailures = 0;

  function reportLoss() {
    if (!onLoss) return;
    lossPending = true;
    if (lossImmediate || lossActive) return;
    lossImmediate = setImmediate(async () => {
      lossImmediate = undefined;
      lossActive = true;
      lossPending = false;
      try {
        await writers.run(true, async () => onLoss(getHealth()));
      } catch {
        lossReportFailures = increment(lossReportFailures);
      } finally {
        lossActive = false;
        if (lossPending) reportLoss();
      }
    });
    if (closed) lossImmediate.unref();
  }

  function markDelivered(sink, key) {
    sink.delivered = increment(sink.delivered);
    if (key !== undefined && suppressionMs && !closed) {
      sink.recent.delete(key);
      sink.recent.set(key, performance.now());
      if (sink.recent.size > suppressionKeys) sink.recent.delete(sink.recent.keys().next().value);
    }
  }

  function getHealth() {
    return {
      closed, invalid, reentrant, afterClose, lossReportFailures,
      destinations: sinks.map(sink => {
        const { name, queue, pendingBytes, active, queued, delivered, suppressed, overflow, failed,
          uncertain, postDeliveryFailures, discarded, lastFailure } = sink;
        return { name, pending: queue.length, pendingBytes, active, queued, delivered, suppressed, overflow, failed,
          uncertain, postDeliveryFailures, discarded, ...(lastFailure && { lastFailure: structuredClone(lastFailure) }),
        };
      }),
    };
  }

  function schedule(sink) {
    if (closed || sink.immediate || sink.active || !sink.queue.length) return;
    sink.immediate = setImmediate(() => {
      sink.immediate = null;
      const { encoded, key, bytes } = sink.queue.shift();
      sink.pendingBytes -= bytes;
      const now = performance.now();
      if (key !== undefined && suppressionMs && now - (sink.recent.get(key) ?? -Infinity) < suppressionMs) {
        sink.suppressed = increment(sink.suppressed);
        schedule(sink);
        return;
      }
      sink.active = true;
      const record = JSON.parse(encoded);
      const original = summarizeOrigin(record, acceptedCodes, allowedContext);
      void writers.run(true, async () => {
        try {
          await sink.write(record);
          markDelivered(sink, key);
        } catch (error) {
          const reported = errorField(error, 'deliveryOutcome');
          const outcome = reported === 'written' || reported === 'uncertain' ? reported : 'failed';
          if (outcome === 'written') {
            markDelivered(sink, key);
            sink.postDeliveryFailures = increment(sink.postDeliveryFailures);
          } else {
            sink[outcome] = increment(sink[outcome]);
          }
          sink.lastFailure = { outcome, ...(original && { original }), diagnostic: summarizeError(error, acceptedCodes) };
          reportLoss();
        }
      }).finally(() => {
        sink.active = false;
        schedule(sink);
      });
    });
  }

  return Object.freeze({
    submit(record, options) {
      if (formatting || writers.getStore()) {
        reentrant = increment(reentrant);
        return 0;
      }
      if (closed) {
        afterClose = increment(afterClose);
        return 0;
      }
      let encoded;
      let key;
      let bytes;
      formatting = true;
      try {
        key = options?.suppressionKey;
        if (!record || typeof record !== 'object' || Array.isArray(record)
          || (key !== undefined && (typeof key !== 'string' || key.length > 256))) throw new TypeError();
        encoded = JSON.stringify(record);
        if (typeof encoded !== 'string' || !encoded.startsWith('{')) throw new TypeError();
        bytes = Buffer.byteLength(encoded);
        if (bytes > maxRecordBytes) {
          throw new TypeError();
        }
      } catch {
        invalid = increment(invalid);
        reportLoss();
        return 0;
      } finally {
        formatting = false;
      }
      if (closed) {
        afterClose = increment(afterClose);
        return 0;
      }
      let queued = 0;
      for (const sink of sinks) {
        if (sink.queue.length >= capacity || sink.pendingBytes + bytes > maxPendingBytes) {
          sink.overflow = increment(sink.overflow);
          reportLoss();
        } else {
          sink.queue.push({ encoded, key, bytes });
          sink.pendingBytes += bytes;
          sink.queued = increment(sink.queued);
          queued++;
          schedule(sink);
        }
      }
      return queued;
    },
    getHealth,
    close() {
      if (closed) return;
      closed = true;
      lossImmediate?.unref();
      for (const sink of sinks) {
        clearImmediate(sink.immediate);
        sink.immediate = null;
        if (sink.queue.length) reportLoss();
        sink.discarded = increment(sink.discarded, sink.queue.length);
        sink.queue.length = 0;
        sink.pendingBytes = 0;
        sink.recent.clear();
      }
    },
  });
}

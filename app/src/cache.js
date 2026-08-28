import { LRUCache } from "lru-cache";

const modelsCache = new LRUCache({ max: 500, ttl: 5 * 60 * 1000 });
const breakerCache = new LRUCache({ max: 1000, ttl: 60 * 1000 });
const pending = new Map();

function jitterMs(base) {
  return base + Math.floor(Math.random() * 60 * 1000);
}

async function getCached(key, cache, fetchFn, baseTtl) {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (pending.has(key)) return pending.get(key);
  const p = (async () => {
    try {
      const val = await fetchFn();
      if (val !== null && val !== undefined) {
        cache.set(key, val, { ttl: jitterMs(baseTtl) });
      }
      return val;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, p);
  return p;
}

export function getModelsCached(fetchFn) {
  return getCached("models", modelsCache, fetchFn, 5 * 60 * 1000);
}

export function clearModelsCache() {
  modelsCache.clear();
  pending.delete("models");
}

export function isBreakerOpen(key = "upstream:429") {
  return breakerCache.get(key) !== undefined;
}

export function getBreakerTTL(key = "upstream:429") {
  const ttl = breakerCache.getRemainingTTL(key);
  return ttl > 0 ? ttl : 0;
}

export function openBreaker(key = "upstream:429", retryAfterMs = 60 * 1000) {
  const ttl = Math.min(Math.max(retryAfterMs, 1000), 15 * 60 * 1000);
  breakerCache.set(key, { at: Date.now() }, { ttl });
}

export function clearBreaker(key = "upstream:429") {
  breakerCache.delete(key);
}

export { modelsCache, breakerCache };

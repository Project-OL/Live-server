/** In-memory Redis stand-in for lucky gift idempotency in unit tests. */
export function createMemoryRedis() {
  const store = new Map()
  return {
    async get(key) {
      const e = store.get(key)
      if (!e) return null
      if (e.expiresAt != null && Date.now() > e.expiresAt) {
        store.delete(key)
        return null
      }
      return e.value
    },
    async set(key, value, opts = {}) {
      const ttlSec = opts.EX ?? opts.ex
      store.set(key, {
        value,
        expiresAt: ttlSec != null ? Date.now() + Number(ttlSec) * 1000 : null,
      })
      return 'OK'
    },
    clear() {
      store.clear()
    },
  }
}

export const noopCheckFrozen = async () => {}

import { describe, expect, it } from 'vitest'
import { checkThresholds } from '../src/observe/threshold.ts'
import type { SelfEvolveStore } from '../src/storage/store.ts'

/** Minimal store double exposing only what the threshold engine reads. */
function storeWithCounts(counts: Record<string, number>): SelfEvolveStore {
  return {
    countObservations: (kind, since, key) => {
      void kind
      void since
      return key === undefined ? 0 : (counts[key] ?? 0)
    },
  } as unknown as SelfEvolveStore
}

const config = {
  toolFailureThreshold: 3,
  requestErrorThreshold: 2,
}

describe('checkThresholds', () => {
  it('crosses when the aggregated count reaches the threshold', () => {
    const store = storeWithCounts({ 'tool-failure:fetch': 3 })
    expect(checkThresholds(store, config, 'tool-failure', 'tool-failure:fetch', 60_000)).toBe(true)
  })

  it('does not cross below the threshold', () => {
    const store = storeWithCounts({ 'tool-failure:fetch': 2 })
    expect(checkThresholds(store, config, 'tool-failure', 'tool-failure:fetch', 60_000)).toBe(false)
  })

  it('returns false when no threshold is configured for the kind', () => {
    const store = storeWithCounts({ 'tool-repeat:x': 99 })
    expect(checkThresholds(store, { repeatThreshold: undefined }, 'tool-repeat', 'tool-repeat:x', 60_000))
      .toBe(false)
  })

  it('aggregates across keys when no key is given', () => {
    let sawKey: string | undefined = 'sentinel'
    const store = {
      countObservations: (_kind: unknown, _since: number, key?: string) => {
        sawKey = key
        return 5
      },
    } as unknown as SelfEvolveStore
    checkThresholds(store, config, 'request-error', undefined, 60_000)
    expect(sawKey).toBeUndefined()
  })
})

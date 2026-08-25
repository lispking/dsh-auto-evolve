import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SelfEvolveStore from '../src/storage/store.ts'
import { getObservationTrend } from '../src/storage/query.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'

/** Boot the real storage/domain/store composition over a memory backend. */
async function harness() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(SelfEvolveStore)
  return { ctx, store: ctx.selfEvolveStore }
}

describe('getObservationTrend', () => {
  it('falls back to the default bucket width when bucketMs is zero', async () => {
    const { store } = await harness()
    await store.observe('tool-failure', 'tool-failure:fetch', 'boom', null, 1000, 60_000)

    const trend = getObservationTrend(store, 'tool-failure', 3_600_000, 0, 5000)

    expect(trend).toBeDefined()
    expect(trend?.bucketMs).toBe(300_000)
    expect(trend?.totalHits).toBe(1)
  })

  it('falls back to the default bucket width when bucketMs is negative', async () => {
    const { store } = await harness()
    await store.observe('tool-failure', 'tool-failure:fetch', 'boom', null, 1000, 60_000)

    const trend = getObservationTrend(store, 'tool-failure', 3_600_000, -100, 5000)

    expect(trend).toBeDefined()
    expect(trend?.bucketMs).toBe(300_000)
    expect(trend?.totalHits).toBe(1)
  })

  it('returns undefined when no observations of the kind fall in the window', async () => {
    const { store } = await harness()
    await store.observe('tool-failure', 'tool-failure:fetch', 'boom', null, 1000, 60_000)

    const trend = getObservationTrend(store, 'request-error', 3_600_000, 300_000, 5000)

    expect(trend).toBeUndefined()
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SelfEvolveStore from '../src/storage/store.ts'
import type { GenomeAsset } from '../src/storage/spec.ts'
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

const asset = (overrides: Partial<GenomeAsset> = {}): GenomeAsset => ({
  id: 'skill:retry-helper',
  kind: 'skill',
  name: 'retry-helper',
  description: 'Retries flaky calls',
  content: '# Retry Helper\n\nRetry once with backoff.',
  version: 0,
  parentVersion: -1,
  status: 'candidate',
  appliedAt: null,
  proposalId: 'proposal-1',
  ...overrides,
})

describe('SelfEvolveStore', () => {
  afterEach(() => {
    // contexts own their services; nothing to clean globally
  })

  it('round-trips genome assets', async () => {
    const { store } = await harness()
    await store.putAsset(asset())
    const read = store.getAsset('skill:retry-helper')
    expect(read).toBeDefined()
    expect(read?.content).toContain('Retry Helper')
    expect(store.listAssets().map(a => a.id)).toEqual(['skill:retry-helper'])
    expect(await store.deleteAsset('skill:retry-helper')).toBe(true)
    expect(store.getAsset('skill:retry-helper')).toBeUndefined()
  })

  it('appends ledger entries newest-first with generated ids', async () => {
    const { store } = await harness()
    const id1 = await store.appendLedger({
      assetId: 'skill:a',
      kind: 'apply',
      fromVersion: 0,
      toVersion: 1,
      at: 100,
      proposalId: null,
      trialId: null,
      prevContent: null,
      reason: 'first',
    })
    const id2 = await store.appendLedger({
      assetId: 'skill:a',
      kind: 'rollback',
      fromVersion: 1,
      toVersion: 0,
      at: 200,
      proposalId: null,
      trialId: null,
      prevContent: 'body',
      reason: 'regression',
    })
    expect(id1).toBeTruthy()
    expect(id2).not.toBe(id1)
    const entries = store.listLedger()
    expect(entries[0]?.id).toBe(id2) // newest first
    expect(entries[1]?.id).toBe(id1)
  })

  it('deduplicates observation bursts within the window', async () => {
    const { store } = await harness()
    const first = await store.observe('tool-failure', 'tool-failure:fetch', 'fetch: boom', null, 1000, 60_000)
    expect(first.isNew).toBe(true)
    expect(first.record.count).toBe(1)

    const second = await store.observe('tool-failure', 'tool-failure:fetch', 'fetch: boom again', null, 2000, 60_000)
    expect(second.isNew).toBe(false)
    expect(second.record.count).toBe(2)
    expect(second.record.lastAt).toBe(2000)
    expect(second.record.firstAt).toBe(1000)

    // Outside the window: a fresh burst.
    const third = await store.observe('tool-failure', 'tool-failure:fetch', 'fetch: boom later', null, 120_000, 60_000)
    expect(third.isNew).toBe(true)
    expect(third.record.count).toBe(1)
  })

  it('counts observations per kind and key', async () => {
    const { store } = await harness()
    await store.observe('tool-failure', 'tool-failure:fetch', 'x', null, 1000, 60_000)
    await store.observe('tool-failure', 'tool-failure:fetch', 'x', null, 2000, 60_000)
    await store.observe('tool-failure', 'tool-failure:write', 'y', null, 3000, 60_000)

    expect(store.countObservations('tool-failure', 0)).toBe(3)
    expect(store.countObservations('tool-failure', 0, 'tool-failure:fetch')).toBe(2)
    expect(store.countObservations('tool-failure', 2500)).toBe(1) // only the write burst
    expect(store.countObservations('request-error', 0)).toBe(0)
  })

  it('prunes stale observations', async () => {
    const { store } = await harness()
    await store.observe('tool-failure', 'tool-failure:old', 'old', null, 1000, 60_000)
    await store.observe('tool-failure', 'tool-failure:new', 'new', null, 200_000, 60_000)
    expect(await store.pruneObservations(50_000)).toBe(1)
    expect(store.countObservations('tool-failure', 0)).toBe(1)
    expect(store.listObservations()[0]?.key).toBe('tool-failure:new')
  })

  it('tracks durable genome state', async () => {
    const { store } = await harness()
    expect(store.state()).toEqual({ generation: 0, cycleActive: false })
    await store.setState({ generation: 1, cycleActive: true })
    expect(store.state()).toEqual({ generation: 1, cycleActive: true })
  })
})

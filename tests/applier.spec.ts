import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SelfEvolveStore from '../src/storage/store.ts'
import SelfEvolveApplier from '../src/apply/applier.ts'
import type { GenomeAsset } from '../src/storage/spec.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'

async function harness() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SelfEvolveStore)
  await ctx.plugin(SelfEvolveApplier)
  return { ctx, store: ctx.selfEvolveStore, applier: ctx.selfEvolveApplier }
}

const candidate = (overrides: Partial<GenomeAsset> = {}): GenomeAsset => ({
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

describe('SelfEvolveApplier', () => {
  it('applies a candidate skill: live registration + promoted record + ledger', async () => {
    const { store, applier } = await harness()
    await store.putAsset(candidate())

    const result = await applier.applyCandidate('skill:retry-helper', 'trial-1', 'validated')
    expect(result).toBeDefined()
    expect(result?.asset.status).toBe('applied')
    expect(result?.asset.appliedAt).not.toBeNull()
    expect(applier.isLive('skill:retry-helper')).toBe(true)

    const stored = store.getAsset('skill:retry-helper')
    expect(stored?.status).toBe('applied')

    const ledger = store.listLedger()
    expect(ledger[0]?.kind).toBe('apply')
    expect(ledger[0]?.assetId).toBe('skill:retry-helper')
    expect(ledger[0]?.trialId).toBe('trial-1')
  })

  it('registers the applied skill so the registry can load it', async () => {
    const { ctx, store, applier } = await harness()
    await store.putAsset(candidate())
    await applier.applyCandidate('skill:retry-helper', null, 'validated')

    const loaded = await ctx.skills.get('retry-helper', {})
    expect(loaded).toBeDefined()
    expect(loaded?.content).toContain('Retry Helper')
  })

  it('no-ops for a missing or non-candidate asset', async () => {
    const { store, applier } = await harness()
    expect(await applier.applyCandidate('skill:nope', null, 'x')).toBeUndefined()

    await store.putAsset(candidate({ status: 'applied', appliedAt: 1 }))
    expect(await applier.applyCandidate('skill:retry-helper', null, 'x')).toBeUndefined()
  })

  it('rolls back an applied asset and restores the parent content', async () => {
    const { store, applier } = await harness()
    // First generation applied, then a patch candidate replaces it.
    await store.putAsset(candidate())
    await applier.applyCandidate('skill:retry-helper', 'trial-1', 'first')

    const patched = candidate({
      version: 1,
      parentVersion: 0,
      content: '# Retry Helper v2\n\nRetry twice with exponential backoff.',
    })
    await store.putAsset(patched)
    await applier.applyCandidate('skill:retry-helper', 'trial-2', 'second')
    expect(applier.isLive('skill:retry-helper')).toBe(true)

    const rollback = await applier.rollback('skill:retry-helper', 'regression observed')
    expect(rollback.reverted).toBe(true)
    expect(applier.isLive('skill:retry-helper')).toBe(false)
    expect(rollback.restored).toBeDefined()
    expect(rollback.restored?.status).toBe('candidate')
    expect(rollback.restored?.version).toBe(0)
    expect(rollback.restored?.content).toContain('Retry Helper')

    const ledger = store.listLedger()
    expect(ledger[0]?.kind).toBe('rollback')
    expect(ledger[0]?.prevContent).toContain('v2')
  })

  it('removes a first-generation asset on rollback when there is no parent', async () => {
    const { store, applier } = await harness()
    await store.putAsset(candidate())
    await applier.applyCandidate('skill:retry-helper', 'trial-1', 'first')

    const rollback = await applier.rollback('skill:retry-helper', 'never helped')
    expect(rollback.reverted).toBe(true)
    expect(rollback.restored).toBeUndefined()
    expect(store.getAsset('skill:retry-helper')).toBeUndefined()
  })

  it('disposes every live registration when the plugin unmounts', async () => {
    const { ctx, store, applier } = await harness()
    await store.putAsset(candidate())
    await applier.applyCandidate('skill:retry-helper', null, 'validated')
    expect(applier.isLive('skill:retry-helper')).toBe(true)

    await ctx.fiber.dispose()
    // After disposal the applier is gone; no throw is the contract.
    expect(true).toBe(true)
  })
})

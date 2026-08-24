import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SelfEvolveStore from '../src/storage/store.ts'
import {
  classifyCycle,
  CooldownGate,
  ConvergenceTracker,
  loadWatch,
  rollBackRegressions,
  trackApplied,
} from '../src/evolve/loop.ts'
import type { AutoApplyResult, RegressionWatch } from '../src/evolve/loop.ts'
import type { SelfEvolveApplier } from '../src/apply/applier.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'

const emptyResult = (): AutoApplyResult => ({ proposed: 0, applied: [], rejected: [], skipped: [] })

/** Minimal applier double exposing only the rollback contract the loop needs. */
function fakeApplier(reverted: boolean): SelfEvolveApplier {
  return { rollback: async () => ({ reverted }) } as unknown as SelfEvolveApplier
}

/** Boot the real store composition over a memory backend (pool reusable for restart tests). */
async function harness(pool = new MemoryMediaPool()) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(SelfEvolveStore)
  return { ctx, store: ctx.selfEvolveStore }
}

describe('classifyCycle', () => {
  it('classifies a rollback as stalled before anything else', () => {
    expect(classifyCycle({ ...emptyResult(), applied: ['a'] }, 1)).toBe('rolled-back')
  })

  it('classifies an apply with no rollbacks as productive', () => {
    expect(classifyCycle({ ...emptyResult(), applied: ['a'] }, 0)).toBe('applied')
  })

  it('classifies rejected / skipped / empty runs', () => {
    expect(classifyCycle({ ...emptyResult(), rejected: ['a'] }, 0)).toBe('rejected')
    expect(classifyCycle({ ...emptyResult(), skipped: ['a'] }, 0)).toBe('skipped')
    expect(classifyCycle(emptyResult(), 0)).toBe('empty')
  })
})

describe('ConvergenceTracker', () => {
  it('counts consecutive stalled cycles up to the threshold, then pauses', () => {
    const tracker = new ConvergenceTracker({ stallThreshold: 3, stallPauseMs: 1000 })
    expect(tracker.record('empty', 1000).shouldPause).toBe(false)
    expect(tracker.record('rejected', 2000).shouldPause).toBe(false)
    expect(tracker.currentStallCount).toBe(2)

    const verdict = tracker.record('empty', 3000)
    expect(verdict.shouldPause).toBe(true)
    expect(verdict.stallCount).toBe(3)
    expect(verdict.pausedUntil).toBe(4000)
  })

  it('resets the stall counter on a productive cycle', () => {
    const tracker = new ConvergenceTracker({ stallThreshold: 2, stallPauseMs: 1000 })
    tracker.record('empty', 1000)
    tracker.record('rejected', 2000)
    const verdict = tracker.record('applied', 3000)
    expect(verdict.shouldPause).toBe(false)
    expect(tracker.currentStallCount).toBe(0)
  })

  it('is paused while a pause is active and auto-resumes after it expires', () => {
    const tracker = new ConvergenceTracker({ stallThreshold: 2, stallPauseMs: 5000 })
    tracker.record('empty', 1000)
    tracker.record('rejected', 2000) // threshold reached → paused until 7000
    expect(tracker.isPaused(3000)).toBe(true)
    expect(tracker.isPaused(6999)).toBe(true)
    // Expiry resets the stall counter so the next cycle starts clean.
    expect(tracker.isPaused(7000)).toBe(false)
    expect(tracker.currentStallCount).toBe(0)
  })

  it('clears an active pause on a productive cycle', () => {
    const tracker = new ConvergenceTracker({ stallThreshold: 2, stallPauseMs: 5000 })
    tracker.record('empty', 1000)
    tracker.record('rejected', 2000)
    expect(tracker.isPaused(3000)).toBe(true)

    tracker.record('applied', 3500)
    expect(tracker.pausedUntil).toBeUndefined()
    expect(tracker.isPaused(4000)).toBe(false)
  })

  it('reset() clears both the stall counter and the pause', () => {
    const tracker = new ConvergenceTracker({ stallThreshold: 1, stallPauseMs: 5000 })
    tracker.record('empty', 1000)
    expect(tracker.isPaused(2000)).toBe(true)

    tracker.reset()
    expect(tracker.currentStallCount).toBe(0)
    expect(tracker.isPaused(2000)).toBe(false)
  })
})

describe('CooldownGate', () => {
  it('starts uncooled and cools a key for the configured window', () => {
    const gate = new CooldownGate(10_000)
    expect(gate.isCooled('k', 1000)).toBe(false)

    gate.mark('k', 1000)
    expect(gate.isCooled('k', 1000)).toBe(true)
    expect(gate.isCooled('k', 10_999)).toBe(true)
    expect(gate.isCooled('k', 11_000)).toBe(false)
  })

  it('keeps cooldowns per key', () => {
    const gate = new CooldownGate(10_000)
    gate.mark('a', 1000)
    expect(gate.isCooled('a', 2000)).toBe(true)
    expect(gate.isCooled('b', 2000)).toBe(false)
  })

  it('clear() removes the cooldown', () => {
    const gate = new CooldownGate(10_000)
    gate.mark('k', 1000)
    gate.clear('k')
    expect(gate.isCooled('k', 1000)).toBe(false)
  })

  it('mark() accepts a custom window', () => {
    const gate = new CooldownGate(10_000)
    gate.mark('k', 1000, 100)
    expect(gate.isCooled('k', 1099)).toBe(true)
    expect(gate.isCooled('k', 1100)).toBe(false)
  })
})

describe('trackApplied', () => {
  it('records the triggering key and time for every applied asset', async () => {
    const watch: RegressionWatch = new Map()
    const result: AutoApplyResult = { proposed: 1, applied: ['a', 'b'], rejected: [], skipped: [] }

    await trackApplied(watch, result, 'tool-failure:fetch', 1000)

    expect(watch.get('a')).toEqual({ key: 'tool-failure:fetch', at: 1000 })
    expect(watch.get('b')).toEqual({ key: 'tool-failure:fetch', at: 1000 })
  })

  it('ignores rejected and skipped assets', async () => {
    const watch: RegressionWatch = new Map()
    await trackApplied(watch, { proposed: 2, applied: [], rejected: ['x'], skipped: ['y'] }, 'k', 1000)
    expect(watch.size).toBe(0)
  })
})

describe('rollBackRegressions', () => {
  it('rolls back watched assets for the same key inside the window', async () => {
    const applier = fakeApplier(true)
    const watch: RegressionWatch = new Map([
      ['a', { key: 'tool-failure:fetch', at: 1000 }],
      ['b', { key: 'request-error:x', at: 1000 }],
    ])

    const rolledBack = await rollBackRegressions(applier, watch, 'tool-failure:fetch', 60_000, 2000)

    expect(rolledBack).toEqual(['a'])
    expect(watch.has('a')).toBe(false) // dropped after rollback
    expect(watch.get('b')).toBeDefined() // different key untouched
  })

  it('drops stale watch entries without rolling back', async () => {
    const applier = fakeApplier(true)
    const watch: RegressionWatch = new Map([
      ['a', { key: 'tool-failure:fetch', at: 1000 }],
    ])

    const rolledBack = await rollBackRegressions(applier, watch, 'tool-failure:fetch', 500, 2000)

    expect(rolledBack).toEqual([])
    expect(watch.has('a')).toBe(false)
  })

  it('returns only the ids whose rollback actually reverted', async () => {
    const applier = fakeApplier(false)
    const watch: RegressionWatch = new Map([
      ['a', { key: 'tool-failure:fetch', at: 1000 }],
    ])

    const rolledBack = await rollBackRegressions(applier, watch, 'tool-failure:fetch', 60_000, 2000)

    expect(rolledBack).toEqual([])
    expect(watch.has('a')).toBe(false) // watch dropped regardless of success
  })
})

describe('durable regression watch', () => {
  it('trackApplied persists entries when a store is provided', async () => {
    const { store } = await harness()
    const watch: RegressionWatch = new Map()

    await trackApplied(watch, { proposed: 1, applied: ['a'], rejected: [], skipped: [] }, 'tool-failure:fetch', 1000, store)

    expect(watch.get('a')).toEqual({ key: 'tool-failure:fetch', at: 1000 })
    expect(store.listWatch()).toEqual([{ assetId: 'a', key: 'tool-failure:fetch', at: 1000 }])
  })

  it('rollBackRegressions deletes the durable entry alongside the map', async () => {
    const { store } = await harness()
    await store.putWatch('a', 'tool-failure:fetch', 1000)
    const watch: RegressionWatch = new Map([['a', { key: 'tool-failure:fetch', at: 1000 }]])

    const rolledBack = await rollBackRegressions(fakeApplier(true), watch, 'tool-failure:fetch', 60_000, 2000, store)

    expect(rolledBack).toEqual(['a'])
    expect(watch.size).toBe(0)
    expect(store.listWatch()).toEqual([])
  })

  it('rollBackRegressions cleans the durable entry when a watch expires', async () => {
    const { store } = await harness()
    await store.putWatch('a', 'tool-failure:fetch', 1000)
    const watch: RegressionWatch = new Map([['a', { key: 'tool-failure:fetch', at: 1000 }]])

    await rollBackRegressions(fakeApplier(true), watch, 'tool-failure:fetch', 500, 2000, store)

    expect(watch.size).toBe(0)
    expect(store.listWatch()).toEqual([])
  })

  it('loadWatch restores the watch across a restart and cleans stale entries', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    await first.store.putWatch('a', 'tool-failure:fetch', 1000) // fresh
    await first.store.putWatch('b', 'tool-failure:fetch', 100) // stale (> 500ms old)
    await first.ctx.fiber.dispose()

    const second = await harness(pool)
    const watch = await loadWatch(second.store, 500, 1000)

    expect([...watch.keys()]).toEqual(['a'])
    expect(watch.get('a')).toEqual({ key: 'tool-failure:fetch', at: 1000 })
    expect(second.store.listWatch().map(entry => entry.assetId)).toEqual(['a'])
  })
})

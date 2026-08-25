import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SelfEvolveStore from '../src/storage/store.ts'
import SelfEvolveApplier from '../src/apply/applier.ts'
import {
  applyCandidateTool,
  describeCandidates,
  describeHealth,
  rollbackTool,
  runCycleTool,
} from '../src/control/tools.ts'
import type { OperatorToolOptions } from '../src/control/tools.ts'
import { CooldownGate, ConvergenceTracker, runAutoApplyCycle } from '../src/evolve/loop.ts'
import { CostLedger, estimateProposalTokens } from '../src/propose/budget.ts'
import type { GenomeAsset } from '../src/storage/spec.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'

/** Fake LLM adapter whose stream returns one canned text block. */
class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly script: string) {
    super()
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    // Advertise one model so provider fallback (resolveProposalTarget) works.
    return [{ provider, id: 'scripted', name: 'Scripted Model' }]
  }

  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.script }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: this.script },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const VALID_PROPOSAL = JSON.stringify({
  rationale: 'fetch failed three times; a retry skill should help',
  expectedImpact: 'fewer tool failures',
  mutations: [
    {
      operator: 'add',
      kind: 'skill',
      targetId: '',
      name: 'retry-helper',
      description: 'Retries flaky calls',
      content: '# Retry Helper\n\nRetry once with backoff.',
    },
  ],
})

async function harness() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(LlmRuntime)
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

function options(
  store: SelfEvolveStore,
  applier: SelfEvolveApplier | undefined,
  overrides: Partial<OperatorToolOptions> = {},
): OperatorToolOptions {
  return {
    mode: 'propose',
    store,
    applier,
    convergence: new ConvergenceTracker(),
    cooldown: new CooldownGate(10_000),
    watch: new Map(),
    windowMs: 60_000,
    proposal: { maxProposalsPerTrigger: 2, maxEpisodesPerProposal: 5, maxPromptChars: 4000, maxTokens: 500 },
    validation: { maxTrialMs: 30_000, maxToolCalls: 20, maxTrialSteps: 12, maxTrialTokens: 8000 },
    ...overrides,
  }
}

describe('describeHealth', () => {
  it('reports mode, generation, asset counts, and watch size', async () => {
    const { store, applier } = await harness()
    await store.putAsset(candidate())
    await store.putAsset(candidate({ id: 'skill:other', name: 'other', status: 'applied', appliedAt: 1 }))

    const report = describeHealth(options(store, applier))

    expect(report).toContain('mode: propose')
    expect(report).toContain('generation: 0')
    expect(report).toContain('candidate=1')
    expect(report).toContain('applied=1')
    expect(report).toContain('paused=false')
    expect(report).toContain('regression-watch: 0 applied asset(s)')
  })

  it('reflects an active convergence pause', async () => {
    const { store, applier } = await harness()
    const convergence = new ConvergenceTracker({ stallThreshold: 1, stallPauseMs: 60_000 })
    convergence.record('empty', 1000) // paused until 61000

    const report = describeHealth(options(store, applier, { convergence }), 2000)

    expect(report).toContain('stalled=1')
    expect(report).toContain('paused=true')
    expect(report).toContain('until')
  })
})

describe('describeCandidates', () => {
  it('lists candidates and reports none when empty', async () => {
    const { store } = await harness()
    expect(describeCandidates(store)).toContain('no candidates')

    await store.putAsset(candidate())
    const report = describeCandidates(store)
    expect(report).toContain('skill:retry-helper')
    expect(report).toContain('Retries flaky calls')
  })
})

describe('applyCandidateTool', () => {
  it('applies a candidate and reports the ledger id', async () => {
    const { store, applier } = await harness()
    await store.putAsset(candidate())

    const report = await applyCandidateTool(options(store, applier), 'skill:retry-helper')

    expect(report).toContain('applied skill:retry-helper')
    expect(store.getAsset('skill:retry-helper')?.status).toBe('applied')
  })

  it('throws for a missing or non-candidate asset', async () => {
    const { store, applier } = await harness()
    await expect(applyCandidateTool(options(store, applier), 'skill:nope')).rejects.toThrow('not found')
  })

  it('throws when the applier is not mounted', async () => {
    const { store } = await harness()
    await expect(applyCandidateTool(options(store, undefined), 'skill:nope')).rejects.toThrow('unavailable')
  })
})

describe('rollbackTool', () => {
  it('reverts an applied asset and reports the restored version', async () => {
    const { store, applier } = await harness()
    await store.putAsset(candidate())
    await applier.applyCandidate('skill:retry-helper', null, 'first')
    await store.putAsset(candidate({ version: 1, parentVersion: 0, content: '# Retry Helper v2' }))
    await applier.applyCandidate('skill:retry-helper', null, 'second')

    const report = await rollbackTool(options(store, applier), 'skill:retry-helper')

    expect(report).toContain('rolled back skill:retry-helper')
    expect(report).toContain('v0')
    expect(store.getAsset('skill:retry-helper')?.status).toBe('candidate')
  })

  it('throws when the asset is not applied', async () => {
    const { store, applier } = await harness()
    await expect(rollbackTool(options(store, applier), 'skill:retry-helper')).rejects.toThrow('not applied')
  })
})

describe('runCycleTool', () => {
  it('materializes candidates in propose mode', async () => {
    const { ctx, store, applier } = await harness()
    ctx.llm.registerAdapter(['fake'], new ScriptedAdapter(VALID_PROPOSAL))

    const report = await runCycleTool(ctx, options(store, applier))

    expect(report).toContain('materialized 1 candidate(s)')
    expect(store.getAsset('skill:retry-helper')?.status).toBe('candidate')
  })

  it('rejects in observe mode', async () => {
    const { ctx, store, applier } = await harness()
    await expect(runCycleTool(ctx, options(store, applier, { mode: 'observe' }))).rejects.toThrow('observe')
  })
})

describe('runAutoApplyCycle budget gate', () => {
  it('stops trial validation when the budget gate rejects', async () => {
    const { ctx, store, applier } = await harness()
    ctx.llm.registerAdapter(['fake'], new ScriptedAdapter(VALID_PROPOSAL))
    const ledger = new CostLedger()

    // Proposal estimate is estimateProposalTokens(4000, 500) = 1500; the
    // trial estimate is 2 × estimateTrialTokens(8000, 12) = 192000. A cap of
    // 100000 lets the proposal through but gates every trial replay.
    const result = await runAutoApplyCycle(ctx, store, applier, {
      provider: 'fake',
      model: 'm',
      maxTokens: 500,
      maxPromptChars: 4000,
      maxMutations: 2,
      maxObservations: 5,
      bounds: { maxTrialMs: 30_000, maxToolCalls: 20, maxTrialSteps: 12, maxTrialTokens: 8000 },
      budget: { maxCostPerCycle: 100_000 },
      costLedger: ledger,
    })

    expect(result.proposed).toBe(1)
    expect(result.applied).toEqual([])
    expect(result.rejected).toEqual([])
    expect(result.skipped).toEqual([])
    // The candidate was materialized but never validated — the gate aborted
    // the trial loop before any replay.
    expect(store.getAsset('skill:retry-helper')?.status).toBe('candidate')
    // Only the proposal call was billed; the blocked trials spent nothing.
    expect(ledger.cycleSpent).toBe(0)
    expect(ledger.dailySpent).toBe(estimateProposalTokens(4000, 500))
  })
})

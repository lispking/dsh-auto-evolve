import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SelfEvolveStore from '../src/storage/store.ts'
import { runProposalCycle } from '../src/propose/cycle.ts'
import { generateProposal } from '../src/propose/engine.ts'
import { CostLedger, estimateProposalTokens } from '../src/propose/budget.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'

/** A fake LLM adapter whose stream returns one canned text block. */
class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly script: string) {
    super()
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

async function harness() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SelfEvolveStore)
  return { ctx, store: ctx.selfEvolveStore }
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

describe('generateProposal', () => {
  it('returns null when the model output is not valid JSON', async () => {
    const { ctx } = await harness()
    ctx.llm.registerAdapter(['fake'], new ScriptedAdapter('not json at all'))
    const proposal = await generateProposal(ctx, [], [], {
      provider: 'fake',
      model: 'm',
      maxTokens: 500,
      maxPromptChars: 4000,
      maxMutations: 2,
    })
    expect(proposal).toBeNull()
  })

  it('returns null when the JSON fails the closed-vocabulary schema', async () => {
    const { ctx } = await harness()
    ctx.llm.registerAdapter(['fake'], new ScriptedAdapter(JSON.stringify({
      rationale: 'x',
      expectedImpact: 'y',
      mutations: [{ operator: 'destroy', kind: 'skill', targetId: '', name: 'a', description: 'd', content: 'c' }],
    })))
    const proposal = await generateProposal(ctx, [], [], {
      provider: 'fake',
      model: 'm',
      maxTokens: 500,
      maxPromptChars: 4000,
      maxMutations: 2,
    })
    expect(proposal).toBeNull()
  })

  it('returns a validated proposal from a valid scripted response', async () => {
    const { ctx } = await harness()
    ctx.llm.registerAdapter(['fake'], new ScriptedAdapter(VALID_PROPOSAL))
    const proposal = await generateProposal(ctx, [], [], {
      provider: 'fake',
      model: 'm',
      maxTokens: 500,
      maxPromptChars: 4000,
      maxMutations: 2,
    })
    expect(proposal).not.toBeNull()
    expect(proposal?.mutations).toHaveLength(1)
    expect(proposal?.mutations[0]?.name).toBe('retry-helper')
    expect(proposal?.mutations[0]?.operator).toBe('add')
  })
})

describe('runProposalCycle', () => {
  it('materializes candidate assets from a valid proposal', async () => {
    const { ctx, store } = await harness()
    ctx.llm.registerAdapter(['fake'], new ScriptedAdapter(VALID_PROPOSAL))

    const materialized = await runProposalCycle(ctx, store, {
      provider: 'fake',
      model: 'm',
      maxTokens: 500,
      maxPromptChars: 4000,
      maxMutations: 2,
      maxObservations: 5,
    })

    expect(materialized).toBe(1)
    const asset = store.getAsset('skill:retry-helper')
    expect(asset).toBeDefined()
    expect(asset?.status).toBe('candidate')
    expect(asset?.proposalId).toBeTruthy()
    expect(asset?.version).toBe(0)
    expect(asset?.parentVersion).toBe(-1)
    // Cycle flag restored after the run.
    expect(store.state().cycleActive).toBe(false)
  })

  it('bumps versions when patching an existing asset', async () => {
    const { ctx, store } = await harness()
    await store.putAsset({
      id: 'skill:retry-helper',
      kind: 'skill',
      name: 'retry-helper',
      description: 'Retries flaky calls',
      content: '# v1',
      version: 0,
      parentVersion: -1,
      status: 'applied',
      appliedAt: 1,
      proposalId: null,
    })
    ctx.llm.registerAdapter(['fake'], new ScriptedAdapter(JSON.stringify({
      rationale: 'patch the helper',
      expectedImpact: 'better',
      mutations: [
        {
          operator: 'patch',
          kind: 'skill',
          targetId: 'skill:retry-helper',
          name: 'retry-helper',
          description: 'Retries flaky calls',
          content: '# v2\n\nRetry twice.',
        },
      ],
    })))

    const materialized = await runProposalCycle(ctx, store, {
      provider: 'fake',
      model: 'm',
      maxTokens: 500,
      maxPromptChars: 4000,
      maxMutations: 2,
      maxObservations: 5,
    })

    expect(materialized).toBe(1)
    const asset = store.getAsset('skill:retry-helper')
    expect(asset?.version).toBe(1)
    expect(asset?.parentVersion).toBe(0)
    expect(asset?.status).toBe('candidate')
  })

  it('guards re-entrancy with the durable cycleActive flag', async () => {
    const { ctx, store } = await harness()
    await store.setState({ generation: 0, cycleActive: true })
    const materialized = await runProposalCycle(ctx, store, {
      provider: 'fake',
      model: 'm',
      maxTokens: 500,
      maxPromptChars: 4000,
      maxMutations: 2,
      maxObservations: 5,
    })
    expect(materialized).toBe(0)
  })

  it('resets the per-cycle ledger after each cycle so the cap is per-cycle', async () => {
    const { ctx, store } = await harness()
    ctx.llm.registerAdapter(['fake'], new ScriptedAdapter(VALID_PROPOSAL))
    const ledger = new CostLedger()
    // One proposal costs estimateProposalTokens(4000, 500) = 1500 tokens.
    // A 2000-token cap fits one cycle but not two without a reset.
    const options = {
      provider: 'fake',
      model: 'm',
      maxTokens: 500,
      maxPromptChars: 4000,
      maxMutations: 2,
      maxObservations: 5,
      budget: { maxCostPerCycle: 2000 },
      costLedger: ledger,
    }

    expect(await runProposalCycle(ctx, store, options)).toBe(1)
    expect(ledger.cycleSpent).toBe(0) // reset in the finally block
    expect(ledger.dailySpent).toBe(estimateProposalTokens(4000, 500))

    // Second cycle with a *different* mutation (new asset id) so the dedup
    // layer does not drop it — proving the cap is per-cycle, not cumulative.
    ctx.llm.registerAdapter(['fake-v2'], new ScriptedAdapter(JSON.stringify({
      rationale: 'add a second helper',
      expectedImpact: 'fewer failures',
      mutations: [
        {
          operator: 'add',
          kind: 'skill',
          targetId: '',
          name: 'retry-v2',
          description: 'Second retry helper',
          content: '# Retry Helper v2\n\nRetry with jitter.',
        },
      ],
    })))
    expect(await runProposalCycle(ctx, store, { ...options, provider: 'fake-v2' })).toBe(1)
    expect(ledger.cycleSpent).toBe(0)
    expect(ledger.dailySpent).toBe(estimateProposalTokens(4000, 500) * 2)
  })

  it('skips a single cycle whose estimate exceeds the per-cycle cap', async () => {
    const { ctx, store } = await harness()
    ctx.llm.registerAdapter(['fake'], new ScriptedAdapter(VALID_PROPOSAL))
    const ledger = new CostLedger()

    const materialized = await runProposalCycle(ctx, store, {
      provider: 'fake',
      model: 'm',
      maxTokens: 500,
      maxPromptChars: 4000,
      maxMutations: 2,
      maxObservations: 5,
      budget: { maxCostPerCycle: 1000 }, // below the 1500 estimate
      costLedger: ledger,
    })

    expect(materialized).toBe(0)
    expect(ledger.cycleSpent).toBe(0)
    expect(store.getAsset('skill:retry-helper')).toBeUndefined()
  })
})

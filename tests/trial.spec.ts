import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { runTrial, validateMutations } from '../src/validate/trial.ts'
import type { TrialBounds } from '../src/validate/trial.ts'
import { createMockLlmStream } from '../src/validate/mock-llm.ts'
import type { MockStreamFactory } from '../src/validate/mock-llm.ts'

const bounds: TrialBounds = { maxTrialMs: 1000, maxToolCalls: 5 }

/**
 * Minimal agents service double: invokes the trial's setup callback with a
 * fake scoped context whose `llm` is the *same object* the host resolves —
 * mirroring how cordis resolves a scoped service through the provider chain
 * to the shared instance. followup() simulates one model request through the
 * (possibly patched) stream, then settles the agent to idle.
 */
function fakeAgentsService(llm: unknown) {
  let idleHandler: ((payload: { status: string }) => void) | undefined
  return {
    async create(options: { setup?: (agentCtx: unknown) => void }) {
      const agentCtx = {
        llm,
        tools: { restrict() {} },
        on() { return () => {} },
      }
      options.setup?.(agentCtx as never)
      return {
        agent: {
          ctx: {
            on(_event: string, handler: (payload: { status: string }) => void) {
              idleHandler = handler
            },
          },
          followup() {
            // Route one model call through the shared stream so the mock
            // patch (if applied) is observable.
            ;(llm as { stream: (options: unknown) => unknown }).stream({
              provider: 'fake',
              model: 'm',
              messages: [],
            })
            idleHandler?.({ status: 'idle' })
          },
        },
        dispose: async () => {},
      }
    },
  }
}

describe('mock stream lifecycle', () => {
  it('restores the shared llm.stream after a mocked trial', async () => {
    const ctx = new Context()
    const originalStream = () => 'original'
    const llm = { stream: originalStream }
    let mockCalls = 0
    const factory: MockStreamFactory = () => {
      mockCalls++
      return createMockLlmStream({ turns: [{ text: 'ok' }] })
    }
    ctx.provide('agents', fakeAgentsService(llm) as never)

    const metrics = await runTrial(ctx, {
      provider: 'fake',
      model: 'm',
      episode: 'replay the failing episode',
      mutations: [],
      bounds,
      mockStream: factory,
    })

    expect(metrics.outcome).toBe('completed')
    // The mock was live during the trial: the followup's model call went
    // through the patched stream.
    expect(mockCalls).toBe(1)
    // And the patch was undone afterwards: the shared stream behaves like the
    // original again instead of the mock.
    expect(llm.stream({ provider: 'fake', model: 'm', messages: [] })).toBe('original')
    expect(mockCalls).toBe(1)
  })

  it('leaves the shared llm.stream untouched when no mock is requested', async () => {
    const ctx = new Context()
    const llm = { stream: () => 'original' }
    ctx.provide('agents', fakeAgentsService(llm) as never)

    const metrics = await runTrial(ctx, {
      provider: 'fake',
      model: 'm',
      episode: 'replay',
      mutations: [],
      bounds,
    })

    expect(metrics.outcome).toBe('completed')
    expect(llm.stream({ provider: 'fake', model: 'm', messages: [] })).toBe('original')
  })
})

describe('validateMutations', () => {
  it('returns an empty run for an empty episode list instead of crashing', async () => {
    const ctx = new Context() // no agents needed: nothing is replayed
    const run = await validateMutations(ctx, {
      provider: 'fake',
      model: 'm',
      episode: 'unused',
      mutations: [],
      bounds,
    }, [])

    expect(run.id).toBeTruthy()
    expect(run.episodes).toEqual([])
    expect(run.baseline).toBeUndefined()
    expect(run.trial).toBeUndefined()
    expect(run.comparison).toBeUndefined()
  })
})

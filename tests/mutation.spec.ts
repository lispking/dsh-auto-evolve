import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import ToolsRuntime from '@deepseek-ai/dsh-tools'
import SelfEvolveStore from '../src/storage/store.ts'
import SelfEvolveApplier from '../src/apply/applier.ts'
import {
  applyMutation,
  isTrialExercisable,
  parseGuardPolicy,
  parsePostProcessor,
  parseToolWrapper,
} from '../src/apply/mutation.ts'
import type { GenomeAsset } from '../src/storage/spec.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'

const asset = (kind: GenomeAsset['kind'], overrides: Partial<GenomeAsset> = {}): GenomeAsset => ({
  id: `${kind}:x`,
  kind,
  name: 'x',
  description: 'd',
  content: '',
  version: 0,
  parentVersion: -1,
  status: 'candidate',
  appliedAt: null,
  proposalId: null,
  ...overrides,
})

/** Minimal context double: records skill/guard registrations and tool listeners. */
function fakeContext() {
  const state = {
    skills: [] as unknown[],
    guards: [] as ((exec: { name: string }) => string | undefined)[],
    listeners: new Map<string, ((exec: unknown, next: unknown) => unknown)[]>(),
  }
  const ctx = {
    skills: {
      register: (registration: unknown) => {
        state.skills.push(registration)
        return () => {}
      },
    },
    tools: {
      guard: (guard: (exec: { name: string }) => string | undefined) => {
        state.guards.push(guard)
        return () => {}
      },
    },
    on: (event: string, listener: (exec: unknown, next: unknown) => unknown) => {
      const list = state.listeners.get(event) ?? []
      list.push(listener)
      state.listeners.set(event, list)
      return () => {}
    },
  }
  return { ctx: ctx as unknown as Context, state }
}

const execOf = (name: string, args: unknown = {}) => ({ name, arguments: args })
const ok = (text = 'ok') => async () => ({ isError: false, content: [{ type: 'text', text }] })
const fail = (message = 'boom') => async () => ({ isError: true, error: { message } })

describe('isTrialExercisable', () => {
  it('accepts every kind with a runtime contribution', () => {
    for (const kind of ['skill', 'tool-wrapper', 'guard-policy', 'post-processor'] as const) {
      expect(isTrialExercisable(kind)).toBe(true)
    }
  })

  it('rejects prompt-section (no replay contribution in this release)', () => {
    expect(isTrialExercisable('prompt-section')).toBe(false)
  })
})

describe('parseToolWrapper', () => {
  it('parses a full config', () => {
    const config = parseToolWrapper(JSON.stringify({
      tool: 'fetch',
      retries: 2,
      validate: { schema: { required: ['url'] }, message: 'url required' },
      fallback: { result: { ok: false }, isError: false },
    }))
    expect(config.tool).toBe('fetch')
    expect(config.retries).toBe(2)
    expect(config.validate?.message).toBe('url required')
    expect(config.fallback?.result).toEqual({ ok: false })
  })

  it('throws when the tool field is missing', () => {
    expect(() => parseToolWrapper('{"retries":1}')).toThrow('tool')
  })
})

describe('parseGuardPolicy', () => {
  it('parses a tool-scoped policy', () => {
    expect(parseGuardPolicy('{"tool":"fetch","reason":"fetch is banned"}')).toEqual({
      tool: 'fetch',
      reason: 'fetch is banned',
    })
  })

  it('parses a global policy without a tool', () => {
    expect(parseGuardPolicy('{"reason":"no tools"}')).toEqual({ reason: 'no tools' })
  })

  it('throws without a reason', () => {
    expect(() => parseGuardPolicy('{"tool":"fetch"}')).toThrow('reason')
  })
})

describe('parsePostProcessor', () => {
  it('parses a valid config', () => {
    expect(parsePostProcessor('{"tool":"fetch","note":"cached result"}')).toEqual({
      tool: 'fetch',
      note: 'cached result',
    })
  })

  it('throws without a note', () => {
    expect(() => parsePostProcessor('{"tool":"fetch"}')).toThrow('note')
  })
})

describe('applyMutation', () => {
  it('registers a skill on ctx.skills', () => {
    const { ctx, state } = fakeContext()
    const disposer = applyMutation(ctx, asset('skill', { name: 'retry-helper' }))
    expect(disposer).toBeDefined()
    expect(state.skills).toHaveLength(1)
    expect(state.skills[0]).toMatchObject({ name: 'retry-helper', invocation: { modelInvocable: true } })
  })

  it('returns undefined for prompt-section (record-only kind)', () => {
    const { ctx } = fakeContext()
    expect(applyMutation(ctx, asset('prompt-section'))).toBeUndefined()
  })

  it('wraps tools/execute for a tool-wrapper with retry and fallback', async () => {
    const { ctx, state } = fakeContext()
    applyMutation(ctx, asset('tool-wrapper', {
      content: JSON.stringify({ tool: 'fetch', retries: 1, fallback: { result: { cached: true } } }),
    }))
    const listener = state.listeners.get('tools/execute')![0]!

    // Non-matching tool passes through.
    expect(await listener(execOf('write'), ok('w'))).toMatchObject({ isError: false })

    // Persistent failure lands on the fallback result.
    const result = await listener(execOf('fetch'), fail('boom'))
    expect(result).toMatchObject({ isError: false, result: { cached: true } })
  })

  it('rejects arguments failing the wrapper validation schema', async () => {
    const { ctx, state } = fakeContext()
    applyMutation(ctx, asset('tool-wrapper', {
      content: JSON.stringify({ tool: 'fetch', validate: { schema: { required: ['url'] }, message: 'url required' } }),
    }))
    const listener = state.listeners.get('tools/execute')![0]!

    const result = await listener(execOf('fetch', {}), ok())
    expect(result).toMatchObject({ isError: true, error: { message: 'url required' } })
  })

  it('registers a guard that denies matching tool calls', () => {
    const { ctx, state } = fakeContext()
    applyMutation(ctx, asset('guard-policy', {
      content: JSON.stringify({ tool: 'fetch', reason: 'fetch is banned' }),
    }))
    expect(state.guards).toHaveLength(1)
    const guard = state.guards[0]!
    expect(guard({ name: 'fetch' })).toBe('fetch is banned')
    expect(guard({ name: 'read' })).toBeUndefined()
  })

  it('registers a guard that denies every call when no tool is set', () => {
    const { ctx, state } = fakeContext()
    applyMutation(ctx, asset('guard-policy', { content: JSON.stringify({ reason: 'no tools' }) }))
    const guard = state.guards[0]!
    expect(guard({ name: 'fetch' })).toBe('no tools')
    expect(guard({ name: 'anything' })).toBe('no tools')
  })

  it('prepends the note to successful results of the named tool', async () => {
    const { ctx, state } = fakeContext()
    applyMutation(ctx, asset('post-processor', {
      content: JSON.stringify({ tool: 'fetch', note: 'cached result' }),
    }))
    const listener = state.listeners.get('tools/execute')![0]!

    const result = await listener(execOf('fetch'), ok('real'))
    expect(result).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: 'cached result' }, { type: 'text', text: 'real' }],
    })

    // Error results and other tools pass through untouched.
    expect(await listener(execOf('fetch'), fail('boom'))).toMatchObject({ isError: true })
    expect(await listener(execOf('write'), ok('w'))).toMatchObject({ content: [{ type: 'text', text: 'w' }] })
  })
})

describe('applier live contributions for non-skill kinds', () => {
  async function harness() {
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    await ctx.plugin(SkillRegistry)
    // ToolRuntime injects `systemPrompt` (dsh-system-prompt is not installed);
    // the stub satisfies the inject and the constructor's section registrations
    // — the callbacks are never invoked because no prompt assembly happens here.
    ctx.provide('systemPrompt', {
      tools: () => () => {},
      section: () => () => {},
    } as never)
    await ctx.plugin(ToolsRuntime)
    await ctx.plugin(SelfEvolveStore)
    await ctx.plugin(SelfEvolveApplier)
    return { ctx, store: ctx.selfEvolveStore, applier: ctx.selfEvolveApplier }
  }

  it('registers a live contribution for guard-policy and post-processor applies', async () => {
    const { store, applier } = await harness()
    await store.putAsset(asset('guard-policy', { content: JSON.stringify({ tool: 'fetch', reason: 'banned' }) }))
    await store.putAsset(asset('post-processor', { content: JSON.stringify({ tool: 'fetch', note: 'note' }) }))

    expect(await applier.applyCandidate('guard-policy:x', null, 'test')).toBeDefined()
    expect(await applier.applyCandidate('post-processor:x', null, 'test')).toBeDefined()
    expect(applier.isLive('guard-policy:x')).toBe(true)
    expect(applier.isLive('post-processor:x')).toBe(true)
  })

  it('applies prompt-section as record-only (no live contribution)', async () => {
    const { store, applier } = await harness()
    await store.putAsset(asset('prompt-section', { content: 'Act carefully.' }))

    const result = await applier.applyCandidate('prompt-section:x', null, 'test')

    expect(result).toBeDefined()
    expect(result?.asset.status).toBe('applied')
    expect(applier.isLive('prompt-section:x')).toBe(false)
  })
})

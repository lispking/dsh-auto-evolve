import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import SelfEvolveStore from '../src/storage/store.ts'
import { installObservations } from '../src/observe/collector.ts'
import type { TriggerSignal } from '../src/observe/collector.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'

const signal = new AbortController().signal

/** Minimal agent identity for repeat-detection tests (chains key by agent id). */
const testAgent = { id: 'agent-1' } as never

function execution(name: string, overrides: Partial<ToolExecution> = {}): ToolExecution {
  const callId = CallId(`call-${name}`)
  return {
    token: Symbol(name) as ToolExecutionToken,
    callId,
    name,
    arguments: Object.freeze({}),
    ...overrides,
    signal: overrides.signal ?? signal,
    rootCallId: overrides.rootCallId ?? callId,
  }
}

const failure = (text: string): ToolExecutionResult => Object.freeze({
  content: Object.freeze([{ type: 'text', text }]) as never,
  isError: true,
  error: { message: text },
})

const success = (): ToolExecutionResult => Object.freeze({
  content: Object.freeze([{ type: 'text', text: 'ok' }]) as never,
  isError: false,
  value: null,
})

/**
 * Emit a `tools/result` event to listeners registered on `ctx`. The listener
 * is a plain context-level observer here; the real loop dispatches through a
 * scoped target, which is out of scope for this unit test.
 */
function emitResult(ctx: Context, exec: ToolExecution, result: ToolExecutionResult): void {
  ctx.emit('tools/result', exec, result)
}

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

describe('installObservations', () => {
  it('records tool failures on tools/result', async () => {
    const { ctx, store } = await harness()
    installObservations(ctx, store, {
      toolFailureThreshold: 3,
      requestErrorThreshold: 3,
      windowMs: 60_000,
    }, () => {})
    emitResult(ctx, execution('fetch'), failure('boom'))
    emitResult(ctx, execution('fetch'), failure('boom'))
    // observe() is async (durable write chain); wait for the records to land.
    await vi.waitFor(() => {
      expect(store.countObservations('tool-failure', 0, 'tool-failure:fetch')).toBe(2)
    })
  })

  it('fires onTrigger once the tool-failure threshold crosses', async () => {
    const { ctx, store } = await harness()
    const triggers: TriggerSignal[] = []
    installObservations(ctx, store, {
      toolFailureThreshold: 2,
      requestErrorThreshold: 5,
      windowMs: 60_000,
    }, (signal) => { triggers.push(signal) })

    emitResult(ctx, execution('fetch'), failure('boom'))
    expect(triggers).toHaveLength(0)
    emitResult(ctx, execution('fetch'), failure('boom'))
    await vi.waitFor(() => expect(triggers).toHaveLength(1))
    expect(triggers[0]?.kind).toBe('tool-failure')
    expect(triggers[0]?.key).toBe('tool-failure:fetch')
  })

  it('detects repeated identical calls as tool-repeat', async () => {
    const { ctx, store } = await harness()
    const triggers: TriggerSignal[] = []
    installObservations(ctx, store, {
      toolFailureThreshold: 10,
      repeatThreshold: 3,
      requestErrorThreshold: 10,
      windowMs: 60_000,
    }, (signal) => { triggers.push(signal) })

    const exec = execution('read', {
      agent: testAgent,
      arguments: Object.freeze({ path: '/a' }),
    })
    emitResult(ctx, exec, success())
    emitResult(ctx, exec, success())
    emitResult(ctx, exec, success())
    await vi.waitFor(() => expect(triggers).toHaveLength(1))
    expect(triggers[0]?.kind).toBe('tool-repeat')
    expect(triggers[0]?.key).toBe('tool-repeat:read')
  })

  it('does not fire for success below the repeat threshold', async () => {
    const { ctx, store } = await harness()
    const triggers: TriggerSignal[] = []
    installObservations(ctx, store, {
      toolFailureThreshold: 10,
      repeatThreshold: 5,
      requestErrorThreshold: 10,
      windowMs: 60_000,
    }, (signal) => { triggers.push(signal) })

    emitResult(ctx, execution('read'), success())
    emitResult(ctx, execution('read'), success())
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(triggers).toHaveLength(0)
  })
})

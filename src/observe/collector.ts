/**
 * Observation collection layer for dsh-self-evolve.
 *
 * Listens on the harness's runtime extension points and records signals into
 * the durable observations table:
 *
 * - `tools/result` (serial observation event): tool failures and repeated
 *   identical calls (no-progress loops).
 * - `agent/request-error` (waterfall): LLM request failures.
 *
 * After each record, a threshold check runs; when the configured threshold is
 * crossed inside the rolling window, the collector fires `onTrigger` with the
 * crossed signal so the proposal cycle can start. The collector is a pure
 * observer — it never vetoes or rewrites calls.
 * @module dsh-self-evolve/src/observe/collector
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { SelfEvolveStore } from '../storage/store.ts'
import type { ObservationKind } from '../storage/spec.ts'
import { thresholdFor } from './threshold.ts'
import type { ThresholdConfig } from './threshold.ts'

/** One crossed threshold, handed to the proposal cycle. */
export interface TriggerSignal {
  /** The observation kind that crossed. */
  readonly kind: ObservationKind
  /** The deduplication key that crossed (e.g. `tool-failure:fetch`). */
  readonly key: string
  /** Aggregated count inside the window. */
  readonly count: number
  /** Latest detail string (tool name, failure message, provider). */
  readonly detail: string
}

/** Per-kind observation thresholds and the aggregation window. */
export interface ObservationConfig extends ThresholdConfig {
  /** Rolling window (ms) over which counts aggregate. Default 5 minutes. */
  readonly windowMs: number
}

/** Canonicalized identity of one repeated call, per agent. */
interface RepeatChain {
  key: string
  count: number
}

/** Deep key-sort of a parsed-JSON value so argument order does not break canonicalization. */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) sorted[key] = sortJsonValue(record[key])
    return sorted
  }
  return value
}

/** Canonical string form of one call's arguments. */
function canonicalize(argumentsValue: unknown): string {
  return JSON.stringify(sortJsonValue(argumentsValue))
}

/** Human-readable detail for a failed tool call. */
function toolFailureDetail(exec: ToolExecution, result: ToolExecutionResult): string {
  if (result.isError) return `${exec.name}: ${result.error.message}`
  return exec.name
}

/**
 * Install the observation listeners. `onTrigger` is invoked (asynchronously,
 * not awaited) whenever a threshold crosses; the caller decides what a cycle
 * does (propose, or just record). Returns nothing — listeners are scoped to
 * `ctx` and disposed with it.
 */
export function installObservations(
  ctx: Context,
  store: SelfEvolveStore,
  config: ObservationConfig,
  onTrigger: (signal: TriggerSignal) => void,
): void {
  const repeatThreshold = config.repeatThreshold ?? 0
  const chains = new Map<string, RepeatChain>()

  // --- tools/result: serial observation event (no `next`) -----------------
  ctx.on('tools/result', (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
    const agentId = exec.agent?.id
    const sessionId = agentId ?? null

    // Repeat detection: same agent + same canonical arguments (success or
    // failure both count — a loop is a loop). Keyed per agent id so parallel
    // agents never share chains.
    if (agentId !== undefined) {
      const canonical = canonicalize(exec.arguments)
      const chainKey = `${exec.name}:${canonical}`
      const chain = chains.get(agentId)
      const count = chain !== undefined && chain.key === chainKey ? chain.count + 1 : 1
      chains.set(agentId, { key: chainKey, count })
      if (repeatThreshold > 0 && count >= repeatThreshold) {
        const key = `tool-repeat:${exec.name}`
        // Fire directly on the chain count: the observation record's own count
        // reflects durable bursts, which may differ from the in-memory chain.
        onTrigger({ kind: 'tool-repeat', key, count, detail: `${exec.name} × ${count}` })
        void store.observe('tool-repeat', key, `${exec.name} × ${count}`, sessionId, Date.now(), config.windowMs)
      }
    }

    // Tool failures.
    if (result.isError) {
      const key = `tool-failure:${exec.name}`
      void store
        .observe('tool-failure', key, toolFailureDetail(exec, result), sessionId, Date.now(), config.windowMs)
        .then(({ record }) => {
          const threshold = thresholdFor('tool-failure', config)
          if (threshold !== undefined && record.count >= threshold) {
            onTrigger({
              kind: 'tool-failure',
              key,
              count: record.count,
              detail: record.detail,
            })
          }
        })
    }
  })

  // --- agent/request-error: waterfall — must delegate via next() -------------
  ctx.on('agent/request-error', async (
    payload: { agent: Agent; failure: { message: string; code: string } },
    next: () => Promise<{ kind: 'retry' } | undefined>,
  ) => {
    const key = `request-error:${payload.agent.options.provider}:${payload.failure.code}`
    void store
      .observe(
        'request-error',
        key,
        `${payload.failure.code}: ${payload.failure.message}`,
        payload.agent.id,
        Date.now(),
        config.windowMs,
      )
      .then(({ record }) => {
        const threshold = thresholdFor('request-error', config)
        if (threshold !== undefined && record.count >= threshold) {
          onTrigger({
            kind: 'request-error',
            key,
            count: record.count,
            detail: record.detail,
          })
        }
      })
    return next()
  })
}

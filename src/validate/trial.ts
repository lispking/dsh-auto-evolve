/**
 * Sandboxed trial runner for dsh-self-evolve.
 *
 * A trial replays a failing episode inside an isolated, scoped sub-agent:
 * the agent is created through the harness registry (`ctx.agents.create`)
 * with a `setup` that composes its world — candidate skill mutations are
 * registered on its scoped context via `ctx.skills.register` (rank 250,
 * visible only inside the trial), tool access can be narrowed, and result
 * listeners collect the metrics. The agent is driven with `followup`, waited
 * to idle (or the wall-clock cap), then disposed. Nothing from the trial
 * leaks into the host session: scoped registrations unwind with disposal.
 * @module dsh-self-evolve/src/validate/trial
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { GenomeAsset } from '../storage/spec.ts'
import { compareMetrics } from './metrics.ts'
import type { MetricComparison, TrialMetrics, TrialOutcome } from './metrics.ts'

/** Bounds that keep one trial cheap and deterministic. */
export interface TrialBounds {
  /** Wall-clock cap for one run in milliseconds. */
  readonly maxTrialMs: number
  /** Tool-call cap: the run stops counting after this many calls. */
  readonly maxToolCalls: number
  /** Restrict trial tools to this allowlist (tool names). Empty = no restriction. */
  readonly toolAllow?: readonly string[]
  /** Model-step cap: the run aborts once this many model requests have been made. */
  readonly maxTrialSteps?: number
  /** Per-request output-token cap forwarded to the trial agent's model. */
  readonly maxTrialTokens?: number
}

/** One sandboxed trial run request. */
export interface TrialRequest {
  /** Provider route for the trial agent's model. */
  readonly provider: string
  /** Model id for the trial agent. */
  readonly model: string
  /** The replayed episode: the failing scenario phrased as a user prompt. */
  readonly episode: string
  /** Candidate assets applied inside the trial (skill bodies are registered). */
  readonly mutations: readonly GenomeAsset[]
  /** Bounds for this run. */
  readonly bounds: TrialBounds
  /** Cancellation signal. */
  readonly signal?: AbortSignal
}

/** The verdict of one validation: baseline (no mutations) vs trial (with mutations). */
export interface ValidationRun {
  /** Fresh run id recorded in the apply ledger as the trial evidence. */
  readonly id: string
  readonly baseline: TrialMetrics
  readonly trial: TrialMetrics
  readonly comparison: MetricComparison
}

/** Collect observed tool activity inside a scoped agent world. */
interface TrialCounter {
  toolCalls: number
  toolFailures: number
}

function initialCounter(): TrialCounter {
  return { toolCalls: 0, toolFailures: 0 }
}

/**
 * Run one sandboxed trial. The candidate skill mutations are registered on
 * the trial agent's scoped context; other asset kinds are skipped (they are
 * not exercisable inside a skill-level replay — recorded in the returned
 * metrics only via the tool counters).
 * @param ctx - host context carrying `agents` (the loop must be loaded).
 * @param request - trial request.
 * @returns the observed metrics; the run is `timed-out`/`error` when the cap
 *   or an agent failure cut it short.
 */
export async function runTrial(ctx: Context, request: TrialRequest): Promise<TrialMetrics> {
  const started = Date.now()
  const counter = initialCounter()
  const outcome = await executeTrial(ctx, request, counter)
  return {
    toolCalls: counter.toolCalls,
    toolFailures: counter.toolFailures,
    completed: outcome === 'completed',
    durationMs: Date.now() - started,
    outcome,
  }
}

/** Execute one trial lifecycle: create, compose, drive, wait, dispose. */
async function executeTrial(
  ctx: Context,
  request: TrialRequest,
  counter: TrialCounter,
): Promise<TrialOutcome> {
  const sessionId = SessionId(randomUUID())
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), request.bounds.maxTrialMs)
  const external = request.signal
  if (external !== undefined) {
    external.addEventListener('abort', () => controller.abort(), { once: true })
  }

  let handle: { agent: Agent; dispose(): Promise<void> } | undefined
  try {
    handle = await ctx.agents.create({
      sessionId,
      agentOptions: {
        provider: request.provider,
        model: request.model,
        ...(request.bounds.maxTrialTokens !== undefined
          ? { maxTokens: request.bounds.maxTrialTokens }
          : {}),
      },
      signal: controller.signal,
      setup: (agentCtx) => {
        // Compose the trial world: candidate skills, tool narrowing, counters.
        for (const mutation of request.mutations) {
          if (mutation.kind !== 'skill') continue // only skills are exercisable here
          const registration: SkillRegistration = {
            name: mutation.name,
            description: mutation.description,
            content: mutation.content,
            source: 'runtime',
            invocation: { modelInvocable: true, userInvocable: false },
          }
          agentCtx.skills.register(registration)
        }
        if (request.bounds.toolAllow !== undefined && request.bounds.toolAllow.length > 0) {
          agentCtx.tools.restrict({ allow: [...request.bounds.toolAllow] })
        }
        // Model-step cap: abort once the loop proposes a step past the bound.
        if (request.bounds.maxTrialSteps !== undefined) {
          agentCtx.on('agent/request', (payload, next) => {
            if (payload.step >= request.bounds.maxTrialSteps!) controller.abort()
            return next()
          })
        }
        agentCtx.on('tools/result', (_exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
          if (counter.toolCalls >= request.bounds.maxToolCalls) return
          counter.toolCalls++
          if (result.isError) counter.toolFailures++
        })
      },
    })
  } catch (error: unknown) {
    if (controller.signal.aborted) return 'timed-out'
    ctx.logger.warn(`[self-evolve] trial agent creation failed: ${String(error)}`)
    return 'error'
  }

  try {
    const agent = handle.agent
    let idleSettled = false
    const idle = new Promise<void>((resolve) => {
      agent.ctx.on('agent/status', (payload: { agent: Agent; status: 'idle' | 'running' }) => {
        if (payload.status === 'idle' && !idleSettled) {
          idleSettled = true
          resolve()
        }
      })
    })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: request.episode }],
      source: { kind: 'user' },
    }))

    await Promise.race([idle, new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new Error('trial aborted'))
      }, { once: true })
    })])
    return 'completed'
  } catch (error: unknown) {
    if (controller.signal.aborted) return 'timed-out'
    ctx.logger.warn(`[self-evolve] trial run failed: ${String(error)}`)
    return 'error'
  } finally {
    clearTimeout(timeout)
    if (external !== undefined) {
      external.removeEventListener('abort', controller.abort)
    }
    try {
      await handle.dispose()
    } catch (error: unknown) {
      ctx.logger.warn(`[self-evolve] trial disposal failed: ${String(error)}`)
    }
  }
}

/**
 * Run a full validation: a baseline run (no mutations) then a trial run (with
 * mutations) over the same episode, and compare. Fresh session ids isolate the
 * two runs from each other and from the host.
 * @param ctx - host context.
 * @param request - shared trial parameters (mutations omitted from baseline).
 * @returns the comparison verdict plus both metric sets.
 */
export async function validateMutations(
  ctx: Context,
  request: TrialRequest,
): Promise<ValidationRun> {
  const baseline = await runTrial(ctx, { ...request, mutations: [] })
  const trial = await runTrial(ctx, request)
  return {
    id: randomUUID(),
    baseline,
    trial,
    comparison: compareMetrics(baseline, trial),
  }
}

/**
 * Sandboxed trial runner for dsh-auto-evolve.
 *
 * A trial replays a failing episode inside an isolated, scoped sub-agent:
 * the agent is created through the harness registry (`ctx.agents.create`)
 * with a `setup` that composes its world — candidate skill mutations are
 * registered on its scoped context via `ctx.skills.register` (rank 250,
 * visible only inside the trial), tool access can be narrowed, and result
 * listeners collect the metrics. The agent is driven with `followup`, waited
 * to idle (or the wall-clock cap), then disposed. Nothing from the trial
 * leaks into the host session: scoped registrations unwind with disposal.
 * @module dsh-auto-evolve/src/validate/trial
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { GenomeAsset } from '../storage/spec.ts'
import { aggregateMetricDeltas, compareMetrics, metricDelta } from './metrics.ts'
import type { MetricComparison, MetricDelta, TrialMetrics, TrialOutcome } from './metrics.ts'
import type { MockStreamFactory } from './mock-llm.ts'

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
  /**
   * Optional mock stream factory. When provided, the trial agent uses this
   * deterministic stream instead of a live LLM, giving reproducible trial
   * runs for unit tests and CI.
   */
  readonly mockStream?: MockStreamFactory
}

/** One episode's paired A/B result (baseline vs trial over the same episode). */
export interface PairedEpisodeResult {
  /** The replayed episode prompt. */
  readonly episode: string
  /** Baseline run metrics (no mutations applied). */
  readonly baseline: TrialMetrics
  /** Trial run metrics (candidate mutations applied). */
  readonly trial: TrialMetrics
  /** Single-episode verdict. */
  readonly comparison: MetricComparison
  /** Paired delta for multi-episode aggregation. */
  readonly delta: MetricDelta
}

/**
 * The verdict of one validation. Multi-episode A/B runs replay every episode
 * twice (baseline then trial with mutations), aggregate the paired deltas,
 * and return both the per-episode breakdown and the overall verdict.
 */
export interface ValidationRun {
  /** Fresh run id recorded in the apply ledger as the trial evidence. */
  readonly id: string
  /** Per-episode paired results (one per replayed episode). */
  readonly episodes: readonly PairedEpisodeResult[]
  /** Legacy single-pair metrics (episode [0]), retained for backward compat. */
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
        // Inject a deterministic mock LLM stream when requested, so trial
        // runs are reproducible without a live provider.
        if (request.mockStream !== undefined) {
          const factory = request.mockStream
          const originalStream = agentCtx.llm?.stream?.bind(agentCtx.llm) ?? null
          // Monkey-patch the trial agent's llm.stream with the mock factory.
          // We intercept only the call shape; the mock returns a compliant
          // AsyncIterable<StreamChunk>.
          const llmRef = agentCtx.llm as unknown as {
            stream?: (options: unknown) => AsyncIterable<unknown>
          } | undefined
          if (llmRef !== undefined && llmRef.stream !== undefined) {
            llmRef.stream = ((options: unknown) => {
              const req = options as {
                provider?: string
                model?: string
                maxTokens?: number
                system?: string
                messages?: readonly unknown[]
                signal?: AbortSignal
              }
              return factory({
                provider: req.provider ?? request.provider,
                model: req.model ?? request.model,
                ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
                ...(req.system !== undefined ? { system: req.system } : {}),
                messages: req.messages ?? [],
                ...(req.signal !== undefined ? { signal: req.signal } : {}),
              }) as unknown as AsyncIterable<unknown>
            }) as (options: unknown) => AsyncIterable<unknown>
          }
          // Suppress unused-variable warning for originalStream (kept for
          // future restore-on-dispose logic).
          void originalStream
        }
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
 * Run a full validation: for each replayed episode, run a baseline (no
 * mutations) then a trial (with mutations), compute the per-episode
 * paired delta, and aggregate all deltas into one verdict. Fresh session
 * ids isolate every run from each other and from the host.
 *
 * The single-episode `request.episode` is still honored as the default
 * episode list; pass `episodes` to override and replay multiple scenarios
 * in one validation pass. The per-episode deltas are aggregated by
 * {@link aggregateMetricDeltas}, which looks at the *direction* of every
 * delta rather than counting raw win/loss votes — so a mutation that
 * shaves 2 failures off every episode wins even if no single episode
 * flipped a boolean.
 *
 * @param ctx - host context.
 * @param request - shared trial parameters (mutations omitted from baseline).
 * @param episodes - override the single `request.episode` with a list of
 *   episode prompts; defaults to `[request.episode]` for backward compat.
 * @returns the per-episode paired results plus the aggregate verdict.
 */
export async function validateMutations(
  ctx: Context,
  request: TrialRequest,
  episodes: readonly string[] = [request.episode],
): Promise<ValidationRun> {
  const paired: PairedEpisodeResult[] = []
  for (const episode of episodes) {
    const episodeRequest: TrialRequest = { ...request, episode }
    const baseline = await runTrial(ctx, { ...episodeRequest, mutations: [] })
    const trial = await runTrial(ctx, episodeRequest)
    paired.push({
      episode,
      baseline,
      trial,
      comparison: compareMetrics(baseline, trial),
      delta: metricDelta(baseline, trial),
    })
  }

  // Legacy single-pair fields point at the first episode for backward compat.
  const first = paired[0]!
  return {
    id: randomUUID(),
    episodes: paired,
    baseline: first.baseline,
    trial: first.trial,
    comparison: first.comparison,
  }
}

/**
 * Aggregate the per-episode deltas of a {@link ValidationRun} into one A/B
 * verdict. Convenience wrapper around {@link aggregateMetricDeltas}.
 */
export function summarizeValidationRun(run: ValidationRun): {
  readonly improved: boolean
  readonly regressed: boolean
  readonly reason: string
} {
  return aggregateMetricDeltas(run.episodes.map((p) => p.delta))
}

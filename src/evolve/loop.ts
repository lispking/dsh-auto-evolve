/**
 * Auto-apply orchestration for dsh-auto-evolve.
 *
 * `runAutoApplyCycle` closes the evolution loop for `auto-apply` mode:
 *
 *   1. **Propose** — materialize candidate assets via `runProposalCycle`
 *      (snapshotting the pre-cycle candidate ids so only *fresh* mutations
 *      from this cycle are validated).
 *   2. **Validate** — replay the failing episode in a sandboxed trial for
 *      each fresh candidate (only `skill` assets are exercisable in a
 *      skill-level replay; other kinds are recorded but not auto-applied).
 *   3. **Apply** — promote a candidate only when the trial strictly improved
 *      over the baseline (`comparison.improved`); regressed or neutral
 *      candidates stay in the genome for manual review.
 *
 * Regression rollback is a separate concern handled by the caller: keep a
 * per-apply watch (`appliedAt` + the triggering observation key) and roll
 * back an applied asset when the same key crosses its threshold again.
 * @module dsh-auto-evolve/src/evolve/loop
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SelfEvolveStore } from '../storage/store.ts'
import type { SelfEvolveApplier } from '../apply/applier.ts'
import type { GenomeAsset } from '../storage/spec.ts'
import { CostLedger } from '../propose/budget.ts'
import type { BudgetConfig } from '../propose/budget.ts'
import { runProposalCycle, listCandidates } from '../propose/cycle.ts'
import { validateMutations } from '../validate/trial.ts'
import type { TrialBounds } from '../validate/trial.ts'

/** Options shared by the propose and validation stages of one auto-apply run. */
export interface AutoApplyOptions {
  /** Provider route for both the proposal call and the trial agent. */
  readonly provider: string
  /** Model id for both the proposal call and the trial agent. */
  readonly model: string
  /** Max output tokens for the proposal call. */
  readonly maxTokens: number
  /** Max prompt characters for the proposal call. */
  readonly maxPromptChars: number
  /** Max mutations per proposal. */
  readonly maxMutations: number
  /** Max observations rendered into the proposal prompt. */
  readonly maxObservations: number
  /** Trial-run bounds (wall clock, tool calls, steps, tokens). */
  readonly bounds: TrialBounds
  /** Abort the whole cycle when triggered. */
  readonly signal?: AbortSignal
  /** Cost/budget gate forwarded to the proposal cycle. */
  readonly budget?: BudgetConfig | undefined
  /** Shared cost ledger (one per plugin instance). */
  readonly costLedger?: CostLedger | undefined
}

/** The outcome of one auto-apply run. */
export interface AutoApplyResult {
  /** How many mutations this cycle materialized as candidates. */
  readonly proposed: number
  /** Candidate ids that were validated, improved, and applied. */
  readonly applied: readonly string[]
  /** Candidate ids that were validated but not applied (regressed or neutral). */
  readonly rejected: readonly string[]
  /** Candidate ids skipped by the trial (non-exercisable kinds). */
  readonly skipped: readonly string[]
}

/** Render a replay episode from the most recent durable observations. */
function buildEpisode(store: SelfEvolveStore, limit = 5): string {
  const records = store.listObservations(limit)
  const lines = records.map(r => `- [${r.kind}] ${r.key} ×${r.count}: ${r.detail}`)
  return [
    'Replay of the failing scenario that produced these recent signals:',
    ...(lines.length > 0 ? lines : ['(no recent observations recorded)']),
    'Complete the task successfully, avoiding the failures above.',
  ].join('\n')
}

/**
 * Run one full auto-apply pass: propose, then validate and apply each fresh
 * candidate. `provider`/`model` are required because the trial agent and the
 * proposal call share the same route; resolve them once with
 * `resolveProposalTarget` before calling.
 * @param ctx - context carrying `llm`, `agents`, and `skills` (auto-apply mode).
 * @param store - the durable self-evolve store.
 * @param applier - the live applier service.
 * @param options - shared propose/validate bounds.
 * @returns the run outcome (proposed/applied/rejected/skipped ids).
 */
export async function runAutoApplyCycle(
  ctx: Context,
  store: SelfEvolveStore,
  applier: SelfEvolveApplier,
  options: AutoApplyOptions,
): Promise<AutoApplyResult> {
  const before = new Set(listCandidates(store).map(asset => asset.id))
  const proposed = await runProposalCycle(ctx, store, {
    provider: options.provider,
    model: options.model,
    maxTokens: options.maxTokens,
    maxPromptChars: options.maxPromptChars,
    maxMutations: options.maxMutations,
    maxObservations: options.maxObservations,
    budget: options.budget,
    costLedger: options.costLedger,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })
  if (proposed === 0) return { proposed, applied: [], rejected: [], skipped: [] }

  const fresh = listCandidates(store).filter(asset => !before.has(asset.id))
  const applied: string[] = []
  const rejected: string[] = []
  const skipped: string[] = []
  for (const candidate of fresh) {
    if (candidate.kind !== 'skill') {
      // Only skills are exercisable inside a skill-level replay; other kinds
      // stay candidates for manual validation/application.
      skipped.push(candidate.id)
      continue
    }
    const run = await validateMutations(ctx, {
      provider: options.provider,
      model: options.model,
      episode: buildEpisode(store),
      mutations: [candidate],
      bounds: options.bounds,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
    if (run.comparison.improved) {
      const result = await applier.applyCandidate(candidate.id, run.id, run.comparison.reason)
      if (result !== undefined) applied.push(candidate.id)
      else rejected.push(candidate.id)
    } else {
      rejected.push(candidate.id)
    }
  }
  return { proposed, applied, rejected, skipped }
}

/** In-memory regression watch: applied asset id → its triggering key + time. */
export type RegressionWatch = Map<string, { key: string; at: number }>

/** Outcome category of one auto-apply cycle, for convergence tracking. */
export type CycleOutcome = 'applied' | 'rejected' | 'skipped' | 'empty' | 'rolled-back'

/**
 * Classify a raw {@link AutoApplyResult} plus rollback count into a
 * {@link CycleOutcome}. The convergence tracker only cares whether the
 * cycle produced a *net positive* (something applied and nothing rolled
 * back) or stalled (empty / everything rejected / regressions).
 */
export function classifyCycle(
  result: AutoApplyResult,
  rolledBackCount: number,
): CycleOutcome {
  if (rolledBackCount > 0) return 'rolled-back'
  if (result.applied.length > 0) return 'applied'
  if (result.rejected.length > 0) return 'rejected'
  if (result.skipped.length > 0) return 'skipped'
  return 'empty'
}

/** Configuration for the convergence tracker. */
export interface ConvergenceConfig {
  /**
   * How many consecutive non-productive cycles (rejected / skipped /
   * empty / rolled-back) before the loop auto-pauses. Default 3.
   */
  readonly stallThreshold?: number
  /**
   * How long (ms) the loop stays paused once the stall threshold is
   * reached. When the pause expires the stall counter resets and auto-apply
   * resumes. Default 30 minutes.
   */
  readonly stallPauseMs?: number
}

/** The verdict the convergence tracker returns after each cycle. */
export interface ConvergenceVerdict {
  /** Whether the loop should pause auto-apply right now (threshold just crossed). */
  readonly shouldPause: boolean
  /** Current consecutive-stall count. */
  readonly stallCount: number
  /** Timestamp (ms) until which the pause lasts, when a pause is active. */
  readonly pausedUntil?: number
  /** Human-readable reason. */
  readonly reason: string
}

/**
 * In-memory convergence tracker. One instance per plugin lifecycle.
 *
 * The tracker counts consecutive "stalled" cycles — cycles where nothing
 * was applied, or where applied assets were immediately rolled back as
 * regressions. When the count reaches
 * {@link ConvergenceConfig.stallThreshold}, the loop pauses auto-apply for
 * {@link ConvergenceConfig.stallPauseMs}, preventing an unbounded
 * "propose → fail → propose" loop that burns tokens without making progress.
 *
 * A single productive cycle (`applied` with no rollbacks) resets the stall
 * counter; so does the expiry of an active pause, so auto-apply resumes on a
 * clean slate.
 */
export class ConvergenceTracker {
  private stallCount = 0
  private readonly stallThreshold: number
  private readonly stallPauseMs: number
  private pauseUntil: number | undefined

  constructor(config: ConvergenceConfig = {}) {
    this.stallThreshold = config.stallThreshold ?? 3
    this.stallPauseMs = config.stallPauseMs ?? 30 * 60_000
  }

  /** Current consecutive-stall count (diagnostics/dashboard). */
  get currentStallCount(): number {
    return this.stallCount
  }

  /** Timestamp (ms) until which the loop is paused, or `undefined`. */
  get pausedUntil(): number | undefined {
    return this.pauseUntil
  }

  /**
   * Whether a pause is active right now. Once the pause expires the stall
   * counter is reset, so the next cycle starts from a clean slate.
   */
  isPaused(now = Date.now()): boolean {
    if (this.pauseUntil === undefined) return false
    if (now >= this.pauseUntil) {
      this.stallCount = 0
      this.pauseUntil = undefined
      return false
    }
    return true
  }

  /**
   * Record one cycle's outcome and return the new verdict.
   *
   * - `applied` (with no rollbacks) resets the stall counter and any pause.
   * - Any other outcome increments the counter.
   * - When the counter reaches the threshold, {@link shouldPause} flips to
   *   `true` and {@link pausedUntil} is set; the loop pauses until then.
   */
  record(outcome: CycleOutcome, now = Date.now()): ConvergenceVerdict {
    if (outcome === 'applied') {
      this.stallCount = 0
      this.pauseUntil = undefined
      return {
        shouldPause: false,
        stallCount: 0,
        reason: 'productive cycle (something applied, nothing rolled back)',
      }
    }
    this.stallCount++
    if (this.stallCount >= this.stallThreshold) {
      this.pauseUntil = now + this.stallPauseMs
      return {
        shouldPause: true,
        stallCount: this.stallCount,
        pausedUntil: this.pauseUntil,
        reason: `${this.stallCount} consecutive stalled cycles — pausing auto-apply for ${this.stallPauseMs}ms`,
      }
    }
    return {
      shouldPause: false,
      stallCount: this.stallCount,
      reason: `stalled cycle (${outcome}), stall count ${this.stallCount}/${this.stallThreshold}`,
    }
  }

  /** Reset the tracker (mainly for tests, or after a manual mode change). */
  reset(): void {
    this.stallCount = 0
    this.pauseUntil = undefined
  }
}

/**
 * Per-key cooldown gate for the evolution loop.
 *
 * After a trigger cycle for an observation key ends without a net positive
 * (nothing applied, or a regression rollback), the key is "cooled" for
 * `cooldownMs`: further triggers for the same key are skipped so the loop
 * cannot thrash (propose → fail → propose) and burn tokens on a signal that
 * just failed. A productive cycle never cools its key; a regression rollback
 * always does.
 */
export class CooldownGate {
  private readonly cooldowns = new Map<string, number>()
  private readonly cooldownMs: number

  constructor(cooldownMs: number) {
    this.cooldownMs = cooldownMs
  }

  /** Whether the key is inside its cooldown window right now. */
  isCooled(key: string, now = Date.now()): boolean {
    const until = this.cooldowns.get(key)
    if (until === undefined) return false
    if (now >= until) {
      this.cooldowns.delete(key)
      return false
    }
    return true
  }

  /** Cool the key for `ms` (defaults to the gate's cooldown). */
  mark(key: string, now = Date.now(), ms = this.cooldownMs): void {
    this.cooldowns.set(key, now + ms)
  }

  /** Remove any cooldown on the key (e.g. after manual review). */
  clear(key: string): void {
    this.cooldowns.delete(key)
  }
}

/**
 * Record a watch for every freshly applied asset from an auto-apply run.
 * @param watch - the caller-owned watch map (per plugin instance).
 * @param result - the run outcome.
 * @param signalKey - the observation key that triggered this cycle.
 * @param now - wall-clock time of the apply (injectable for tests).
 */
export function trackApplied(
  watch: RegressionWatch,
  result: AutoApplyResult,
  signalKey: string,
  now = Date.now(),
): void {
  for (const assetId of result.applied) {
    watch.set(assetId, { key: signalKey, at: now })
  }
}

/**
 * Scan the watch map for a regression: an asset applied for `signalKey`
 * within the window whose key recurs now. Roll it back and drop the watch.
 * @returns the ids rolled back.
 */
export async function rollBackRegressions(
  applier: SelfEvolveApplier,
  watch: RegressionWatch,
  signalKey: string,
  windowMs: number,
  now = Date.now(),
): Promise<string[]> {
  const rolledBack: string[] = []
  for (const [assetId, entry] of [...watch]) {
    if (entry.key !== signalKey) continue
    if (now - entry.at > windowMs) {
      watch.delete(assetId)
      continue
    }
    const result = await applier.rollback(assetId, `regression: ${signalKey} recurred after apply`)
    watch.delete(assetId)
    if (result.reverted) rolledBack.push(assetId)
  }
  return rolledBack
}

/** Convenience re-export for consumers that only need the candidate type. */
export type { GenomeAsset }

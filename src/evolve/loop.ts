/**
 * Auto-apply orchestration for dsh-self-evolve.
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
 * @module dsh-self-evolve/src/evolve/loop
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SelfEvolveStore } from '../storage/store.ts'
import type { SelfEvolveApplier } from '../apply/applier.ts'
import type { GenomeAsset } from '../storage/spec.ts'
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

/**
 * Proposal cycle orchestration for dsh-auto-evolve.
 *
 * One proposal cycle: guarded by the durable `cycleActive` flag (no
 * re-entrancy), it snapshots the current genome and recent observations,
 * calls the proposal engine, and materializes validated mutations as
 * `candidate` assets in the genome table (proposalId recorded). The
 * validation layer (task 6) turns candidates into trial runs; the
 * application layer (task 7) promotes winners to `applied`.
 * @module dsh-auto-evolve/src/propose/cycle
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SelfEvolveStore } from '../storage/store.ts'
import type { EvolvableKind, GenomeAsset } from '../storage/spec.ts'
import { CostLedger } from './budget.ts'
import type { BudgetConfig } from './budget.ts'
import { estimateProposalTokens } from './budget.ts'
import { generateProposal, resolveProposalTarget } from './engine.ts'
import { dedupMutations } from './fingerprint.ts'
import { mutationAssetId } from './operators.ts'

/** Options for one proposal cycle. */
export interface CycleOptions {
  /** Provider route for the proposal call; falls back to the first registered. */
  readonly provider?: string
  /** Model id for the proposal call; falls back to the first model. */
  readonly model?: string
  /** Max output tokens for one proposal call. */
  readonly maxTokens: number
  /** Max prompt characters (bounds context and cost). */
  readonly maxPromptChars: number
  /** Max mutations per proposal. */
  readonly maxMutations: number
  /** Max observations rendered into the prompt. */
  readonly maxObservations: number
  /** Abort the whole cycle when triggered. */
  readonly signal?: AbortSignal
  /**
   * Cost/budget gate. When provided, the cycle estimates the token cost
   * before the LLM call and skips (logging a warning) when the estimate
   * exceeds the per-cycle or per-day cap.
   */
  readonly budget?: BudgetConfig | undefined
  /**
   * Shared cost ledger (one per plugin instance). When omitted a fresh
   * ledger is created for this cycle — useful for tests but not for
   * production where the daily tally must persist across cycles.
   */
  readonly costLedger?: CostLedger | undefined
}

/**
 * Run one proposal cycle. No-op when the durable `cycleActive` flag is set
 * (a cycle is already in flight) or when no LLM provider is registered.
 * Candidate assets are persisted; the returned count reports how many
 * mutations were materialized (0 when nothing was proposed or the store is
 * not ready).
 * @param ctx - context carrying the LLM service.
 * @param store - the durable self-evolve store.
 * @param options - cycle bounds.
 * @returns the number of materialized candidate mutations.
 */
export async function runProposalCycle(
  ctx: Context,
  store: SelfEvolveStore,
  options: CycleOptions,
): Promise<number> {
  const state = store.state()
  if (state.cycleActive) return 0

  // Hoisted so the finally block can reset the per-cycle tally. When the
  // caller shares a ledger across cycles the reset keeps maxCostPerCycle
  // bounding one cycle instead of the plugin's cumulative lifetime spend.
  const ledger = options.costLedger ?? new CostLedger()

  await store.setState({ ...state, cycleActive: true })
  try {
    const target = options.provider !== undefined && options.model !== undefined
      ? { provider: options.provider, model: options.model }
      : await resolveProposalTarget(ctx)
    if (target === undefined) {
      ctx.logger.warn('[self-evolve] proposal cycle skipped: no LLM provider registered')
      return 0
    }

    // Budget gate: estimate the proposal token cost and skip the call when
    // the per-cycle or per-day cap is exceeded.
    if (options.budget !== undefined) {
      const estimate = estimateProposalTokens(options.maxPromptChars, options.maxTokens)
      const verdict = ledger.check(estimate, options.budget)
      if (!verdict.allowed) {
        ctx.logger.warn(
          `[self-evolve] proposal cycle skipped: ${verdict.rejection} ` +
          `(cycle ${verdict.cycleSpent}/${options.budget.maxCostPerCycle ?? 0}, ` +
          `day ${verdict.dailySpent}/${options.budget.dailyBudget ?? 0})`,
        )
        return 0
      }
    }

    const genome = store.listAssets()
    const observations = store.listObservations(options.maxObservations)
    const proposal = await generateProposal(ctx, genome, observations, {
      provider: target.provider,
      model: target.model,
      maxTokens: options.maxTokens,
      maxPromptChars: options.maxPromptChars,
      maxMutations: options.maxMutations,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })

    // Record the actual token usage after the call. The harness reports
    // usage via the stream; for simplicity we record the pre-call estimate
    // when actual usage is unavailable, which still bounds daily spend.
    ledger.record(estimateProposalTokens(options.maxPromptChars, options.maxTokens))
    if (proposal === null) {
      ctx.logger.warn('[self-evolve] proposal cycle produced no valid proposal')
      return 0
    }

    // Dedup against existing candidates: drop mutations whose fingerprint
    // already matches a pending candidate, so we never re-trial the same
    // patch while the previous one is still awaiting validation.
    const { kept, dropped } = dedupMutations(proposal, genome)
    if (dropped.length > 0) {
      ctx.logger.info(
        `[self-evolve] proposal ${proposal.id} dropped ${dropped.length} duplicate mutation(s)`,
      )
    }

    let materialized = 0
    for (const mutation of kept) {
      const id = mutationAssetId(mutation)
      const existing = store.getAsset(id)
      const version = existing === undefined ? 0 : existing.version + 1
      const asset: GenomeAsset = {
        id,
        kind: mutation.kind as EvolvableKind,
        name: mutation.name,
        description: mutation.description,
        content: mutation.content,
        version,
        parentVersion: existing === undefined ? -1 : existing.version,
        status: 'candidate',
        appliedAt: null,
        proposalId: proposal.id,
      }
      await store.putAsset(asset)
      materialized++
    }

    ctx.logger.info(
      `[self-evolve] proposal ${proposal.id} materialized ${materialized} candidate mutation(s): ${proposal.rationale}`,
    )
    return materialized
  } finally {
    const latest = store.state()
    await store.setState({ ...latest, cycleActive: false })
    // Reset the per-cycle tally so maxCostPerCycle bounds one proposal
    // cycle rather than the plugin's cumulative lifetime spend.
    ledger.resetCycle()
  }
}

/** Read the current candidates (validated mutations awaiting a trial run). */
export function listCandidates(store: SelfEvolveStore): GenomeAsset[] {
  return store.listAssets().filter(asset => asset.status === 'candidate')
}

/** Read the current applied assets (the live genome). */
export function listApplied(store: SelfEvolveStore): GenomeAsset[] {
  return store.listAssets().filter(asset => asset.status === 'applied')
}

/** Convenience re-export for consumers that only need the mutation type. */
export type { Mutation } from './operators.ts'

/**
 * Proposal cycle orchestration for dsh-self-evolve.
 *
 * One proposal cycle: guarded by the durable `cycleActive` flag (no
 * re-entrancy), it snapshots the current genome and recent observations,
 * calls the proposal engine, and materializes validated mutations as
 * `candidate` assets in the genome table (proposalId recorded). The
 * validation layer (task 6) turns candidates into trial runs; the
 * application layer (task 7) promotes winners to `applied`.
 * @module dsh-self-evolve/src/propose/cycle
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SelfEvolveStore } from '../storage/store.ts'
import type { EvolvableKind, GenomeAsset } from '../storage/spec.ts'
import { generateProposal, resolveProposalTarget } from './engine.ts'
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

  await store.setState({ ...state, cycleActive: true })
  try {
    const target = options.provider !== undefined && options.model !== undefined
      ? { provider: options.provider, model: options.model }
      : await resolveProposalTarget(ctx)
    if (target === undefined) {
      ctx.logger.warn('[self-evolve] proposal cycle skipped: no LLM provider registered')
      return 0
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
    if (proposal === null) {
      ctx.logger.warn('[self-evolve] proposal cycle produced no valid proposal')
      return 0
    }

    let materialized = 0
    for (const mutation of proposal.mutations) {
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

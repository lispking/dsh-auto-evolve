/**
 * Proposal fingerprinting and deduplication for dsh-auto-evolve.
 *
 * The LLM proposal engine is called whenever a threshold crosses. Without
 * dedup the engine happily re-emits the same patch every cycle (the
 * observations that triggered it are still present), burning tokens on a
 * trial that was already rejected. This module computes a stable
 * fingerprint for one mutation and a whole proposal, and offers a
 * `dedupMutations` helper that drops mutations whose fingerprint already
 * matches a `candidate` asset in the genome.
 *
 * The fingerprint is intentionally a **content hash**, not a structural
 * one: two patches that differ only in trailing whitespace are treated as
 * duplicates. This is the right call for an evolution loop — the goal is
 * to avoid re-running the *same* trial, and whitespace-only differences
 * produce the same trial outcome.
 *
 * @module dsh-auto-evolve/src/propose/fingerprint
 */

import { createHash } from 'node:crypto'
import type { GenomeAsset } from '../storage/spec.ts'
import type { Mutation, Proposal } from './operators.ts'

/**
 * Compute a stable fingerprint for one mutation. The fingerprint is the
 * SHA-256 hash of a canonical string built from the operator, target id,
 * asset kind, name, and the **trimmed** content. Description is excluded
 * on purpose: two mutations with the same body but different one-line
 * descriptions are the *same* mutation from a trial-outcome perspective.
 *
 * @param mutation - the mutation to fingerprint.
 * @returns a 16-character hex digest (truncated SHA-256; collisions at
 *   this length are astronomically unlikely for a per-genome dedup set).
 */
export function mutationFingerprint(mutation: Mutation): string {
  const canonical = [
    `op=${mutation.operator}`,
    `kind=${mutation.kind}`,
    `target=${mutation.targetId}`,
    `name=${mutation.name}`,
    `content=${mutation.content.trim()}`,
  ].join('\n')
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

/**
 * Compute a fingerprint for a whole proposal: the sorted concatenation of
 * its mutation fingerprints. Two proposals with the same mutations in
 * different orders thus share a fingerprint.
 */
export function proposalFingerprint(proposal: Pick<Proposal, 'mutations'>): string {
  const parts = proposal.mutations.map(mutationFingerprint).sort()
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)
}

/**
 * Deduplicate a proposal's mutations against the current genome.
 *
 * A mutation is a **duplicate** when a `candidate` asset with the same
 * fingerprint already exists in the genome — meaning a recent cycle
 * already materialized this exact mutation and it is awaiting trial. We
 * also dedup *within* the batch: two mutations in the same proposal that
 * share a fingerprint collapse to one.
 *
 * @param proposal - the proposal whose mutations should be deduped.
 * @param genome - the current genome assets (only `candidate` status is
 *   checked — `applied` / `rolled-back` assets do not suppress a fresh
 *   proposal, since the situation may have changed).
 * @returns a tuple of `[kept, dropped]` mutation arrays.
 */
export function dedupMutations(
  proposal: Pick<Proposal, 'mutations'>,
  genome: readonly GenomeAsset[],
): { readonly kept: readonly Mutation[]; readonly dropped: readonly Mutation[] } {
  /** Fingerprints of every existing candidate asset's content. */
  const existing = new Set<string>()
  for (const asset of genome) {
    if (asset.status !== 'candidate') continue
    // Reconstruct a pseudo-mutation to reuse the fingerprint function.
    existing.add(
      mutationFingerprint({
        operator: asset.parentVersion < 0 ? 'add' : 'patch',
        kind: asset.kind,
        targetId: asset.id,
        name: asset.name,
        description: asset.description,
        content: asset.content,
      }),
    )
  }

  const kept: Mutation[] = []
  const dropped: Mutation[] = []
  const seen = new Set<string>()
  for (const mutation of proposal.mutations) {
    const fp = mutationFingerprint(mutation)
    if (existing.has(fp) || seen.has(fp)) {
      dropped.push(mutation)
      continue
    }
    seen.add(fp)
    kept.push(mutation)
  }
  return { kept, dropped }
}

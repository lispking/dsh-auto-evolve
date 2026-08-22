/**
 * Application layer for dsh-auto-evolve.
 *
 * Turns validated candidate assets into LIVE genome entries: skills are
 * registered on the plugin context via `ctx.skills.register` (immediately
 * visible to the model), the genome record is promoted from
 * `candidate` to `applied`, and the ledger records the mutation with the
 * previous content captured so rollback can restore it exactly.
 *
 * Every applied asset keeps its live disposer. Rollback unregisters the live
 * contribution, restores the parent content as a new candidate (ready for the
 * next cycle), and writes a `rollback` ledger entry. On plugin disposal all
 * live disposers run, so nothing leaks into a later session.
 * @module dsh-auto-evolve/src/apply/applier
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import type { SelfEvolveStore } from '../storage/store.ts'
import type { GenomeAsset } from '../storage/spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    selfEvolveApplier: SelfEvolveApplier
  }
}

/** Result of one apply operation. */
export interface ApplyResult {
  /** The promoted asset (status `applied`). */
  readonly asset: GenomeAsset
  /** Ledger entry id of the apply event. */
  readonly ledgerId: string
}

/** Result of one rollback operation. */
export interface RollbackResult {
  /** Whether a live asset was found and reverted. */
  readonly reverted: boolean
  /** The restored parent asset (status `candidate`), when one exists. */
  readonly restored?: GenomeAsset
  /** Ledger entry id of the rollback event. */
  readonly ledgerId?: string
}

/**
 * Applies and reverts genome mutations on the live plugin context. Mirrors
 * the Service pattern: consumers inject `selfEvolveApplier`; disposal runs
 * every live disposer. The skills service is required because applying a
 * skill candidate registers it live on the context.
 */
export class SelfEvolveApplier extends Service {
  static inject = ['selfEvolveStore', 'skills']

  /** Live skill disposers keyed by asset id; unregistered on rollback/dispose. */
  private readonly disposers = new Map<string, () => void>()

  constructor(ctx: Context) {
    super(ctx, 'selfEvolveApplier')
  }

  /** Ensure every live contribution is torn down with the plugin. */
  protected async [Service.init](): Promise<void> {
    this.ctx.effect(() => () => {
      for (const dispose of this.disposers.values()) dispose()
      this.disposers.clear()
    }, 'self-evolve.applierDispose')
  }

  private requireStore(): SelfEvolveStore {
    const store = this.ctx.selfEvolveStore
    if (store === undefined || !store.ready) {
      throw new Error('self-evolve: store is not initialized (mount dsh-auto-evolve after storage-domain)')
    }
    return store
  }

  /**
   * Apply one candidate asset: register its live contribution, promote the
   * genome record, and write the apply ledger entry.
   * @param assetId - candidate asset id (`<kind>:<name>`).
   * @param trialId - trial run id whose validation authorized this apply, if any.
   * @param reason - human-readable rationale (proposal summary).
   * @returns the promoted asset and ledger id, or `undefined` when the asset
   *   is missing or not a candidate.
   */
  async applyCandidate(
    assetId: string,
    trialId: string | null,
    reason: string,
  ): Promise<ApplyResult | undefined> {
    const store = this.requireStore()
    const asset = store.getAsset(assetId)
    if (asset === undefined || asset.status !== 'candidate') return undefined

    this.disposeLive(assetId) // a stale live registration must not outlive a re-apply
    if (asset.kind === 'skill') {
      const registration: SkillRegistration = {
        name: asset.name,
        description: asset.description,
        content: asset.content,
        source: 'runtime',
        invocation: { modelInvocable: true, userInvocable: false },
      }
      // Runtime-registered skills are immediately visible to the model; the
      // registry resolves duplicate names by provider rank.
      const disposer = this.ctx.skills.register(registration)
      this.disposers.set(assetId, disposer)
    }
    // Other kinds (post-processor / prompt-section / guard-policy) are
    // recorded in the genome but have no live contribution in this release;
    // the ledger still records the apply so the state machine stays honest.

    const promoted: GenomeAsset = {
      ...asset,
      status: 'applied',
      appliedAt: Date.now(),
    }
    await store.putAsset(promoted)
    const ledgerId = await store.appendLedger({
      assetId,
      kind: 'apply',
      fromVersion: asset.parentVersion < 0 ? 0 : asset.version - 1,
      toVersion: asset.version,
      at: Date.now(),
      proposalId: asset.proposalId,
      trialId,
      prevContent: asset.parentVersion < 0 ? null : asset.content,
      reason,
    })
    return { asset: promoted, ledgerId }
  }

  /**
   * Revert one applied asset: unregister its live contribution, restore the
   * parent content as a fresh candidate (next cycle may revalidate it), and
   * write the rollback ledger entry.
   * @param assetId - applied asset id.
   * @param reason - human-readable rollback cause.
   * @returns the rollback result; `reverted: false` when the asset is missing
   *   or not currently applied.
   */
  async rollback(assetId: string, reason: string): Promise<RollbackResult> {
    const store = this.requireStore()
    const asset = store.getAsset(assetId)
    if (asset === undefined || asset.status !== 'applied') {
      return { reverted: false }
    }

    this.disposeLive(assetId)

    let restored: GenomeAsset | undefined
    if (asset.parentVersion >= 0) {
      const parentAsset: GenomeAsset = {
        ...asset,
        version: asset.parentVersion,
        parentVersion: -1,
        status: 'candidate',
        appliedAt: null,
        proposalId: null,
      }
      await store.putAsset(parentAsset)
      restored = parentAsset
    } else {
      // No parent: the asset was first-generation; rollback removes it from
      // the genome entirely (its content is still in the ledger for audit).
      await store.deleteAsset(assetId)
    }

    const ledgerId = await store.appendLedger({
      assetId,
      kind: 'rollback',
      fromVersion: asset.version,
      toVersion: asset.parentVersion < 0 ? 0 : asset.parentVersion,
      at: Date.now(),
      proposalId: asset.proposalId,
      trialId: null,
      prevContent: asset.content,
      reason,
    })
    return {
      reverted: true,
      ...(restored !== undefined ? { restored } : {}),
      ledgerId,
    }
  }

  /** Unregister a live contribution without touching durable state. */
  private disposeLive(assetId: string): void {
    const dispose = this.disposers.get(assetId)
    if (dispose !== undefined) {
      dispose()
      this.disposers.delete(assetId)
    }
  }

  /** Whether an asset currently has a live contribution (diagnostics/tests). */
  isLive(assetId: string): boolean {
    return this.disposers.has(assetId)
  }
}

export default SelfEvolveApplier

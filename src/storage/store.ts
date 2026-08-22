/**
 * Storage-domain service for dsh-auto-evolve. Opens the `self_evolve` domain
 * and exposes typed handles for the genome, ledger, observations, and the
 * shared genome state. Mirrors the WorkspaceRegistry pattern: `Service.init`
 * opens the domain, an effect owns its close, and consumers inject
 * `selfEvolveStore`.
 * @module dsh-auto-evolve/src/storage/store
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Domain, DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { selfEvolveDomainSpec } from './spec.ts'
import type {
  GenomeAsset,
  GenomeState,
  LedgerEntry,
  ObservationKind,
  ObservationRecord,
} from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    selfEvolveStore: SelfEvolveStore
  }
}

/** Typed view of the durable domain, kept private; accessors below stay narrow. */
type SelfEvolveDomain = Domain<typeof selfEvolveDomainSpec>

/** One deduplicated observation update, with the fresh count. */
export interface ObservationUpdate {
  readonly record: ObservationRecord
  readonly isNew: boolean
}

/**
 * Durable store for genome assets, the evolution ledger, and runtime
 * observations. All mutations are queued on the domain's write chain by the
 * underlying storage-domain service; callers never touch backends directly.
 */
export class SelfEvolveStore extends Service {
  static inject = ['storageDomain']

  private domain?: SelfEvolveDomain
  private genomeTable?: KvTable<string, GenomeAsset>
  private ledgerTable?: KvTable<string, LedgerEntry>
  private observationsTable?: KvTable<string, ObservationRecord>
  private stateGlobal?: DomainGlobal<GenomeState>
  /** Monotonic ledger clock: guarantees a stable newest-first order even for same-ms writes. */
  private lastLedgerAt = 0
  /** Per-key observe write tails: read-modify-write must not interleave. */
  private readonly observeTails = new Map<string, Promise<void>>()

  constructor(ctx: Context) {
    super(ctx, 'selfEvolveStore')
  }

  /** Open and own the one self-evolve domain. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(selfEvolveDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'self-evolve.storeDomainClose')
    this.domain = domain
    this.genomeTable = domain.table('genome')
    this.ledgerTable = domain.table('ledger')
    this.observationsTable = domain.table('observations')
    this.stateGlobal = domain.global
  }

  // --- genome -----------------------------------------------------------

  /** Read one genome asset by its stable `<kind>:<name>` id. */
  getAsset(id: string): GenomeAsset | undefined {
    return this.requireGenome().get(id)
  }

  /** Snapshot of every genome asset, sorted by id. */
  listAssets(): GenomeAsset[] {
    return [...this.requireGenome().entries()].map(([, asset]) => asset).sort((a, b) => a.id.localeCompare(b.id))
  }

  /** Persist (insert or replace) one genome asset. */
  putAsset(asset: GenomeAsset): Promise<void> {
    return this.requireGenome().put(asset.id, asset)
  }

  /** Delete one genome asset. */
  deleteAsset(id: string): Promise<boolean> {
    return this.requireGenome().delete(id)
  }

  // --- ledger -----------------------------------------------------------

  /** Snapshot of every ledger entry, newest first. */
  listLedger(limit = 200): LedgerEntry[] {
    return [...this.requireLedger().entries()]
      .map(([, entry]) => entry)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
  }

  /** Append one immutable evolution event; returns its id. */
  appendLedger(entry: Omit<LedgerEntry, 'id'> & { id?: string }): Promise<string> {
    const at = Math.max(entry.at, this.lastLedgerAt + 1)
    this.lastLedgerAt = at
    const record: LedgerEntry = entry.id !== undefined
      ? { ...entry, id: entry.id, at }
      : { ...entry, id: randomUUID(), at }
    return this.requireLedger().put(record.id, record).then(() => record.id)
  }

  // --- observations -----------------------------------------------------

  /**
   * Record one observation, deduplicating consecutive hits with the same key:
   * an existing record within `windowMs` of the last hit is bumped (count++,
   * lastAt updated), otherwise a fresh record is written. Per-key write tails
   * serialize the read-modify-write so concurrent observers never interleave.
   * Returns the record plus whether it was a fresh burst.
   */
  observe(
    kind: ObservationKind,
    key: string,
    detail: string,
    sessionId: string | null,
    now = Date.now(),
    windowMs = 60_000,
  ): Promise<ObservationUpdate> {
    const previous = this.observeTails.get(key) ?? Promise.resolve()
    const operation = previous.then(async () => {
      const table = this.requireObservations()
      const existing = table.get(key)
      if (existing !== undefined && existing.kind === kind && now - existing.lastAt <= windowMs) {
        const record: ObservationRecord = {
          ...existing,
          count: existing.count + 1,
          lastAt: now,
          detail,
          sessionId: sessionId ?? existing.sessionId,
        }
        await table.put(key, record)
        return { record, isNew: false }
      }
      const record: ObservationRecord = {
        id: randomUUID(),
        kind,
        key,
        count: 1,
        firstAt: now,
        lastAt: now,
        detail,
        sessionId,
      }
      await table.put(key, record)
      return { record, isNew: true }
    })
    const tail = operation.then(() => undefined, () => undefined)
    this.observeTails.set(key, tail)
    return operation.finally(() => {
      if (this.observeTails.get(key) === tail) this.observeTails.delete(key)
    })
  }

  /**
   * Count observations of one kind whose `firstAt` falls after `since`.
   * `key` optionally narrows to a specific deduplication key.
   */
  countObservations(kind: ObservationKind, since: number, key?: string): number {
    let total = 0
    for (const [, record] of this.requireObservations().entries()) {
      if (record.kind !== kind || record.firstAt < since) continue
      if (key !== undefined && record.key !== key) continue
      total += record.count
    }
    return total
  }

  /** Snapshot of every observation record, newest first. */
  listObservations(limit = 200): ObservationRecord[] {
    return [...this.requireObservations().entries()]
      .map(([, record]) => record)
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, limit)
  }

  /** Prune observations older than `before` (bound the durable log). */
  async pruneObservations(before: number): Promise<number> {
    const table = this.requireObservations()
    let removed = 0
    for (const [key, record] of table.entries()) {
      if (record.lastAt < before) {
        if (await table.delete(key)) removed++
      }
    }
    return removed
  }

  // --- state ------------------------------------------------------------

  /** Current genome generation and cycle flag. */
  state(): GenomeState {
    return this.requireState().get()
  }

  /** Update the shared genome state durably. */
  setState(state: GenomeState): Promise<void> {
    return this.requireState().set(state)
  }

  // --- teardown ---------------------------------------------------------

  /** Whether the domain is initialized (diagnostics/tests). */
  get ready(): boolean {
    return this.domain !== undefined
  }

  private requireGenome(): KvTable<string, GenomeAsset> {
    if (this.genomeTable === undefined) throw new Error('self-evolve: genome table is not initialized')
    return this.genomeTable
  }

  private requireLedger(): KvTable<string, LedgerEntry> {
    if (this.ledgerTable === undefined) throw new Error('self-evolve: ledger table is not initialized')
    return this.ledgerTable
  }

  private requireObservations(): KvTable<string, ObservationRecord> {
    if (this.observationsTable === undefined) {
      throw new Error('self-evolve: observations table is not initialized')
    }
    return this.observationsTable
  }

  private requireState(): DomainGlobal<GenomeState> {
    if (this.stateGlobal === undefined) throw new Error('self-evolve: domain state is not initialized')
    return this.stateGlobal
  }
}

export default SelfEvolveStore

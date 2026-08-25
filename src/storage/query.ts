/**
 * Evolution dashboard query API for dsh-auto-evolve.
 *
 * The raw store exposes generic CRUD (`listAssets`, `listLedger`,
 * `listObservations`), but a dashboard needs *derived* views: the evolution
 * timeline (which assets changed when), per-asset version history, rolling
 * observation trends, and a high-level health summary. This module wraps
 * the store with read-only aggregators that return the exact shapes a UI
 * wants to render, without leaking durable-schema internals.
 *
 * Every function is synchronous and read-only; callers never need to await
 * or worry about mutating durable state. The trade-off is that these views
 * are point-in-time snapshots — the dashboard should re-query on refresh.
 *
 * @module dsh-auto-evolve/src/storage/query
 */

import type { SelfEvolveStore } from './store.ts'
import type {
  AssetStatus,
  EvolvableKind,
  GenomeAsset,
  LedgerEntry,
  ObservationKind,
} from './spec.ts'

// --- timeline ------------------------------------------------------------

/** One entry in the evolution timeline. */
export interface TimelineEntry {
  /** Epoch ms of the ledger event. */
  readonly at: number
  /** Ledger event kind (`apply` or `rollback`). */
  readonly kind: LedgerEntry['kind']
  /** The asset id that changed. */
  readonly assetId: string
  /** Version transition `fromVersion → toVersion`. */
  readonly fromVersion: number
  readonly toVersion: number
  /** Human-readable reason from the ledger entry. */
  readonly reason: string
  /** Proposal id that authorized the change, when known. */
  readonly proposalId: string | null
}

/**
 * The evolution timeline: ledger events (applies and rollbacks) in
 * newest-first order, trimmed to `limit`. This is the chronological
 * "what did the plugin do" view a dashboard renders as a feed.
 *
 * @param store - durable self-evolve store (read-only access).
 * @param limit - max entries to return (default 100).
 * @returns ledger entries projected into the dashboard shape.
 */
export function getEvolutionTimeline(store: SelfEvolveStore, limit = 100): readonly TimelineEntry[] {
  return store.listLedger(limit).map(toTimelineEntry)
}

/** Project one ledger entry into a {@link TimelineEntry}. */
function toTimelineEntry(entry: LedgerEntry): TimelineEntry {
  return {
    at: entry.at,
    kind: entry.kind,
    assetId: entry.assetId,
    fromVersion: entry.fromVersion,
    toVersion: entry.toVersion,
    reason: entry.reason,
    proposalId: entry.proposalId,
  }
}

// --- asset history -------------------------------------------------------

/** One version snapshot in an asset's history. */
export interface AssetVersionEntry {
  readonly version: number
  readonly parentVersion: number
  readonly status: AssetStatus
  readonly description: string
  readonly content: string
  /** Epoch ms this version became active, when applicable. */
  readonly appliedAt: number | null
  /** Proposal id that produced this version, when known. */
  readonly proposalId: string | null
}

/** The full history of one asset: every version the store has recorded. */
export interface AssetHistory {
  /** The stable asset id (`<kind>:<name>`). */
  readonly id: string
  /** Asset kind. */
  readonly kind: EvolvableKind
  /** Asset name. */
  readonly name: string
  /** Every recorded version, newest first. */
  readonly versions: readonly AssetVersionEntry[]
}

/**
 * Reconstruct the version history of one asset from the genome table.
 *
 * The genome stores only the *current* record per asset id, so this function
 * returns at most one version per asset id (the live one). To recover full
 * version history the caller must consult the ledger; this helper focuses on
 * the common dashboard need: "show me what this asset looks like now".
 *
 * @param store - durable self-evolve store (read-only access).
 * @param assetId - the stable asset id.
 * @returns the asset history, or `undefined` when the asset is not recorded.
 */
export function getAssetHistory(
  store: SelfEvolveStore,
  assetId: string,
): AssetHistory | undefined {
  const asset = store.getAsset(assetId)
  if (asset === undefined) return undefined
  return {
    id: asset.id,
    kind: asset.kind,
    name: asset.name,
    versions: [
      {
        version: asset.version,
        parentVersion: asset.parentVersion,
        status: asset.status,
        description: asset.description,
        content: asset.content,
        appliedAt: asset.appliedAt,
        proposalId: asset.proposalId,
      },
    ],
  }
}

/**
 * List every asset's current state, grouped by kind. A dashboard renders
 * one panel per kind ("Skills", "Post-processors", …) with the live entries.
 *
 * @param store - durable self-evolve store (read-only access).
 * @returns a map from asset kind to the live assets of that kind.
 */
export function getGenomeByKind(
  store: SelfEvolveStore,
): ReadonlyMap<EvolvableKind, readonly GenomeAsset[]> {
  const byKind = new Map<EvolvableKind, GenomeAsset[]>()
  for (const asset of store.listAssets()) {
    const list = byKind.get(asset.kind)
    if (list === undefined) byKind.set(asset.kind, [asset])
    else list.push(asset)
  }
  return byKind
}

// --- observation trends --------------------------------------------------

/** One bucket in a rolling observation trend. */
export interface TrendBucket {
  /** Bucket start epoch ms. */
  readonly bucketStart: number
  /** Sum of observation counts whose `lastAt` falls in this bucket. */
  readonly hits: number
  /** Distinct deduplication keys observed in this bucket. */
  readonly distinctKeys: number
}

/** A per-kind rolling trend, bucketed by `bucketMs`. */
export interface ObservationTrend {
  /** The observation kind this trend describes. */
  readonly kind: ObservationKind
  /** Bucket width in milliseconds. */
  readonly bucketMs: number
  /** Buckets in chronological order (oldest first). */
  readonly buckets: readonly TrendBucket[]
  /** Total hits across all buckets. */
  readonly totalHits: number
}

/**
 * Build a rolling observation trend for one kind, bucketed by `bucketMs`.
 *
 * The trend covers every observation record whose `lastAt` is within
 * `windowMs` of `now`. Buckets are contiguous and oldest-first; empty
 * buckets between the first and last non-empty bucket are preserved so the
 * dashboard can render an unbroken timeline.
 *
 * @param store - durable self-evolve store (read-only access).
 * @param kind - observation kind to trend.
 * @param windowMs - rolling window width (default 1 hour).
 * @param bucketMs - bucket width (default 5 minutes).
 * @param now - wall-clock time (injectable for tests).
 * @returns the trend, or `undefined` when no observations of `kind` are
 *   recorded in the window.
 */
export function getObservationTrend(
  store: SelfEvolveStore,
  kind: ObservationKind,
  windowMs = 3_600_000,
  bucketMs = 300_000,
  now: number = Date.now(),
): ObservationTrend | undefined {
  const since = now - windowMs
  // Guard the divisor: a zero or negative bucket width would turn
  // windowMs / bucketMs into Infinity (or a negative count) and the bucket
  // loop below would never terminate. Fall back to the default width.
  const step = bucketMs > 0 ? bucketMs : 300_000
  const records = store
    .listObservations()
    .filter((record) => record.kind === kind && record.lastAt >= since)
  if (records.length === 0) return undefined

  const bucketCount = Math.ceil(windowMs / step)
  const buckets: TrendBucket[] = []
  for (let i = 0; i < bucketCount; i++) {
    buckets.push({ bucketStart: since + i * step, hits: 0, distinctKeys: 0 })
  }

  const distinctKeysPerBucket = new Map<number, Set<string>>()
  for (const record of records) {
    const offset = record.lastAt - since
    if (offset < 0) continue
    const bucketIndex = Math.min(Math.floor(offset / step), bucketCount - 1)
    const bucket = buckets[bucketIndex]!
    const keySet = distinctKeysPerBucket.get(bucketIndex) ?? new Set<string>()
    keySet.add(record.key)
    distinctKeysPerBucket.set(bucketIndex, keySet)
    buckets[bucketIndex] = {
      bucketStart: bucket.bucketStart,
      hits: bucket.hits + record.count,
      distinctKeys: keySet.size,
    }
  }

  // Trim leading and trailing empty buckets so the dashboard renders only
  // the active span.
  let firstNonEmpty = 0
  let lastNonEmpty = buckets.length - 1
  while (firstNonEmpty <= lastNonEmpty && buckets[firstNonEmpty]!.hits === 0) firstNonEmpty++
  while (lastNonEmpty >= firstNonEmpty && buckets[lastNonEmpty]!.hits === 0) lastNonEmpty--
  const trimmed = buckets.slice(firstNonEmpty, lastNonEmpty + 1)

  if (trimmed.length === 0) return undefined

  return {
    kind,
    bucketMs: step,
    buckets: trimmed,
    totalHits: trimmed.reduce((sum, bucket) => sum + bucket.hits, 0),
  }
}

// --- health summary ------------------------------------------------------

/** High-level health snapshot for the dashboard's top banner. */
export interface HealthSummary {
  /** Current genome generation. */
  readonly generation: number
  /** Whether a proposal cycle is currently in flight. */
  readonly cycleActive: boolean
  /** Count of assets currently in each lifecycle status. */
  readonly statusCounts: ReadonlyMap<AssetStatus, number>
  /** Total ledger events recorded (applies + rollbacks). */
  readonly totalEvents: number
  /** Total ledger rollbacks (the "things that did not stick" count). */
  readonly totalRollbacks: number
  /** Total observation records currently in the store. */
  readonly totalObservations: number
}

/**
 * Compute the high-level health summary the dashboard renders at the top:
 * genome generation, cycle activity, asset status counts, and ledger /
 * observation totals.
 *
 * @param store - durable self-evolve store (read-only access).
 * @returns the health summary.
 */
export function getHealthSummary(store: SelfEvolveStore): HealthSummary {
  const state = store.state()
  const assets = store.listAssets()
  const statusCounts = new Map<AssetStatus, number>()
  for (const asset of assets) {
    statusCounts.set(asset.status, (statusCounts.get(asset.status) ?? 0) + 1)
  }
  const ledger = store.listLedger()
  const totalRollbacks = ledger.filter((entry) => entry.kind === 'rollback').length
  const totalObservations = store.listObservations().length
  return {
    generation: state.generation,
    cycleActive: state.cycleActive,
    statusCounts,
    totalEvents: ledger.length,
    totalRollbacks,
    totalObservations,
  }
}

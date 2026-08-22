/**
 * Cross-window observation aggregation for dsh-auto-evolve.
 *
 * The durable observation store deduplicates consecutive hits inside one
 * rolling window (count++, lastAt updated), but there is no view that
 * aggregates bursts *across* windows. That matters because a single burst
 * is noise (a flaky tool) while a rising trend across windows is a real
 * signal that deserves a proposal. This module computes per-key and
 * per-kind rolling statistics over the durable observations table:
 *
 * - total hit count (sum of every burst's `count`)
 * - burst count (how many deduplication windows the key appeared in)
 * - first/last seen timestamps spanning all bursts
 * - a simple trend direction derived from burst ordering
 *
 * The functions are pure and take the store only for reads, so they are
 * unit-testable in isolation. Callers (the proposal engine, the dashboard
 * API) consume {@link AggregatedObservation} to decide "is this getting
 * worse?" instead of reacting to a single noisy spike.
 *
 * @module dsh-auto-evolve/src/observe/aggregate
 */

import type { SelfEvolveStore } from '../storage/store.ts'
import type { ObservationKind, ObservationRecord } from '../storage/spec.ts'

/**
 * One aggregated observation key: statistics computed across every burst
 * the store recorded for `(kind, key)`.
 */
export interface AggregatedObservation {
  /** Observation kind. */
  readonly kind: ObservationKind
  /** Deduplication key (`tool-failure:fetch`, etc.). */
  readonly key: string
  /** Sum of `count` over every recorded burst for this key. */
  readonly totalHits: number
  /** How many distinct bursts (deduplication windows) the key appeared in. */
  readonly burstCount: number
  /** Epoch ms of the earliest hit across all bursts. */
  readonly firstAt: number
  /** Epoch ms of the most recent hit across all bursts. */
  readonly lastAt: number
  /** Mean hits per burst (`totalHits / burstCount`), rounded to 2 decimals. */
  readonly meanHitsPerBurst: number
  /**
   * Coarse trend over the burst sequence: `rising` when later bursts have
   * strictly greater counts than earlier ones on average, `falling` for the
   * inverse, `steady` when all bursts share the same count, `volatile`
   * otherwise.
   */
  readonly trend: 'rising' | 'falling' | 'steady' | 'volatile'
  /** Latest detail string (carried from the most recent burst). */
  readonly detail: string
}

/**
 * Aggregate every burst recorded for one `(kind, key)` pair.
 *
 * The store keys observations by `key` alone (see `observe` in store.ts),
 * so for a given `key` every record shares the same `kind`. We filter by
 * `kind` defensively in case a caller passes a key that collides across
 * kinds.
 *
 * @param store - durable observations store (read-only access).
 * @param kind - observation kind to aggregate.
 * @param key - deduplication key to aggregate.
 * @returns the aggregated statistics, or `undefined` when no burst is
 *   recorded for that `(kind, key)` pair.
 */
export function aggregateKey(
  store: SelfEvolveStore,
  kind: ObservationKind,
  key: string,
): AggregatedObservation | undefined {
  const bursts = store.listObservations().filter(
    (record) => record.kind === kind && record.key === key,
  )
  if (bursts.length === 0) return undefined
  return aggregateBursts(kind, key, bursts)
}

/**
 * Aggregate every burst of one `kind`, across all keys. Each distinct `key`
 * produces its own {@link AggregatedObservation}.
 *
 * @param store - durable observations store (read-only access).
 * @param kind - observation kind to aggregate.
 * @returns one aggregated entry per recorded key, sorted by `totalHits`
 *   descending (highest-pressure key first).
 */
export function aggregateKind(
  store: SelfEvolveStore,
  kind: ObservationKind,
): readonly AggregatedObservation[] {
  const byKey = new Map<string, ObservationRecord[]>()
  for (const record of store.listObservations()) {
    if (record.kind !== kind) continue
    const list = byKey.get(record.key)
    if (list === undefined) byKey.set(record.key, [record])
    else list.push(record)
  }
  const aggregated: AggregatedObservation[] = []
  for (const [key, bursts] of byKey) {
    const entry = aggregateBursts(kind, key, bursts)
    if (entry !== undefined) aggregated.push(entry)
  }
  return aggregated.sort((a, b) => b.totalHits - a.totalHits)
}

/**
 * Compute the trend direction from the burst sequence. We compare the mean
 * count of the first half of bursts against the mean count of the second
 * half — a cheap, robust signal that works even with a handful of bursts.
 */
function computeTrend(bursts: readonly ObservationRecord[]): AggregatedObservation['trend'] {
  if (bursts.length < 2) return 'steady'
  const half = Math.floor(bursts.length / 2)
  const firstHalf = bursts.slice(0, half)
  const secondHalf = bursts.slice(half)

  const mean = (records: readonly ObservationRecord[]): number =>
    records.reduce((sum, r) => sum + r.count, 0) / records.length

  const firstMean = mean(firstHalf)
  const secondMean = mean(secondHalf)

  if (secondMean > firstMean) return 'rising'
  if (secondMean < firstMean) return 'falling'
  return 'steady'
}

/** Reduce a burst list into one {@link AggregatedObservation}. */
function aggregateBursts(
  kind: ObservationKind,
  key: string,
  bursts: readonly ObservationRecord[],
): AggregatedObservation | undefined {
  if (bursts.length === 0) return undefined

  let totalHits = 0
  let firstAt = Number.POSITIVE_INFINITY
  let lastAt = Number.MIN_SAFE_INTEGER
  let latestDetail = ''
  for (const burst of bursts) {
    totalHits += burst.count
    if (burst.firstAt < firstAt) firstAt = burst.firstAt
    if (burst.lastAt > lastAt) {
      lastAt = burst.lastAt
      latestDetail = burst.detail
    }
  }

  const burstCount = bursts.length
  const meanHitsPerBurst = Number((totalHits / burstCount).toFixed(2))
  const trend = computeTrend(bursts)

  return {
    kind,
    key,
    totalHits,
    burstCount,
    firstAt,
    lastAt,
    meanHitsPerBurst,
    trend,
    detail: latestDetail,
  }
}

/**
 * Threshold predicate over aggregated stats. Unlike the per-window
 * `checkThresholds`, this reads the *trend* too: a `steady` or `falling`
 * trend under the threshold is ignored (the problem is already cooling),
 * while a `rising` trend triggers even below the threshold (early warning).
 *
 * @param aggregated - the per-key aggregated stats.
 * @param threshold - hit count that, once crossed, indicates real pressure.
 * @returns `true` when the aggregated trend warrants a proposal cycle.
 */
export function isUnderPressure(
  aggregated: AggregatedObservation,
  threshold: number,
): boolean {
  if (aggregated.trend === 'rising' && aggregated.totalHits >= Math.ceil(threshold / 2)) {
    return true
  }
  return aggregated.totalHits >= threshold && aggregated.trend !== 'falling'
}

/**
 * Observation semantic clustering for dsh-auto-evolve.
 *
 * The durable observation store deduplicates hits with the *same* literal
 * key, but two semantically equivalent failures land as separate records:
 * `tool-failure:fetch` and `tool-failure:httpGet` are the same root cause
 * from the proposal engine's perspective. This module clusters observation
 * records by similarity so the engine can react to *classes* of failures
 * rather than individual keys.
 *
 * The similarity metric is character-level 3-gram Jaccard distance — a
 * cheap, embedding-free measure that works well for short
 * identifier-like strings (tool names, error codes). Two keys with
 * Jaccard similarity ≥ {@link ClusteringConfig.threshold} join the same
 * cluster.
 *
 * The algorithm is single-linkage agglomerative clustering with a
 * distance-matrix cache, capped at `maxKeys` entries to stay cheap on
 * large observation logs. It is pure (no I/O) and unit-testable.
 *
 * @module dsh-auto-evolve/src/observe/cluster
 */

import type { ObservationKind, ObservationRecord } from '../storage/spec.ts'

/** Configuration for the clustering pass. */
export interface ClusteringConfig {
  /**
   * Minimum Jaccard similarity (0–1) for two keys to join the same
   * cluster. Higher values are stricter (fewer, tighter clusters);
   * lower values are looser (more keys per cluster). Default 0.45.
   */
  readonly threshold?: number
  /**
   * Cap on the number of distinct keys clustered in one pass. Keys
   * beyond this cap are each placed in their own singleton cluster.
   * Default 100.
   */
  readonly maxKeys?: number
}

/** One cluster of semantically similar observation keys. */
export interface ObservationCluster {
  /** Observation kind shared by every member of the cluster. */
  readonly kind: ObservationKind
  /** Every deduplication key in this cluster. */
  readonly keys: readonly string[]
  /** Sum of `count` over every member record. */
  readonly totalHits: number
  /** Representative key (the one with the highest hit count). */
  readonly representative: string
  /** Epoch ms of the earliest hit across members. */
  readonly firstAt: number
  /** Epoch ms of the most recent hit across members. */
  readonly lastAt: number
}

/**
 * Cluster observation records by key similarity.
 *
 * @param records - the observation records to cluster (typically the
 *   output of `store.listObservations()`).
 * @param config - clustering thresholds.
 * @returns one {@link ObservationCluster} per detected similarity group,
 *   sorted by `totalHits` descending.
 */
export function clusterObservations(
  records: readonly ObservationRecord[],
  config: ClusteringConfig = {},
): readonly ObservationCluster[] {
  const threshold = config.threshold ?? 0.45
  const maxKeys = config.maxKeys ?? 100

  // Group records by kind first — a `tool-failure` key should never
  // cluster with a `request-error` key even if the strings are similar.
  const byKind = new Map<ObservationKind, ObservationRecord[]>()
  for (const record of records) {
    const list = byKind.get(record.kind)
    if (list === undefined) byKind.set(record.kind, [record])
    else list.push(record)
  }

  const allClusters: ObservationCluster[] = []
  for (const [kind, kindRecords] of byKind) {
    // Collapse duplicate keys: keep the record with the highest count as
    // the representative, and aggregate totalHits.
    const keyMap = new Map<string, ObservationRecord>()
    for (const r of kindRecords) {
      const existing = keyMap.get(r.key)
      if (existing === undefined || r.count > existing.count) {
        keyMap.set(r.key, r)
      }
    }
    const keys = [...keyMap.keys()]
    const clustered = clusterKeys(keys, threshold, maxKeys)
    for (const group of clustered) {
      allClusters.push(buildCluster(kind, group, keyMap))
    }
  }
  return allClusters.sort((a, b) => b.totalHits - a.totalHits)
}

/**
 * Single-linkage agglomerative clustering of a key list by 3-gram Jaccard
 * similarity. Returns an array of key groups.
 */
function clusterKeys(
  keys: readonly string[],
  threshold: number,
  maxKeys: number,
): readonly (readonly string[])[] {
  if (keys.length === 0) return []
  if (keys.length > maxKeys) {
    // Too many keys: each gets its own singleton cluster.
    return keys.map((k) => [k])
  }

  // Precompute 3-gram sets for every key.
  const gramSets = new Map<string, Set<string>>()
  for (const key of keys) {
    gramSets.set(key, trigrams(key))
  }

  // Union-Find structure.
  const parent = new Map<string, string>()
  for (const key of keys) parent.set(key, key)

  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)!
    // Path compression.
    let curr = x
    while (curr !== root) {
      const next = parent.get(curr)!
      parent.set(curr, root)
      curr = next
    }
    return root
  }

  const union = (a: string, b: string): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  // Single-linkage: union any pair whose similarity ≥ threshold.
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i]!
      const b = keys[j]!
      const sim = jaccardSimilarity(gramSets.get(a)!, gramSets.get(b)!)
      if (sim >= threshold) union(a, b)
    }
  }

  // Collect clusters.
  const clusters = new Map<string, string[]>()
  for (const key of keys) {
    const root = find(key)
    const list = clusters.get(root)
    if (list === undefined) clusters.set(root, [key])
    else list.push(key)
  }
  return [...clusters.values()]
}

/** Build a {@link ObservationCluster} from a group of keys. */
function buildCluster(
  kind: ObservationKind,
  group: readonly string[],
  keyMap: Map<string, ObservationRecord>,
): ObservationCluster {
  let totalHits = 0
  let firstAt = Number.POSITIVE_INFINITY
  let lastAt = Number.MIN_SAFE_INTEGER
  let representative = group[0]!
  let representativeHits = 0

  for (const key of group) {
    const record = keyMap.get(key)!
    totalHits += record.count
    if (record.firstAt < firstAt) firstAt = record.firstAt
    if (record.lastAt > lastAt) lastAt = record.lastAt
    if (record.count > representativeHits) {
      representative = key
      representativeHits = record.count
    }
  }

  return {
    kind,
    keys: [...group].sort(),
    totalHits,
    representative,
    firstAt,
    lastAt,
  }
}

/**
 * Compute the set of character-level 3-grams for a string. The string is
 * padded with boundary markers so that short strings still produce
 * meaningful trigrams.
 */
function trigrams(s: string): Set<string> {
  const padded = `^${s}$`
  const result = new Set<string>()
  for (let i = 0; i + 3 <= padded.length; i++) {
    result.add(padded.slice(i, i + 3))
  }
  return result
}

/** Jaccard similarity between two sets: |A ∩ B| / |A ∪ B|. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  let intersection = 0
  for (const gram of a) {
    if (b.has(gram)) intersection++
  }
  const unionSize = a.size + b.size - intersection
  if (unionSize === 0) return 1 // both empty → identical
  return intersection / unionSize
}

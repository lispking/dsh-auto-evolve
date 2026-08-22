/**
 * Threshold engine for dsh-self-evolve.
 *
 * Pure decision helpers: given the durable observations store, decide whether
 * one kind/key has crossed its configured threshold inside the rolling
 * window. Kept free of event wiring so the logic is unit-testable in
 * isolation.
 * @module dsh-self-evolve/src/observe/threshold
 */

import type { SelfEvolveStore } from '../storage/store.ts'
import type { ObservationKind } from '../storage/spec.ts'

/** Per-kind thresholds; every field is optional so partial configs merge cleanly. */
export interface ThresholdConfig {
  readonly toolFailureThreshold?: number
  readonly repeatThreshold?: number
  readonly requestErrorThreshold?: number
}

/** Resolved threshold for one kind, with the config field it came from. */
export function thresholdFor(kind: ObservationKind, config: ThresholdConfig): number | undefined {
  switch (kind) {
    case 'tool-failure':
      return config.toolFailureThreshold
    case 'tool-repeat':
      return config.repeatThreshold
    case 'request-error':
      return config.requestErrorThreshold
    default:
      return undefined
  }
}

/**
 * Whether one kind/key crossed its threshold inside the window.
 * @param store - observations store.
 * @param config - threshold config.
 * @param kind - the observation kind.
 * @param key - the deduplication key (or `undefined` to aggregate all keys of
 *   the kind — used by callers that want whole-kind pressure).
 * @param windowMs - rolling window over which counts aggregate.
 * @returns `true` when the aggregated count is at or above the threshold.
 */
export function checkThresholds(
  store: SelfEvolveStore,
  config: ThresholdConfig,
  kind: ObservationKind,
  key: string | undefined,
  windowMs: number,
): boolean {
  const threshold = thresholdFor(kind, config)
  if (threshold === undefined) return false
  const since = Date.now() - windowMs
  const count = store.countObservations(kind, since, key)
  return count >= threshold
}

/**
 * Trial metrics and baseline comparison for dsh-auto-evolve.
 *
 * A trial run is a sandboxed agent executing a replayed episode. Metrics are
 * the observable outcome: tool activity, failures, completion, and duration.
 * `compareMetrics` is the pure decision function the validation layer uses to
 * decide whether a candidate mutation helped — kept free of harness wiring so
 * it is unit-testable in isolation.
 * @module dsh-auto-evolve/src/validate/metrics
 */

/** How a trial run ended. */
export type TrialOutcome = 'completed' | 'timed-out' | 'error' | 'skipped'

/** Observable outcome of one sandboxed trial run. */
export interface TrialMetrics {
  /** Number of tool calls observed during the run. */
  readonly toolCalls: number
  /** Number of tool calls that settled with `isError`. */
  readonly toolFailures: number
  /** Whether the agent returned to idle before the wall-clock cap. */
  readonly completed: boolean
  /** Wall-clock duration of the run in milliseconds. */
  readonly durationMs: number
  /** How the run ended. */
  readonly outcome: TrialOutcome
}

/** A comparison verdict between a baseline run and a trial run. */
export interface MetricComparison {
  /** Whether the trial strictly improved over the baseline. */
  readonly improved: boolean
  /** Whether the trial strictly regressed (worse or timed out when baseline finished). */
  readonly regressed: boolean
  /** Human-readable explanation of the verdict. */
  readonly reason: string
}

/**
 * Compare a candidate trial against the baseline. Order of checks (each
 * dominates the next): completion, then failure count, then activity cost.
 * @param baseline - the run without candidate mutations.
 * @param trial - the run with candidate mutations applied.
 * @returns the verdict; `improved`/`regressed` can both be false (neutral).
 */
export function compareMetrics(baseline: TrialMetrics, trial: TrialMetrics): MetricComparison {
  // Completion dominates: a run that finishes is strictly better than one
  // that timed out or errored, regardless of counts.
  if (trial.completed && !baseline.completed) {
    return { improved: true, regressed: false, reason: 'trial completed where baseline did not' }
  }
  if (!trial.completed && baseline.completed) {
    return { improved: false, regressed: true, reason: 'baseline completed but trial did not' }
  }

  // Both completed or both failed: compare failure count.
  if (trial.toolFailures < baseline.toolFailures) {
    return {
      improved: true,
      regressed: false,
      reason: `fewer tool failures (${trial.toolFailures} < ${baseline.toolFailures})`,
    }
  }
  if (trial.toolFailures > baseline.toolFailures) {
    return {
      improved: false,
      regressed: true,
      reason: `more tool failures (${trial.toolFailures} > ${baseline.toolFailures})`,
    }
  }

  // Equal failures: prefer fewer tool calls (less activity, lower cost).
  if (trial.toolCalls < baseline.toolCalls) {
    return {
      improved: true,
      regressed: false,
      reason: `equal failures but fewer tool calls (${trial.toolCalls} < ${baseline.toolCalls})`,
    }
  }
  if (trial.toolCalls > baseline.toolCalls) {
    return {
      improved: false,
      regressed: true,
      reason: `equal failures but more tool calls (${trial.toolCalls} > ${baseline.toolCalls})`,
    }
  }

  return { improved: false, regressed: false, reason: 'no measurable difference' }
}

/** Aggregate a batch of comparison verdicts into one decision. */
export function summarizeComparisons(comparisons: readonly MetricComparison[]): {
  readonly improved: boolean
  readonly regressed: boolean
  readonly reason: string
} {
  if (comparisons.length === 0) {
    return { improved: false, regressed: false, reason: 'no trials ran' }
  }
  const improved = comparisons.filter(c => c.improved).length
  const regressed = comparisons.filter(c => c.regressed).length
  if (improved > regressed) {
    return {
      improved: true,
      regressed: false,
      reason: `${improved} of ${comparisons.length} trials improved over baseline`,
    }
  }
  if (regressed > improved) {
    return {
      improved: false,
      regressed: true,
      reason: `${regressed} of ${comparisons.length} trials regressed against baseline`,
    }
  }
  return {
    improved: false,
    regressed: false,
    reason: `${comparisons.length} trials showed no net improvement`,
  }
}

/**
 * One paired delta from a multi-episode A/B trial: trial metric minus the
 * matched baseline metric for the same episode. Negative deltas on failures
 * and tool calls are improvements; on completion a positive delta (trial
 * completed where baseline did not) is the win.
 */
export interface MetricDelta {
  /** Delta of tool calls (trial - baseline). Negative is cheaper. */
  readonly toolCallsDelta: number
  /** Delta of tool failures (trial - baseline). Negative is better. */
  readonly toolFailuresDelta: number
  /** Delta of duration in ms (trial - baseline). Negative is faster. */
  readonly durationMsDelta: number
  /** Trial completed where baseline did not (+1), or vice versa (-1), else 0. */
  readonly completionDelta: number
}

/** Compute the paired delta for one episode's baseline vs trial metrics. */
export function metricDelta(baseline: TrialMetrics, trial: TrialMetrics): MetricDelta {
  const completionDelta =
    trial.completed && !baseline.completed ? 1
      : !trial.completed && baseline.completed ? -1
      : 0
  return {
    toolCallsDelta: trial.toolCalls - baseline.toolCalls,
    toolFailuresDelta: trial.toolFailures - baseline.toolFailures,
    durationMsDelta: trial.durationMs - baseline.durationMs,
    completionDelta,
  }
}

/**
 * Aggregate a batch of paired deltas into one A/B verdict. This is the
 * statistically meaningful path for multi-episode trials: it looks at the
 * *direction* of every episode's delta rather than counting raw win/loss
 * votes, so a mutation that shaves 2 failures off every episode wins even
 * if no single episode flipped a boolean.
 *
 * Decision rule (each gate can veto the next):
 * 1. **Completion** — if the net completion delta is positive, the mutation
 *    fixed episodes the baseline could not finish: improved.
 * 2. **Failures** — if the mean failure delta is negative and at least one
 *    episode improved: improved. A positive mean failure delta regresses.
 * 3. **Activity** — equal-failure cases break the tie on tool-call delta.
 * 4. Otherwise neutral.
 *
 * @param deltas - one {@link MetricDelta} per replayed episode.
 * @returns the aggregate verdict with a human-readable reason.
 */
export function aggregateMetricDeltas(deltas: readonly MetricDelta[]): {
  readonly improved: boolean
  readonly regressed: boolean
  readonly reason: string
} {
  if (deltas.length === 0) {
    return { improved: false, regressed: false, reason: 'no paired trials ran' }
  }
  const n = deltas.length

  const netCompletion = deltas.reduce((sum, d) => sum + d.completionDelta, 0)
  if (netCompletion > 0) {
    return {
      improved: true,
      regressed: false,
      reason: `trial completed ${netCompletion} more episode(s) than baseline across ${n} replays`,
    }
  }
  if (netCompletion < 0) {
    return {
      improved: false,
      regressed: true,
      reason: `trial completed ${-netCompletion} fewer episode(s) than baseline across ${n} replays`,
    }
  }

  const meanFailureDelta = deltas.reduce((sum, d) => sum + d.toolFailuresDelta, 0) / n
  if (meanFailureDelta < 0) {
    return {
      improved: true,
      regressed: false,
      reason: `mean failure delta ${meanFailureDelta.toFixed(2)} across ${n} paired replays`,
    }
  }
  if (meanFailureDelta > 0) {
    return {
      improved: false,
      regressed: true,
      reason: `mean failure delta ${meanFailureDelta.toFixed(2)} across ${n} paired replays`,
    }
  }

  const meanToolCallsDelta = deltas.reduce((sum, d) => sum + d.toolCallsDelta, 0) / n
  if (meanToolCallsDelta < 0) {
    return {
      improved: true,
      regressed: false,
      reason: `mean tool-call delta ${meanToolCallsDelta.toFixed(2)} across ${n} paired replays`,
    }
  }
  if (meanToolCallsDelta > 0) {
    return {
      improved: false,
      regressed: true,
      reason: `mean tool-call delta ${meanToolCallsDelta.toFixed(2)} across ${n} paired replays`,
    }
  }

  return {
    improved: false,
    regressed: false,
    reason: `${n} paired replays showed no net difference`,
  }
}

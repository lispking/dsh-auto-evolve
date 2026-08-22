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

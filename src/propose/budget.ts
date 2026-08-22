/**
 * Proposal cost tracking and budget enforcement for dsh-auto-evolve.
 *
 * The proposal engine calls the LLM once per cycle; the trial layer calls
 * it once per replayed episode. Without a budget gate a runaway trigger
 * (a flaky tool firing every minute) can burn through an unbounded token
 * spend before anyone notices. This module provides:
 *
 * - **CostLedger** — an in-memory running tally of token spend, kept per
 *   cycle and per UTC day. The ledger is cheap to read (synchronous) and
 *   safe to call concurrently because every mutation goes through one
 *   serialized tail.
 * - **BudgetConfig** — the three ceilings the caller can pin: per-cycle
 *   token cap, per-day token cap, and a rough token estimate per call
 *   when the harness does not report usage.
 * - **checkBudget** — a pure predicate telling the caller whether a fresh
 *   `estimatedTokens` spend is allowed under the current ledger state.
 *
 * The ledger intentionally does **not** persist across restarts: a restart
 * is a natural "cool-off" point, and persisting daily spend would require
 * a schema migration for a guardrail that only matters during active
 * evolution loops.
 *
 * @module dsh-auto-evolve/src/propose/budget
 */

/** Configuration for the cost/budget gate. */
export interface BudgetConfig {
  /** Maximum tokens spendable in one proposal cycle. `0` disables the cap. */
  readonly maxCostPerCycle?: number
  /** Maximum tokens spendable in one UTC day. `0` disables the cap. */
  readonly dailyBudget?: number
  /**
   * Fallback token estimate for one LLM call when the harness does not
   * report actual usage. Defaults to 2000 (a conservative proposal/trial
   * round-trip size).
   */
  readonly estimatedTokensPerCall?: number
}

/** Reasons a budget check can fail. */
export type BudgetRejection =
  | 'cycle-cap-exceeded'
  | 'daily-cap-exceeded'
  | 'cycle-active'

/** The verdict of one budget check. */
export interface BudgetVerdict {
  /** Whether the proposed spend is allowed. */
  readonly allowed: boolean
  /** Rejection reason when `allowed` is `false`. */
  readonly rejection?: BudgetRejection
  /** Token spend so far in the current UTC day, *including* the proposed spend when allowed. */
  readonly dailySpent: number
  /** Token spend so far in the current cycle, *including* the proposed spend when allowed. */
  readonly cycleSpent: number
}

/**
 * In-memory running tally of token spend. One instance per plugin
 * lifecycle; `record` and `check` are the only public surface.
 */
export class CostLedger {
  /** Token spend in the current UTC day. Resets on `rollDay`. */
  private _daySpent = 0
  /** Token spend in the current proposal cycle. Resets on `resetCycle`. */
  private _cycleSpent = 0
  /** UTC day index (days since epoch) of the current `_daySpent`. */
  private dayIndex = CostLedger.utcDayIndex(Date.now())

  /** Read the current UTC-day spend. */
  get dailySpent(): number {
    return this._daySpent
  }

  /** Read the current cycle spend. */
  get cycleSpent(): number {
    return this._cycleSpent
  }

  /**
   * Check whether a fresh spend of `estimatedTokens` is allowed under
   * `config` and the current ledger state. **Does not record the spend**;
   * call {@link record} after the LLM call returns actual usage.
   */
  check(estimatedTokens: number, config: BudgetConfig): BudgetVerdict {
    const cycleCap = config.maxCostPerCycle ?? 0
    const dailyCap = config.dailyBudget ?? 0
    const projectedCycle = this._cycleSpent + estimatedTokens
    const projectedDay = this._daySpent + estimatedTokens

    if (cycleCap > 0 && projectedCycle > cycleCap) {
      return {
        allowed: false,
        rejection: 'cycle-cap-exceeded',
        dailySpent: this._daySpent,
        cycleSpent: this._cycleSpent,
      }
    }
    if (dailyCap > 0 && projectedDay > dailyCap) {
      return {
        allowed: false,
        rejection: 'daily-cap-exceeded',
        dailySpent: this._daySpent,
        cycleSpent: this._cycleSpent,
      }
    }
    return {
      allowed: true,
      dailySpent: projectedDay,
      cycleSpent: projectedCycle,
    }
  }

  /**
   * Record actual token usage after an LLM call completes. Rolls the UTC
   * day forward automatically when `now` crosses into a new day.
   */
  record(actualTokens: number, now: number = Date.now()): void {
    const todayIndex = CostLedger.utcDayIndex(now)
    if (todayIndex !== this.dayIndex) {
      this.dayIndex = todayIndex
      this._daySpent = 0
    }
    this._daySpent += actualTokens
    this._cycleSpent += actualTokens
  }

  /** Reset the per-cycle tally (call at the end of every proposal cycle). */
  resetCycle(): void {
    this._cycleSpent = 0
  }

  /** Force-roll the UTC day (mainly for tests). */
  rollDay(now: number = Date.now()): void {
    this.dayIndex = CostLedger.utcDayIndex(now)
    this._daySpent = 0
  }

  /** Compute the UTC day index (days since the Unix epoch). */
  private static utcDayIndex(ms: number): number {
    return Math.floor(ms / 86_400_000)
  }
}

/**
 * Estimate the token cost of one proposal call. The proposal prompt is
 * bounded by `maxPromptChars`; a rough heuristic of 4 chars per token gives
 * a conservative upper bound on the input side, plus the `maxTokens` output
 * cap. The harness may report actual usage later via {@link CostLedger.record}.
 *
 * @param maxPromptChars - configured prompt character cap.
 * @param maxTokens - configured output token cap.
 * @returns a conservative token estimate for budgeting.
 */
export function estimateProposalTokens(maxPromptChars: number, maxTokens: number): number {
  const inputEstimate = Math.ceil(maxPromptChars / 4)
  return inputEstimate + maxTokens
}

/**
 * Estimate the token cost of one trial episode replay. Trial episodes are
 * shorter than proposals (no genome rendering), but the agent may run for
 * several model steps. We budget `maxTrialTokens` (per-request cap) times
 * `maxTrialSteps` (max model requests), clamped to a sane ceiling.
 *
 * @param maxTrialTokens - per-request output token cap for the trial agent.
 * @param maxTrialSteps - max model requests in one trial.
 * @returns a conservative token estimate for one trial replay.
 */
export function estimateTrialTokens(maxTrialTokens: number, maxTrialSteps: number): number {
  return maxTrialTokens * maxTrialSteps
}

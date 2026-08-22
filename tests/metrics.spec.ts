import { describe, expect, it } from 'vitest'
import { compareMetrics, summarizeComparisons } from '../src/validate/metrics.ts'
import type { TrialMetrics } from '../src/validate/metrics.ts'

function metrics(partial: Partial<TrialMetrics>): TrialMetrics {
  return {
    toolCalls: 0,
    toolFailures: 0,
    completed: true,
    durationMs: 100,
    outcome: 'completed',
    ...partial,
  }
}

describe('compareMetrics', () => {
  it('prefers completion over counts', () => {
    const verdict = compareMetrics(
      metrics({ completed: false, outcome: 'timed-out' }),
      metrics({ completed: true, toolFailures: 5 }),
    )
    expect(verdict.improved).toBe(true)
    expect(verdict.regressed).toBe(false)
    expect(verdict.reason).toContain('completed')
  })

  it('flags a regression when baseline completed but trial did not', () => {
    const verdict = compareMetrics(
      metrics({ completed: true }),
      metrics({ completed: false, outcome: 'timed-out' }),
    )
    expect(verdict.improved).toBe(false)
    expect(verdict.regressed).toBe(true)
  })

  it('prefers fewer tool failures', () => {
    const verdict = compareMetrics(
      metrics({ toolFailures: 4, toolCalls: 10 }),
      metrics({ toolFailures: 1, toolCalls: 20 }),
    )
    expect(verdict.improved).toBe(true)
    expect(verdict.reason).toContain('fewer tool failures')
  })

  it('flags more tool failures as a regression', () => {
    const verdict = compareMetrics(
      metrics({ toolFailures: 1 }),
      metrics({ toolFailures: 3 }),
    )
    expect(verdict.improved).toBe(false)
    expect(verdict.regressed).toBe(true)
  })

  it('breaks ties with fewer tool calls', () => {
    const fewer = compareMetrics(
      metrics({ toolFailures: 2, toolCalls: 9 }),
      metrics({ toolFailures: 2, toolCalls: 5 }),
    )
    expect(fewer.improved).toBe(true)
    const more = compareMetrics(
      metrics({ toolFailures: 2, toolCalls: 3 }),
      metrics({ toolFailures: 2, toolCalls: 8 }),
    )
    expect(more.regressed).toBe(true)
  })

  it('reports neutral when nothing differs', () => {
    const verdict = compareMetrics(metrics({}), metrics({}))
    expect(verdict.improved).toBe(false)
    expect(verdict.regressed).toBe(false)
    expect(verdict.reason).toContain('no measurable difference')
  })
})

describe('summarizeComparisons', () => {
  it('returns neutral for an empty batch', () => {
    const summary = summarizeComparisons([])
    expect(summary.improved).toBe(false)
    expect(summary.regressed).toBe(false)
  })

  it('improves when more trials improved than regressed', () => {
    const summary = summarizeComparisons([
      { improved: true, regressed: false, reason: 'a' },
      { improved: true, regressed: false, reason: 'b' },
      { improved: false, regressed: true, reason: 'c' },
    ])
    expect(summary.improved).toBe(true)
    expect(summary.regressed).toBe(false)
  })

  it('regresses when more trials regressed', () => {
    const summary = summarizeComparisons([
      { improved: false, regressed: true, reason: 'a' },
      { improved: false, regressed: false, reason: 'b' },
    ])
    expect(summary.improved).toBe(false)
    expect(summary.regressed).toBe(true)
  })
})

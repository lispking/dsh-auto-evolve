/**
 * Operator control plane for dsh-auto-evolve: a small set of agent-callable
 * tools that make the evolution loop operable from inside the harness —
 * inspect health and candidates, apply/rollback mutations manually, and
 * trigger proposal cycles on demand.
 *
 * dsh exposes no chat-command framework; the natural operator surface in an
 * agent harness is tools. Every handler below is also exported standalone so
 * the logic is unit-testable without the tool runtime.
 * @module dsh-auto-evolve/src/control/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SelfEvolveStore } from '../storage/store.ts'
import type { SelfEvolveApplier } from '../apply/applier.ts'
import type { AssetStatus } from '../storage/spec.ts'
import type { BudgetConfig } from '../propose/budget.ts'
import type { CostLedger } from '../propose/budget.ts'
import { listCandidates, runProposalCycle } from '../propose/cycle.ts'
import { resolveProposalTarget } from '../propose/engine.ts'
import { runAutoApplyCycle } from '../evolve/loop.ts'
import type { CooldownGate, ConvergenceTracker, RegressionWatch } from '../evolve/loop.ts'
import { getHealthSummary } from '../storage/query.ts'
import type { TrialBounds } from '../validate/trial.ts'

/** Everything the operator tools need to do their job. */
export interface OperatorToolOptions {
  /** Current plugin evolution mode (read at registration time). */
  readonly mode: 'observe' | 'propose' | 'auto-apply'
  readonly store: SelfEvolveStore
  /** Present when the applier service is mounted (propose / auto-apply). */
  readonly applier?: SelfEvolveApplier | undefined
  readonly convergence: ConvergenceTracker
  readonly cooldown: CooldownGate
  readonly watch: RegressionWatch
  readonly windowMs: number
  readonly proposal: {
    readonly maxProposalsPerTrigger: number
    readonly maxEpisodesPerProposal: number
    readonly maxPromptChars: number
    readonly maxTokens: number
  }
  readonly validation: TrialBounds
  readonly budget?: BudgetConfig | undefined
  readonly costLedger?: CostLedger | undefined
}

/** Render one plain-text value as a single model-facing text block. */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** Health/status report for `evolve_status`. */
export function describeHealth(options: OperatorToolOptions, now = Date.now()): string {
  const health = getHealthSummary(options.store)
  const statuses: readonly AssetStatus[] = ['candidate', 'applied', 'rolled-back', 'retired']
  const assets = statuses.map((s) => `${s}=${health.statusCounts.get(s) ?? 0}`).join(' ')
  const paused = options.convergence.isPaused(now)
  const pauseUntil = options.convergence.pausedUntil
  return [
    `mode: ${options.mode}`,
    `generation: ${health.generation}`,
    `cycle-active: ${health.cycleActive}`,
    `assets: ${assets}`,
    `ledger-events: ${health.totalEvents} (rollbacks: ${health.totalRollbacks})`,
    `observations: ${health.totalObservations}`,
    `convergence: stalled=${options.convergence.currentStallCount}, paused=${paused}` +
      (paused && pauseUntil !== undefined ? ` until ${new Date(pauseUntil).toISOString()}` : ''),
    `regression-watch: ${options.watch.size} applied asset(s) monitored (window ${options.windowMs}ms)`,
  ].join('\n')
}

/** Candidate report for `evolve_candidates`. */
export function describeCandidates(store: SelfEvolveStore): string {
  const candidates = listCandidates(store)
  if (candidates.length === 0) return 'no candidates awaiting validation or application'
  return candidates
    .map((c) => `${c.id} [${c.kind} v${c.version}] ${c.name}: ${c.description}`)
    .join('\n')
}

/**
 * Apply one candidate for `evolve_apply`. Throws when the applier is not
 * mounted or the asset is missing / not in candidate status.
 */
export async function applyCandidateTool(options: OperatorToolOptions, assetId: string): Promise<string> {
  if (options.applier === undefined) {
    throw new Error(`evolve_apply is unavailable in ${options.mode} mode (applier not mounted)`)
  }
  const result = await options.applier.applyCandidate(assetId, null, 'manual approval via evolve_apply')
  if (result === undefined) throw new Error(`candidate ${assetId} not found or not in candidate status`)
  return `applied ${assetId} (v${result.asset.version}, ledger ${result.ledgerId})`
}

/** Roll back one applied asset for `evolve_rollback`. Throws when nothing can be reverted. */
export async function rollbackTool(options: OperatorToolOptions, assetId: string): Promise<string> {
  if (options.applier === undefined) {
    throw new Error(`evolve_rollback is unavailable in ${options.mode} mode (applier not mounted)`)
  }
  const result = await options.applier.rollback(assetId, 'manual rollback via evolve_rollback')
  if (!result.reverted) throw new Error(`rollback failed: ${assetId} is not applied or missing`)
  const restored = result.restored !== undefined ? ` (restored v${result.restored.version} as candidate)` : ''
  return `rolled back ${assetId}${restored}`
}

/**
 * Manually trigger one evolution cycle for `evolve_cycle`: in auto-apply mode
 * run the full propose → validate → apply loop (needs an LLM provider), in
 * propose mode just materialize candidate mutations (provider falls back to
 * the first registered). Observe mode rejects.
 */
export async function runCycleTool(ctx: Context, options: OperatorToolOptions): Promise<string> {
  if (options.mode === 'observe') throw new Error('evolve_cycle is unavailable in observe mode')
  const p = options.proposal
  if (options.mode === 'auto-apply' && options.applier !== undefined) {
    if (ctx.llm === undefined) throw new Error('no LLM service registered')
    const target = await resolveProposalTarget(ctx)
    if (target === undefined) throw new Error('no LLM provider/model registered')
    const result = await runAutoApplyCycle(ctx, options.store, options.applier, {
      provider: target.provider,
      model: target.model,
      maxTokens: p.maxTokens,
      maxPromptChars: p.maxPromptChars,
      maxMutations: p.maxProposalsPerTrigger,
      maxObservations: p.maxEpisodesPerProposal,
      bounds: options.validation,
      budget: options.budget,
      costLedger: options.costLedger,
    })
    return (
      `cycle: proposed ${result.proposed}; ` +
      `applied [${result.applied.join(', ')}]; ` +
      `rejected [${result.rejected.join(', ')}]; ` +
      `skipped [${result.skipped.join(', ')}]`
    )
  }
  const materialized = await runProposalCycle(ctx, options.store, {
    maxTokens: p.maxTokens,
    maxPromptChars: p.maxPromptChars,
    maxMutations: p.maxProposalsPerTrigger,
    maxObservations: p.maxEpisodesPerProposal,
    budget: options.budget,
    costLedger: options.costLedger,
  })
  return materialized > 0 ? `materialized ${materialized} candidate(s)` : 'no candidates materialized'
}

/**
 * Register the operator tools on the plugin context. The registrations are
 * tied to `ctx` and torn down with it. Call inside an inject block whose deps
 * include `tools` (the tool runtime) so registration happens once the runtime
 * is ready.
 */
export function installOperatorTools(ctx: Context, options: OperatorToolOptions): void {
  const disposers = [
    ctx.tools.register(defineTool({
      name: 'evolve_status',
      description:
        'Report the self-evolution plugin health: mode, generation, asset status counts, ' +
        'ledger/observation totals, convergence pause state, and regression watch size.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
      execute: async () => describeHealth(options),
    })),
    ctx.tools.register(defineTool({
      name: 'evolve_candidates',
      description: 'List candidate mutations awaiting validation or manual application.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
      execute: async () => describeCandidates(options.store),
    })),
    ctx.tools.register(defineTool({
      name: 'evolve_apply',
      description:
        'Apply a candidate mutation immediately (manual approval), registering its live ' +
        'contribution. Provide the asset id listed by evolve_candidates.',
      parameters: {
        assetId: { type: 'string', description: 'Candidate asset id, e.g. skill:retry-helper' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
      execute: async ({ assetId }: { assetId: string }) => applyCandidateTool(options, assetId),
    })),
    ctx.tools.register(defineTool({
      name: 'evolve_rollback',
      description:
        'Roll back an applied mutation, restoring its previous content as a candidate. ' +
        'Provide the asset id.',
      parameters: {
        assetId: { type: 'string', description: 'Applied asset id, e.g. skill:retry-helper' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
      execute: async ({ assetId }: { assetId: string }) => rollbackTool(options, assetId),
    })),
    ctx.tools.register(defineTool({
      name: 'evolve_cycle',
      description:
        'Manually trigger one evolution cycle: materialize candidate mutations (propose mode) ' +
        'or run the full propose-validate-apply loop (auto-apply mode).',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
      execute: async () => runCycleTool(ctx, options),
    })),
  ]
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  }, 'self-evolve.operatorTools')
}

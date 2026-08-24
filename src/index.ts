/**
 * dsh-auto-evolve: a self-evolving plugin for DeepSeek Harness.
 *
 * The plugin owns a small set of evolvable assets (skills, tool-result
 * post-processors, system-prompt sections, guard policies). It observes the
 * agent's runtime behavior, proposes improvements via the LLM, validates them
 * inside a sandboxed trial agent, and applies only verified mutations to its
 * own genome — with a versioned ledger and rollback on regression.
 *
 * @module dsh-auto-evolve
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import SelfEvolveStore from './storage/store.ts'
import SelfEvolveApplier from './apply/applier.ts'
import { CostLedger } from './propose/budget.ts'
import { installObservations } from './observe/collector.ts'
import { installOperatorTools } from './control/tools.ts'
import { runProposalCycle } from './propose/cycle.ts'
import { resolveProposalTarget } from './propose/engine.ts'
import {
  classifyCycle,
  CooldownGate,
  ConvergenceTracker,
  loadWatch,
  rollBackRegressions,
  runAutoApplyCycle,
  trackApplied,
} from './evolve/loop.ts'
import type { CycleOutcome, RegressionWatch } from './evolve/loop.ts'

export const name = 'self-evolve'

export { SelfEvolveStore } from './storage/store.ts'
export { SelfEvolveApplier } from './apply/applier.ts'
export type { ApplyResult, RollbackResult } from './apply/applier.ts'
export {
  applyMutation,
  isTrialExercisable,
  parseGuardPolicy,
  parsePostProcessor,
  parseToolWrapper,
} from './apply/mutation.ts'
export type {
  GuardPolicyConfig,
  PostProcessorConfig,
  ToolWrapperConfig,
} from './apply/mutation.ts'
export {
  genomeAssetSchema,
  genomeStateSchema,
  ledgerEntrySchema,
  observationRecordSchema,
  selfEvolveDomainSpec,
  watchEntrySchema,
} from './storage/spec.ts'
export type {
  AssetStatus,
  EvolvableKind,
  GenomeAsset,
  GenomeState,
  LedgerEntry,
  ObservationKind,
  ObservationRecord,
  WatchEntry,
} from './storage/spec.ts'
export { installObservations } from './observe/collector.ts'
export type { ObservationConfig, TriggerSignal } from './observe/collector.ts'
export { installOperatorTools } from './control/tools.ts'
export type { OperatorToolOptions } from './control/tools.ts'
export { checkThresholds } from './observe/threshold.ts'
export type { ThresholdConfig } from './observe/threshold.ts'
export { generateProposal, resolveProposalTarget } from './propose/engine.ts'
export type { ProposalOptions } from './propose/engine.ts'
export { runProposalCycle, listCandidates, listApplied } from './propose/cycle.ts'
export type { CycleOptions } from './propose/cycle.ts'
export { MUTATION_OPERATORS, mutationAssetId, mutationSchema, proposalSchema } from './propose/operators.ts'
export type { Mutation, MutationOperator, Proposal } from './propose/operators.ts'
export { compareMetrics, summarizeComparisons } from './validate/metrics.ts'
export type { MetricComparison, TrialMetrics, TrialOutcome } from './validate/metrics.ts'
export { runTrial, validateMutations } from './validate/trial.ts'
export type { TrialBounds, TrialRequest, ValidationRun } from './validate/trial.ts'
export {
  loadWatch,
  rollBackRegressions,
  runAutoApplyCycle,
  trackApplied,
} from './evolve/loop.ts'
export type { AutoApplyOptions, AutoApplyResult, RegressionWatch } from './evolve/loop.ts'
export { aggregateKey, aggregateKind, isUnderPressure } from './observe/aggregate.ts'
export type { AggregatedObservation } from './observe/aggregate.ts'
export { clusterObservations } from './observe/cluster.ts'
export type { ClusteringConfig, ObservationCluster } from './observe/cluster.ts'
export {
  ConvergenceTracker,
  classifyCycle,
} from './evolve/loop.ts'
export type {
  ConvergenceConfig,
  ConvergenceVerdict,
  CycleOutcome,
} from './evolve/loop.ts'
export {
  exportGenome,
  importGenome,
  diffGenome,
} from './storage/snapshot.ts'
export type { GenomeDiff, GenomeSnapshot, ImportResult, SnapshotAsset } from './storage/snapshot.ts'
export {
  getEvolutionTimeline,
  getAssetHistory,
  getGenomeByKind,
  getObservationTrend,
  getHealthSummary,
} from './storage/query.ts'
export type {
  AssetHistory,
  AssetVersionEntry,
  HealthSummary,
  ObservationTrend,
  TimelineEntry,
  TrendBucket,
} from './storage/query.ts'

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Evolution mode: observe-only, propose (needs approval), or auto-apply. */
  mode?: 'observe' | 'propose' | 'auto-apply'
  /** Observation thresholds that trigger a proposal cycle. */
  observation?: {
    toolFailureThreshold?: number
    repeatThreshold?: number
    requestErrorThreshold?: number
    windowMs?: number
  }
  /** Proposal-generation bounds (token/cost guardrails). */
  proposal?: {
    maxProposalsPerTrigger?: number
    maxEpisodesPerProposal?: number
    maxPromptChars?: number
    maxTokens?: number
  }
  /** Cost/budget ceilings. `0` disables a cap. */
  budget?: {
    /** Max tokens spendable in one proposal cycle. */
    maxCostPerCycle?: number
    /** Max tokens spendable in one UTC day. */
    dailyBudget?: number
  }
  /** Sandboxed trial-run bounds. */
  validation?: {
    maxTrialMs?: number
    maxToolCalls?: number
    maxTrialSteps?: number
    maxTrialTokens?: number
  }
  /** Evolution-loop safeguards: convergence pause + per-key cooldown. */
  evolution?: {
    /** Consecutive stalled cycles before auto-apply pauses. Default 3. */
    stallThreshold?: number
    /** How long a convergence pause lasts (ms). Default 30 min. */
    stallPauseMs?: number
    /** Per-key cooldown after a failed or rolled-back cycle (ms). Default 10 min. */
    cooldownMs?: number
  }
}

export const Config: z<Config> = z.object({
  mode: z.union(['observe', 'propose', 'auto-apply']).default('observe'),
  observation: z.object({
    toolFailureThreshold: z.number().default(3),
    repeatThreshold: z.number().default(3),
    requestErrorThreshold: z.number().default(3),
    windowMs: z.number().default(5 * 60_000),
  }),
  proposal: z.object({
    maxProposalsPerTrigger: z.number().default(1),
    maxEpisodesPerProposal: z.number().default(5),
    maxPromptChars: z.number().default(24000),
    maxTokens: z.number().default(2000),
  }),
  budget: z.object({
    maxCostPerCycle: z.number().default(0),
    dailyBudget: z.number().default(0),
  }),
  validation: z.object({
    maxTrialMs: z.number().default(30_000),
    maxToolCalls: z.number().default(20),
    maxTrialSteps: z.number().default(12),
    maxTrialTokens: z.number().default(8000),
  }),
  evolution: z.object({
    stallThreshold: z.number().default(3),
    stallPauseMs: z.number().default(30 * 60_000),
    cooldownMs: z.number().default(10 * 60_000),
  }),
})

/**
 * Install the plugin's listeners and services.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const mode = config.mode ?? 'observe'
  const observation = config.observation as {
    toolFailureThreshold: number
    repeatThreshold: number
    requestErrorThreshold: number
    windowMs: number
  }
  const proposal = config.proposal as {
    maxProposalsPerTrigger: number
    maxEpisodesPerProposal: number
    maxPromptChars: number
    maxTokens: number
  }
  const validation = config.validation as {
    maxTrialMs: number
    maxToolCalls: number
    maxTrialSteps: number
    maxTrialTokens: number
  }
  const budget = config.budget as {
    maxCostPerCycle: number
    dailyBudget: number
  }

  // Shared cost ledger for the lifetime of this plugin instance.
  const costLedger = new CostLedger()

  // Evolution safeguards shared by every trigger cycle of this instance: a
  // convergence tracker that pauses auto-apply after repeated stalls, and a
  // per-key cooldown gate that prevents propose → fail → propose thrash.
  const evolution = config.evolution as {
    stallThreshold: number
    stallPauseMs: number
    cooldownMs: number
  }
  const convergence = new ConvergenceTracker({
    stallThreshold: evolution.stallThreshold,
    stallPauseMs: evolution.stallPauseMs,
  })
  const cooldown = new CooldownGate(evolution.cooldownMs)

  // Mount services. Startup failures (config or domain open errors) reject
  // the returned fiber; surface them as logged errors instead of letting them
  // become unhandled rejections.
  void Promise.resolve(ctx.plugin(SelfEvolveStore)).catch((error: unknown) => {
    ctx.logger.error(`[self-evolve] store failed to start: ${String(error)}`)
  })
  void Promise.resolve(ctx.plugin(SelfEvolveApplier)).catch((error: unknown) => {
    ctx.logger.error(`[self-evolve] applier failed to start: ${String(error)}`)
  })

  // Observation + operator-tool layer. The dependency list is mode-aware so
  // the framework waits for exactly the services each mode consumes: observe
  // needs only the store (+ tool runtime for the operator tools), propose
  // adds the LLM and the applier (manual apply via tools), auto-apply adds
  // agents + skills for the sandboxed trial replay.
  const observationDeps = mode === 'auto-apply'
    ? ['selfEvolveStore', 'selfEvolveApplier', 'llm', 'agents', 'skills', 'tools']
    : mode === 'propose'
      ? ['selfEvolveStore', 'selfEvolveApplier', 'llm', 'skills', 'tools']
      : ['selfEvolveStore', 'tools']

  ctx.inject(observationDeps, (injected) => {
    const store = injected.selfEvolveStore
    // Regression watch for auto-apply: applied asset id → the observation key
    // that justified it, plus the apply time. Restored from durable storage
    // (entries older than the observation window are stale and dropped), so
    // applied assets stay monitored across plugin restarts. The restore fills
    // the same map instance listeners already close over.
    const watch: RegressionWatch = new Map()
    void loadWatch(store, observation.windowMs)
      .then((restored) => {
        for (const [assetId, entry] of restored) watch.set(assetId, entry)
      })
      .catch((error: unknown) => {
        injected.logger.warn(`[self-evolve] failed to restore regression watch: ${String(error)}`)
      })

    installObservations(
      injected,
      store,
      {
        toolFailureThreshold: observation.toolFailureThreshold,
        repeatThreshold: observation.repeatThreshold,
        requestErrorThreshold: observation.requestErrorThreshold,
        windowMs: observation.windowMs,
      },
      (signal) => {
        injected.logger.info(
          `[self-evolve] observation threshold crossed: ${signal.kind} ${signal.key} × ${signal.count}`,
        )
        if (mode === 'observe') return // observe-only: never propose

        void (async () => {
          if (mode === 'auto-apply') {
            const applier = injected.selfEvolveApplier
            // Regression safety always runs first: a recurring key inside the
            // observation window means an applied fix did not hold. Cooldown
            // and convergence pause gate the (re-)proposal, never a rollback.
            const rolledBack = await rollBackRegressions(
              applier,
              watch,
              signal.key,
              observation.windowMs,
              undefined,
              store,
            )
            for (const assetId of rolledBack) {
              injected.logger.info(`[self-evolve] rolled back ${assetId}: regression on ${signal.key}`)
            }

            // Classify this trigger for the convergence tracker. Anything but
            // a clean apply cools the key so the same signal cannot thrash.
            let outcome: CycleOutcome = 'empty'
            if (rolledBack.length > 0) {
              // The applied fix did not hold: skip re-proposing and count the
              // cycle as stalled.
              outcome = 'rolled-back'
            } else if (convergence.isPaused()) {
              injected.logger.info('[self-evolve] auto-apply paused: convergence stall limit reached')
              return
            } else if (cooldown.isCooled(signal.key)) {
              injected.logger.info(`[self-evolve] auto-apply skipped: ${signal.key} is in cooldown`)
              return
            } else {
              // The trial and proposal calls share one provider/model route.
              const target = await resolveProposalTarget(injected)
              if (target === undefined) {
                injected.logger.warn('[self-evolve] auto-apply skipped: no LLM provider registered')
                return
              }

              const result = await runAutoApplyCycle(injected, store, applier, {
                provider: target.provider,
                model: target.model,
                maxTokens: proposal.maxTokens,
                maxPromptChars: proposal.maxPromptChars,
                maxMutations: proposal.maxProposalsPerTrigger,
                maxObservations: proposal.maxEpisodesPerProposal,
                bounds: {
                  maxTrialMs: validation.maxTrialMs,
                  maxToolCalls: validation.maxToolCalls,
                  maxTrialSteps: validation.maxTrialSteps,
                  maxTrialTokens: validation.maxTrialTokens,
                },
                budget,
                costLedger,
              })
              await trackApplied(watch, result, signal.key, undefined, store)
              outcome = classifyCycle(result, 0)
              injected.logger.info(
                `[self-evolve] auto-apply: proposed ${result.proposed}, ` +
                `applied [${result.applied.join(', ')}], rejected [${result.rejected.join(', ')}], ` +
                `skipped [${result.skipped.join(', ')}]`,
              )
            }

            const verdict = convergence.record(outcome)
            if (verdict.shouldPause) {
              injected.logger.info(
                `[self-evolve] ${verdict.reason}; auto-apply resumes after ` +
                new Date(verdict.pausedUntil!).toISOString(),
              )
            }
            if (outcome !== 'applied') cooldown.mark(signal.key)
          } else {
            // propose mode: generate and persist candidates; validation and
            // application await manual approval or the exported API.
            await runProposalCycle(injected, store, {
              maxTokens: proposal.maxTokens,
              maxPromptChars: proposal.maxPromptChars,
              maxMutations: proposal.maxProposalsPerTrigger,
              maxObservations: proposal.maxEpisodesPerProposal,
              budget,
              costLedger,
            })
          }
        })().catch((error: unknown) => {
          injected.logger.warn(`[self-evolve] evolution cycle failed: ${String(error)}`)
        })
      },
    )

    // Operator control plane: agent-callable management tools. Mounted in
    // every mode; apply/rollback/cycle degrade gracefully when their backing
    // service (applier / llm) is not part of the current mode's deps.
    installOperatorTools(ctx, {
      mode,
      store,
      applier: mode === 'observe' ? undefined : injected.selfEvolveApplier,
      convergence,
      cooldown,
      watch,
      windowMs: observation.windowMs,
      proposal: {
        maxProposalsPerTrigger: proposal.maxProposalsPerTrigger,
        maxEpisodesPerProposal: proposal.maxEpisodesPerProposal,
        maxPromptChars: proposal.maxPromptChars,
        maxTokens: proposal.maxTokens,
      },
      validation: {
        maxTrialMs: validation.maxTrialMs,
        maxToolCalls: validation.maxToolCalls,
        maxTrialSteps: validation.maxTrialSteps,
        maxTrialTokens: validation.maxTrialTokens,
      },
      budget,
      costLedger,
    })
  })
}

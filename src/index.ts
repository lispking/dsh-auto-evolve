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
import { installObservations } from './observe/collector.ts'
import { runProposalCycle } from './propose/cycle.ts'
import { resolveProposalTarget } from './propose/engine.ts'
import {
  rollBackRegressions,
  runAutoApplyCycle,
  trackApplied,
} from './evolve/loop.ts'
import type { RegressionWatch } from './evolve/loop.ts'

export const name = 'self-evolve'

export { SelfEvolveStore } from './storage/store.ts'
export { SelfEvolveApplier } from './apply/applier.ts'
export type { ApplyResult, RollbackResult } from './apply/applier.ts'
export {
  genomeAssetSchema,
  genomeStateSchema,
  ledgerEntrySchema,
  observationRecordSchema,
  selfEvolveDomainSpec,
} from './storage/spec.ts'
export type {
  AssetStatus,
  EvolvableKind,
  GenomeAsset,
  GenomeState,
  LedgerEntry,
  ObservationKind,
  ObservationRecord,
} from './storage/spec.ts'
export { installObservations } from './observe/collector.ts'
export type { ObservationConfig, TriggerSignal } from './observe/collector.ts'
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
  rollBackRegressions,
  runAutoApplyCycle,
  trackApplied,
} from './evolve/loop.ts'
export type { AutoApplyOptions, AutoApplyResult, RegressionWatch } from './evolve/loop.ts'

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
  /** Sandboxed trial-run bounds. */
  validation?: {
    maxTrialMs?: number
    maxToolCalls?: number
    maxTrialSteps?: number
    maxTrialTokens?: number
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
  validation: z.object({
    maxTrialMs: z.number().default(30_000),
    maxToolCalls: z.number().default(20),
    maxTrialSteps: z.number().default(12),
    maxTrialTokens: z.number().default(8000),
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

  // Mount services. Startup failures (config or domain open errors) reject
  // the returned fiber; surface them as logged errors instead of letting them
  // become unhandled rejections.
  void Promise.resolve(ctx.plugin(SelfEvolveStore)).catch((error: unknown) => {
    ctx.logger.error(`[self-evolve] store failed to start: ${String(error)}`)
  })
  void Promise.resolve(ctx.plugin(SelfEvolveApplier)).catch((error: unknown) => {
    ctx.logger.error(`[self-evolve] applier failed to start: ${String(error)}`)
  })

  // Observation layer. The dependency list is mode-aware so the framework
  // waits for exactly the services each mode consumes: observe needs only the
  // store, propose adds the LLM, auto-apply adds agents + skills + applier.
  const observationDeps = mode === 'auto-apply'
    ? ['selfEvolveStore', 'selfEvolveApplier', 'llm', 'agents', 'skills']
    : mode === 'propose'
      ? ['selfEvolveStore', 'llm']
      : ['selfEvolveStore']

  ctx.inject(observationDeps, (injected) => {
    const store = injected.selfEvolveStore
    // Regression watch for auto-apply: applied asset id → the observation key
    // that justified it, plus the apply time. In-memory per plugin instance.
    const watch: RegressionWatch = new Map()

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
            // Regression first: the same key recurring inside the observation
            // window means an applied fix did not hold — roll it back.
            const rolledBack = await rollBackRegressions(
              applier,
              watch,
              signal.key,
              observation.windowMs,
            )
            for (const assetId of rolledBack) {
              injected.logger.info(`[self-evolve] rolled back ${assetId}: regression on ${signal.key}`)
            }

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
            })
            trackApplied(watch, result, signal.key)
            injected.logger.info(
              `[self-evolve] auto-apply: proposed ${result.proposed}, ` +
              `applied [${result.applied.join(', ')}], rejected [${result.rejected.join(', ')}], ` +
              `skipped [${result.skipped.join(', ')}]`,
            )
          } else {
            // propose mode: generate and persist candidates; validation and
            // application await manual approval or the exported API.
            await runProposalCycle(injected, store, {
              maxTokens: proposal.maxTokens,
              maxPromptChars: proposal.maxPromptChars,
              maxMutations: proposal.maxProposalsPerTrigger,
              maxObservations: proposal.maxEpisodesPerProposal,
            })
          }
        })().catch((error: unknown) => {
          injected.logger.warn(`[self-evolve] evolution cycle failed: ${String(error)}`)
        })
      },
    )
  })
}

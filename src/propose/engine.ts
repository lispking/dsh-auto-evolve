/**
 * Proposal engine for dsh-auto-evolve.
 *
 * Generates evolution proposals by calling the harness LLM service
 * (`ctx.llm.stream`) with a bounded prompt built from the current genome and
 * recent observations, assembles the streamed response with `BlockAssembler`,
 * then validates the structured output against the closed mutation
 * vocabulary. Any parse or schema failure yields `null` — the loop never
 * applies an unvalidated proposal.
 * @module dsh-auto-evolve/src/propose/engine
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { proposalSchema } from './operators.ts'
import type { Proposal } from './operators.ts'
import type { GenomeAsset, ObservationRecord } from '../storage/spec.ts'
import { autoStrategy, strategyPrompt } from './strategies.ts'
import type { ProposalStrategy } from './strategies.ts'

/** Options controlling one proposal run. */
export interface ProposalOptions {
  /** Provider route for the proposal call. */
  readonly provider: string
  /** Model id for the proposal call. */
  readonly model: string
  /** Max output tokens for one proposal call. */
  readonly maxTokens: number
  /** Max prompt characters (bounds context and cost). */
  readonly maxPromptChars: number
  /** Max mutations per proposal. */
  readonly maxMutations: number
  /** Abort the proposal call when triggered. */
  readonly signal?: AbortSignal
  /**
   * Proposal strategy pinning the system prompt's risk posture. When
   * omitted, {@link autoStrategy} picks one from the observation mix.
   */
  readonly strategy?: ProposalStrategy
}

/** Render one genome asset for the prompt (compact). */
function renderAsset(asset: GenomeAsset): string {
  return `- ${asset.id} [${asset.status}] v${asset.version}: ${asset.description}`
}

/** Render the recent observations for the prompt. */
function renderObservations(records: readonly ObservationRecord[], cap: number): string {
  let budget = cap
  const lines: string[] = []
  for (const record of records) {
    const line = `[${record.kind}] ${record.key} ×${record.count} (${record.detail})`
    if (line.length > budget) break
    lines.push(line)
    budget -= line.length
  }
  return lines.join('\n')
}

/** Extract the first JSON object from a model response (fence-tolerant). */
function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1]! : trimmed
  try {
    return JSON.parse(candidate)
  } catch {
    // Fall back to the first balanced {...} region when the model added prose.
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) return undefined
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

/**
 * Run one proposal generation pass.
 * @param ctx - context carrying the LLM service.
 * @param genome - current genome assets (the proposal may patch/retire these).
 * @param observations - recent observations, newest first.
 * @param options - provider/model and bounds for the call.
 * @returns the validated proposal, or `null` when the model output failed
 *   parsing/schema validation or the call was aborted.
 */
export async function generateProposal(
  ctx: Context,
  genome: readonly GenomeAsset[],
  observations: readonly ObservationRecord[],
  options: ProposalOptions,
): Promise<Proposal | null> {
  const assetsText = genome.length === 0 ? '(none yet)' : genome.map(renderAsset).join('\n')
  const observationsText = observations.length === 0
    ? '(none yet)'
    : renderObservations(observations, options.maxPromptChars)

  const userText = [
    'Current genome:',
    assetsText,
    '',
    'Recent observations:',
    observationsText,
  ].join('\n')

  // Resolve the proposal strategy: explicit pin wins, else auto-pick
  // from the observation mix.
  const strategy: ProposalStrategy = options.strategy ?? autoStrategy(
    observations.map((r) => r.kind),
  )
  const promptFactory = strategyPrompt(strategy)

  const stream = ctx.llm.stream({
    provider: options.provider,
    model: options.model,
    maxTokens: options.maxTokens,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    system: promptFactory(options.maxMutations),
    messages: [
      createUserMessage({
        content: [{ type: 'text', text: userText.slice(0, options.maxPromptChars) }],
        source: { kind: 'plugin', plugin: 'self-evolve' },
      }),
    ],
  })

  const assembler = new BlockAssembler()
  for await (const chunk of stream) {
    assembler.push(chunk)
  }

  const text = assembler
    .blocks()
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim()

  if (text === '') return null

  const parsed = extractJson(text)
  const validated = proposalSchema.safeParse(parsed)
  if (!validated.success) return null

  const { rationale, expectedImpact, mutations } = validated.data
  return {
    id: randomUUID(),
    rationale,
    expectedImpact,
    mutations: mutations.slice(0, options.maxMutations),
  }
}

/**
 * Resolve the default proposal target from the LLM registry when config does
 * not pin a provider/model: the first registered provider and its first model.
 * @param ctx - context carrying the LLM service.
 * @returns a provider/model pair, or `undefined` when no provider is registered.
 */
export async function resolveProposalTarget(
  ctx: Context,
): Promise<{ provider: string; model: string } | undefined> {
  const providers = ctx.llm.listProviders()
  if (providers.length === 0) return undefined
  const provider = providers[0]!.id
  const models = await ctx.llm.listModels(provider)
  if (models.length === 0) return undefined
  return { provider, model: models[0]!.id }
}

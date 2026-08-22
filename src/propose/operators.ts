/**
 * Mutation operators and proposal vocabulary for dsh-auto-evolve.
 *
 * The plugin owns a closed set of evolvable assets. An operator is one
 * bounded mutation the proposal engine may ask for — the LLM never invents
 * asset kinds, it only fills in operator payloads. This is the safety
 * boundary of the whole evolution loop: the vocabulary is code, the content
 * is model-generated, and both are validated before any trial runs.
 * @module dsh-auto-evolve/src/propose/operators
 */

import { z } from 'zod'
import { EVOLVABLE_KINDS } from '../storage/spec.ts'

/** The bounded mutation vocabulary the proposal engine may emit. */
export const MUTATION_OPERATORS = [
  /** Add a brand-new asset (skill, post-processor, prompt-section, guard-policy). */
  'add',
  /** Replace the body of an existing asset, producing a new version. */
  'patch',
  /** Remove an existing asset from the genome. */
  'retire',
] as const
export type MutationOperator = (typeof MUTATION_OPERATORS)[number]

/** One validated mutation the proposal requests. */
export interface Mutation {
  /** Bounded operator. */
  readonly operator: MutationOperator
  /** Evolvable asset kind (closed vocabulary from the genome spec). */
  readonly kind: (typeof EVOLVABLE_KINDS)[number]
  /** Target asset id for patch/retire (`<kind>:<name>`); empty for add. */
  readonly targetId: string
  /** Kebab-case name for a new/patched asset. */
  readonly name: string
  /** One-line routing description. */
  readonly description: string
  /** Full body: skill markdown, processor rule, prompt text, or policy JSON. */
  readonly content: string
}

/** One complete proposal produced by the engine, after schema validation. */
export interface Proposal {
  /** Fresh proposal id (uuid). */
  readonly id: string
  /** Human-readable rationale for the change. */
  readonly rationale: string
  /** Expected impact, phrased as a measurable direction. */
  readonly expectedImpact: string
  /** The requested mutations (bounded by config `maxProposalsPerTrigger`). */
  readonly mutations: readonly Mutation[]
}

const namePattern = /^[a-z0-9][a-z0-9-]*$/

/**
 * Runtime schema for one mutation. `kind` uses the same closed vocabulary as
 * the genome spec so a validated proposal can never name an unknown asset
 * kind; names must be kebab-case (matching skill naming rules).
 */
export const mutationSchema = z.object({
  operator: z.enum(MUTATION_OPERATORS),
  kind: z.enum(EVOLVABLE_KINDS),
  targetId: z.string(),
  name: z.string().regex(namePattern, 'name must be kebab-case (lowercase letters, digits, hyphens)'),
  description: z.string().min(1).refine(text => text.trim().length > 0, {
    message: 'description must contain a non-whitespace character',
  }),
  content: z.string().min(1).refine(text => text.trim().length > 0, {
    message: 'content must contain a non-whitespace character',
  }),
}).superRefine((mutation, ctx) => {
  if (mutation.operator !== 'add' && mutation.targetId === '') {
    ctx.addIssue({
      code: 'custom',
      path: ['targetId'],
      message: `operator '${mutation.operator}' requires a target asset id`,
    })
  }
  if (mutation.operator === 'add' && mutation.targetId !== '') {
    ctx.addIssue({
      code: 'custom',
      path: ['targetId'],
      message: "operator 'add' must leave targetId empty",
    })
  }
}) satisfies z.ZodType<Mutation>

/** Runtime schema for one complete proposal. */
export const proposalSchema = z.object({
  rationale: z.string().min(1).max(4000),
  expectedImpact: z.string().min(1).max(2000),
  mutations: z.array(mutationSchema).min(1).max(8),
}) satisfies z.ZodType<Omit<Proposal, 'id'>>

/** Derive a mutation's stable asset id from its payload. */
export function mutationAssetId(mutation: Mutation): string {
  return mutation.operator === 'add'
    ? `${mutation.kind}:${mutation.name}`
    : mutation.targetId
}

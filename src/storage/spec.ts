/**
 * Durable storage-domain declaration for dsh-auto-evolve: the genome (current
 * evolvable assets), the evolution ledger (every applied/rolled-back mutation),
 * and the observation log (collected runtime signals). Record schemas are zod
 * (per the storage-domain split rationale); plugin `Config` stays schemastery.
 * @module dsh-auto-evolve/src/storage/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** Kinds of assets this plugin can evolve. */
export const EVOLVABLE_KINDS = [
  'skill',
  'post-processor',
  'prompt-section',
  'guard-policy',
] as const
export type EvolvableKind = (typeof EVOLVABLE_KINDS)[number]

/** Lifecycle status of one genome asset. */
export const ASSET_STATUS = [
  'candidate', // proposed but not yet applied
  'applied', // currently active
  'rolled-back', // was applied, later reverted
  'retired', // replaced by a newer version
] as const
export type AssetStatus = (typeof ASSET_STATUS)[number]

/**
 * One evolvable asset. `id` is the stable key (`<kind>:<name>`); `version`
 * counts mutations of this asset; `parentVersion` is the previous version (or
 * `-1` for a first-generation asset). `content` is the full definition body
 * (skill markdown, processor rule, prompt section text, guard policy JSON).
 */
export const genomeAssetSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(EVOLVABLE_KINDS),
  name: z.string().min(1),
  description: z.string().min(1),
  content: z.string().min(1),
  version: nonNegativeSafeInteger,
  parentVersion: z.number().int().min(-1),
  status: z.enum(ASSET_STATUS),
  /** Epoch ms when this version became active; absent while candidate. */
  appliedAt: nonNegativeSafeInteger.nullable(),
  /** Proposal id that produced this version, when one is known. */
  proposalId: z.string().nullable(),
})
export type GenomeAsset = z.infer<typeof genomeAssetSchema>

/** Kinds of ledger entries. */
export const LEDGER_KINDS = ['apply', 'rollback'] as const
export type LedgerKind = (typeof LEDGER_KINDS)[number]

/**
 * One immutable evolution event. `id` is a uuid; `assetId` points at the
 * mutated asset; `fromVersion`/`toVersion` bracket the change; `reason` is the
 * human-readable rationale (proposal summary or rollback cause).
 */
export const ledgerEntrySchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  kind: z.enum(LEDGER_KINDS),
  fromVersion: nonNegativeSafeInteger,
  toVersion: nonNegativeSafeInteger,
  /** Epoch ms of the event. */
  at: nonNegativeSafeInteger,
  /** Proposal id whose validation authorized this event, when applicable. */
  proposalId: z.string().nullable(),
  /** Trial run id that produced the evidence, when applicable. */
  trialId: z.string().nullable(),
  /**
   * Body of the asset at `fromVersion`, captured so rollback can restore the
   * exact previous content instead of losing it when a patch overwrites the
   * record. Null for first-generation applies.
   */
  prevContent: z.string().nullable(),
  reason: z.string().min(1),
})
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>

/** Kinds of observed runtime signals. */
export const OBSERVATION_KINDS = [
  'tool-failure', // a tool call settled with isError
  'tool-repeat', // identical tool call repeated (no progress)
  'request-error', // an LLM request failed
  'feedback-negative', // user down-voted a message
  'feedback-positive', // user up-voted a message
] as const
export type ObservationKind = (typeof OBSERVATION_KINDS)[number]

/**
 * One collected signal. `key` is the deduplication key (e.g.
 * `tool-failure:fetch` or `request-error:provider/model`); consecutive hits
 * with the same key within a rolling window bump `count` instead of appending.
 */
export const observationRecordSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(OBSERVATION_KINDS),
  key: z.string().min(1),
  count: nonNegativeSafeInteger,
  /** Epoch ms of the first hit in this burst. */
  firstAt: nonNegativeSafeInteger,
  /** Epoch ms of the most recent hit. */
  lastAt: nonNegativeSafeInteger,
  /** Free-form detail of the latest hit (tool name, failure message, etc.). */
  detail: z.string(),
  /** Session id the signal came from, when known. */
  sessionId: z.string().nullable(),
})
export type ObservationRecord = z.infer<typeof observationRecordSchema>

/** Runtime state shared across the plugin (mode is config; generation is durable). */
export const genomeStateSchema = z.object({
  /** Monotonic genome generation: bumps on every applied mutation batch. */
  generation: nonNegativeSafeInteger,
  /** Whether a proposal cycle is currently in flight (re-entrancy guard). */
  cycleActive: z.boolean(),
})
export type GenomeState = z.infer<typeof genomeStateSchema>

/** One durable self-evolve domain: genome assets, ledger, observations, state. */
export const selfEvolveDomainSpec = defineDomain({
  name: 'self_evolve',
  version: 1,
  global: {
    schema: genomeStateSchema,
    initial: { generation: 0, cycleActive: false },
  },
  tables: {
    genome: domainTable<string, GenomeAsset>(genomeAssetSchema),
    ledger: domainTable<string, LedgerEntry>(ledgerEntrySchema),
    observations: domainTable<string, ObservationRecord>(observationRecordSchema),
  },
})

/**
 * Genome snapshot, import, and diff for dsh-auto-evolve.
 *
 * The genome is the plugin's durable "current self": every evolvable asset
 * (skill / post-processor / prompt-section / guard-policy) at its live
 * version. This module makes that state portable and comparable:
 *
 * - **exportGenome** — serialize the *applied* genome as a stable JSON
 *   document (sorted keys, trimmed content) so it can be committed, shared,
 *   or fed back through `importGenome` on another instance.
 * - **importGenome** — validate an exported snapshot with zod and write every
 *   asset into the store as an `applied` asset, replacing any existing asset
 *   with the same id.
 * - **diffGenome** — compute the added / removed / changed asset ids between
 *   two snapshots, the minimal summary a dashboard needs to render "this
 *   evolution changed N skills".
 *
 * The snapshot format is intentionally minimal and forward-compatible: only
 * the fields that define asset *identity and body* are stored, never the
 * transient lifecycle flags (`status`, `appliedAt`) that are import-time
 * derived. A `format` version guards future schema evolution.
 *
 * @module dsh-auto-evolve/src/storage/snapshot
 */

import { z } from 'zod'
import type { SelfEvolveStore } from './store.ts'
import type { EvolvableKind, GenomeAsset } from './spec.ts'
import { EVOLVABLE_KINDS } from './spec.ts'

/** Snapshot format version; bump when the serialized shape changes. */
export const SNAPSHOT_FORMAT = 1

/** One asset entry in the portable snapshot (only identity + body). */
export interface SnapshotAsset {
  readonly id: string
  readonly kind: EvolvableKind
  readonly name: string
  readonly description: string
  readonly content: string
  readonly version: number
  readonly parentVersion: number
  readonly proposalId: string | null
}

/** The portable genome document. */
export interface GenomeSnapshot {
  /** Schema format version (matches {@link SNAPSHOT_FORMAT}). */
  readonly format: typeof SNAPSHOT_FORMAT
  /** Epoch ms the snapshot was taken. */
  readonly exportedAt: number
  /** Genome generation at snapshot time, when known. */
  readonly generation: number | null
  /** Asset entries, sorted by id. Only `applied` assets are exported. */
  readonly assets: readonly SnapshotAsset[]
}

// --- zod schemas (validation gate for import) ----------------------------

const snapshotAssetSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(EVOLVABLE_KINDS),
  name: z.string().min(1),
  description: z.string().min(1),
  content: z.string().min(1),
  version: z.number().int().nonnegative(),
  parentVersion: z.number().int().min(-1),
  proposalId: z.string().nullable(),
})

const genomeSnapshotSchema = z.object({
  format: z.literal(SNAPSHOT_FORMAT),
  exportedAt: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative().nullable(),
  assets: z.array(snapshotAssetSchema),
})

// --- export --------------------------------------------------------------

/**
 * Serialize the current applied genome as a portable snapshot.
 *
 * Only `applied` assets are exported — `candidate` assets are in-flight and
 * not yet part of the live self, while `rolled-back` / `retired` assets are
 * historical (their content lives in the ledger). Asset content is
 * right-trimmed so snapshots are stable across incidental whitespace drift.
 *
 * @param store - durable self-evolve store (read-only access).
 * @param now - wall-clock time of the export (injectable for tests).
 * @returns the portable genome snapshot.
 */
export function exportGenome(store: SelfEvolveStore, now: number = Date.now()): GenomeSnapshot {
  const assets = store
    .listAssets()
    .filter((asset) => asset.status === 'applied')
    .map(toSnapshotAsset)
    .sort((a, b) => a.id.localeCompare(b.id))
  const state = store.state()
  return {
    format: SNAPSHOT_FORMAT,
    exportedAt: now,
    generation: state.generation,
    assets,
  }
}

/** Project one durable {@link GenomeAsset} into a {@link SnapshotAsset}. */
function toSnapshotAsset(asset: GenomeAsset): SnapshotAsset {
  return {
    id: asset.id,
    kind: asset.kind,
    name: asset.name,
    description: asset.description,
    content: asset.content.replace(/\s+$/, ''),
    version: asset.version,
    parentVersion: asset.parentVersion,
    proposalId: asset.proposalId,
  }
}

// --- import --------------------------------------------------------------

/** Result of an import operation. */
export interface ImportResult {
  /** Number of assets written to the store. */
  readonly written: number
  /** Number of existing assets removed because they were absent from the snapshot. */
  readonly removed: number
}

/**
 * Validate and apply a portable genome snapshot to the store.
 *
 * Every asset in the snapshot is written as `applied` (status derived at
 * import time, never stored). Existing assets with the same id are
 * overwritten. Assets in the store that are *not* in the snapshot are
 * deleted, so the store mirrors the snapshot exactly after import.
 *
 * @param store - durable self-evolve store.
 * @param snapshot - the portable genome document to import.
 * @returns counts of written and removed assets.
 * @throws {Error} when the snapshot fails zod validation (wrong format
 *   version, unknown kind, missing fields, etc.).
 */
export async function importGenome(
  store: SelfEvolveStore,
  snapshot: unknown,
): Promise<ImportResult> {
  const parsed = genomeSnapshotSchema.safeParse(snapshot)
  if (!parsed.success) {
    throw new Error(`invalid genome snapshot: ${parsed.error.message}`)
  }
  const data = parsed.data

  const snapshotIds = new Set(data.assets.map((a) => a.id))
  let removed = 0
  for (const existing of store.listAssets()) {
    if (existing.status !== 'applied') continue
    if (!snapshotIds.has(existing.id)) {
      if (await store.deleteAsset(existing.id)) removed++
    }
  }

  let written = 0
  for (const entry of data.assets) {
    const asset: GenomeAsset = {
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      description: entry.description,
      content: entry.content,
      version: entry.version,
      parentVersion: entry.parentVersion,
      status: 'applied',
      appliedAt: data.exportedAt,
      proposalId: entry.proposalId,
    }
    await store.putAsset(asset)
    written++
  }

  return { written, removed }
}

// --- diff ----------------------------------------------------------------

/** The diff between two genome snapshots. */
export interface GenomeDiff {
  /** Asset ids present in `after` but not `before`. */
  readonly added: readonly string[]
  /** Asset ids present in `before` but not `after`. */
  readonly removed: readonly string[]
  /** Asset ids present in both whose content (or version) differs. */
  readonly changed: readonly string[]
}

/**
 * Compute the structural diff between two genome snapshots. An asset is
 * "changed" when its id appears in both snapshots but either the `version`
 * differs or the trimmed `content` differs. The diff is the minimal summary
 * a dashboard needs to render "this evolution changed N skills".
 *
 * @param before - the earlier snapshot.
 * @param after - the later snapshot.
 * @returns the diff with added / removed / changed asset ids, each sorted.
 */
export function diffGenome(before: GenomeSnapshot, after: GenomeSnapshot): GenomeDiff {
  const beforeMap = new Map(before.assets.map((a) => [a.id, a]))
  const afterMap = new Map(after.assets.map((a) => [a.id, a]))

  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []

  for (const [id, afterAsset] of afterMap) {
    const beforeAsset = beforeMap.get(id)
    if (beforeAsset === undefined) {
      added.push(id)
    } else if (
      beforeAsset.version !== afterAsset.version ||
      beforeAsset.content !== afterAsset.content
    ) {
      changed.push(id)
    }
  }
  for (const [id] of beforeMap) {
    if (!afterMap.has(id)) removed.push(id)
  }

  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
  }
}

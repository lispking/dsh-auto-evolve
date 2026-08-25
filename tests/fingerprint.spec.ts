import { describe, expect, it } from 'vitest'
import { dedupMutations, mutationFingerprint } from '../src/propose/fingerprint.ts'
import type { Mutation } from '../src/propose/operators.ts'
import type { GenomeAsset } from '../src/storage/spec.ts'

const addMutation = (overrides: Partial<Mutation> = {}): Mutation => ({
  operator: 'add',
  kind: 'skill',
  targetId: '',
  name: 'retry-helper',
  description: 'Retries flaky calls',
  content: '# Retry Helper\n\nRetry once with backoff.',
  ...overrides,
})

const candidate = (overrides: Partial<GenomeAsset> = {}): GenomeAsset => ({
  id: 'skill:retry-helper',
  kind: 'skill',
  name: 'retry-helper',
  description: 'Retries flaky calls',
  content: '# Retry Helper\n\nRetry once with backoff.',
  version: 0,
  parentVersion: -1,
  status: 'candidate',
  appliedAt: null,
  proposalId: 'proposal-1',
  ...overrides,
})

const proposal = (mutations: readonly Mutation[]) => ({ id: 'p', mutations })

describe('dedupMutations', () => {
  it('drops an add mutation whose content matches an existing candidate', () => {
    // The candidate was materialized from the same `add` (targetId ''), so
    // its reconstructed fingerprint must match — this is the regression test
    // for the targetId mismatch that made add-dedup a no-op.
    const { kept, dropped } = dedupMutations(
      proposal([addMutation()]),
      [candidate()],
    )
    expect(dropped).toHaveLength(1)
    expect(kept).toHaveLength(0)
  })

  it('keeps an add mutation whose content differs from the candidate', () => {
    const { kept, dropped } = dedupMutations(
      proposal([addMutation({ content: '# A different skill\n\nTotally new body.' })]),
      [candidate()],
    )
    expect(dropped).toHaveLength(0)
    expect(kept).toHaveLength(1)
  })

  it('drops a patch mutation matching a patched candidate', () => {
    const patched: GenomeAsset = candidate({
      version: 1,
      parentVersion: 0,
      content: '# Retry Helper\n\nRetry twice with backoff.',
    })
    const mutation: Mutation = {
      operator: 'patch',
      kind: 'skill',
      targetId: 'skill:retry-helper',
      name: 'retry-helper',
      description: 'Retries flaky calls',
      content: '# Retry Helper\n\nRetry twice with backoff.',
    }
    const { kept, dropped } = dedupMutations(proposal([mutation]), [patched])
    expect(dropped).toHaveLength(1)
    expect(kept).toHaveLength(0)
  })

  it('drops a retire mutation matching an existing candidate', () => {
    const existing: GenomeAsset = candidate({ parentVersion: 0, version: 1 })
    const mutation: Mutation = {
      operator: 'retire',
      kind: 'skill',
      targetId: 'skill:retry-helper',
      name: 'retry-helper',
      description: 'Retires the helper',
      content: 'no longer needed',
    }
    // The candidate materialized from this retire has the same name/content.
    const retired: GenomeAsset = candidate({
      parentVersion: 0,
      version: 1,
      name: 'retry-helper',
      description: 'Retires the helper',
      content: 'no longer needed',
    })
    const { kept, dropped } = dedupMutations(proposal([mutation]), [existing, retired])
    expect(dropped).toHaveLength(1)
    expect(kept).toHaveLength(0)
  })

  it('does not dedup against applied or rolled-back assets', () => {
    const { kept, dropped } = dedupMutations(
      proposal([addMutation()]),
      [
        candidate({ status: 'applied', appliedAt: 1 }),
        candidate({ status: 'rolled-back' }),
      ],
    )
    expect(dropped).toHaveLength(0)
    expect(kept).toHaveLength(1)
  })

  it('dedups duplicate mutations within the same proposal', () => {
    const { kept, dropped } = dedupMutations(
      proposal([addMutation(), addMutation()]),
      [],
    )
    expect(dropped).toHaveLength(1)
    expect(kept).toHaveLength(1)
  })
})

describe('mutationFingerprint', () => {
  it('is stable across identical mutations and sensitive to content', () => {
    expect(mutationFingerprint(addMutation())).toBe(mutationFingerprint(addMutation()))
    expect(mutationFingerprint(addMutation({ content: 'x' })))
      .not.toBe(mutationFingerprint(addMutation({ content: 'y' })))
  })

  it('distinguishes add from patch on the target id', () => {
    const add = mutationFingerprint(addMutation())
    const patch = mutationFingerprint({
      operator: 'patch',
      kind: 'skill',
      targetId: 'skill:retry-helper',
      name: 'retry-helper',
      description: 'Retries flaky calls',
      content: '# Retry Helper\n\nRetry once with backoff.',
    })
    expect(add).not.toBe(patch)
  })
})

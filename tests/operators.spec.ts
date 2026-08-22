import { describe, expect, it } from 'vitest'
import { mutationAssetId, mutationSchema, proposalSchema } from '../src/propose/operators.ts'

describe('mutationSchema', () => {
  it('accepts a valid add mutation with an empty targetId', () => {
    const parsed = mutationSchema.safeParse({
      operator: 'add',
      kind: 'skill',
      targetId: '',
      name: 'retry-helper',
      description: 'Retries flaky calls',
      content: '# Retry Helper\n\nWhen a tool fails, retry once with backoff.',
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects an add mutation that names a targetId', () => {
    const parsed = mutationSchema.safeParse({
      operator: 'add',
      kind: 'skill',
      targetId: 'skill:existing',
      name: 'retry-helper',
      description: 'd',
      content: 'body',
    })
    expect(parsed.success).toBe(false)
  })

  it('requires a targetId for patch and retire', () => {
    for (const operator of ['patch', 'retire'] as const) {
      const parsed = mutationSchema.safeParse({
        operator,
        kind: 'guard-policy',
        targetId: '',
        name: 'policy',
        description: 'd',
        content: '{}',
      })
      expect(parsed.success).toBe(false)
    }
  })

  it('rejects unknown operators and asset kinds', () => {
    const badOperator = mutationSchema.safeParse({
      operator: 'destroy',
      kind: 'skill',
      targetId: '',
      name: 'x',
      description: 'd',
      content: 'c',
    })
    expect(badOperator.success).toBe(false)

    const badKind = mutationSchema.safeParse({
      operator: 'add',
      kind: 'binary',
      targetId: '',
      name: 'x',
      description: 'd',
      content: 'c',
    })
    expect(badKind.success).toBe(false)
  })

  it('rejects non-kebab-case names', () => {
    const parsed = mutationSchema.safeParse({
      operator: 'add',
      kind: 'skill',
      targetId: '',
      name: 'Not Kebab',
      description: 'd',
      content: 'c',
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects empty content', () => {
    const parsed = mutationSchema.safeParse({
      operator: 'add',
      kind: 'skill',
      targetId: '',
      name: 'ok-name',
      description: 'd',
      content: '   ',
    })
    expect(parsed.success).toBe(false)
  })
})

describe('proposalSchema', () => {
  it('accepts a complete valid proposal', () => {
    const parsed = proposalSchema.safeParse({
      rationale: 'The fetch tool failed three times in a row.',
      expectedImpact: 'fewer tool failures',
      mutations: [
        {
          operator: 'add',
          kind: 'skill',
          targetId: '',
          name: 'retry-helper',
          description: 'Retries flaky calls',
          content: '# Retry Helper\n\nRetry once with backoff.',
        },
      ],
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a proposal with no mutations', () => {
    const parsed = proposalSchema.safeParse({
      rationale: 'nothing to do',
      expectedImpact: 'none',
      mutations: [],
    })
    expect(parsed.success).toBe(false)
  })
})

describe('mutationAssetId', () => {
  it('derives the asset id from kind:name for adds', () => {
    const mutation = {
      operator: 'add' as const,
      kind: 'skill' as const,
      targetId: '',
      name: 'retry-helper',
      description: 'd',
      content: 'c',
    }
    expect(mutationAssetId(mutation)).toBe('skill:retry-helper')
  })

  it('uses the targetId for patch and retire', () => {
    const mutation = {
      operator: 'patch' as const,
      kind: 'skill' as const,
      targetId: 'skill:retry-helper',
      name: 'retry-helper',
      description: 'd',
      content: 'c',
    }
    expect(mutationAssetId(mutation)).toBe('skill:retry-helper')
  })
})

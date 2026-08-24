/**
 * Mutation application for dsh-auto-evolve: one shared function that applies
 * a genome mutation to a context — the trial agent's scoped context during
 * validation, or the host context at apply time. Keeping both paths on the
 * same code guarantees what passes validation is exactly what gets deployed.
 * @module dsh-auto-evolve/src/apply/mutation
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { EvolvableKind, GenomeAsset } from '../storage/spec.ts'

/** Kinds with a runtime contribution a sandboxed trial replay can exercise. */
const TRIAL_EXERCISABLE = new Set<EvolvableKind>(['skill', 'tool-wrapper', 'guard-policy', 'post-processor'])

/** Whether a kind can be validated (and auto-applied) via trial replay. */
export function isTrialExercisable(kind: EvolvableKind): boolean {
  return TRIAL_EXERCISABLE.has(kind)
}

/** Parsed tool-wrapper mutation content (retry / validate / fallback). */
export interface ToolWrapperConfig {
  readonly tool: string
  readonly retries?: number
  readonly validate?: { readonly schema: unknown; readonly message?: string }
  readonly fallback?: { readonly result: unknown; readonly isError?: boolean }
}

/** Parsed guard-policy mutation content: deny matching executions. */
export interface GuardPolicyConfig {
  /** Restrict the policy to one tool name; omitted = all tools. */
  readonly tool?: string
  /** Denial reason surfaced to the model when a matching call is denied. */
  readonly reason: string
}

/** Parsed post-processor mutation content: prepend a note to successes. */
export interface PostProcessorConfig {
  readonly tool: string
  /** Text block prepended to the named tool's successful result content. */
  readonly note: string
}

/** Parse the tool-wrapper JSON body: `{ tool, retries?, validate?, fallback? }`. */
export function parseToolWrapper(content: string): ToolWrapperConfig {
  const parsed = JSON.parse(content) as {
    tool?: string
    retries?: number
    validate?: { schema?: unknown; message?: string }
    fallback?: { result?: unknown; isError?: boolean }
  }
  if (typeof parsed.tool !== 'string' || parsed.tool.length === 0) {
    throw new Error('tool-wrapper: missing or invalid "tool" field')
  }
  const result: {
    tool: string
    retries?: number
    validate?: { schema: unknown; message?: string }
    fallback?: { result: unknown; isError?: boolean }
  } = { tool: parsed.tool }
  if (parsed.retries !== undefined) result.retries = parsed.retries
  if (parsed.validate !== undefined && parsed.validate.schema !== undefined) {
    result.validate = {
      schema: parsed.validate.schema,
      ...(parsed.validate.message !== undefined ? { message: parsed.validate.message } : {}),
    }
  }
  if (parsed.fallback !== undefined && parsed.fallback.result !== undefined) {
    result.fallback = {
      result: parsed.fallback.result,
      ...(parsed.fallback.isError !== undefined ? { isError: parsed.fallback.isError } : {}),
    }
  }
  return result
}

/** Parse the guard-policy JSON body: `{ tool?, reason }`. */
export function parseGuardPolicy(content: string): GuardPolicyConfig {
  const parsed = JSON.parse(content) as { tool?: unknown; reason?: unknown }
  if (typeof parsed.reason !== 'string' || parsed.reason.length === 0) {
    throw new Error('guard-policy: missing or invalid "reason" field')
  }
  if (parsed.tool !== undefined && typeof parsed.tool !== 'string') {
    throw new Error('guard-policy: "tool" must be a string when present')
  }
  const result: {
    tool?: string
    reason: string
  } = { reason: parsed.reason }
  if (parsed.tool !== undefined) result.tool = parsed.tool
  return result
}

/** Parse the post-processor JSON body: `{ tool, note }`. */
export function parsePostProcessor(content: string): PostProcessorConfig {
  const parsed = JSON.parse(content) as { tool?: unknown; note?: unknown }
  if (typeof parsed.tool !== 'string' || parsed.tool.length === 0) {
    throw new Error('post-processor: missing or invalid "tool" field')
  }
  if (typeof parsed.note !== 'string' || parsed.note.length === 0) {
    throw new Error('post-processor: missing or invalid "note" field')
  }
  return { tool: parsed.tool, note: parsed.note }
}

/** Minimal JSON Schema argument validation (type + required only). */
function validateArguments(args: unknown, schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object') return true
  const s = schema as { type?: string; required?: string[]; properties?: Record<string, unknown> }
  if (s.type === 'object' && (args === null || typeof args !== 'object')) return false
  if (s.required !== undefined && args !== null && typeof args === 'object') {
    const obj = args as Record<string, unknown>
    for (const key of s.required) {
      if (obj[key] === undefined) return false
    }
  }
  return true
}

/** Build the tools/execute wrapper for a parsed tool-wrapper config. */
function wrapToolExecution(config: ToolWrapperConfig): (
  exec: Readonly<ToolExecution>,
  next: () => Promise<ToolExecutionResult>,
) => Promise<ToolExecutionResult> {
  return async (exec, next) => {
    if (exec.name !== config.tool) return next()
    // Argument validation gate.
    if (config.validate !== undefined) {
      const ok = validateArguments(exec.arguments, config.validate.schema)
      if (!ok) {
        return {
          isError: true,
          error: { message: config.validate.message ?? 'argument validation failed' },
        } as ToolExecutionResult
      }
    }
    // Retry-on-error with fallback.
    const maxAttempts = (config.retries ?? 0) + 1
    const attempt = (remaining: number): Promise<ToolExecutionResult> =>
      next().then((r) => {
        if (r.isError && remaining > 0) return attempt(remaining - 1)
        if (r.isError && config.fallback !== undefined) {
          return {
            isError: config.fallback.isError ?? false,
            result: config.fallback.result,
          } as unknown as ToolExecutionResult
        }
        return r
      })
    return attempt(maxAttempts - 1)
  }
}

/**
 * Apply one mutation to `ctx` — a trial agent's scoped context or the host
 * context — and return its disposer. Returns `undefined` for kinds with no
 * runtime contribution (prompt-section in this release); the caller decides
 * whether to skip or record them.
 */
export function applyMutation(ctx: Context, asset: GenomeAsset): (() => void) | undefined {
  switch (asset.kind) {
    case 'skill': {
      const registration: SkillRegistration = {
        name: asset.name,
        description: asset.description,
        content: asset.content,
        source: 'runtime',
        invocation: { modelInvocable: true, userInvocable: false },
      }
      return ctx.skills.register(registration)
    }
    case 'tool-wrapper': {
      const config = parseToolWrapper(asset.content)
      return ctx.on('tools/execute', wrapToolExecution(config) as never)
    }
    case 'guard-policy': {
      const config = parseGuardPolicy(asset.content)
      return ctx.tools.guard((execution) => {
        if (config.tool !== undefined && execution.name !== config.tool) return undefined
        return config.reason
      })
    }
    case 'post-processor': {
      const config = parsePostProcessor(asset.content)
      const listener = (
        exec: Readonly<ToolExecution>,
        next: () => Promise<ToolExecutionResult>,
      ): Promise<ToolExecutionResult> => {
        if (exec.name !== config.tool) return next()
        return next().then((result) => {
          if (result.isError) return result
          return {
            ...result,
            content: [{ type: 'text', text: config.note }, ...(result.content ?? [])],
          } as ToolExecutionResult
        })
      }
      return ctx.on('tools/execute', listener as never)
    }
    case 'prompt-section':
      // No system-prompt injection surface exists in this harness release;
      // prompt-section candidates stay manual-only (recorded, not applied).
      return undefined
  }
}

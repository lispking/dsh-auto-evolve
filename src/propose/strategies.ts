/**
 * Multi-strategy proposal engine for dsh-auto-evolve.
 *
 * The original proposal engine used a single system prompt for every cycle.
 * That prompt had to be simultaneously aggressive enough to fix real
 * regressions and conservative enough not to invent problems — a tension
 * it could not resolve. This module splits the prompt into three
 * pluggable strategies, each with a distinct risk posture:
 *
 * - **minimal-patch** — only tweak an existing asset's `description` or
 *   make a tiny, surgical content edit. Lowest risk, lowest payoff.
 *   Default for `observe` and `propose` modes where a human reviews.
 * - **structural** — rewrite an asset's `content` body wholesale, or add
 *   a brand-new asset. Medium risk, medium payoff. The original behavior.
 * - **meta** — change a `guard-policy` or `tool-wrapper` asset to
 *   *indirectly* constrain other assets (retry budgets, validation
 *   gates). Highest leverage, highest risk.
 *
 * Strategies are pure functions: `(maxMutations) => string` returning the
 * system prompt. The engine picks one per cycle via {@link ProposalStrategy}
 * in {@link ProposalOptions}.
 *
 * @module dsh-auto-evolve/src/propose/strategies
 */

/** Identifier of one proposal strategy. */
export type ProposalStrategy = 'minimal-patch' | 'structural' | 'meta'

/** All available strategies, in order of increasing risk. */
export const STRATEGIES: readonly ProposalStrategy[] = [
  'minimal-patch',
  'structural',
  'meta',
]

/** The shared prompt header describing the evolvable asset kinds. */
const HEADER = [
  'You are the self-improvement engine of a coding agent harness.',
  'You propose changes to YOUR OWN small set of evolvable assets.',
  'You never change user code or sessions — only assets owned by the plugin:',
  'skills (reusable agent skill markdown), post-processors (tool-result',
  'rewriting rules), prompt-sections (system prompt text), guard-policies',
  '(JSON policy rules), tool-wrappers (JSON retry/validation config for',
  'error-prone tools).',
  '',
  'Output exactly ONE JSON object with this shape (no markdown fences, no commentary):',
  '{"rationale":"...","expectedImpact":"...","mutations":[',
  '{"operator":"add|patch|retire","kind":"skill|post-processor|prompt-section|guard-policy|tool-wrapper",',
  '"targetId":"<kind>:<name> or empty for add","name":"kebab-case","description":"one line",',
  '"content":"full body"}]}',
].join('\n')

/** Shared rules block; strategies append their own directives after this. */
function sharedRules(maxMutations: number): string {
  return [
    'Rules:',
    `- emit at most ${maxMutations} mutation(s)`,
    '- operator "add" requires an empty targetId and a fresh name',
    '- operator "patch"/"retire" requires targetId matching an existing asset',
    '- names must be kebab-case (lowercase letters, digits, hyphens)',
    '- content must be the complete new body, never a diff or placeholder',
    '- base every change on the observations below; do not invent problems',
  ].join('\n')
}

/**
 * **minimal-patch** strategy: only adjust an existing asset's description
 * or make a surgical one-line content edit. Lowest risk; ideal when the
 * genome is already mostly-correct and observations suggest a routing
 * problem (wrong skill picked) rather than a content problem.
 */
function minimalPatchPrompt(maxMutations: number): string {
  return [
    HEADER,
    '',
    'Strategy: MINIMAL-PATCH',
    '- prefer operator "patch" on an existing asset',
    '- edit only the description, or make a one-line content change',
    '- do NOT rewrite the full content body',
    '- do NOT add or retire assets',
    '',
    sharedRules(maxMutations),
  ].join('\n')
}

/**
 * **structural** strategy: rewrite an asset's content body wholesale, or
 * add a brand-new asset. Medium risk, medium payoff. This is the original
 * engine behavior — the right default when observations show repeated
 * failures that a description tweak cannot fix.
 */
function structuralPrompt(maxMutations: number): string {
  return [
    HEADER,
    '',
    'Strategy: STRUCTURAL',
    '- operator "patch" may rewrite the full content body',
    '- operator "add" may introduce a new skill or post-processor',
    '- prefer fixing the root cause over adding workarounds',
    '',
    sharedRules(maxMutations),
  ].join('\n')
}

/**
 * **meta** strategy: change a guard-policy or tool-wrapper asset to
 * *indirectly* constrain other assets. Highest leverage: a single
 * guard-policy edit can prevent a whole class of failures. Highest risk:
 * a bad guard can silently suppress legitimate tool calls.
 */
function metaPrompt(maxMutations: number): string {
  return [
    HEADER,
    '',
    'Strategy: META',
    '- prefer operator "add" or "patch" on kind "guard-policy" or "tool-wrapper"',
    '- a guard-policy edit should add a validation gate or retry budget',
    '- a tool-wrapper edit should add retry-on-error or argument validation',
    '- do NOT edit skills or prompt-sections directly in this strategy',
    '',
    sharedRules(maxMutations),
  ].join('\n')
}

/** Resolve a strategy name to its system-prompt factory. */
export function strategyPrompt(strategy: ProposalStrategy): (maxMutations: number) => string {
  switch (strategy) {
    case 'minimal-patch':
      return minimalPatchPrompt
    case 'meta':
      return metaPrompt
    case 'structural':
    default:
      return structuralPrompt
  }
}

/**
 * Pick a strategy automatically from the observation mix, for callers that
 * do not want to pin one explicitly. The heuristic:
 *
 * - if every observation is a `tool-failure` or `request-error`, use
 *   `meta` (the problem is tool/LLM reliability, not skill content);
 * - if observations are mostly `tool-repeat` (loops), use `structural`
 *   (the skill body is leading the agent into a loop);
 * - otherwise default to `minimal-patch`.
 */
export function autoStrategy(
  observationKinds: readonly string[],
): ProposalStrategy {
  const counts = new Map<string, number>()
  for (const kind of observationKinds) {
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  const total = observationKinds.length
  if (total === 0) return 'minimal-patch'
  const toolFailures = counts.get('tool-failure') ?? 0
  const requestErrors = counts.get('request-error') ?? 0
  const toolRepeats = counts.get('tool-repeat') ?? 0
  if (toolFailures + requestErrors >= Math.ceil(total * 0.6)) return 'meta'
  if (toolRepeats >= Math.ceil(total * 0.5)) return 'structural'
  return 'minimal-patch'
}

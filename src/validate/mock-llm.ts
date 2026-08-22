/**
 * Deterministic mock LLM for trial replay in dsh-auto-evolve.
 *
 * A real trial depends on the LLM's non-deterministic output: the same
 * episode replayed twice can take different tool paths, so the baseline
 * vs trial comparison has high variance. This module provides a
 * deterministic **scripted** stream that the trial layer can inject in
 * place of `ctx.llm.stream`, giving:
 *
 * - reproducible trial runs for unit tests and CI
 * - a way to measure *pure* mutation impact with the model held fixed
 * - a fallback when a real LLM is unavailable in the test environment
 *
 * The mock replays a pre-recorded sequence of text deltas and tool-call
 * blocks, terminating with a `finish` chunk. It does not attempt to model
 * tool dispatch — that remains the harness's job. The trial agent will
 * call the registered tools exactly as with a live model, but the model's
 * *choices* are pre-baked.
 *
 * @module dsh-auto-evolve/src/validate/mock-llm
 */

import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/** One scripted assistant turn (a text utterance and/or tool calls). */
export interface ScriptedTurn {
  /**
   * The text the mock model emits for this turn. Empty for a pure
   * tool-call turn.
   */
  readonly text?: string
  /**
   * Tool calls the mock model makes this turn. Each entry is a tool name
   * plus the arguments object that will be forwarded to the tool.
   */
  readonly toolCalls?: readonly {
    readonly name: string
    readonly arguments: Readonly<Record<string, unknown>>
  }[]
}

/** A deterministic async iterable that mimics an LLM stream. */
export class ScriptedLlmStream implements AsyncIterable<StreamChunk> {
  private readonly turns: readonly ScriptedTurn[]
  private consumed = 0

  constructor(turns: readonly ScriptedTurn[]) {
    this.turns = turns
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
    let blockIndex = 0
    const chunk = (value: unknown): StreamChunk => value as unknown as StreamChunk
    for (const turn of this.turns) {
      if (turn.text !== undefined && turn.text.length > 0) {
        yield chunk({ type: 'block-start', index: blockIndex, blockType: 'text' })
        yield chunk({ type: 'text-delta', index: blockIndex, text: turn.text })
        yield chunk({
          type: 'block-end',
          index: blockIndex,
          block: { type: 'text', text: turn.text },
        })
        blockIndex++
      }
      if (turn.toolCalls !== undefined) {
        for (const call of turn.toolCalls) {
          yield chunk({
            type: 'block-start',
            index: blockIndex,
            blockType: 'tool-call',
          })
          yield chunk({
            type: 'tool-call-delta',
            index: blockIndex,
            id: `call-${blockIndex}`,
            name: call.name,
            argumentsDelta: JSON.stringify(call.arguments),
          })
          yield chunk({
            type: 'block-end',
            index: blockIndex,
            block: {
              type: 'tool-call',
              id: `call-${blockIndex}`,
              name: call.name,
              arguments: call.arguments,
            },
          })
          blockIndex++
        }
      }
      this.consumed++
    }
    yield chunk({ type: 'finish', reason: 'stop' })
  }

  /** How many turns have been consumed so far (diagnostics/tests). */
  get consumedTurns(): number {
    return this.consumed
  }
}

/** Options for {@link createMockLlmStream}. */
export interface MockLlmOptions {
  /** The scripted turns to replay, in order. */
  readonly turns: readonly ScriptedTurn[]
  /**
   * Optional seed for a deterministic turn selector. When provided, the
   * mock applies a seeded xorshift shuffle to `turns`, giving cross-run
   * reproducibility even when the script is large.
   */
  readonly seed?: number
}

/**
 * Create a deterministic mock LLM stream from a script of turns.
 *
 * @param options - the script and optional seed.
 * @returns a stream that replays the script verbatim.
 */
export function createMockLlmStream(options: MockLlmOptions): ScriptedLlmStream {
  if (options.seed !== undefined) {
    const prng = createPrng(options.seed)
    const shuffled = [...options.turns]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(prng() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
    }
    return new ScriptedLlmStream(shuffled)
  }
  return new ScriptedLlmStream(options.turns)
}

/**
 * A tiny xorshift32 PRNG. Deterministic for a given seed, which is what we
 * need for reproducible trial replays.
 */
function createPrng(seed: number): () => number {
  let state = seed >>> 0
  if (state === 0) state = 0x9e3779b9
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
}

/**
 * A factory that builds a fresh mock stream for one trial call. The trial
 * layer can swap `ctx.llm.stream` for this factory to get deterministic
 * replays without touching the harness's real LLM wiring.
 */
export type MockStreamFactory = (request: {
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
  readonly system?: string
  readonly messages: readonly unknown[]
  readonly signal?: AbortSignal
}) => ScriptedLlmStream

/**
 * Build a {@link MockStreamFactory} from a fixed script. Every call
 * returns a fresh stream backed by the same script, so multiple trials
 * replay identically.
 */
export function mockStreamFactory(turns: readonly ScriptedTurn[]): MockStreamFactory {
  return () => createMockLlmStream({ turns })
}

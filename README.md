# dsh-self-evolve

A **self-evolving plugin** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). It observes how the agent runs, proposes improvements to *its own* assets via the LLM, validates each proposal inside a sandboxed trial agent, and applies only verified mutations — with a versioned ledger and automatic rollback on regression.

[中文](README.zh.md)

> **The idea.** Instead of shipping a static skill set, the plugin owns a small *genome* of evolvable assets (skills, tool-result post-processors, prompt sections, guard policies). Every runtime signal (tool failures, repeated calls, request errors) is collected; when a threshold crosses, a proposal cycle drafts a mutation, a sandboxed agent replays the failing episode with and without the change, and the change is applied only if the trial shows measurable improvement. Every mutation is versioned in a durable ledger and can be rolled back.

## How it works

```
Observe ──▶ Propose ──▶ Validate ──▶ Apply ──▶ (observe again, for regressions)
  │             │            │            │
  tools/result  ctx.llm      sandboxed    ctx.skills.register + ledger
  request-error (stream)     sub-agent    disposer kept for rollback
```

### The evolution loop

| Layer | Module | What it does |
|---|---|---|
| **Observe** | `src/observe` | Listens on `tools/result` and `agent/request-error`; records deduplicated signals (tool failures, no-progress repeats, request errors) into the durable observations table; fires `onTrigger` when a threshold crosses. |
| **Propose** | `src/propose` | A bounded cycle snapshots the genome + recent observations, calls `ctx.llm.stream()` with a strict prompt, and validates the model output against a closed mutation vocabulary (`add` / `patch` / `retire` over `skill` / `post-processor` / `prompt-section` / `guard-policy`). Anything that fails parsing or schema validation is discarded — never applied. |
| **Validate** | `src/validate` | Replays the failing episode inside a fresh scoped sub-agent (`ctx.agents.create` + `setup`), once without the candidate mutations (baseline) and once with them (trial), then compares metrics: completion, tool failures, tool-call cost. |
| **Apply** | `src/apply` | Promotes a validated candidate to the live genome: skills are registered on the plugin context via `ctx.skills.register` (immediately visible), the ledger records the apply with the previous content captured, and the disposer is kept for rollback. |
| **Rollback** | `src/apply` | Unregisters the live contribution, restores the parent content as a fresh candidate, and writes a `rollback` ledger entry. On plugin disposal every live registration is torn down. |

### Safety boundaries

- **The mutation vocabulary is code, the content is model-generated.** The LLM never invents asset kinds or operators; it only fills in payloads that pass the closed zod schema.
- **Validation is by execution, not by self-claim.** A proposal is applied only when a sandboxed trial beats the baseline on observable metrics.
- **Rollback is first-class.** Every applied mutation keeps its disposer and its parent content; regression reverts the exact previous state.
- **Observe-only is the default.** In `observe` mode the plugin never proposes — it just collects signals and logs triggers.

## Installation

The plugin is a **dsh bundle**: install it with the official CLI in one command — no manual `cordis.yml` editing required.

```sh
# Install into the web profile (the default UI profile)
dsh plugin --profile web add dsh-self-evolve

# Or into the TUI profile
dsh plugin --profile tui add dsh-self-evolve
```

`dsh plugin add` initializes the profile if needed, installs the package, and automatically adds `dsh-self-evolve` to the profile's bundle stack (`dsh.profile.bundles`). The bundled `cordis.patch.yml` registers the plugin row with the defaults below; restart `dsh` and the plugin is live.

Local development / source build:

```sh
git clone https://github.com/lispking/dsh-self-evolve.git
cd dsh-self-evolve
pnpm install
pnpm build
# Install your local checkout into a profile
dsh plugin --profile web add /absolute/path/to/dsh-self-evolve
```

### Custom configuration

The bundle applies a default config; to change it, override the row in your own profile patch (applied after every bundle layer):

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: self-evolve
  config:
    mode: auto-apply        # observe | propose | auto-apply
    observation:
      toolFailureThreshold: 3
      repeatThreshold: 3
      requestErrorThreshold: 3
      windowMs: 300000
    proposal:
      maxProposalsPerTrigger: 1
      maxEpisodesPerProposal: 5
      maxPromptChars: 24000
      maxTokens: 2000
    validation:
      maxTrialMs: 30000
      maxToolCalls: 20
      maxTrialSteps: 12
      maxTrialTokens: 8000
```

> Note: a patch **replaces** the row's whole config rather than merging into it, so specify every field you want to keep. The plugin's peer services (storage, LLM, tools, skills) come from the dsh-base/web bundles — no extra setup.

### Modes

| Mode | Behavior |
|---|---|
| `observe` | Collect signals, fire triggers, **never propose**. Safe default. |
| `propose` | Generate and persist candidate mutations when thresholds cross. Candidates await validation/application (manual or via the exported API). |
| `auto-apply` | Run the full loop: observe → propose → validate → apply verified mutations automatically, with automatic rollback when the same failure key recurs after an apply (regression watch). |

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `mode` | `observe` | Evolution mode (see above). |
| `observation.toolFailureThreshold` | `3` | Tool-failure burst count that triggers a cycle. |
| `observation.repeatThreshold` | `3` | Identical-call count treated as a no-progress loop. |
| `observation.requestErrorThreshold` | `3` | LLM request-error count that triggers a cycle. |
| `observation.windowMs` | `300000` | Rolling window (ms) over which signal counts aggregate. |
| `proposal.maxProposalsPerTrigger` | `1` | Max mutations per proposal. |
| `proposal.maxEpisodesPerProposal` | `5` | Max observations rendered into the proposal prompt. |
| `proposal.maxPromptChars` | `24000` | Prompt size cap (bounds cost). |
| `proposal.maxTokens` | `2000` | Max output tokens for one proposal call. |
| `validation.maxTrialMs` / `maxToolCalls` | `30000` / `20` | Trial wall-clock and tool-call caps. |
| `validation.maxTrialSteps` / `maxTrialTokens` | `12` / `8000` | Trial model-step and per-request token caps. |

## Programmatic API

```ts
import { SelfEvolveStore, SelfEvolveApplier, runProposalCycle, validateMutations } from 'dsh-self-evolve'

// Run one proposal cycle (persists candidate assets).
const materialized = await runProposalCycle(ctx, store, { provider, model, maxTokens: 2000 })

// Validate a candidate: baseline vs trial replay, returns the verdict.
const { baseline, trial, comparison } = await validateMutations(ctx, {
  provider,
  model,
  episode: 'replay of the failing scenario',
  mutations: [candidateAsset],
  bounds: { maxTrialMs: 30_000, maxToolCalls: 20 },
})

// Apply a validated candidate (registers the skill live) or roll it back.
await applier.applyCandidate(candidate.id, trialId, 'validated')
await applier.rollback(candidate.id, 'regression observed')
```

## Development

```sh
pnpm build   # tsc + tsdown → lib/
pnpm test    # vitest (unit + integration over a memory storage backend)
```

The test suite covers the pure decision logic (metrics comparison, mutation schema, thresholds) and the full wiring (durable store, observation collector, proposal cycle with a scripted LLM adapter, apply/rollback with the real skill registry).

## License

[MIT](LICENSE)

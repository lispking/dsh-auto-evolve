# dsh-auto-evolve

一个用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(`dsh`)的**自我进化插件**。它观察 agent 的运行表现,通过 LLM 提议改进**它自己**的资产,在每个提案放入沙箱子 agent 验证之后,只应用通过验证的变异——并配备版本化台账与回归自动回滚。

[English](README.md)

> **核心理念。** 插件不提供一套静态技能,而是拥有一个小型可进化**基因组**(skill、工具结果后处理器、系统提示词片段、防护策略)。所有运行时信号(工具失败、重复调用、请求错误)被持续采集;当阈值被越过时,提议周期草拟一个变异,沙箱子 agent 分别带与不带该变异重放失败片段,只有试运行表现出可测改进时才应用该变异。每个变异都记入持久化台账且可回滚。

## 工作原理

```
观察 ──▶ 提议 ──▶ 验证 ──▶ 应用 ──▶(再次观察,捕捉回归)
  │            │           │           │
  tools/result ctx.llm     沙箱子      ctx.skills.register + 台账
  request-error(流式)      子 agent    保留 disposer 用于回滚
```

### 进化闭环

| 层 | 模块 | 职责 |
|---|---|---|
| **观察** | `src/observe` | 监听 `tools/result` 与 `agent/request-error`;将去重信号(工具失败、无进展的重复调用、请求错误)写入持久化观察表;阈值被越过时触发 `onTrigger`。 |
| **提议** | `src/propose` | 有界周期快照基因组 + 近期观察,以严格提示词调用 `ctx.llm.stream()`,并用封闭变异词表(`add` / `patch` / `retire`,作用于 `skill` / `post-processor` / `prompt-section` / `guard-policy`)校验模型输出。任何解析或 schema 校验失败都会被丢弃——绝不应用。 |
| **验证** | `src/validate` | 在一个全新作用域子 agent(`ctx.agents.create` + `setup`)中重放失败片段:一次不带候选变异(基线),一次带变异(试运行),然后对比指标:完成度、工具失败数、工具调用成本。 |
| **应用** | `src/apply` | 将已验证候选提升为在线基因组:skill 通过 `ctx.skills.register` 注册到插件上下文(立即可见),台账记录本次应用并保存上一版内容,disposer 保留用于回滚。 |
| **回滚** | `src/apply` | 注销在线贡献,将父版本内容恢复为新的候选,写入 `rollback` 台账条目。插件销毁时所有在线注册被拆除。 |

### 安全边界

- **变异词表是代码,内容是模型生成的。** LLM 无法发明资产种类或算子,只能填写通过封闭 zod schema 校验的载荷。
- **验证靠执行,而非自我声称。** 只有沙箱试运行在可观测指标上胜过基线时,提案才会被应用。
- **回滚是一等公民。** 每个已应用变异都保留自己的 disposer 与父版本内容;回归时精确还原上一状态。
- **默认只观察。** 在 `observe` 模式下插件从不提议,只采集信号并记录触发。

## 安装

本插件是一个 **dsh bundle**:用官方 CLI 一条命令安装,无需手改 `cordis.yml`。

```sh
# 装入 web profile(默认 UI profile)
dsh plugin --profile web add dsh-auto-evolve

# 或装入 TUI profile
dsh plugin --profile tui add dsh-auto-evolve
```

`dsh plugin add` 会按需初始化 profile、安装包,并自动把 `dsh-auto-evolve` 加入 profile 的 bundle 层栈(`dsh.profile.bundles`)。随包发布的 `cordis.patch.yml` 以默认配置注册插件行;重启 `dsh` 后插件即生效。

本地开发 / 源码构建:

```sh
git clone https://github.com/lispking/dsh-auto-evolve.git
cd dsh-auto-evolve
pnpm install
pnpm build
# 把本地 checkout 装入 profile
dsh plugin --profile web add /绝对/路径/to/dsh-auto-evolve
```

### 自定义配置

bundle 应用一份默认配置;如需修改,在你自己 profile 的 patch(在所有 bundle 层之后应用)中按 id 覆盖:

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
    evolution:
      stallThreshold: 3
      stallPauseMs: 1800000
      cooldownMs: 600000
```

> 注意:patch 会**整体替换**该行的 config 而非合并,所以需要保留的字段都要写上。插件的对等服务(存储、LLM、工具、skill)由 dsh-base / web bundle 提供,无需额外配置。

### 模式

| 模式 | 行为 |
|---|---|
| `observe` | 采集信号、触发记录,**从不提议**。安全的默认值。 |
| `propose` | 阈值越过时生成并持久化候选变异。候选等待验证/应用(手动或通过导出的 API)。 |
| `auto-apply` | 运行完整闭环:观察 → 提议 → 验证 → 自动应用通过验证的变异,并在同一失败 key 于应用后再次出现时自动回滚(回归监视)。连续停滞达到阈值后自动暂停(收敛),失败/回滚后的 key 进入冷却期,避免"提议 → 失败 → 再提议"的抖动。 |

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | `observe` | 进化模式(见上表)。 |
| `observation.toolFailureThreshold` | `3` | 触发周期的工具失败爆发计数。 |
| `observation.repeatThreshold` | `3` | 视为无进展循环的相同调用计数。 |
| `observation.requestErrorThreshold` | `3` | 触发周期的 LLM 请求错误计数。 |
| `observation.windowMs` | `300000` | 信号计数聚合的滚动窗口(毫秒)。 |
| `proposal.maxProposalsPerTrigger` | `1` | 每个提案的最大变异数。 |
| `proposal.maxEpisodesPerProposal` | `5` | 渲染进提议提示词的观察数上限。 |
| `proposal.maxPromptChars` | `24000` | 提示词大小上限(控制成本)。 |
| `proposal.maxTokens` | `2000` | 一次提议调用的最大输出 token 数。 |
| `validation.maxTrialMs` / `maxToolCalls` | `30000` / `20` | 试运行的墙钟与工具调用上限。 |
| `validation.maxTrialSteps` / `maxTrialTokens` | `12` / `8000` | 试运行的模型步数上限与单次请求 token 上限。 |
| `evolution.stallThreshold` | `3` | 连续停滞周期数,达到后暂停 auto-apply。 |
| `evolution.stallPauseMs` | `1800000` | 一次收敛暂停的时长(毫秒),到期后自动恢复。 |
| `evolution.cooldownMs` | `600000` | 失败/回滚周期后,同一观察 key 的冷却时长(毫秒)。 |

## 编程 API

```ts
import { SelfEvolveStore, SelfEvolveApplier, runProposalCycle, validateMutations } from 'dsh-auto-evolve'

// 运行一个提议周期(持久化候选资产)。
const materialized = await runProposalCycle(ctx, store, { provider, model, maxTokens: 2000 })

// 验证候选:基线 vs 试运行重放,返回结论。
const { baseline, trial, comparison } = await validateMutations(ctx, {
  provider,
  model,
  episode: '失败场景的重放',
  mutations: [candidateAsset],
  bounds: { maxTrialMs: 30_000, maxToolCalls: 20 },
})

// 应用已验证候选(在线注册 skill)或回滚。
await applier.applyCandidate(candidate.id, trialId, 'validated')
await applier.rollback(candidate.id, 'regression observed')
```

## 开发

```sh
pnpm build   # tsc + tsdown → lib/
pnpm test    # vitest(单元 + 基于内存存储后端的集成)
```

测试套件覆盖纯决策逻辑(指标对比、变异 schema、阈值)与完整接线(持久化存储、观察采集器、脚本化 LLM 适配器的提议周期、真实 skill 注册表上的应用/回滚)。

## 许可证

[MIT](LICENSE)

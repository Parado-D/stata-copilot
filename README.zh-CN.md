# stata-copilot（中文说明）

[![ci](https://github.com/Parado-D/stata-copilot/actions/workflows/ci.yml/badge.svg)](https://github.com/Parado-D/stata-copilot/actions/workflows/ci.yml)

**一个让 AI 助手变成「守规矩的 Stata 分析员」的 MCP 服务器 + 技能包。**

英文文档见 [README.md](README.md)。

模型早就会在终端里敲 `regress y x`。它不会的是：把 Stata 的回显可靠地读成数字、分清系数和脚注、
知道 `erase` 不能碰，以及留下一条可以放进复现附录的运行记录。这个项目补的就是这一段：

| | |
|---|---|
| **结构化结果** | `stata_model` 每个变量返回 `{name, b, se, t, p, ciLo, ciHi}`，外加 `{n, r2, F, df_r, crit, omitted}`——不是一张要眯着眼看的表。`stata_results` 把 `r()` / `e()` 宏变成 JSON。 |
| **安全护栏** | 终端逃逸、`erase`、以及 `readonly` 模式下所有写盘命令，在送到 Stata 之前就被拒。工作目录白名单把运行范围钉在项目里。 |
| **可复现记录** | 每次运行追加一行到 `<cwd>/.stata-copilot/runs.jsonl`：命令、目录、返回码、耗时、图数量。`stata_history` 可回读。 |
| **零运行时依赖** | 服务器是纯 Node（≥18）写 JSON-RPC over stdio，不需要 `npm install`，也没有供应链可审。 |

## 环境要求

- **Stata** 17 或 18（MP/SE/BE），已授权且能被找到。
- 一个在跑的 **`stata-ai-skill`** 服务——本地 HTTP 会话管理器，服务器通过它驱动 Stata
  （默认 `http://127.0.0.1:19522`）。它持有真正的 Stata 进程、授权与图捕获。
- **Node.js ≥ 18.17**（只用来跑服务器；计算都发生在 Stata 里）。

服务没起来时，每个工具都会带 `OFFLINE` 和它试过的地址失败——不会静默失败。

## 安装

### DeepSeek Harness：装 bundle，不用手写配置

本包同时是一个 DSH carrier bundle（`package.json` 里的 `dsh.bundle.patch`），它会自己挂上
MCP 那一行，不需要你编辑 JSON：

1. **设置 → 插件 → 从来源安装**，粘贴 `https://github.com/Parado-D/stata-copilot`。
2. 新开一个会话。工具会以 `mcp__stata__stata_status`、`mcp__stata__stata_run` … 出现。
   不用重启 Host——MCP 条目是在会话创建时读取的。

> 只在「来源」栏填 Git 地址。插件管理器对话框里若还有「安装源 / registry」一栏，请保持默认
> （`https://registry.npmjs.org/`）。把仓库地址也填进 registry，pnpm 会把命令拼成
> `pnpm add <仓库URL> --registry=<仓库URL>`，于是它转身去仓库里找 `@tryao/...`、`dsh-plugin-dev-kb`
> 这些包，报 `ERR_PNPM_FETCH_404 … /@tryao%2Fdsh-wps365-plugin`。

也可以用命令行，从本地检出装：

```bash
dsh plugin --profile <profile> add file:/path/to/stata-copilot   # 复制
dsh plugin --profile <profile> add link:/path/to/stata-copilot   # 软链，改代码即时生效
```

挂载写在 [`cordis.patch.yml`](cordis.patch.yml) 里，两个细节值得知道：

- 这一行用 **DSH 自己的可执行文件 + `ELECTRON_RUN_AS_NODE=1`** 启动服务器，所以 `PATH` 上不需要
  独立的 `node`；在源码检出里 `process.execPath` 就是 node，这个变量无副作用。
- `failOnStartupError: false` 加 `reconnect` 块：Stata 没装、或 `stata-ai-skill` 没起来，会退化成
  「工具不可用」，而不是让整个剖面起不来。

要调这一行的参数，在你自己的剖面 patch 层里覆盖，不要改包内文件：

```yaml
- id: stata-copilot-mcp
  config:
    cwd: 'D:\papers\my-study'          # 默认：用户主目录
    env:
      STATA_COPILOT_MODE: readonly     # open | guarded | readonly
      STATA_COPILOT_ROOTS: 'D:\papers'
```

### 其他 MCP 客户端（Claude Code / Cursor / Windsurf / Claude Desktop）

**Claude Code**（项目根目录 `.mcp.json`）：

```json
{
  "mcpServers": {
    "stata": {
      "command": "node",
      "args": ["C:/tools/stata-copilot/bin/stata-copilot.mjs", "--mode", "guarded", "--root", "."]
    }
  }
}
```

Cursor / Windsurf / Claude Desktop 用同一段 `mcpServers`。可复制的两个版本在
[`examples/`](examples/)：`mcp-config.json` 给上面的客户端，`dsh.cordis.yml` 给 DeepSeek Harness
（`dsh web --patch ...`）。

Codex 或别的 agent：契约就是「stdio 上的 JSON-RPC」，仅此而已。

```bash
stata-copilot --mode guarded    # npm link 之后；在 stdin/stdout 上说 JSON-RPC
```

### 装没装对？跑一遍

```bash
node bin/stata-copilot.mjs --doctor
```

打印一个 JSON：配置、引擎是否可达、服务找到的 Stata 版本、授权状态、工具清单；服务连不上时退出码
非零。贴进 issue 基本能一次答完「它不工作」。

## 工具（16 个）

| 工具 | 用途 |
|---|---|
| `stata_status` | Stata 是否可达、哪个安装、是否有命令在跑、当前策略模式。 |
| `stata_run` | 跑一段命令；返回 `success`、`returnCode`、回显、图、策略告警。加 `verify:true` 时附带数据指纹。 |
| `stata_run_do` | 以文件方式跑现成 `.do`（`do "..."`），`cwd` 默认是它所在目录；加 `background:true` 立刻拿到作业 id。 |
| `stata_results` | 把 `r()`、`e()`、`s()` 宏读成 JSON。 |
| `stata_profile_data` | 数据集表头，加每个变量的类型、格式、标签、缺失数。 |
| `stata_model` | 一条估计命令进，系数表与拟合统计出：b、se、t/z、p、95% 区间、被省略项。 |
| `stata_lint` | 静态审查 Stata 代码，专门抓「不报错但做错事」的写法。**不执行任何命令**。 |
| `stata_signature` | 当前数据的 `datasignature` 指纹，用来证明某条命令有没有改动数据。 |
| `stata_graphs` | 把运行导出的 PNG 作为图片附上，模型真的「看」得到。 |
| `stata_break` | 中断失控的命令，并确认 `busy: false`。 |
| `stata_history` | 运行台账。 |
| `stata_job_submit` | 在独立的 Stata 进程里跑 `.do`，立刻返回作业 id。 |
| `stata_job_status` | 作业状态、已跑秒数、返回码、首个 Stata 错误、日志尾。 |
| `stata_job_log` | 作业此刻正在写的日志。 |
| `stata_job_kill` | 停掉作业，保留已有的日志。 |
| `stata_job_list` | 某个工作目录下记录过的作业，新的在前。 |

## 一次会话长什么样

```text
> stata_status
  running · Stata 18 MP · D:\StataMP-64.exe · busy false · mode guarded

> stata_profile_data { dataset: "auto" }
  74 obs · 12 vars · make (str18) "Make and model" · price (int) 0 missing …

> stata_model { command: "regress price mpg weight" }
  mpg    b=-49.512   se=86.156   t=-0.575   p=0.567   [ -221.30,  122.28 ]
  weight b=  1.747   se= 0.641   t= 2.723   p=0.008   [    0.47,    3.03 ]
  _cons  b=1946.069  se=3597.05  t= 0.541   p=0.590   [ -5226.1,  9118.2 ]
  fit: n=74  r2=0.293  F=14.74  crit=1.99394  omitted=[]

> stata_run { code: "scatter price mpg\ngraph export \"output/fit.png\", replace width(1200)" }
  success · 1 graph → output/fit.png

> stata_graphs
  [image]
```

## 长任务：为什么不能硬塞进 `stata_run`

本地服务把 Stata 引擎嵌在自己的进程里，所以**一次只能跑一条命令**：命令执行期间，其他调用会被回
`409 Stata is busy executing another command`；超过服务自身的上限，调用连返回码都拿不到。一次二十分钟的
多重插补，无论超时设多大，都开不进 `stata_run`。

`stata_job_submit` 绕开 HTTP 会话：它把 `StataMP-64.exe /e /q do <文件>` 作为独立的操作系统进程拉起
（先把 do 文件复制成 ASCII 文件名），立刻返回作业 id。交互会话保持空闲，没有单次上限（默认 30 分钟，
`--job-timeout`），回显落在日志文件里，跑着也能读。

```text
> stata_job_submit { file: "analysis/40-impute.do", label: "ice 插补" }
  j-m3x9k1-4f2a · running · pid 9184 · log analysis/__job-j-m3x9k1-4f2a.log

> stata_job_status { jobId: "j-m3x9k1-4f2a" }
  running · 420s elapsed

> stata_job_log { jobId: "j-m3x9k1-4f2a", tail: 4000 }
  Imputing [Perfect prediction detected: using augmlogit to impute moccu; ...
```

作业状态取自**日志**而不是退出码：batch 模式下 do 文件出错 Stata 也返回 0，所以 `stata_job_status`
会报 `failed`，并带上首个 `r(NNN);`、出错的那条命令和它的消息。记录写在 `<cwd>/.stata-copilot/jobs/`，
服务器重启后 `stata_job_list` 仍然找得到。

一个 Windows 细节已经替你处理：启动第二个 Stata 会让内嵌引擎把接下来那个连接重置一次
（一次 `ECONNRESET`，之后恢复正常）。`stata_job_submit` 会在返回前等服务重新应答，所以紧跟着的调用
不会撞上这个空档。`node examples/jobs.mjs` 演示完整流程——提交、并发的一次交互调用仍在约 60 ms 内完成、
实时进度、结论、杀掉、列表。

## 抓 Stata 不报的错

Stata 对最糟的错误是沉默的。下面这些全是**能跑完**的程序，只是结果不是你想的那个——也正是模型会
乐呵呵写进报告的那类：

| 写法 | 实际发生什么 |
|---|---|
| `if foreign { ... }` | `if` 是**命令**，只判断第 1 个观测，不是逐行循环 |
| 没 `sort` 就 `gen gap = price - price[_n-1]` | `_n` 跟着数据「碰巧」的顺序走 |
| 同一文件第二次 `gen w = exp(educ)` | `r(110) variable w already defined`——某个已发表的复现包就是这样停在第 4735 行 |
| 引用了从未定义的 `` `cutoff' `` | 宏静默展开成空串，命令照样跑完 |
| `missing(a b c)` | `missing()` 要的是逗号分隔的表达式列表，不是 varlist：它只测了 `a` |
| `l` 被理解成 `length` | 开着变量缩写时，一个你写错的名字可能悄悄指到另一个变量 |

两层来挡。会话启动时执行 `set varabbrev off`，于是 Stata 认不出的名字会报错，而不是指到别的变量；
`stata_lint` 则在 Stata 看到代码之前先读一遍：

```text
> stata_lint { file: "analysis/40-model.do" }
  1 error(s), 2 warning(s), 1 note(s)
  line 118  error    gen-redefine    `gen wvs` is already defined by line 96; Stata stops with r(110)
  line  44  warning  if-command      `if foreign` tests observation 1 only, not every observation
  line  12  warning  sort-order      `_n`-dependent code runs on whatever order the data are in
  line   1  info     no-varabbrev-guard  this do-file estimates models but never turns abbreviation off
```

`stata_lint` 不执行任何命令，所以在 `readonly` 模式下也安全，每份草稿都跑一遍也不心疼。error 意为
「Stata 会中断」；warning 意为「能跑，但很可能不是你想要的」；是否接受由调用方判断。

## 数据到底改没改：指纹

`stata_signature` 读 `datasignature`，`stata_run` / `stata_run_do` 的 `verify: true` 则围绕一次调用
自动做前后对比：

```text
> stata_run { code: "replace mpg = mpg + 1", verify: true }
  data.before  { observations: 74, dataHashA: 2537987732, sortedby: null }
  data.after   { observations: 74, dataHashA: 3092844121, sortedby: null }
  data.changed true
```

于是「这一步只改了标签」从一句声称变成一枚可以引用的指纹。两个指纹相同，说明数据确实没变；
`sortOrderChanged` 覆盖的是「值一样、但 `_n` 已经不是那个意思」的情况。取指纹失败不会静默吞掉——
错误信息进 `data.error`。

> 一个实测到的坑：`i.foreign##c.w1000` 这类因子记号会把展开项**作为普通变量写进数据集**，而
> `estimates restore` 会把它们一起带回来。所以只跑回归的一章也会显示数据变了。示例里 40/50 两章
> 末尾回读干净数据，就是为了让「本章产物是表和图，不是被改过的数据」这句话站得住。

## 安全模型

三种模式，用 `--mode` / `STATA_COPILOT_MODE` 选：

- **`guarded`**（默认）——拒绝 `!`、`shell`、`winexec`、`erase`、`rmdir`；对 `clear all` 给警告。
- **`readonly`**——另外拒绝 `save`、`export`、`outreg2`、`esttab`、`log`、`putexcel`、`file`、`mkdir`、
  `copy`、`do`——任何可能写盘的东西。适合「只读并汇报」的场景。
- **`open`**——不检查。当前模式会印在每条结果里，并且一次调用只能**收紧**会话模式，不能放宽。

工作目录白名单：`--root`（可重复）或 `STATA_COPILOT_ROOTS`（用路径分隔符分隔）。配了 roots 之后，
`cwd` 落在之外的运行会被拒绝；不配则信任调用方，并在 `stata_status` 里说明。

**边界要说清楚**：这是正则级的护栏，不是操作系统沙箱。do 文件只在调用点被检查，宏间接拼接、`open`
模式、以及把数据写到白名单之外都不在防护范围内。`SECURITY.md` 列了全部六条边界。

## 复现台账

每次 `stata_run` / `stata_run_do` / `stata_model` 追加一行 JSON：

```json
{"at":"2026-11-27T00:41:12.480Z","tool":"stata_model","ok":true,"returnCode":0,"ms":412,
 "cwd":"D:/paper","code":"regress price mpg weight"}
```

用 `--no-ledger` 关掉。台账是搭复现附录的便利，**不能替代 `.do` 文件本身**——那些要进版本控制。

## 技能包

`skills/stata-analysis/SKILL.md` 是压在上面的工作流：定计划 → 描述数据 → 估计 → 出表 → 出图 → 审计。
把整个目录放进客户端的 skills 目录（`.claude/skills/`、`.agents/skills/`，或 DSH 的 skill 路径），
当用户要「做一次分析」而不是「跑一条命令」时，agent 就会照它走。

DSH 用户不用手动放：bundle 里已经带了这一行（`skill-filesystem` 的 `bundledSkillDir`）。

## 配置

| 参数 | 环境变量 | 默认 |
|---|---|---|
| `--endpoint` | `STATA_COPILOT_ENDPOINT` | `http://127.0.0.1:19522` |
| `--driver` | `STATA_COPILOT_DRIVER` | `http`（引擎适配器） |
| `--mode` | `STATA_COPILOT_MODE` | `guarded` |
| `--root` | `STATA_COPILOT_ROOTS` | 无（不限 cwd） |
| `--timeout` | `STATA_COPILOT_TIMEOUT` | 每次调用 `120` 秒 |
| `--max-output` | `STATA_COPILOT_MAX_OUTPUT` | 回显 `20000` 字符 |
| `--no-ledger` | `STATA_COPILOT_NO_LEDGER` | 台账开启 |
| `--log-level` | `STATA_COPILOT_LOG` | `info`（只走 stderr） |
| `--stata-exe` | `STATA_COPILOT_STATA_EXE` | `D:\StataMP-64.exe`（后台作业用） |
| `--job-timeout` | `STATA_COPILOT_JOB_TIMEOUT` | 每个后台作业 `1800` 秒 |

参数也接受 `--flag=value`。未知参数会被拒绝而不是忽略；上表每一项都从同一处声明生成到 `--help`
（`src/config.mjs`）。

## 代码地图

```
bin/stata-copilot.mjs   入口：配置 → 引擎 → 注册表 → 服务（以及 --doctor）
src/server.mjs          基于 stdio 的 JSON-RPC；只有协议，不含 Stata 知识
src/tools/*.mjs         一个工具一个文件；{name, title, description, inputSchema, handler}
src/tools/index.mjs     注册表：定义校验、参数校验、分发
src/session.mjs         门禁 → 执行 → 截断 → 台账；运行契约只在这里写一次
src/jobs.mjs            后台作业：batch 方式起 Stata，轮询、杀灭、从日志定论
src/policy.mjs          把安全规则写成数据（RULES/WARNINGS），模式与 cwd 白名单
src/lint.mjs            静态检查规则（8 条）与 lintCode()
src/signature.mjs       datasignature 指纹读取与比较
src/engines/http.mjs    本地服务的 HTTP 适配器；src/engines/index.mjs 注册驱动
src/parsers/*.mjs       回显 → 数字（宏、模型、数据集描述、分布函数、首个错误、指纹）
src/lib/*.mjs           文本/图片内容助手、schema 校验
src/config.mjs          参数 + 环境变量 + --help，全部来自一张表
src/errors.mjs          冻结的错误码与 MCP 错误结果形状
cordis.patch.yml        DSH carrier bundle：为本包挂上 MCP 客户端那一行
examples/paper/         编号分章（导入 → 清洗 → 描述 → 建模 → 出图）+ 驱动脚本
examples/jobs.mjs       后台作业的客户端视角：提交、轮询、看日志、杀、列表
```

每一层只有一个职责、一个变更理由。加一个工具碰两个文件，加一个引擎碰三个；都不需要改协议。
具体做法见 `docs/EXTENDING.md`。

## 开发与测试

```bash
npm test                  # contracts(45) + offline(50) —— 不需要 Stata
npm run test:contracts    # 只做结构检查：模块图、工具定义、配置
npm run test:stata        # 真实 Stata 会话，48 条断言
npm run demo:paper        # 分章示例端到端，跑在真实会话上
npm run demo:jobs         # 后台作业：提交、观察、杀、列表
npm run check             # 语法 + contracts，pre-commit 跑的就是它
```

`npm test` 是 CI 门：每个模块都要能导入、每个工具定义都要过校验、每个配置项都要出现在 `--help`、
注册表仍要拒绝坏参数，解析器、策略规则与 JSON-RPC 分帧都要在录制的回显与桩引擎上通过。
`npm run test:stata` 才是真正的契约：协议握手、工具清单、真实回归系数与 Stata 自己的输出对齐、策略拒绝、
图片附带、台账，以及一个被提交、轮询、从日志判定为失败、再被 kill 的后台作业。

Node 不在 `PATH` 上的时候（例如本机是 DSH 自带 runtime），用绝对路径：
`C:\Users\<你>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe test\smoke.mjs`。

## 路线图

- [ ] `spawn` 引擎适配器——直接管理 Stata 会话，不再依赖外部服务。
- [ ] `stata_table`——从一组命名的估计结果生成 `esttab` 表，返回 CSV + Markdown。
- [ ] 面板 / IV 诊断：`xtset` 变量缺失时告警；聚类数据上拟合却没有 `vce(cluster ...)` 时告警。
- [ ] CI 覆盖 Mac / Linux（Stata 按机器授权，CI 用录制的回显跑解析与协议测试）。

## 致谢

引擎契约（`/status`、`/execute`、`/break`、图捕获）来自
[stata-ai-skill](https://github.com/ZihaoVistonWang/Stata-AI-Skill)，由它管理原生 Stata 会话。
本项目是面向 agent 的那一层：结构、安全、台账与技能。

## License

MIT

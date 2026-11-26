# 设计文档：stata-copilot

> 目标不是"让 AI 能跑 Stata 命令"，而是**让 AI 做成一份经得起复现审查的 Stata 分析**。
> 这两件事的区别，决定了整个架构。

---

## 1. 问题定义

参考仓库 [pedrohcgs/claude-code-my-workflow](https://github.com/pedrohcgs/claude-code-my-workflow)
值得学的地方不是它的技能数量（50+），而是它把"科研代理"拆成了三层可验证的东西：**执行层**
（编号 do 文件 + 日志 + 产物）、**判据层**（质量门、verification ladder、external oracle）、
**记忆层**（`quality_reports/`、`[LEARN]` 纠错记录）。它的 `stata-replication` 技能把执行交给
`stata-mcp`，自己只负责流程与产物规范——这就是正确的分工。

所以本项目的定位是：**补上"Stata 执行"这一层的上半部分**——不是再造一个 MCP 壳，而是让
执行层产出**结构化、可判据、可追溯**的东西，再把流程写成技能。

### 现有赛道的空位

| 项目 | 强项 | 没解决的 |
|---|---|---|
| SepineTam/mcp-for-stata (285★) | safety-first、Python 生态 | 结果仍是日志文本，无可复现轨迹，无技能层 |
| tmonk/mcp-stata (92★) | 轻量，`r()/e()` 与图 | 面向"看一眼"，无分析工作流、无政策护栏 |
| haoyu-haoyu/stata-ai-fusion (45★) | MCP + Skill + VS Code 扩展 | 绑定 VS Code；技能偏"会用命令"而非"会做研究" |
| Stata-AI-Skill (本机已装) | 原生会话、许可证、图捕获、HTTP 稳定接口 | 只到执行层，工具面是通用 `{code}`，无结构、无护栏、无台账 |

**结论**：MCP 执行器已经拥挤，**结构化结果 + 护栏 + 台账 + 跨客户端技能**这个组合仍是空的。

---

## 2. 设计原则（每条都对应一个真实失败模式）

1. **工具返回结构，不返回转录。**
   代理读 `regress` 表格出错的方式太多：把 `t` 当 `z`、把星号当显著性、把 `_cons` 漏掉。
   `stata_model` 直接把 `e(b)`/`e(V)` 通过 Mata 读出来，返回 `{name, b, se, t, p}` 与
   `{n, r2, F, df_r}`；转录仍在结果里（调试需要），但**契约是字段**。

2. **不让一句 `!` 逃出沙箱。**
   代理在 Stata 里能做的事，包括 `! del /q *`。策略在**发送前**拦：`guarded` 拒 shell 与删除，
   `readonly` 拒一切写盘命令；调用方只能收紧、不能放宽会话模式。策略判定结果随每次运行返回，
   代理知道"为什么被拦"，而不是收到一个神秘错误。

3. **每次运行留一行证据。**
   论文附录要的不是聊天记录。`<cwd>/.stata-copilot/runs.jsonl` 记录时间、工具、命令、cwd、
   返回码、耗时、图数量。这是**可复现轨迹的最小形式**，也是后面接 `esttab` 出表、
   生成 replication package 的锚点。

4. **零依赖、纯 stdio。**
   用户装一个 MCP 服务器最怕两件事：装不上、装上了不敢信。手写 ~200 行 JSON-RPC，`npx` 即用，
   没有传递依赖要审计。这个决定牺牲了 SDK 的便利，换来"可审计的一屏代码"。

5. **引擎与工具面解耦。**
   工具面只依赖 `Engine` 接口（`status/execute/break/shutdown`）。今天是 HTTP 服务，
   明天可以是自己 spawn 的 Stata 进程、可以是远程节点。**换引擎不改工具契约**。

6. **技能与服务器分离。**
   服务器必须跨客户端（Claude Code / DSH / Cursor / Codex），技能才能按客户端的目录约定分发。
   参考仓库用 `scripts/sync-agent-skills.py` 从一个源生成多份适配，本项目沿用这个思路：
   `skills/stata-analysis/SKILL.md` 是唯一源。

---

## 3. 架构

```
┌──────────────────────────────────────────────────────────────┐
│ 客户端：Claude Code / DSH / Cursor / Codex / 任意 MCP 宿主     │
│   技能层  skills/stata-analysis/SKILL.md（流程与判据）          │
└───────────────────────────┬──────────────────────────────────┘
                            │ MCP over stdio (JSON-RPC 2.0)
┌───────────────────────────▼──────────────────────────────────┐
│ stata-copilot（本项目，零依赖 Node ≥18）                       │
│  server.mjs   协议帧、tools/list、tools/call                   │
│  tools.mjs    9 个工具：结构提取、护栏、台账                    │
│  policy.mjs   命令词级策略 + cwd 白名单                         │
│  parse.mjs    转录 → 结构（r()/e()、系数行、变量画像）           │
│  engine.mjs   引擎适配器（GET 重试、POST 不重试）               │
└───────────────────────────┬──────────────────────────────────┘
                            │ HTTP 127.0.0.1:19522
┌───────────────────────────▼──────────────────────────────────┐
│ stata-ai-skill 服务（原生进程管理）                            │
│  /status  /execute  /break  /shutdown  + 图捕获（SVG→PNG）     │
└───────────────────────────┬──────────────────────────────────┘
                            │
                     Stata 18 MP（真实会话）
```

### 关键实现选择

- **系数怎么拿**：`e(b)` 与 `e(V)` 是矩阵，文本表格不可靠。用一段 Mata 直接读矩阵并打印
  `ROW|eq|var|b|se` 行（`st_matrixcolstripe` 给出行标签，注意它是 `k×2`，不是 `2×k`），
  再由 `parse.mjs` 解析。Mata 失败会以 `r(3301)` 整体报错，因此解析器对缺行是容错的：
  没有 `ROW|` 行就返回 `hint`，不伪造系数。
- **p 值怎么算**：`e(df_r)` 存在时用 t 分布（正则化不完全贝塔），否则退化为正态。两者都在
  `parse.mjs` 里实现，避免为了一个 p 值引入依赖。
- **重试语义**：只对 GET 重试（Windows 上本地服务刚绑定端口时首个连接偶发被拒，实测可复现）；
  POST `/execute` **绝不重试**——重放一次回归可能把结果写两遍。
- **图**：服务把 `graph export x.png` 拦下、先出 SVG 再转 PNG。工具把 PNG 读成 base64
  作为 MCP image 内容块返回，代理真的"看见"图；只有 SVG 时返回路径并说明原因（MCP image
  不支持 SVG）。

### 工具面契约（v0.1）

| 工具 | 输入 | 输出关键字段 |
|---|---|---|
| `stata_status` | `format?` | `reachable, sessionActive, busy, stata{path,version,edition}, licenseFound, policy` |
| `stata_run` | `code, cwd?, timeout?, mode?` | `success, returnCode, output, outputTruncated, error, graphs[], policy{mode,warnings}` |
| `stata_run_do` | `file, cwd?, timeout?, mode?` | 同上 + `file` |
| `stata_results` | `scope, cwd?, timeout?` | `macros{r,e,s}, matrices[]` |
| `stata_profile_data` | `dataset?, cwd?, timeout?` | `dataset{source,observations,variables}, variables[{name,type,format,label,missing}]` |
| `stata_model` | `command, cwd?, timeout?, quiet?` | `estimates[{equation,name,b,se,t,p}], fit{n,k,df_r,r2,r2_a,F,ll,aic,bic,cmdline}` |
| `stata_graphs` | `files?, max?` | image 内容块 + `files[]` |
| `stata_break` | — | `interrupted, status{busy}` |
| `stata_history` | `limit?` | `entries[{at,tool,ok,returnCode,ms,cwd,code}]` |

**为什么只有 9 个**：工具越多，模型选错的概率越高。这 9 个对应分析循环里的 9 个动作
（看状态 → 摸数据 → 估计 → 取结果 → 看图 → 中断 → 查痕迹），没有一个是"可能有用"的。

---

## 4. 技能层：把纪律写成流程

`skills/stata-analysis/SKILL.md` 规定六步，每步绑定工具与产物：

1. **plan** — 先把假设、数据、识别策略写成三行，再动 Stata；产物 `analysis/00-plan.md`。
2. **profile** — `stata_profile_data`；记录 n、缺失、标签，落 `analysis/01-profile.md`。
3. **scaffold** — 编号 do 文件 `analysis/10-import.do`、`20-clean.do`、`30-model.do`；
   由代理写文件、`stata_run_do` 执行（不是把 200 行塞进 `stata_run`）。
4. **estimate** — `stata_model`，把 `estimates` 原样存 `output/estimates.json`。
5. **table / figure** — `esttab` 出三线表、`graph export` 出图、`stata_graphs` 核图。
6. **audit** — `stata_history` 与 `.do` 文件对照：命令是否都来自文件？有没有人工改过结果？
   没有 seed 的模拟、没有 `vce(cluster)` 的面板回归，一律回退修正。

这条流程就是"判据层"的最小版本：**产物必须能由 do 文件重跑出来**。

---

## 5. 发布方案

1. **仓库** `stata-copilot`，MIT，Node ≥18，`bin/` + `src/` + `skills/` + `docs/` + `test/`。
2. **CI**（GitHub Actions）：
   - `node --check` 全量语法；
   - `test/parse.test.mjs`（对录制转录跑解析器，不需要 Stata）；
   - `test/protocol.test.mjs`（对假引擎跑 JSON-RPC 与策略，不需要 Stata）；
   - 真实 Stata 的集成测试只在有许可证的机器上手动跑（`npm run test:stata`）。
3. **版本策略**：`0.1.x` 先做工具契约稳定；工具名/字段一旦发布不轻易改，
   改字段走 minor + CHANGELOG 的 "Breaking" 段。
4. **npm**：`npm publish` 后 `npx stata-copilot` 可用；包名被占则退到 `@scope/stata-copilot`。
5. **文档**：README 面向"第一次配置"，`docs/DESIGN.md`（本文件）面向"为什么这样设计"，
   `skills/` 面向"让代理真的按流程做"。
6. **社区**：提交到 `awesome-mcp-servers`、`punkpeye/awesome-mcp-servers` 的 Stata 分类；
   在 README 放一段 30 秒 GIF（status → profile → model → graph）。

### 风险与对策

| 风险 | 对策 |
|---|---|
| 依赖外部 `stata-ai-skill` 服务，用户装不上 | README 写清"两件套"；roadmap 的 `spawn` 适配器最终消除依赖 |
| 解析器遇 Stata 版本差异失效 | 解析容错 + 测试用录制转录；失败时返回 `hint` 而不是假数据 |
| 策略误伤（如 `log` 在 readonly 被拒） | 每次拦截都返回 `rule` 与 `why`，用户可 `--mode open` 或按提示改写 |
| 与已有 MCP 同质 | 差异化写在 README 第一屏：结构化结果、护栏、台账、技能 |

---

## 6. 下一步（按价值排序）

1. `spawn` 引擎适配器：不依赖外部服务，一条命令拉起 Stata。
2. `stata_table`：多模型 → `esttab` → CSV/Markdown，直接进论文。
3. 诊断规则：面板未 `xtset`、聚类未 `vce(cluster)`、模拟无 `set seed`——在 `stata_run` 返回里作为 `warnings`。
4. 与 `markstat` 打通：分析产物直接进可编译的报告（叙事 + 内联数值）。

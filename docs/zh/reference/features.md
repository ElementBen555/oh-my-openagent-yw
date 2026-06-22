# 功能概览

## 11 个内置 Agent

| Agent | 角色 | 默认模型 | 说明 |
|-------|------|---------|------|
| **Sisyphus** | 主编排器 | Claude Opus 4.7 | 任务分解、Agent 路由、ultrawork 触发 |
| **Prometheus** | 战略规划 | Claude Opus 4.7 | 面试式需求收集、计划生成 |
| **Atlas** | Todo 编排 | Claude Sonnet 4.6 | 任务列表管理、进度跟踪 |
| **Oracle** | 架构咨询 | GPT-5.5 | 复杂设计决策、多系统权衡 |
| **Hephaestus** | 深度实现 | GPT-5.5 | "Codex 增强版"，自主完成大型任务 |
| **Metis** | 预规划审查 | Claude Sonnet 4.6 | 审查 Prometheus 计划的缺口 |
| **Momus** | 高精度审查 | GPT-5.5 | 计划验证、质量把关 |
| **Librarian** | 文档查询 | GPT-5.4 Mini | 外部库文档查询（Context7） |
| **Explore** | 代码搜索 | Grok Code Fast | 快速代码库搜索（grep_app） |
| **Multimodal-Looker** | 视觉分析 | GPT-5.5 | 图像/PDF 分析 |
| **Sisyphus-Junior** | 任务执行 | 按类别自动 | 类别派生的轻量执行器 |

## 7 个内置 MCP

### 远程 MCP（需网络）

| MCP | 功能 | 环境变量 |
|-----|------|---------|
| **websearch** | 实时网页搜索（Exa/Tavily） | `EXA_API_KEY` / `TAVILY_API_KEY`（可选） |
| **context7** | 官方文档查询 | `CONTEXT7_API_KEY`（可选） |
| **grep_app** | GitHub 代码搜索 | 无需认证 |

### 本地 MCP（stdio）

| MCP | 功能 | 要求 |
|-----|------|------|
| **lsp** | 语言服务器：诊断、跳转、引用、重命名 | Node/Bun |
| **codegraph** | 代码图谱：调用链、影响分析 | codegraph 二进制 |
| **sequential_thinking** | 动态反思式问题解决 | npx |
| **github** | GitHub 仓库/PR/Issue 管理 | `GITHUB_PERSONAL_ACCESS_TOKEN` |

**离线韧性**: 远程 MCP 启动时探测（2 秒超时），不可达自动禁用。

## 三层 MCP 架构

| 层级 | 来源 | 加载方式 |
|------|------|---------|
| **Tier 1 — 内置** | `src/mcp/` | 插件启动时自动注册 |
| **Tier 2 — Claude Code** | `.mcp.json` | `claude-code-mcp-loader` 加载 |
| **Tier 3 — Skill 嵌入** | `SKILL.md` YAML | `SkillMcpManager` 按需启动 |

## 生命周期钩子（53-60 个）

### 5 大层级

| 层级 | 数量 | 代表钩子 |
|------|------|---------|
| **Session** | 23 | 会话创建/销毁、模型回退、自动更新检查 |
| **ToolGuard** | 17 | 写文件保护、注释检查、JSON 错误恢复 |
| **Transform** | 4 | 关键字检测、上下文注入、工具对验证 |
| **Continuation** | 7 | 停止延续防护、压缩上下文保留 |
| **Skill** | 2 | 类别技能提醒、自动斜杠命令 |

Team Mode 启用时额外增加 7 个钩子。

## 工具目录（20-39 个）

### 始终可用（18 个）

| 类别 | 工具 |
|------|------|
| **代码分析** | `lsp_diagnostics`, `lsp_goto_definition`, `lsp_find_references`, `lsp_symbols`, `lsp_rename` |
| **搜索** | `grep`, `glob`, `websearch`, `context7`, `grep_app` |
| **会话** | `session_list`, `session_read`, `session_search`, `session_info` |
| **后台** | `background_output`, `background_cancel` |
| **Agent** | `call_omo_agent`, `task` |
| **技能** | `skill`, `skill_mcp` |

### 条件启用

| 条件 | 工具 |
|------|------|
| `hashline_edit` | `edit` |
| tmux 可用 | `interactive_bash` |
| `experimental.task_system` | `task_create`, `task_get`, `task_list`, `task_update` |
| `team_mode.enabled` | 12 个 `team_*` 工具 |

## 模式关键词

在消息中包含以下关键词自动触发对应模式：

| 关键词 | 说明 |
|--------|------|
| `ultrawork` / `ulw` | 全编排模式，直到完成 |
| `search` | 网页/文档搜索优先 |
| `analyze` | 深度分析模式 |
| `team` | 强制 Team Mode 编排 |
| `hyperplan` | 对抗式规划（5 个批评者） |

## 斜杠命令（Ultimate）

| 命令 | 说明 |
|------|------|
| `/init-deep` | 自动生成 AGENTS.md |
| `/start-work` | Prometheus 访谈式规划 |
| `/ralph-loop` | 自循环直到完成 |
| `/ulw-loop` | Ultrawork 循环 |
| `/refactor` | LSP + AST 智能重构 |
| `/handoff` | 生成会话交接摘要 |
| `/remove-ai-slops` | 清理 AI 代码异味 |
| `/hyperplan` | 对抗式规划 |

## Team Mode（可选）

- **默认关闭**，需显式启用
- 最多 **8 个成员**，**4 个并行**
- 基于文件系统的 Mailbox 通信（每 3 秒轮询）
- 每个成员独立 git worktree
- 支持 `tmux_visualization` 面板可视化

## 关键机制

### Hashline 编辑
- `Read` 输出行带 `LINE#ID` 内容哈希
- `edit` 验证哈希后才应用
- 哈希不匹配 → 拒绝编辑

### Prompt Async Gate
- 所有内部 prompt 调用必须通过 `dispatchInternalPrompt`
- 防止 OpenCode `promptAsync` 竞态导致的重复注入
- 超时清理、状态检查、队列行为显式声明

### 双回退系统
- **model-fallback**: 主动式，API 错误前配置
- **runtime-fallback**: 反应式，API 错误后触发

---

**相关文档**: [安装指南](../../guide/installation.md) | [配置参考](configuration.md)

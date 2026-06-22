# Oh My OpenAgent

> OpenCode 多 Agent 编排插件。11 个 Agent、60+ 生命周期钩子、7 个内置 MCP、Team Mode、离线韧性。

**[English](README.md) | 简体中文**

<br/>

## 这是什么？

Oh My OpenAgent 是一个 **OpenCode 插件**，它将单一的 AI 助手升级为**协调工作的多 Agent 软件工程团队**。

不再是让一个通用模型处理所有任务，而是 11 个专业角色的 Agent 协作：
- **Sisyphus** — 主编排器；制定计划、分配任务、推动完成
- **Prometheus** — 战略规划师；在写代码前先访谈你
- **Hephaestus** — 深度自主工作者；端到端执行，无需手把手指导
- **Oracle** — 架构与调试顾问
- **Librarian** — 外部文档与代码搜索
- **Explore** — 快速代码库搜索
- **Multimodal Looker** — 图像与 PDF 分析
- **Metis / Momus** — 计划审查员
- **Atlas** — Todo 编排器
- **Sisyphus-Junior** — 轻量级委托执行器

## 安装

```bash
# 完整版（推荐）
bunx oh-my-openagent install

# Codex 轻量版
npx lazycodex-ai install

# 两个都装
bunx oh-my-openagent install --platform=both
```

详见 [安装指南](docs/zh/guide/installation.md) 或 [英文文档](docs/guide/installation.md)。

## 快速开始

```
# 在 OpenCode 聊天中输入
ultrawork

# 就这一句。所有 Agent 激活。任务完成前绝不停止。
```

## 核心特性

| 特性 | 说明 |
|------|------|
| **11 个自律 Agent** | 针对特定角色调优；无需手动切换模型 |
| **Team Mode** | 领导 Agent + 最多 8 个并行成员，实时 tmux 布局 |
| **7 个内置 MCP** | Exa（网络搜索）、Context7（文档）、Grep.app（代码）、Sequential Thinking（动态推理）、GitHub（仓库/PR）、LSP、Codegraph |
| **离线韧性** | 远程 MCP 启动时自动探测；不可达的自动优雅降级 |
| **Hashline 编辑** | LINE#ID 内容哈希验证每次修改；零错位错误 |
| **IntentGate** | 自动识别 `ultrawork` / `search` / `analyze` / `team` / `hyperplan` 关键词 |
| **Ralph Loop** | 自我引用闭环，直到 100% 完成 |
| **技能嵌入 MCP** | 技能按需自带 MCP 服务器 |
| **三层 MCP 系统** | 内置 + Claude Code `.mcp.json` + 技能嵌入 |
| **Claude Code 兼容** | Hook、命令、技能、MCP 全部兼容 |

## 架构

```
packages/omo-opencode/src/
├── agents/        # 11 个 Agent 工厂
├── hooks/         # 60 个生命周期钩子，分布在 60 个目录
├── tools/         # 13 个原生工具目录
├── mcp/           # 7 个内置 MCP（3 远程 + 4 本地 stdio）
├── features/      # 22 个功能模块（team-mode、boulder、openclaw ...）
├── cli/           # Commander.js CLI（install、doctor、run、boulder ...）
├── config/        # Zod v4  schema 系统（32 个 schema）
└── shared/        # 跨模块工具函数
```

总计 37 个包：18 个 Core 纯 TS + 3 个 MCP 层 + Skills + Adapters + 平台二进制 + Web。

## 本分支新增

- **+2 个新 MCP**：`sequential_thinking`（动态反思式推理）、`github`（仓库/PR/Issue 管理，需 `GITHUB_PERSONAL_ACCESS_TOKEN`）
- **MCP 健康探测**：2 秒超时探测；离线时优雅降级
- **Open-Design Skills 子模块**：157 个 skills + 152 个 design systems（工作流、原型、品牌规范）
- **中文文档体系**：docs/zh/（安装指南、配置参考、功能概览）
- **Git 远程**：现维护于 `ElementBen555/oh-my-openagent-yw`

## 配置

JSONC 配置文件位于 `~/.config/opencode/oh-my-openagent.jsonc`：

```jsonc
{
  "agents": {
    "sisyphus": { "model": "anthropic/claude-opus-4-7" }
  },
  "disabled_mcps": [],
  "team_mode": {
    "enabled": false,
    "max_parallel_members": 4
  }
}
```

详见 [配置参考](docs/zh/reference/configuration.md) 或 [英文配置参考](docs/reference/configuration.md)。

## 环境变量

| 变量 | 用途 |
|------|------|
| `GITHUB_PERSONAL_ACCESS_TOKEN` | 启用 GitHub MCP |
| `EXA_API_KEY` / `TAVILY_API_KEY` | 可选；增强 websearch MCP |
| `OMO_DISABLE_POSTHOG=1` | 禁用遥测 |

## 常用命令

```bash
bunx oh-my-openagent doctor          # 健康诊断
bunx oh-my-openagent run <message>   # 非交互式会话
bunx oh-my-openagent boulder         # 查看工作状态
bunx oh-my-openagent mcp-oauth login <url>  # 第三层 MCP OAuth 登录
```

## 文档链接

- [安装指南 (中文)](docs/zh/guide/installation.md)
- [配置参考 (中文)](docs/zh/reference/configuration.md)
- [功能概览 (中文)](docs/zh/reference/features.md)
- [英文文档](README.md)
- [路线图](ROADMAP.md)

## 许可证

SUL-1.0

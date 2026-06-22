# Oh My OpenAgent 中文文档

> **注意**: 本文档与英文文档同步更新。如有冲突，以英文文档为准。

## 快速开始

- [安装指南](./guide/installation.md) — 安装 Ultimate（OpenCode）或 Light（Codex）版本
- [配置参考](./reference/configuration.md) — 完整的配置字段说明
- [功能概览](./reference/features.md) — 内置 Agent、MCP、工具一览

## 版本说明

Oh My OpenAgent 提供两个版本：

| 版本 | 目标平台 | 功能 |
|------|---------|------|
| **Ultimate** | OpenCode | 11 个 Agent、53-60 个生命周期钩子、Team Mode、所有 MCP |
| **Light** | Codex CLI | 8 个组件、核心规则、LSP、ultrawork、telemetry |

## 核心特性

- **11 个专用 Agent**: Sisyphus（编排）、Oracle（架构）、Librarian（文档）、Explore（搜索）、Prometheus（规划）等
- **三层 MCP 系统**: Built-in + Claude Code `.mcp.json` + Skill-embedded
- **Team Mode**: 并行多 Agent 协作（最多 8 成员）
- **Hashline 编辑**: 带内容哈希验证的安全代码编辑
- **离线韧性**: 远程 MCP 自动探测，不可达时优雅降级

## 环境要求

- **运行时**: Bun 1.3.12+
- **Node.js**: 仅用于 `lsp-tools-mcp` 和 `lsp-daemon` 构建
- **Git**: 必需
- **tmux**: 可选（启用交互式 bash 和 Team Mode 可视化）

## 快速安装

```bash
# Ultimate 版本（推荐）
bunx oh-my-openagent install

# Light 版本（Codex CLI）
npx lazycodex-ai install

# 两个版本都安装
bunx oh-my-openagent install --platform=both
```

## 常用命令

```bash
# 健康检查
bunx oh-my-openagent doctor

# 非交互式运行
bunx oh-my-openagent run "你的任务描述"

# 查看 Boulder 工作状态
bunx oh-my-openagent boulder

# 刷新模型能力缓存
bunx oh-my-openagent refresh-model-capabilities
```

## 文档索引

### 指南
- [安装指南](./guide/installation.md) — 详细安装步骤和模型配置

### 参考
- [配置参考](./reference/configuration.md) — JSONC 配置完整字段说明
- [功能概览](./reference/features.md) — Agent、工具、MCP 清单

---

**项目链接**:
- GitHub: https://github.com/code-yeongyu/oh-my-openagent
- Discord: https://discord.gg/PUwSMR9XNk
- 官网: https://sisyphuslabs.ai

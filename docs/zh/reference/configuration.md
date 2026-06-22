# 配置参考

配置文件使用 **JSONC** 格式（支持注释和尾随逗号）。

## 配置文件位置

### 用户配置（全局生效）

| 平台 | 路径 |
|------|------|
| macOS/Linux | `~/.config/opencode/oh-my-openagent.jsonc` |
| Windows | `%APPDATA%\opencode\oh-my-openagent.jsonc` |

### 项目配置（仅当前项目）

- `.opencode/oh-my-openagent.jsonc`

**合并规则**: 项目配置覆盖用户配置，用户配置覆盖默认值。

## 快速配置示例

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/dev/assets/oh-my-opencode.schema.json",

  "agents": {
    // 主编排器：Claude Opus 或 Kimi K2.6
    "sisyphus": {
      "model": "anthropic/claude-opus-4-7",
      "variant": "max"
    },
    // 研究 Agent：便宜快速的模型
    "explore": { "model": "github-copilot/grok-code-fast-1" },
    "librarian": { "model": "google/gemini-3-flash" },
    // 架构咨询：GPT-5.5
    "oracle": { "model": "openai/gpt-5.5", "variant": "high" }
  },

  // 禁用不需要的 MCP
  "disabled_mcps": ["websearch"],

  // 启用 Team Mode
  "team_mode": {
    "enabled": true,
    "max_parallel_members": 4
  }
}
```

## 核心配置字段

### `agents` — Agent 模型覆盖

为每个 Agent 指定模型和参数：

```jsonc
{
  "agents": {
    "sisyphus": { "model": "anthropic/claude-opus-4-7", "variant": "max" },
    "oracle": { "model": "openai/gpt-5.5", "variant": "high" },
    "prometheus": { "prompt_append": "优先使用并行 Agent" },
    "explore": { "model": "github-copilot/grok-code-fast-1" }
  }
}
```

支持字段：
- `model`: 模型 ID
- `variant`: 模型变体（`low`/`medium`/`high`/`max`）
- `prompt`: 覆盖系统提示
- `prompt_append`: 追加到系统提示
- `temperature`: 采样温度
- `maxTokens`: 最大 token 数
- `fallback_models`: 后备模型链

### `categories` — 任务类别模型

```jsonc
{
  "categories": {
    "visual-engineering": { "model": "google/gemini-3.1-pro" },
    "quick": { "model": "openai/gpt-5.4-mini" },
    "deep": { "model": "anthropic/claude-opus-4-7" },
    "writing": { "model": "google/gemini-3-flash" }
  }
}
```

### `disabled_mcps` — 禁用内置 MCP

```jsonc
{
  // 禁用特定 MCP（默认全部启用）
  "disabled_mcps": ["websearch", "context7"]
}
```

内置 MCP 清单：
- `websearch` — 网页搜索（Exa/Tavily）
- `context7` — 官方文档查询
- `grep_app` — GitHub 代码搜索
- `lsp` — 语言服务器工具
- `codegraph` — 代码图谱分析
- `sequential_thinking` — 动态反思式问题解决
- `github` — GitHub 仓库管理（需 `GITHUB_PERSONAL_ACCESS_TOKEN`）

### `disabled_agents` — 禁用 Agent

```jsonc
{ "disabled_agents": ["multimodal-looker"] }
```

### `disabled_tools` — 禁用工具

```jsonc
{ "disabled_tools": ["todowrite", "todoread"] }
```

### `disabled_skills` — 禁用技能

```jsonc
{ "disabled_skills": ["playwright"] }
```

### `team_mode` — 团队模式

```jsonc
{
  "team_mode": {
    "enabled": true,              // 默认 false
    "tmux_visualization": false,  // 是否显示 tmux 面板布局
    "max_parallel_members": 4,    // 并行成员数（1-8）
    "max_members": 8,             // 最大成员数（1-8）
    "max_messages_per_run": 10000,
    "max_wall_clock_minutes": 120,
    "max_member_turns": 500,
    "base_dir": null,             // 覆盖默认团队目录
    "message_payload_max_bytes": 32768,
    "recipient_unread_max_bytes": 262144,
    "mailbox_poll_interval_ms": 3000
  }
}
```

### `experimental` — 实验性功能

```jsonc
{
  "experimental": {
    "task_system": true,        // 启用任务系统
    "max_tools": 32             // 每轮最大工具调用数
  }
}
```

### `ralph_loop` — 自循环配置

```jsonc
{
  "ralph_loop": {
    "enabled": true,
    "auto_commit": true         // 自动提交更改
  }
}
```

### `background_task` — 后台任务

```jsonc
{
  "background_task": {
    "modelConcurrency": 5,      // 每模型并发数
    "providerConcurrency": 5    // 每提供商并发数
  }
}
```

### `openclaw` — 双向外部集成

```jsonc
{
  "openclaw": {
    "discord": {
      "enabled": true,
      "token": "YOUR_BOT_TOKEN",
      "channel_id": "CHANNEL_ID"
    },
    "telegram": {
      "enabled": true,
      "bot_token": "YOUR_BOT_TOKEN",
      "chat_id": "CHAT_ID"
    }
  }
}
```

### `skills` — 技能路径

```jsonc
{
  "skills": {
    "paths": [
      "~/.config/opencode/skills",
      "./.opencode/skills"
    ]
  }
}
```

### `hashline_edit` — 哈希行编辑

```jsonc
{ "hashline_edit": true }
```

启用后，`Read` 工具输出带 `LINE#ID` 内容哈希，`edit` 工具验证哈希后才应用。

### `model_fallback` — 模型回退

```jsonc
{ "model_fallback": true }
```

API 错误时自动切换到后备模型。

### `runtime_fallback` — 运行时回退

```jsonc
{
  "runtime_fallback": {
    "enabled": true,
    "retry_on_errors": [429, 500, 502, 503, 504],
    "timeout_seconds": 30
  }
}
```

## 完整环境变量列表

| 变量 | 说明 |
|------|------|
| `GITHUB_PERSONAL_ACCESS_TOKEN` | GitHub MCP 必需 |
| `EXA_API_KEY` / `TAVILY_API_KEY` | websearch 可选 |
| `CONTEXT7_API_KEY` | context7 可选 |
| `OMO_DISABLE_POSTHOG=1` | 禁用遥测 |
| `OPENCODE_DEFAULT_AGENT` | `omo run` 默认 Agent |
| `CODEX_LOCAL_BIN_DIR` | Codex 组件目录 |

## 配置验证

```bash
# 验证配置并查看诊断
bunx oh-my-openagent doctor

# 重建 JSON Schema（开发用）
bun run build:schema
```

---

**相关文档**: [功能概览](../reference/features.md)

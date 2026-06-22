# Oh My OpenAgent

> Multi-agent orchestration plugin for OpenCode. 11 agents, 60+ lifecycle hooks, 7 built-in MCPs, Team Mode, offline resilience.

**[English](README.md) | [简体中文](README.zh-cn.md)**

<br/>

## What is this?

Oh My OpenAgent is an **OpenCode plugin** that upgrades a single AI assistant into a **coordinated multi-agent software engineering team**.

Instead of one generic model handling everything, 11 discipline-specific agents collaborate:
- **Sisyphus** — main orchestrator; plans, delegates, drives to completion
- **Prometheus** — strategic planner; interviews you before writing code
- **Hephaestus** — deep autonomous worker; end-to-end execution without hand-holding
- **Oracle** — architecture & debugging consultant
- **Librarian** — external docs & code search
- **Explore** — fast codebase grep
- **Multimodal Looker** — vision & PDF analysis
- **Metis / Momus** — plan reviewers
- **Atlas** — todo orchestrator
- **Sisyphus-Junior** — lightweight delegated executor

## Installation

```bash
# Full edition (recommended)
bunx oh-my-openagent install

# Codex Light edition
npx lazycodex-ai install

# Both
bunx oh-my-openagent install --platform=both
```

See [Installation Guide](docs/guide/installation.md) or [Chinese docs](docs/zh/README.md).

## Quick Start

```bash
# Run once
type "ultrawork" in your OpenCode chat

# That's it. Every agent activates. Doesn't stop until done.
```

## Core Features

| Feature | Description |
|---------|-------------|
| **11 Discipline Agents** | Model-tuned for specific roles; no manual model juggling |
| **Team Mode** | Lead + up to 8 parallel members, real-time tmux layout |
| **7 Built-in MCPs** | Exa (web), Context7 (docs), Grep.app (code), Sequential Thinking (reasoning), GitHub (repo/PR), LSP, Codegraph |
| **Offline Resilience** | Remote MCPs auto-probed at startup; unreachable ones gracefully disabled |
| **Hashline Edits** | LINE#ID content hash validates every change; zero stale-line errors |
| **IntentGate** | Detects `ultrawork` / `search` / `analyze` / `team` / `hyperplan` keywords |
| **Ralph Loop** | Self-referential loop until 100% done |
| **Skill-Embedded MCPs** | Skills bring their own MCP servers on demand |
| **3-Tier MCP System** | Built-in + Claude Code `.mcp.json` + Skill-embedded |
| **Claude Code Compatible** | Hooks, commands, skills, MCPs all work unchanged |

## Architecture

```
packages/omo-opencode/src/
├── agents/        # 11 agent factories
├── hooks/         # 60 lifecycle hooks across 60 dirs
├── tools/         # 13 native tool dirs
├── mcp/           # 7 built-in MCPs (3 remote + 4 local stdio)
├── features/      # 22 feature modules (team-mode, boulder, openclaw, ...)
├── cli/           # Commander.js CLI (install, doctor, run, boulder, ...)
├── config/        # Zod v4 schema system (32 schemas)
└── shared/        # Cross-cutting utilities
```

37 packages total: 18 Core pure-TS + 3 MCP-layer + Skills + Adapters + Platform binaries + Web.

## New in this Fork

- **+2 New MCPs**: `sequential_thinking` (dynamic reasoning), `github` (repo/PR/issue management, gated on `GITHUB_PERSONAL_ACCESS_TOKEN`)
- **MCP Health Check**: 2-second probe; offline graceful degradation
- **Open-Design Skills Submodule**: 157 skills + 152 design systems (workflow, prototyping, brand guidelines)
- **Chinese Documentation Suite**: docs/zh/ (installation, configuration, features)
- **Git Remote**: now maintained at `ElementBen555/oh-my-openagent-yw`

## Configuration

JSONC config at `~/.config/opencode/oh-my-openagent.jsonc`:

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

See [Configuration Reference](docs/reference/configuration.md) or [中文配置参考](docs/zh/reference/configuration.md).

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `GITHUB_PERSONAL_ACCESS_TOKEN` | Enables GitHub MCP |
| `EXA_API_KEY` / `TAVILY_API_KEY` | Optional; enhances websearch MCP |
| `OMO_DISABLE_POSTHOG=1` | Disables telemetry |

## Commands

```bash
bunx oh-my-openagent doctor          # Health diagnostics
bunx oh-my-openagent run <message>   # Non-interactive session
bunx oh-my-openagent boulder         # Inspect work state
bunx oh-my-openagent mcp-oauth login <url>  # Tier-3 MCP OAuth
```

## Links

- [Installation Guide](docs/guide/installation.md)
- [Configuration Reference](docs/reference/configuration.md)
- [Features Overview](docs/reference/features.md)
- [中文文档](docs/zh/README.md)
- [ROADMAP](ROADMAP.md)

## License

SUL-1.0

# 安装指南

Oh My OpenAgent 提供两个版本：

- **Ultimate** — OpenCode 插件，完整功能
- **Light** — Codex CLI 插件，轻量版

## 快速安装

### Ultimate 版本（推荐）

```bash
bunx oh-my-openagent install
```

TUI 向导会引导完成：
1. 平台选择（OpenCode / Codex / Both）
2. 模型提供商订阅检测
3. Agent → 模型映射配置
4. 认证设置

### Light 版本（Codex CLI）

```bash
npx lazycodex-ai install
```

非交互式安装（推荐）：
```bash
npx lazycodex-ai install --no-tui --codex-autonomous
```

### 两个版本都安装

```bash
bunx oh-my-openagent install --platform=both
```

## 环境准备

### 必需

- **Bun** 1.3.12+: `curl -fsSL https://bun.sh/install | bash`
- **Git**: 用于版本控制和 Team Mode
- **OpenCode** 1.4.0+（Ultimate 版本）: https://opencode.ai

### 可选

- **tmux**: 启用交互式 bash 和 Team Mode 可视化
- **Node.js**: 仅用于构建 LSP 工具包

## 模型订阅配置

安装器会根据你的订阅自动配置 Agent → 模型映射：

| 订阅 | 安装器标志 | 影响 |
|------|-----------|------|
| Claude Pro/Max | `--claude=yes` / `--claude=max20` | Sisyphus、Prometheus、Metis 默认使用 Claude |
| ChatGPT Plus | `--openai=yes` | Oracle、Hephaestus、Momus 可使用 GPT-5.5 |
| Gemini | `--gemini=yes` | 视觉/前端任务使用 Gemini |
| GitHub Copilot | `--copilot=yes` | 后备提供商 |
| OpenCode Zen | `--opencode-zen=yes` | 访问 opencode/ 前缀模型 |
| Z.ai Coding | `--zai-coding-plan=yes` | GLM-5 后备 |
| OpenCode Go | `--opencode-go=yes` | Kimi K2.6、GLM-5.1、MiniMax M3 |
| Kimi for Coding | `--kimi-for-coding=yes` | Kimi K2.5 链 |

## 安装后验证

### Ultimate 版本

```bash
# 检查 OpenCode 版本
opencode --version

# 检查插件注册
cat ~/.config/opencode/opencode.json

# 运行健康检查
bunx oh-my-openagent doctor
```

### Light 版本

```bash
# 检查插件缓存
ls ~/.codex/plugins/cache/sisyphuslabs/omo/

# 检查 Codex 配置
grep -A4 'marketplaces.sisyphuslabs' ~/.codex/config.toml

# 检查组件二进制
ls ~/.local/bin/ | grep omo-
```

## 关键环境变量

| 变量 | 说明 |
|------|------|
| `GITHUB_PERSONAL_ACCESS_TOKEN` | 启用 GitHub MCP（仓库/PR/Issue 管理） |
| `EXA_API_KEY` / `TAVILY_API_KEY` | websearch MCP 可选 API key |
| `CONTEXT7_API_KEY` | context7 MCP 可选 API key |
| `OMO_DISABLE_POSTHOG=1` | 禁用遥测 |
| `OPENCODE_DEFAULT_AGENT` | `omo run` 默认 Agent |

## 启用 Team Mode（可选）

编辑配置文件：

```jsonc
// ~/.config/opencode/oh-my-openagent.jsonc
{
  "team_mode": {
    "enabled": true,
    "max_parallel_members": 4,
    "max_members": 8,
    "tmux_visualization": false
  }
}
```

重启 OpenCode 后生效。

## 故障排除

| 问题 | 解决 |
|------|------|
| `opencode` 无法找到插件 | 重新运行 `bunx oh-my-openagent install` |
| Codex 插件未加载 | 运行 `npx lazycodex-ai install`（幂等） |
| MCP 连接失败 | 检查网络，远程 MCP 会离线自动降级 |
| 模型调用失败 | 运行 `bunx oh-my-openagent doctor` 检查模型链 |

## 卸载

```bash
# Ultimate 版本
bunx oh-my-openagent uninstall

# Light 版本
npx lazycodex-ai uninstall
```

---

**下一步**: [配置参考](./../reference/configuration.md)

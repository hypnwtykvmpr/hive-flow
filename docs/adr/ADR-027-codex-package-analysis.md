# ADR-027 Supplement: @openai/codex Package Deep Analysis

## Package Overview

**Package**: `@openai/codex@0.98.0`
**License**: Apache-2.0
**Repository**: https://github.com/openai/codex
**Type**: ESM module with native binary wrapper

## Architecture

### Package Structure

```
@openai/codex/
├── package.json          # Package manifest
├── README.md            # Installation instructions
├── bin/
│   ├── codex.js         # Node.js entry point (177 lines)
│   └── rg               # dotslash manifest for ripgrep
└── vendor/              # Pre-compiled native binaries
    ├── aarch64-apple-darwin/      # macOS ARM64
    ├── x86_64-apple-darwin/       # macOS x86_64
    ├── aarch64-unknown-linux-musl/ # Linux ARM64
    ├── x86_64-unknown-linux-musl/  # Linux x86_64
    ├── aarch64-pc-windows-msvc/   # Windows ARM64
    └── x86_64-pc-windows-msvc/    # Windows x86_64
```

### Binary Sizes

| Platform | Codex Binary | ripgrep | Total |
|----------|--------------|---------|-------|
| Linux x86_64 | 73 MB | 6.6 MB | ~80 MB |
| Linux ARM64 | 60 MB | 5.2 MB | ~65 MB |
| macOS x86_64 | 62 MB | 5.2 MB | ~67 MB |
| macOS ARM64 | 54 MB | 4.4 MB | ~58 MB |
| Windows x86_64 | 81 MB + helpers | 5.4 MB | ~88 MB |
| Windows ARM64 | 68 MB + helpers | 4.2 MB | ~74 MB |

**Total package size**: ~450 MB (all platforms included)

### Windows-Specific Binaries

Windows builds include additional helper executables:
- `codex-command-runner.exe` (~600 KB) - Command execution helper
- `codex-windows-sandbox-setup.exe` (~600 KB) - Sandbox configuration

## Entry Point Analysis (`bin/codex.js`)

### Platform Detection

```javascript
const { platform, arch } = process;
// Maps Node.js platform/arch to Rust target triples:
// - linux/x64    → x86_64-unknown-linux-musl
// - linux/arm64  → aarch64-unknown-linux-musl
// - darwin/x64   → x86_64-apple-darwin
// - darwin/arm64 → aarch64-apple-darwin
// - win32/x64    → x86_64-pc-windows-msvc
// - win32/arm64  → aarch64-pc-windows-msvc
```

### Execution Flow

1. Detect platform and architecture
2. Locate vendor binary path
3. Prepend vendor `path/` directory to `PATH` (for ripgrep)
4. Set package manager environment variable (`CODEX_MANAGED_BY_NPM` or `CODEX_MANAGED_BY_BUN`)
5. Spawn native binary with stdio inherited
6. Forward signals (SIGINT, SIGTERM, SIGHUP) to child
7. Mirror child exit code/signal

### Key Implementation Details

```javascript
// ESM module with async top-level await
const child = spawn(binaryPath, process.argv.slice(2), {
  stdio: "inherit",  // Full stdio passthrough
  env,               // Modified PATH for ripgrep
});

// Signal forwarding for graceful shutdown
["SIGINT", "SIGTERM", "SIGHUP"].forEach((sig) => {
  process.on(sig, () => forwardSignal(sig));
});

// Exit code mirroring
if (childResult.type === "signal") {
  process.kill(process.pid, childResult.signal);
} else {
  process.exit(childResult.exitCode);
}
```

## CLI Commands Reference

### Core Commands

| Command | Description | Aliases |
|---------|-------------|---------|
| `codex [PROMPT]` | Interactive terminal UI | - |
| `codex exec` | Non-interactive execution | `e` |
| `codex review` | Code review mode | - |
| `codex resume` | Continue previous session | - |
| `codex fork` | Branch from existing session | - |
| `codex apply` | Apply cloud task diffs | `a` |
| `codex cloud` | Browse Codex Cloud tasks | - |

### MCP Integration

| Command | Description |
|---------|-------------|
| `codex mcp list` | List configured MCP servers |
| `codex mcp get <name>` | Get server configuration |
| `codex mcp add <name>` | Add new MCP server |
| `codex mcp remove <name>` | Remove MCP server |
| `codex mcp login <name>` | OAuth login for server |
| `codex mcp logout <name>` | Logout from server |
| `codex mcp-server` | Run Codex as MCP server |

### Authentication

| Command | Description |
|---------|-------------|
| `codex login` | Authenticate (ChatGPT OAuth or API key) |
| `codex logout` | Remove stored credentials |

### Utility Commands

| Command | Description |
|---------|-------------|
| `codex features list` | Show feature flags |
| `codex features enable <flag>` | Enable feature |
| `codex features disable <flag>` | Disable feature |
| `codex completion <shell>` | Generate shell completions |
| `codex sandbox <cmd>` | Run command in sandbox |
| `codex debug` | Debugging tools |

## Feature Flags

### Stable Features (Default: ON)

| Feature | Description |
|---------|-------------|
| `shell_tool` | Default shell command tool |
| `unified_exec` | PTY-backed exec tool |
| `request_rule` | Smart approvals |
| `enable_request_compression` | Compress requests |
| `skill_mcp_dependency_install` | Auto-install skill dependencies |
| `steer` | Steering controls |
| `collaboration_modes` | Collaboration mode selection |
| `personality` | Personality customization |

### Experimental Features (Default: OFF)

| Feature | Description |
|---------|-------------|
| `shell_snapshot` | Cache shell environment |
| `child_agents_md` | Nested AGENTS.md support |
| `apply_patch_freeform` | Freeform patch application |
| `collab` | Collaboration features |
| `apps` | App integrations |

### Under Development (Default: varies)

| Feature | Default | Description |
|---------|---------|-------------|
| `exec_policy` | ON | Enforce policy rules |
| `remote_compaction` | ON | Remote history compression |
| `remote_models` | ON | Refresh model list |
| `runtime_metrics` | OFF | Performance metrics |
| `sqlite` | OFF | SQLite integration |
| `use_linux_sandbox_bwrap` | OFF | Bubblewrap sandboxing |

## Configuration Options

### Command Line Flags

| Flag | Values | Description |
|------|--------|-------------|
| `-c, --config` | `key=value` | Override config.toml values |
| `-m, --model` | string | Select model |
| `-s, --sandbox` | `read-only`, `workspace-write`, `danger-full-access` | Sandbox mode |
| `-a, --ask-for-approval` | `untrusted`, `on-failure`, `on-request`, `never` | Approval policy |
| `-p, --profile` | string | Load config profile |
| `-C, --cd` | path | Working directory |
| `-i, --image` | paths | Attach images |
| `--oss` | - | Use local OSS provider |
| `--local-provider` | `lmstudio`, `ollama` | OSS provider selection |
| `--full-auto` | - | Low-friction automatic mode |
| `--dangerously-bypass-approvals-and-sandbox` | - | YOLO mode |
| `--search` | - | Enable live web search |
| `--add-dir` | path | Additional writable directories |

### Exec-Specific Options

| Flag | Description |
|------|-------------|
| `--json` | Output JSONL events |
| `-o, --output-last-message` | Write final message to file |
| `--output-schema` | JSON Schema for response validation |
| `--skip-git-repo-check` | Allow non-Git directories |
| `--color` | `always`, `never`, `auto` |

## Vendored Dependencies

### ripgrep (`rg`)

Codex includes pre-built ripgrep binaries for fast file searching.

**Version**: 14.1.1 (most platforms), 13.0.0-13 (Windows ARM64)

The `bin/rg` file uses [dotslash](https://dotslash-cli.com/) format:

```json
{
  "name": "rg",
  "platforms": {
    "macos-aarch64": {
      "hash": "blake3",
      "digest": "8d9942032585...",
      "format": "tar.gz",
      "path": "ripgrep-14.1.1-aarch64-apple-darwin/rg",
      "providers": [{
        "url": "https://github.com/BurntSushi/ripgrep/releases/..."
      }]
    }
    // ... other platforms
  }
}
```

## Integration with Claude Flow

### Parallels

| Claude Flow | Codex | Notes |
|-------------|-------|-------|
| `CLAUDE.md` | `AGENTS.md` | Project instructions |
| `CLAUDE.local.md` | `AGENTS.override.md` | Local overrides |
| `.claude/skills/*.md` | `.agents/skills/*/SKILL.md` | Skills |
| `.claude/settings.json` | `~/.codex/config.toml` | Configuration |
| `.mcp.json` | `config.toml [mcp_servers]` | MCP config |
| Hooks system | Automations | Background tasks |
| `claude -p` | `codex exec` | Non-interactive |
| Permission modes | Approval policies | Safety |

### Recommended Integration Points

1. **MCP Server Mode**
   - Codex can run as MCP server (`codex mcp-server`)
   - Claude Flow can connect to Codex as MCP client
   - Enables cross-platform agent orchestration

2. **Skills Conversion**
   - Convert `.claude/skills/*.md` to `.agents/skills/*/SKILL.md`
   - Maintain bidirectional sync

3. **Configuration Translation**
   - Map `settings.json` hooks to `config.toml` features
   - Translate approval policies

4. **Session Interop**
   - Codex sessions use `codex resume`/`codex fork`
   - Claude Flow uses session persistence
   - Consider session format translation

## Security Considerations

### Sandbox Modes

| Mode | File Access | Network | Use Case |
|------|-------------|---------|----------|
| `read-only` | Read only | Blocked | Safe exploration |
| `workspace-write` | Workspace only | Limited | Normal development |
| `danger-full-access` | Unrestricted | Unrestricted | Trusted environments |

### Approval Policies

| Policy | Behavior | Risk Level |
|--------|----------|------------|
| `untrusted` | Only trusted commands | Low |
| `on-failure` | Approve on failure | Medium |
| `on-request` | Model decides | Medium-High |
| `never` | No approval | High |

### Dangerous Flag

```bash
--dangerously-bypass-approvals-and-sandbox
```

This flag bypasses ALL safety checks. Only use in:
- Externally sandboxed environments (containers, VMs)
- CI/CD pipelines with proper isolation
- Automated testing infrastructure

## Implementation Recommendations

### For `init --codex`

1. **Generate AGENTS.md** from project analysis
2. **Create `.agents/skills/`** directory with converted skills
3. **Generate `config.toml`** with:
   - MCP server configuration for claude-flow
   - Skill enablement
   - Default approval policy (`on-request`)
   - Default sandbox mode (`workspace-write`)

4. **Create `.codex/` for local overrides** (gitignored)

### For Dual-Mode Support

1. **Keep both configurations in sync**
2. **Use `.claude-flow/` as shared runtime**
3. **Generate platform-specific skills**
4. **Map hooks ↔ automations**

### For MCP Integration

```toml
# Claude Flow as MCP server for Codex
[mcp_servers.claude-flow]
command = "npx"
args = ["-y", "@claude-flow/cli@latest"]
enabled = true
tool_timeout_sec = 120
```

## Conclusion

The `@openai/codex` package is a well-designed native binary wrapper that:

1. **Is lightweight** - The Node.js wrapper is only 177 lines
2. **Is cross-platform** - Supports all major OS/arch combinations
3. **Includes dependencies** - Bundles ripgrep for file search
4. **Follows standards** - Uses AGENTS.md, Skills, MCP
5. **Is actively developed** - 27+ feature flags indicate rapid iteration

The package architecture is similar to Claude Code's approach, making it straightforward to create a compatible Codex integration in claude-flow.

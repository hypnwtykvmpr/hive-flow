#!/bin/bash
# Hive Flow Plugin Installation Script
# Version: 2.5.0

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

success() {
    echo -e "${GREEN}✓${NC} $1"
}

warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

error() {
    echo -e "${RED}✗${NC} $1"
}

# Install hive-flow as a global Claude Code plugin
# Called via: bash install.sh --plugin-only
# Also called via npm postinstall
install_global_plugin() {
    local SCRIPT_DIR
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local PLUGIN_SOURCE
    PLUGIN_SOURCE="$(dirname "$SCRIPT_DIR")"  # .claude-plugin/ dir

    local PLUGIN_VERSION
    PLUGIN_VERSION=$(node -e "try{console.log(require('$PLUGIN_SOURCE/plugin.json').version)}catch(e){console.log('2.5.0')}" 2>/dev/null || echo "2.5.0")

    local CACHE_DIR="$HOME/.claude/plugins/cache/local/hive-flow/$PLUGIN_VERSION"
    mkdir -p "$CACHE_DIR/hooks"

    cp "$PLUGIN_SOURCE/plugin.json" "$CACHE_DIR/plugin.json"
    cp "$PLUGIN_SOURCE/hooks/hooks.json" "$CACHE_DIR/hooks/hooks.json"

    local SETTINGS="$HOME/.claude/settings.json"
    if [ -f "$SETTINGS" ]; then
        PLUGIN_SOURCE="$PLUGIN_SOURCE" python3 << 'PYEOF'
import json, os

settings_path = os.path.expanduser('~/.claude/settings.json')
plugin_source = os.environ['PLUGIN_SOURCE']
hooks_path = os.path.join(plugin_source, 'hooks', 'hooks.json')

with open(settings_path) as f:
    settings = json.load(f)

with open(hooks_path) as f:
    plugin_hooks = json.load(f)

existing = settings.setdefault('hooks', {})

for event, handlers in plugin_hooks.get('hooks', {}).items():
    if not isinstance(handlers, list):
        handlers = [handlers]
    existing_handlers = existing.setdefault(event, [])
    for h in handlers:
        inner_cmds = [hh.get('command', '') for hh in h.get('hooks', []) if isinstance(hh, dict)] if isinstance(h, dict) else []
        already = False
        for eh in existing_handlers:
            eh_str = json.dumps(eh)
            if inner_cmds:
                if any(c in eh_str for c in inner_cmds if c):
                    already = True
                    break
            elif isinstance(h, dict) and h.get('command', '') in eh_str:
                already = True
                break
        if not already:
            existing_handlers.append(h)

with open(settings_path, 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')

print('hive-flow hooks merged into ' + settings_path)
PYEOF
    fi

    echo ""
    echo "✓ hive-flow plugin installed to $CACHE_DIR"
    echo "✓ Hooks registered in $SETTINGS"
    echo "  Restart Claude Code to activate the plugin globally."
}

# Handle --plugin-only flag (called from npm postinstall)
if [[ "${1:-}" == "--plugin-only" ]]; then
    install_global_plugin
    exit $?
fi

# Banner
echo -e "${BLUE}"
cat << "EOF"
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║          Hive Flow Plugin Installer v2.5.0             ║
║       Enterprise AI Agent Orchestration Plugin           ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
EOF
echo -e "${NC}"

# Check prerequisites
info "Checking prerequisites..."

# Check Claude Code
if ! command -v claude &> /dev/null; then
    error "Claude Code CLI not found. Please install it first:"
    echo "  Visit: https://claude.com/code"
    exit 1
fi
success "Claude Code CLI detected"

# Check Node.js version
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 20 ]; then
        error "Node.js version must be >= 20.0.0"
        echo "  Current version: $(node -v)"
        exit 1
    fi
    success "Node.js $(node -v) detected"
else
    warning "Node.js not found (optional for MCP features)"
fi

# Check Git
if command -v git &> /dev/null; then
    success "Git $(git --version | cut -d' ' -f3) detected"
else
    warning "Git not found (required for GitHub integration features)"
fi

echo ""
info "Installation Options:"
echo "  1. Full installation (commands + agents + MCP servers)"
echo "  2. Commands only"
echo "  3. Agents only"
echo "  4. MCP servers only"
echo ""

read -p "Select installation type (1-4) [1]: " INSTALL_TYPE
INSTALL_TYPE=${INSTALL_TYPE:-1}

# Determine installation directories
CLAUDE_DIR="${HOME}/.claude"
COMMANDS_DIR="${CLAUDE_DIR}/commands"
AGENTS_DIR="${CLAUDE_DIR}/agents"
SETTINGS_FILE="${CLAUDE_DIR}/settings.json"

# Create directories
info "Creating directories..."
mkdir -p "$COMMANDS_DIR"
mkdir -p "$AGENTS_DIR"
success "Directories created"

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"

# Install commands
if [ "$INSTALL_TYPE" = "1" ] || [ "$INSTALL_TYPE" = "2" ]; then
    info "Installing 150+ slash commands..."

    if [ -d "$PLUGIN_DIR/commands" ]; then
        cp -r "$PLUGIN_DIR/commands/"* "$COMMANDS_DIR/"
        COMMAND_COUNT=$(find "$COMMANDS_DIR" -name "*.md" | wc -l | tr -d ' ')
        success "Installed $COMMAND_COUNT commands"
    else
        error "Commands directory not found"
        exit 1
    fi
fi

# Install agents
if [ "$INSTALL_TYPE" = "1" ] || [ "$INSTALL_TYPE" = "3" ]; then
    info "Installing 74+ specialized agents..."

    if [ -d "$PLUGIN_DIR/agents" ]; then
        cp -r "$PLUGIN_DIR/agents/"* "$AGENTS_DIR/"
        AGENT_COUNT=$(find "$AGENTS_DIR" -name "*.md" | wc -l | tr -d ' ')
        success "Installed $AGENT_COUNT agents"
    else
        error "Agents directory not found"
        exit 1
    fi
fi

# Setup MCP servers
if [ "$INSTALL_TYPE" = "1" ] || [ "$INSTALL_TYPE" = "4" ]; then
    info "Configuring MCP servers..."

    # Create or update settings.json
    if [ ! -f "$SETTINGS_FILE" ]; then
        cat > "$SETTINGS_FILE" << 'SETTINGS_EOF'
{
  "mcpServers": {
    "hive-flow": {
      "command": "node",
      "args": ["/Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/mcp-server.js", "mcp", "start"],
      "description": "Core Hive Flow MCP server with 40+ orchestration tools"
    }
  }
}
SETTINGS_EOF
        success "Created settings.json with Hive Flow MCP server"
    else
        info "Settings file exists. Please manually add MCP servers:"
        echo ""
        cat << 'MCP_INSTRUCTIONS'
Add to ~/.claude/settings.json:

{
  "mcpServers": {
    "hive-flow": {
      "command": "node",
      "args": ["/Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/mcp-server.js", "mcp", "start"]
    },
    # [REMOVED] ruv-swarm and flow-nexus have no local equivalent
    # "ruv-swarm": {
    #   "command": "npx",
    #   "args": ["ruv-swarm", "mcp", "start"]
    # },
    # [REMOVED] ruv-swarm and flow-nexus have no local equivalent
    # "flow-nexus": {
    #   "command": "npx",
    #   "args": ["flow-nexus@latest", "mcp", "start"]
    # }
  }
}
MCP_INSTRUCTIONS
        echo ""
    fi

    # Install MCP packages
    read -p "Install MCP packages now? (y/n) [y]: " INSTALL_MCP
    INSTALL_MCP=${INSTALL_MCP:-y}

    if [ "$INSTALL_MCP" = "y" ]; then
        info "Installing hive-flow MCP server..."
        node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js --version 2>/dev/null || true  # Local dev: no npm install needed — using local build at /Users/jonathandirks/Development/Tools/hive-flow
        success "Hive Flow MCP server installed"

        # [REMOVED] ruv-swarm and flow-nexus have no local equivalent
        # read -p "Install optional ruv-swarm MCP? (y/n) [n]: " INSTALL_RUV
        # if [ "$INSTALL_RUV" = "y" ]; then
        #     info "Installing ruv-swarm MCP server..."
        #     npx ruv-swarm --version 2>/dev/null || npm install -g ruv-swarm
        #     success "ruv-swarm MCP server installed"
        # fi

        # [REMOVED] ruv-swarm and flow-nexus have no local equivalent
        # read -p "Install optional flow-nexus MCP? (y/n) [n]: " INSTALL_NEXUS
        # if [ "$INSTALL_NEXUS" = "y" ]; then
        #     info "Installing flow-nexus MCP server..."
        #     npx flow-nexus@latest --version 2>/dev/null || npm install -g flow-nexus@latest
        #     success "flow-nexus MCP server installed"
        # fi
    fi
fi

# Installation complete
echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                                                           ║${NC}"
echo -e "${GREEN}║           🎉 Installation Complete! 🎉                   ║${NC}"
echo -e "${GREEN}║                                                           ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""

info "Next Steps:"
echo ""
echo "  1. Restart Claude Code to load the plugin"
echo "  2. Verify installation:"
echo "     $ claude --version"
echo ""
echo "  3. Try a command:"
echo "     /coordination-swarm-init"
echo ""
echo "  4. Test MCP integration:"
echo "     In Claude Code, check available MCP tools"
echo ""

info "Available Commands:"
echo "  • 150+ slash commands in ~/.claude/commands/"
echo "  • 74+ specialized agents in ~/.claude/agents/"
echo "  • 3 MCP servers with 110+ tools"
echo ""

info "Documentation:"
echo "  • README: $PLUGIN_DIR/README.md"
echo "  • Quickstart: $PLUGIN_DIR/docs/QUICKSTART.md"
echo "  • User Guide: $PLUGIN_DIR/docs/USER_GUIDE.md"
echo "  • Examples: $PLUGIN_DIR/docs/EXAMPLES.md"
echo ""

success "Hive Flow plugin is ready to use!"
echo ""

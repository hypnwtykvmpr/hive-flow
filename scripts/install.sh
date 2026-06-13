#!/usr/bin/env bash
#
# Hive Flow Installer
#
# Usage:
#
# Options (via arguments):
#   --minimal             Minimal install (no optional deps)
#   --full                Full setup (global + MCP + doctor + init)
#   --version=X.X.X       Specific version
#
# Options (via environment - requires export):
#   export HIVE_FLOW_VERSION=alpha
#   export HIVE_FLOW_MINIMAL=1
#   export HIVE_FLOW_GLOBAL=1
#

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m' # No Color

# Default configuration (can be overridden by env vars)
VERSION="${HIVE_FLOW_VERSION:-alpha}"
MINIMAL="${HIVE_FLOW_MINIMAL:-0}"
GLOBAL="${HIVE_FLOW_GLOBAL:-0}"
SETUP_MCP="${HIVE_FLOW_SETUP_MCP:-0}"
RUN_DOCTOR="${HIVE_FLOW_DOCTOR:-0}"
RUN_INIT="${HIVE_FLOW_INIT:-1}"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --global|-g)
            GLOBAL="1"
            shift
            ;;
        --minimal|-m)
            MINIMAL="1"
            shift
            ;;
        --setup-mcp|--mcp)
            SETUP_MCP="1"
            shift
            ;;
        --doctor|-d)
            RUN_DOCTOR="1"
            shift
            ;;
        --init|-i)
            RUN_INIT="1"
            shift
            ;;
        --no-init)
            RUN_INIT="0"
            shift
            ;;
        --full|-f)
            GLOBAL="1"
            SETUP_MCP="1"
            RUN_DOCTOR="1"
            RUN_INIT="1"
            shift
            ;;
        --version=*)
            VERSION="${1#*=}"
            shift
            ;;
        --help|-h)
            echo "Hive Flow Installer"
            echo ""
            echo "Usage: curl -fsSL .../install.sh | bash -s -- [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --global, -g     Install globally (npm install -g hive-flow)"
            echo "  --minimal, -m    Minimal install (skip optional deps)"
            echo "  --setup-mcp      Auto-configure MCP server for Claude Code"
            echo "  --doctor, -d     Run diagnostics after install"
            echo "  --no-init        Skip project initialization (enabled by default)"
            echo "  --full, -f       Full setup (global + mcp + doctor + init)"
            echo "  --version=X.X.X  Install specific version (default: alpha)"
            echo "  --help, -h       Show this help"
            exit 0
            ;;
        *)
            shift
            ;;
    esac
done

PACKAGE="hive-flow@${VERSION}"

# Progress animation
SPINNER_CHARS="⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
SPINNER_INDEX=0

spinner() {
    printf "\r${CYAN}${SPINNER_CHARS:SPINNER_INDEX++:1}${NC} $1"
    SPINNER_INDEX=$((SPINNER_INDEX % 10))
}

print_banner() {
    echo ""
    echo -e "${CYAN}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║${NC}  ${BOLD}Hive Flow${NC} - AI Agent Orchestration for Claude Code ${CYAN}║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

print_step() {
    echo -e "${GREEN}▸${NC} $1"
}

print_substep() {
    echo -e "  ${DIM}├─${NC} $1"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

check_requirements() {
    print_step "Checking requirements..."

    # Check Node.js
    if command -v node &> /dev/null; then
        NODE_VERSION=$(node -v | sed 's/v//')
        NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
        if [ "$NODE_MAJOR" -ge 20 ]; then
            print_substep "Node.js ${GREEN}v${NODE_VERSION}${NC} ✓"
        else
            print_error "Node.js 20+ required (found v${NODE_VERSION})"
            echo ""
            echo "Install Node.js 20+:"
            echo "  fnm install 20"
            exit 1
        fi
    else
        print_error "Node.js not found"
        echo ""
        echo "Install Node.js 20+:"
        echo "  fnm install 20"
        exit 1
    fi

    # Check npm
    if command -v npm &> /dev/null; then
        NPM_VERSION=$(npm -v)
        print_substep "npm ${GREEN}v${NPM_VERSION}${NC} ✓"
    else
        print_error "npm not found"
        exit 1
    fi

    # Check Claude Code CLI
    if command -v claude &> /dev/null; then
        CLAUDE_VERSION=$(claude --version 2>/dev/null | head -1 || echo "installed")
        print_substep "Claude Code ${GREEN}${CLAUDE_VERSION}${NC} ✓"
    else
        print_warning "Claude Code CLI not found"
        print_substep "Installing Claude Code CLI via npm..."
        if npm install -g @anthropic-ai/claude-code 2>/dev/null; then
            if command -v claude &> /dev/null; then
                CLAUDE_VERSION=$(claude --version 2>/dev/null | head -1 || echo "installed")
                print_substep "Claude Code ${GREEN}${CLAUDE_VERSION}${NC} ✓"
            else
                print_substep "Installed. Restart terminal to use 'claude' command"
            fi
        else
            print_warning "npm install failed. Try manually:"
            print_substep "${BOLD}npm install -g @anthropic-ai/claude-code${NC}"
        fi
    fi

    echo ""
}

show_install_options() {
    print_step "Installation options:"
    print_substep "Package: ${BOLD}${PACKAGE}${NC}"
    if [ "$GLOBAL" = "1" ]; then
        print_substep "Mode: ${BOLD}Global${NC} (npm install -g)"
    else
        print_substep "Mode: ${BOLD}npx${NC} (on-demand)"
    fi
    if [ "$MINIMAL" = "1" ]; then
        print_substep "Profile: ${BOLD}Minimal${NC} (--omit=optional)"
    else
        print_substep "Profile: ${BOLD}Full${NC} (all features)"
    fi
    echo ""
}

install_package() {
    local START_TIME=$(date +%s)

    if [ "$GLOBAL" = "1" ]; then
        print_step "Installing globally..."

        if [ "$MINIMAL" = "1" ]; then
            npm install -g "$PACKAGE" --omit=optional 2>&1 | while read -r line; do
                if [[ "$line" == *"added"* ]]; then
                    print_substep "$line"
                fi
            done
        else
            npm install -g "$PACKAGE" 2>&1 | while read -r line; do
                if [[ "$line" == *"added"* ]]; then
                    print_substep "$line"
                fi
            done
        fi
    else
        print_step "Installing for npx usage..."
        npx -y "$PACKAGE" --version >/dev/null 2>&1 || true
        print_substep "Package installed for npx"
    fi

    local END_TIME=$(date +%s)
    local DURATION=$((END_TIME - START_TIME))

    echo ""
    print_success "Installed in ${BOLD}${DURATION}s${NC}"
}

verify_installation() {
    print_step "Verifying installation..."

    local VERSION_OUTPUT
    if [ "$GLOBAL" = "1" ]; then
        VERSION_OUTPUT=$(hive-flow --version 2>/dev/null || echo "")
        if [ -z "$VERSION_OUTPUT" ]; then
            print_warning "Global command not found in PATH"
            print_substep "Try: ${BOLD}npm install -g hive-flow@${VERSION}${NC}"
            return 0  # Don't fail - npm might need PATH refresh
        fi
    else
        VERSION_OUTPUT=$(npx "$PACKAGE" --version 2>/dev/null || echo "")
    fi

    if [ -n "$VERSION_OUTPUT" ]; then
        print_substep "Version: ${GREEN}${VERSION_OUTPUT}${NC}"
        echo ""
        return 0
    else
        print_error "Installation verification failed"
        return 1
    fi
}

show_quickstart() {
    echo -e "${CYAN}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║${NC}  ${BOLD}Quick Start${NC}                                              ${CYAN}║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════╝${NC}"
    echo ""

    if [ "$GLOBAL" = "1" ]; then
        echo -e "  ${DIM}# Initialize project${NC}"
        echo -e "  ${BOLD}hive-flow init --wizard${NC}"
        echo ""
        echo -e "  ${DIM}# Run system diagnostics${NC}"
        echo -e "  ${BOLD}hive-flow doctor${NC}"
        echo ""
        echo -e "  ${DIM}# Add as MCP server to Claude Code${NC}"
        echo -e "  ${BOLD}claude mcp add hive-flow -- hive-flow mcp start${NC}"
    else
        echo -e "  ${DIM}# Initialize project${NC}"
        echo -e "  ${BOLD}npx ${PACKAGE} init --wizard${NC}"
        echo ""
        echo -e "  ${DIM}# Run system diagnostics${NC}"
        echo -e "  ${BOLD}npx ${PACKAGE} doctor${NC}"
        echo ""
        echo -e "  ${DIM}# Add as MCP server to Claude Code${NC}"
        echo -e "  ${BOLD}claude mcp add hive-flow -- npx -y ${PACKAGE} mcp start${NC}"
    fi

    echo ""
    echo ""
}

setup_mcp_server() {
    if [ "$SETUP_MCP" != "1" ]; then
        return 0
    fi

    print_step "Setting up MCP server..."

    if ! command -v claude &> /dev/null; then
        print_warning "Claude CLI not found, skipping MCP setup"
        return 0
    fi

    # Check if already configured
    if claude mcp list 2>/dev/null | grep -q "hive-flow"; then
        print_substep "MCP server already configured ✓"
        return 0
    fi

    # Add MCP server
    if [ "$GLOBAL" = "1" ]; then
        claude mcp add hive-flow -- hive-flow mcp start 2>/dev/null && \
            print_substep "MCP server configured ✓" || \
            print_warning "MCP setup failed - run manually: claude mcp add hive-flow -- hive-flow mcp start"
    else
        claude mcp add hive-flow -- npx -y "$PACKAGE" mcp start 2>/dev/null && \
            print_substep "MCP server configured ✓" || \
            print_warning "MCP setup failed - run manually: claude mcp add hive-flow -- npx -y ${PACKAGE} mcp start"
    fi
    echo ""
}

run_doctor() {
    if [ "$RUN_DOCTOR" != "1" ]; then
        return 0
    fi

    print_step "Running diagnostics..."
    echo ""

    if [ "$GLOBAL" = "1" ]; then
        hive-flow doctor 2>&1 || true
    else
        npx -y "$PACKAGE" doctor 2>&1 || true
    fi
    echo ""
}

run_init() {
    if [ "$RUN_INIT" != "1" ]; then
        return 0
    fi

    print_step "Initializing project..."
    echo ""

    if [ "$GLOBAL" = "1" ]; then
        hive-flow init --yes 2>&1 || true
    else
        npx -y "$PACKAGE" init --yes 2>&1 || true
    fi
    echo ""
}

# Main
main() {
    print_banner
    check_requirements
    show_install_options
    install_package
    verify_installation
    setup_mcp_server
    run_doctor
    run_init
    show_quickstart

    print_success "${BOLD}Hive Flow is ready!${NC}"
    echo ""
}

main "$@"

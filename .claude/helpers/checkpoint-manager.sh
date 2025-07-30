#!/bin/bash
# Claude Checkpoint Manager - Easy rollback functionality

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# Checkpoint directory
CHECKPOINT_DIR=".claude/checkpoints"

function show_help() {
    cat << EOF
Claude Checkpoint Manager
========================

Usage: $0 <command> [options]

Commands:
  list              List all checkpoints
  show <id>         Show details of a specific checkpoint
  rollback <id>     Rollback to a specific checkpoint
  diff <id>         Show diff since checkpoint
  clean             Clean old checkpoints (older than 7 days)
  summary           Show session summary
  
Options:
  --hard            For rollback: use git reset --hard (destructive)
  --soft            For rollback: use git reset --soft (default)
  --branch          For rollback: create new branch from checkpoint

Examples:
  $0 list
  $0 show checkpoint-20240130-143022
  $0 rollback checkpoint-20240130-143022 --branch
  $0 diff session-end-session-20240130-150000
  
EOF
}

function list_checkpoints() {
    echo -e "${BLUE}📋 Available Checkpoints:${NC}"
    echo ""
    
    # List checkpoint tags
    echo -e "${YELLOW}Git Tags:${NC}"
    local tags=$(git tag -l 'checkpoint-*' -l 'session-end-*' -l 'task-*' --sort=-creatordate | head -20)
    if [ -n "$tags" ]; then
        echo "$tags"
    else
        echo "No checkpoint tags found"
    fi
    
    echo ""
    
    # List checkpoint branches
    echo -e "${YELLOW}Checkpoint Branches:${NC}"
    local branches=$(git branch -a | grep "checkpoint/" | sed 's/^[ *]*//')
    if [ -n "$branches" ]; then
        echo "$branches"
    else
        echo "No checkpoint branches found"
    fi
    
    echo ""
    
    # List checkpoint files
    if [ -d "$CHECKPOINT_DIR" ]; then
        echo -e "${YELLOW}Recent Checkpoint Files:${NC}"
        find "$CHECKPOINT_DIR" -name "*.json" -type f -printf "%T@ %p\n" | \
            sort -rn | head -10 | while read -r timestamp file; do
            basename "$file"
        done
    fi
}

function show_checkpoint() {
    local checkpoint_id="$1"
    
    if [ -z "$checkpoint_id" ]; then
        echo -e "${RED}Error: Please specify a checkpoint ID${NC}"
        exit 1
    fi
    
    echo -e "${BLUE}📍 Checkpoint Details: $checkpoint_id${NC}"
    echo ""
    
    # Check if it's a tag
    if git rev-parse "refs/tags/$checkpoint_id" >/dev/null 2>&1; then
        echo -e "${YELLOW}Type:${NC} Git Tag"
        echo -e "${YELLOW}Commit:${NC} $(git rev-parse "$checkpoint_id")"
        echo -e "${YELLOW}Date:${NC} $(git log -1 --format=%ci "$checkpoint_id")"
        echo -e "${YELLOW}Message:${NC}"
        git log -1 --format=%B "$checkpoint_id" | sed 's/^/  /'
        echo ""
        echo -e "${YELLOW}Files changed:${NC}"
        git diff --stat "$checkpoint_id"^ "$checkpoint_id" 2>/dev/null || echo "  (First commit)"
    
    # Check if it's a branch
    elif git rev-parse "refs/heads/$checkpoint_id" >/dev/null 2>&1; then
        echo -e "${YELLOW}Type:${NC} Git Branch"
        echo -e "${YELLOW}Commit:${NC} $(git rev-parse "$checkpoint_id")"
        echo -e "${YELLOW}Date:${NC} $(git log -1 --format=%ci "$checkpoint_id")"
        
    # Check checkpoint files
    elif [ -f "$CHECKPOINT_DIR/$checkpoint_id.json" ]; then
        echo -e "${YELLOW}Checkpoint File:${NC}"
        jq '.' "$CHECKPOINT_DIR/$checkpoint_id.json"
    else
        echo -e "${RED}Checkpoint not found: $checkpoint_id${NC}"
        exit 1
    fi
}

function rollback_checkpoint() {
    local checkpoint_id="$1"
    local mode="soft"
    local create_branch=false
    
    # Parse additional options
    shift
    while [[ $# -gt 0 ]]; do
        case $1 in
            --hard)
                mode="hard"
                shift
                ;;
            --soft)
                mode="soft"
                shift
                ;;
            --branch)
                create_branch=true
                shift
                ;;
            *)
                shift
                ;;
        esac
    done
    
    if [ -z "$checkpoint_id" ]; then
        echo -e "${RED}Error: Please specify a checkpoint ID${NC}"
        exit 1
    fi
    
    # Check for uncommitted changes
    if ! git diff --quiet || ! git diff --cached --quiet; then
        echo -e "${YELLOW}⚠️  Warning: You have uncommitted changes${NC}"
        read -p "Do you want to stash them first? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            git stash push -m "Stash before rollback to $checkpoint_id"
            echo -e "${GREEN}✅ Changes stashed${NC}"
        fi
    fi
    
    # Get current branch
    current_branch=$(git branch --show-current)
    
    # Perform rollback
    if [ "$create_branch" = true ]; then
        # Create new branch from checkpoint
        new_branch="rollback/$checkpoint_id-$(date +%Y%m%d-%H%M%S)"
        echo -e "${BLUE}Creating new branch: $new_branch${NC}"
        git checkout -b "$new_branch" "$checkpoint_id"
        echo -e "${GREEN}✅ Created and switched to branch: $new_branch${NC}"
    else
        # Reset to checkpoint
        echo -e "${BLUE}Rolling back to: $checkpoint_id${NC}"
        if [ "$mode" = "hard" ]; then
            echo -e "${YELLOW}⚠️  Using --hard reset (destructive)${NC}"
            git reset --hard "$checkpoint_id"
        else
            git reset --soft "$checkpoint_id"
            echo -e "${GREEN}✅ Soft reset complete. Changes are staged.${NC}"
        fi
    fi
    
    echo ""
    echo -e "${GREEN}✅ Rollback complete!${NC}"
    echo -e "Original branch: $current_branch"
    echo -e "Current position: $(git rev-parse --short HEAD)"
}

function show_diff() {
    local checkpoint_id="$1"
    
    if [ -z "$checkpoint_id" ]; then
        echo -e "${RED}Error: Please specify a checkpoint ID${NC}"
        exit 1
    fi
    
    echo -e "${BLUE}📊 Changes since checkpoint: $checkpoint_id${NC}"
    echo ""
    
    # Show diff
    git diff "$checkpoint_id" HEAD
}

function clean_old_checkpoints() {
    echo -e "${BLUE}🧹 Cleaning old checkpoints...${NC}"
    
    # Clean old checkpoint files
    if [ -d "$CHECKPOINT_DIR" ]; then
        find "$CHECKPOINT_DIR" -name "*.json" -mtime +7 -delete
        echo -e "${GREEN}✅ Removed checkpoint files older than 7 days${NC}"
    fi
    
    # List old tags (but don't delete automatically)
    echo ""
    echo -e "${YELLOW}Old checkpoint tags (manual cleanup recommended):${NC}"
    git tag -l 'checkpoint-*' --sort=creatordate | head -10
    
    echo ""
    echo "To delete old tags manually:"
    echo "  git tag -d <tag-name>"
    echo "  git push origin --delete <tag-name>  # if pushed"
}

function show_summary() {
    local latest_summary=$(find "$CHECKPOINT_DIR" -name "summary-*.md" -type f -printf "%T@ %p\n" 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
    
    if [ -n "$latest_summary" ] && [ -f "$latest_summary" ]; then
        echo -e "${BLUE}📋 Latest Session Summary:${NC}"
        echo ""
        cat "$latest_summary"
    else
        echo -e "${YELLOW}No session summary found${NC}"
        echo "Session summaries are created when Claude's Stop hook is triggered"
    fi
}

# Main command handling
case "${1:-help}" in
    list)
        list_checkpoints
        ;;
    show)
        show_checkpoint "$2"
        ;;
    rollback)
        rollback_checkpoint "$2" "${@:3}"
        ;;
    diff)
        show_diff "$2"
        ;;
    clean)
        clean_old_checkpoints
        ;;
    summary)
        show_summary
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        echo -e "${RED}Unknown command: $1${NC}"
        echo ""
        show_help
        exit 1
        ;;
esac
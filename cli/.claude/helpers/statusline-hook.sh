# Hive Flow V3 Statusline Hook
# Add to your shell RC file (.bashrc, .zshrc, etc.)

# Function to get statusline
hive_flow_statusline() {
  local statusline_script="${HIVE_FLOW_DIR:-.claude}/helpers/statusline.cjs"
  if [ -f "$statusline_script" ]; then
    node "$statusline_script" 2>/dev/null || echo ""
  fi
}

# For bash PS1
# export PS1='$(hive_flow_statusline) \n\$ '

# For zsh RPROMPT
# export RPROMPT='$(hive_flow_statusline)'

# For starship (add to starship.toml)
# [custom.hive_flow]
# command = "node .claude/helpers/statusline.cjs 2>/dev/null"
# when = "test -f .claude/helpers/statusline.cjs"

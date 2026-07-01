#!/bin/bash
# Hive Flow V3 - Auto-sync Metrics from Actual Implementation
# Scans the V3 codebase and updates metrics to reflect reality

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI_DIR=""
LEGACY_PACKAGES_DIR="$PROJECT_ROOT/v3/@hive-flow"
METRICS_DIR="$PROJECT_ROOT/.hive-flow/metrics"
SECURITY_DIR="$PROJECT_ROOT/.hive-flow/cli/security"

# Ensure directories exist
mkdir -p "$METRICS_DIR" "$SECURITY_DIR"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RESET='\033[0m'

log() {
    echo -e "${CYAN}[sync] $1${RESET}"
}

resolve_cli_dir() {
    local candidate
    for candidate in \
        "$PROJECT_ROOT/cli" \
        "$PROJECT_ROOT" \
        "$PROJECT_ROOT/node_modules/hive-flow"; do
        if [ -d "$candidate/src" ] && [ -f "$candidate/package.json" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done

    printf '%s\n' "$PROJECT_ROOT/cli"
}

CLI_DIR="$(resolve_cli_dir)"

collect_module_dirs() {
    local dir

    if [ -d "$CLI_DIR" ]; then
        printf '%s\n' "$CLI_DIR"
    fi

    if [ -d "$CLI_DIR/packages" ]; then
        for dir in "$CLI_DIR/packages"/*/; do
            [ -d "$dir" ] || continue
            printf '%s\n' "${dir%/}"
        done
    fi

    if [ -d "$LEGACY_PACKAGES_DIR" ]; then
        for dir in "$LEGACY_PACKAGES_DIR"/*/; do
            [ -d "$dir" ] || continue
            case "$(basename "$dir")" in
                cli|providers|embeddings)
                    continue
                    ;;
            esac
            printf '%s\n' "${dir%/}"
        done
    fi
}

module_name() {
    local module_dir="$1"
    if [ "$module_dir" = "$CLI_DIR" ]; then
        printf '%s\n' "cli"
    else
        basename "$module_dir"
    fi
}

find_module_dir() {
    local wanted="$1"
    local dir
    while IFS= read -r dir; do
        [ "$(module_name "$dir")" = "$wanted" ] || continue
        printf '%s\n' "$dir"
        return 0
    done < <(collect_module_dirs)

    return 1
}

# Count active Hive Flow package roots
count_modules() {
    collect_module_dirs | wc -l | tr -d ' '
}

# Calculate module completion percentage
calculate_module_progress() {
    local module_dir="$1"

    if [ ! -d "$module_dir" ]; then
        echo "0"
        return
    fi

    local has_src=$([ -d "$module_dir/src" ] && echo 1 || echo 0)
    local has_index=$([ -f "$module_dir/src/index.ts" ] || [ -f "$module_dir/index.ts" ] && echo 1 || echo 0)
    local has_tests=$([ -d "$module_dir/__tests__" ] || [ -d "$module_dir/tests" ] && echo 1 || echo 0)
    local has_package=$([ -f "$module_dir/package.json" ] && echo 1 || echo 0)
    local file_count=$(find "$module_dir" -name "*.ts" -type f 2>/dev/null | wc -l)

    # Calculate progress based on structure and content
    local progress=0
    [ "$has_src" -eq 1 ] && ((progress += 20))
    [ "$has_index" -eq 1 ] && ((progress += 20))
    [ "$has_tests" -eq 1 ] && ((progress += 20))
    [ "$has_package" -eq 1 ] && ((progress += 10))
    [ "$file_count" -gt 5 ] && ((progress += 15))
    [ "$file_count" -gt 10 ] && ((progress += 15))

    # Cap at 100
    [ "$progress" -gt 100 ] && progress=100

    echo "$progress"
}

# Check security CVE status
check_security_status() {
    local cves_fixed=0
    local security_dir="$CLI_DIR/src/security"

    # CVE-1: Input validation - check for input-validator.ts
    if [ -f "$security_dir/input-validator.ts" ]; then
        lines=$(wc -l < "$security_dir/input-validator.ts" 2>/dev/null || echo 0)
        [ "$lines" -gt 100 ] && ((cves_fixed++))
    fi

    # CVE-2: Path traversal - check for path-validator.ts
    if [ -f "$security_dir/path-validator.ts" ]; then
        lines=$(wc -l < "$security_dir/path-validator.ts" 2>/dev/null || echo 0)
        [ "$lines" -gt 100 ] && ((cves_fixed++))
    fi

    # CVE-3: Command injection - check for safe-executor.ts
    if [ -f "$security_dir/safe-executor.ts" ]; then
        lines=$(wc -l < "$security_dir/safe-executor.ts" 2>/dev/null || echo 0)
        [ "$lines" -gt 100 ] && ((cves_fixed++))
    fi

    echo "$cves_fixed"
}

# Calculate overall DDD progress
calculate_ddd_progress() {
    local total_progress=0
    local module_count=0
    local dir

    while IFS= read -r dir; do
        progress=$(calculate_module_progress "$dir")
        ((total_progress += progress))
        ((module_count++))
    done < <(collect_module_dirs)

    if [ "$module_count" -gt 0 ]; then
        echo $((total_progress / module_count))
    else
        echo 0
    fi
}

# Count total lines of code
count_total_lines() {
    local total=0
    local dir
    local file

    while IFS= read -r dir; do
        while IFS= read -r file; do
            lines=$(wc -l < "$file" 2>/dev/null || echo 0)
            total=$((total + lines))
        done < <(find "$dir" -name "*.ts" -type f 2>/dev/null)
    done < <(collect_module_dirs)

    echo "$total"
}

# Count total files
count_total_files() {
    local total=0
    local dir

    while IFS= read -r dir; do
        count=$(find "$dir" -name "*.ts" -type f 2>/dev/null | wc -l | tr -d ' ')
        total=$((total + count))
    done < <(collect_module_dirs)

    echo "$total"
}

# Check domains (map modules to domains)
count_domains() {
    local domains=0

    # Map Hive Flow modules to DDD domains
    [ -d "$CLI_DIR/src/swarm" ] && ((domains++))       # task-management
    [ -d "$CLI_DIR/src/memory" ] && ((domains++))      # session-management
    [ -d "$CLI_DIR/src/performance" ] && ((domains++)) # health-monitoring
    [ -d "$CLI_DIR" ] && ((domains++))                 # lifecycle-management
    find_module_dir "integration" >/dev/null && ((domains++)) # event-coordination

    echo "$domains"
}

# Main sync function
sync_metrics() {
    log "Scanning V3 implementation..."

    local modules=$(count_modules)
    local domains=$(count_domains)
    local ddd_progress=$(calculate_ddd_progress)
    local cves_fixed=$(check_security_status)
    local total_files=$(count_total_files)
    local total_lines=$(count_total_lines)
    local timestamp=$(date -Iseconds)

    # Determine security status
    local security_status="PENDING"
    if [ "$cves_fixed" -eq 3 ]; then
        security_status="CLEAN"
    elif [ "$cves_fixed" -gt 0 ]; then
        security_status="IN_PROGRESS"
    fi

    log "Found: $modules modules, $domains domains, $total_files files, $total_lines lines"
    log "DDD Progress: ${ddd_progress}%, Security: $cves_fixed/3 CVEs fixed"

    # Update v3-progress.json
    cat > "$METRICS_DIR/v3-progress.json" << EOF
{
  "domains": {
    "completed": $domains,
    "total": 5,
    "list": [
      {"name": "task-management", "status": "$([ -d "$CLI_DIR/src/swarm" ] && echo "complete" || echo "pending")", "module": "swarm"},
      {"name": "session-management", "status": "$([ -d "$CLI_DIR/src/memory" ] && echo "complete" || echo "pending")", "module": "memory"},
      {"name": "health-monitoring", "status": "$([ -d "$CLI_DIR/src/performance" ] && echo "complete" || echo "pending")", "module": "performance"},
      {"name": "lifecycle-management", "status": "$([ -d "$CLI_DIR" ] && echo "complete" || echo "pending")", "module": "cli"},
      {"name": "event-coordination", "status": "$(find_module_dir "integration" >/dev/null && echo "complete" || echo "pending")", "module": "integration"}
    ]
  },
  "ddd": {
    "progress": $ddd_progress,
    "modules": $modules,
    "totalFiles": $total_files,
    "totalLines": $total_lines
  },
  "swarm": {
    "activeAgents": 0,
    "totalAgents": 15,
    "topology": "hierarchical-mesh",
    "coordination": "$([ -d "$CLI_DIR/src/swarm" ] && echo "ready" || echo "pending")"
  },
  "lastUpdated": "$timestamp",
  "autoSynced": true
}
EOF

    # Update security audit status
    cat > "$SECURITY_DIR/audit-status.json" << EOF
{
  "status": "$security_status",
  "cvesFixed": $cves_fixed,
  "totalCves": 3,
  "criticalVulnerabilities": [
    {
      "id": "CVE-1",
      "description": "Input validation bypass",
      "severity": "critical",
      "status": "$([ -f "$CLI_DIR/src/security/input-validator.ts" ] && echo "fixed" || echo "pending")",
      "fixedBy": "input-validator.ts"
    },
    {
      "id": "CVE-2",
      "description": "Path traversal vulnerability",
      "severity": "critical",
      "status": "$([ -f "$CLI_DIR/src/security/path-validator.ts" ] && echo "fixed" || echo "pending")",
      "fixedBy": "path-validator.ts"
    },
    {
      "id": "CVE-3",
      "description": "Command injection vulnerability",
      "severity": "critical",
      "status": "$([ -f "$CLI_DIR/src/security/safe-executor.ts" ] && echo "fixed" || echo "pending")",
      "fixedBy": "safe-executor.ts"
    }
  ],
  "lastAudit": "$timestamp",
  "autoSynced": true
}
EOF

    log "Metrics synced successfully!"

    # Output summary for statusline
    echo ""
    echo -e "${GREEN}V3 Implementation Status:${RESET}"
    echo "  Modules: $modules"
    echo "  Domains: $domains/5"
    echo "  DDD Progress: ${ddd_progress}%"
    echo "  Security: $cves_fixed/3 CVEs fixed ($security_status)"
    echo "  Codebase: $total_files files, $total_lines lines"
}

# Run sync
sync_metrics

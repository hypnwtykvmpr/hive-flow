#!/bin/bash
set -euo pipefail

# Usage: hive-poll-notify.sh <hiveId> [taskId1 taskId2 ...]
# Polls .hive-flow/tasks/{taskId}.result.json every 15s
# Falls back to checking hive.json status if no taskIds given
# Exits 0 when all complete, exits 1 on timeout (2h)

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
TASKS_DIR="$PROJECT_DIR/.hive-flow/tasks"
HIVES_DIR="$PROJECT_DIR/.hive-flow/hives"
POLL_INTERVAL=15
MAX_ITERATIONS=480  # 2 hours
TERMINAL_STATUSES="completed failed terminated"

# Validate hiveId (required first argument)
validate_hive_id() {
    local hive_id="$1"
    if [[ -z "$hive_id" ]]; then
        echo "ERROR: hiveId cannot be empty" >&2
        return 1
    fi
    if [[ "$hive_id" == *"/"* ]] || [[ "$hive_id" == *".."* ]]; then
        echo "ERROR: hiveId cannot contain / or .." >&2
        return 1
    fi
    return 0
}

# Validate taskId (no slashes or path traversal)
validate_task_id() {
    local task_id="$1"
    if [[ -z "$task_id" ]]; then
        echo "ERROR: taskId cannot be empty" >&2
        return 1
    fi
    if [[ "$task_id" == *"/"* ]] || [[ "$task_id" == *".."* ]]; then
        echo "ERROR: taskId cannot contain / or .." >&2
        return 1
    fi
    return 0
}


# Check hive status from hive.json file
check_hive_status() {
    local hive_file="$HIVES_DIR/$hiveId/hive.json"
    if [[ ! -f "$hive_file" ]]; then
        return 1
    fi
    
    # Extract status field using grep and sed (no jq dependency)
    local status
    status=$(grep -o '"status"[[:space:]]*:[[:space:]]*"[^"]*"' "$hive_file" 2>/dev/null | head -1 | sed 's/.*:[[:space:]]*"\([^"]*\)"/\1/')
    
    if [[ -z "$status" ]]; then
        return 1
    fi
    
    # Check if status is terminal
    for term_status in $TERMINAL_STATUSES; do
        if [[ "$status" == "$term_status" ]]; then
            echo "$status"
            return 0
        fi
    done
    
    return 1
}

# Main script starts here
if [[ $# -lt 1 ]]; then
    echo "ERROR: Usage: $0 <hiveId> [taskId1 taskId2 ...]" >&2
    exit 1
fi

hiveId="$1"
shift

if ! validate_hive_id "$hiveId"; then
    exit 1
fi

# If taskIds provided, poll for result.json files
if [[ $# -gt 0 ]]; then
    task_ids=("$@")
    
    # Validate all taskIds
    for task_id in "${task_ids[@]}"; do
        if ! validate_task_id "$task_id"; then
            exit 1
        fi
    done
    
    total_tasks=${#task_ids[@]}
    iteration=0
    
    while [[ $iteration -lt $MAX_ITERATIONS ]]; do
        completed=0
        
        for task_id in "${task_ids[@]}"; do
            result_file="$TASKS_DIR/${task_id}.result.json"
            if [[ -f "$result_file" ]]; then
                completed=$((completed + 1))
            fi
        done
        
        # All tasks completed
        if [[ $completed -eq $total_tasks ]]; then
            echo "HIVE_COMPLETE: hiveId=$hiveId completed=$completed/$total_tasks"
            exit 0
        fi
        
        # Progress output every 2 minutes (8 iterations)
        if [[ $((iteration % 8)) -eq 0 ]] && [[ $iteration -gt 0 ]]; then
            echo "[$(date +%H:%M:%S)] Polling... completed=$completed/$total_tasks" >&2
        fi
        
        iteration=$((iteration + 1))
        sleep "$POLL_INTERVAL"
    done
    
    # Timeout - count current completed tasks
    completed=0
    for task_id in "${task_ids[@]}"; do
        result_file="$TASKS_DIR/${task_id}.result.json"
        if [[ -f "$result_file" ]]; then
            completed=$((completed + 1))
        fi
    done
    
    echo "HIVE_TIMEOUT: hiveId=$hiveId completed=$completed/$total_tasks"
    exit 1
fi

# No taskIds provided - poll hive.json status field
iteration=0
while [[ $iteration -lt $MAX_ITERATIONS ]]; do
    status=$(check_hive_status || true)

    if [[ -n "$status" ]]; then
        echo "HIVE_COMPLETE: hiveId=$hiveId status=$status"
        exit 0
    fi
    
    # Progress output every 2 minutes (8 iterations)
    if [[ $((iteration % 8)) -eq 0 ]] && [[ $iteration -gt 0 ]]; then
        echo "[$(date +%H:%M:%S)] Polling hive status..." >&2
    fi
    
    iteration=$((iteration + 1))
    sleep "$POLL_INTERVAL"
done

# Timeout - check final status
final_status=$(check_hive_status || true)
if [[ -n "$final_status" ]]; then
    echo "HIVE_COMPLETE: hiveId=$hiveId status=$final_status"
else
    echo "HIVE_TIMEOUT: hiveId=$hiveId"
fi
exit 1

# issue-triage

Intelligent issue classification and triage.

## Usage
```bash
hive-flow github issue-triage [options]
```

## Options
- `--repository <owner/repo>` - Target repository
- `--auto-label` - Automatically apply labels
- `--assign` - Auto-assign to team members

## Examples
```bash
# Triage issues
hive-flow github issue-triage --repository myorg/myrepo

# With auto-labeling
hive-flow github issue-triage --repository myorg/myrepo --auto-label

# Full automation
hive-flow github issue-triage --repository myorg/myrepo --auto-label --assign
```

# code-review

Automated code review with swarm intelligence.

## Usage
```bash
hive-flow github code-review [options]
```

## Options
- `--pr-number <n>` - Pull request to review
- `--focus <areas>` - Review focus (security, performance, style)
- `--suggest-fixes` - Suggest code fixes

## Examples
```bash
# Review PR
hive-flow github code-review --pr-number 456

# Security focus
hive-flow github code-review --pr-number 456 --focus security

# With fix suggestions
hive-flow github code-review --pr-number 456 --suggest-fixes
```

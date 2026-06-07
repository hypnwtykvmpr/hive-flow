# repo-analyze

Deep analysis of GitHub repository with AI insights.

## Usage
```bash
hive-flow github repo-analyze [options]
```

## Options
- `--repository <owner/repo>` - Repository to analyze
- `--deep` - Enable deep analysis
- `--include <areas>` - Include specific areas (issues, prs, code, commits)

## Examples
```bash
# Basic analysis
hive-flow github repo-analyze --repository myorg/myrepo

# Deep analysis
hive-flow github repo-analyze --repository myorg/myrepo --deep

# Specific areas
hive-flow github repo-analyze --repository myorg/myrepo --include issues,prs
```

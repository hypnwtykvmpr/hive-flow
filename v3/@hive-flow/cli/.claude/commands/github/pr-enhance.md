# pr-enhance

AI-powered pull request enhancements.

## Usage
```bash
hive-flow github pr-enhance [options]
```

## Options
- `--pr-number <n>` - Pull request number
- `--add-tests` - Add missing tests
- `--improve-docs` - Improve documentation
- `--check-security` - Security review

## Examples
```bash
# Enhance PR
hive-flow github pr-enhance --pr-number 123

# Add tests
hive-flow github pr-enhance --pr-number 123 --add-tests

# Full enhancement
hive-flow github pr-enhance --pr-number 123 --add-tests --improve-docs
```

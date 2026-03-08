/**
 * Help text templates for Hive Flow CLI
 * Provides clear, actionable command documentation
 */

import { HelpFormatter } from './help-formatter.js';
import { VERSION } from '../core/version.js';

export { VERSION };

export const MAIN_HELP = `
🌊 Hive-Flow v${VERSION} - Enterprise-Grade AI Agent Orchestration Platform

🎯 ENTERPRISE FEATURES:
  • Complete ruv-swarm integration with 90+ MCP tools
  • Flow Nexus cloud platform with distributed sandboxes
  • Claude Code SDK integration for maximum performance
  • Production-ready infrastructure with enterprise reliability

USAGE:
  npx hive-flow <command> [options]    # Run latest alpha version
  npx hive-flow <command> --help       # Get detailed help for any command
  npx hive-flow --help                 # Show this help
  
  # After local install:
  hive-flow <command> [options]
  hive-flow <command> --help    # Get detailed help for any command

🚀 QUICK START:
  # First time setup (creates CLAUDE.md & .claude/commands)
  npx hive-flow init
  
  # 🌐 FLOW NEXUS CLOUD (NEW!):
  mcp__flow-nexus__user_register         # Register for cloud features
  mcp__flow-nexus__user_login            # Login to access sandboxes & neural networks
  mcp__flow-nexus__sandbox_create        # Create cloud execution environments
  
  # 🐝 HIVE MIND QUICK START:
  hive-flow hive-mind wizard          # Interactive setup wizard
  hive-flow hive-mind spawn "objective"  # Create intelligent swarm
  hive-flow hive-mind spawn "Build API" --claude  # Open Claude Code CLI
  
  # After setup, use without npx:
  hive-flow start --swarm              # Start with swarm intelligence
  hive-flow swarm "build REST API"     # Deploy multi-agent workflow
  hive-flow swarm "create service" --claude  # Open Claude Code CLI with swarm

🐝 HIVE MIND COMMANDS (NEW!):
  hive-mind wizard         🎯 Interactive setup wizard (RECOMMENDED)
  hive-mind init           Initialize Hive Mind system with SQLite
  hive-mind spawn <task>   Create intelligent swarm with objective
  hive-mind status         View active swarms and performance metrics
  hive-mind metrics        Advanced performance analytics

📋 CORE COMMANDS:
  init                     Initialize Hive Flow v2.0.0 (creates CLAUDE.md & .claude/commands)
                          --monitoring enables token usage tracking
  start [--swarm]          Start orchestration system
  swarm <objective>        Multi-agent swarm coordination
  agent <action>           Agent management (spawn, list, terminate)
    • agent booster        Ultra-fast code editing (352x faster, $0 cost)
      - edit <file>        Edit single file with local WASM processing
      - batch <pattern>    Batch edit multiple files (1000 files in 1 sec)
      - benchmark          Validate 352x speed claim with tests
    • agent memory         ReasoningBank learning memory (46% faster, 88% success)
      - init               Initialize ReasoningBank database
      - status             Show memory statistics
      - list               List stored memories
  sparc <mode>             SPARC development modes (13 available)
  memory <action>          ReasoningBank persistent memory system
  proxy <action>           OpenRouter proxy server (85-98% cost savings)
    - start                Start proxy server
    - status               Check proxy status
    - config               Configuration guide
  github <mode>            GitHub workflow automation (6 modes)
  status                   System status and health
  
🔍 VERIFICATION COMMANDS (NEW!):
  verify <subcommand>      Truth verification system (0.95 threshold)
  truth                    View truth scores and reliability metrics
  pair [--start]           Collaborative development with real-time verification
  
📋 SWARM INTELLIGENCE COMMANDS:
  training <command>       Neural pattern learning & model updates (3 commands)
  coordination <command>   Swarm & agent orchestration (3 commands)
  analysis <command>       Performance & token usage analytics (real tracking!)
  automation <command>     Intelligent agent & workflow management (3 commands)
  hooks <command>          Lifecycle event management (5 commands)
  migrate-hooks            Migrate settings.json to Claude Code 1.0.51+ format
  monitoring <command>     Real-time system monitoring (3 commands)
  optimization <command>   Performance & topology optimization (3 commands)
  
📋 ADDITIONAL COMMANDS:
  task <action>            Task and workflow management
  config <action>          System configuration
  mcp <action>             MCP server management
  batch <action>           Batch operations
  stream-chain <workflow>  Stream-JSON chaining for multi-agent pipelines

🔥 NEW MCP TOOLS (v2.5.0-alpha.130):
  Available via Claude Code after installing:
    claude mcp add hive-flow npx hive-flow@alpha mcp start

  mcp__hive-flow__agents_spawn_parallel    Spawn agents in parallel (10-20x faster)
    • Spawn multiple agents concurrently
    • 10-20x speedup vs sequential spawning
    • Example: 3 agents in 150ms instead of 2250ms

  mcp__hive-flow__query_control            Control running queries in real-time
    • Actions: pause, resume, terminate
    • Change model mid-execution (Sonnet → Haiku for cost savings)
    • Change permissions dynamically
    • Execute commands in query context

  mcp__hive-flow__query_list               List active queries with status
    • View all running queries
    • Monitor query status and performance
    • Filter by active or include history

🔍 GET HELP:
  npx hive-flow --help                Show this help
  npx hive-flow <command> --help      Detailed command help

🎯 RECOMMENDED FOR NEW USERS:
  npx hive-flow hive-mind wizard     # Start here! Interactive guided setup
  npx hive-flow init                 # Initialize Hive Flow
  npx hive-flow help hive-mind       # Learn about Hive Mind features
  npx hive-flow swarm "Build API" --claude  # Quick start with Claude Code CLI

📚 Documentation: https://github.com/ruvnet/hive-flow
🐝 Hive Mind Guide: https://github.com/ruvnet/hive-flow/tree/main/docs/hive-mind
🐝 ruv-swarm: https://github.com/ruvnet/ruv-FANN/tree/main/ruv-swarm
💬 Discord Community: https://discord.agentics.org

💖 Created by rUv with love: https://github.com/ruvnet
`;

export const COMMAND_HELP = {
  verify: `
🔍 VERIFY COMMAND - Truth Verification System

USAGE:
  hive-flow verify <subcommand> [options]

DESCRIPTION:
  Enforce truth and accuracy in multi-agent operations with a 0.95 threshold.
  "Truth is enforced, not assumed" - every agent claim is verified.

SUBCOMMANDS:
  init <mode>        Initialize verification system
                     Modes: strict (0.95), moderate (0.85), development (0.75)
  verify <task>      Run verification on specific task or agent
  status             Show verification system status and metrics
  rollback           Trigger manual rollback to last good state

OPTIONS:
  --threshold <n>    Custom accuracy threshold (0.0-1.0)
  --agent <type>     Specify agent type for verification
  --auto-rollback    Enable automatic rollback on failures
  --verbose          Detailed verification output
  --json             Output in JSON format

EXAMPLES:
  hive-flow verify init strict                  # Production mode
  hive-flow verify verify task-123 --agent coder
  hive-flow verify status --recent 10
  hive-flow verify rollback --checkpoint last
`,
  truth: `
📊 TRUTH COMMAND - Truth Score Analytics

USAGE:
  hive-flow truth [options]

DESCRIPTION:
  View and analyze truth scores, reliability metrics, and verification history.
  Provides insights into agent accuracy and system reliability.

OPTIONS:
  --report           Generate detailed truth score report
  --analyze          Analyze failure patterns and trends
  --agent <type>     Filter by specific agent type
  --taskId <id>      Check specific task truth score
  --threshold <n>    Filter scores below threshold
  --json             Output in JSON format
  --export <file>    Export report to file

EXAMPLES:
  hive-flow truth                        # Show current scores
  hive-flow truth --report               # Detailed report
  hive-flow truth --analyze              # Pattern analysis
  hive-flow truth --agent coder --detailed
  hive-flow truth --json | jq .averageScore
`,
  pair: `
👥 PAIR COMMAND - Collaborative Development Mode

USAGE:
  hive-flow pair [options]

DESCRIPTION:
  Real-time collaborative development with AI verification.
  Continuous validation with instant feedback and auto-rollback.

OPTIONS:
  --start            Start new pair programming session
  --mode <type>      Set verification mode:
                     strict (0.95), standard (0.85), development (0.75)
  --threshold <n>    Custom accuracy threshold (0.0-1.0)
  --verify           Enable real-time verification
  --monitor          Show real-time metrics dashboard
  --auto-rollback    Enable automatic rollback on failures
  --summary          View session summary
  --export <file>    Export session metrics

EXAMPLES:
  hive-flow pair --start                 # Start session
  hive-flow pair --start --mode strict   # Production pairing
  hive-flow pair --threshold 0.90        # Custom threshold
  hive-flow pair --summary               # View session stats
  hive-flow pair --monitor --verify      # Real-time monitoring
`,
  swarm: `
🧠 SWARM COMMAND - Multi-Agent AI Coordination

USAGE:
  hive-flow swarm <objective> [options]

DESCRIPTION:
  Deploy intelligent multi-agent swarms to accomplish complex objectives.
  Agents work in parallel with neural optimization and real-time coordination.

OPTIONS:
  --strategy <type>    Execution strategy: research, development, analysis,
                       testing, optimization, maintenance
  --mode <type>        Coordination mode: centralized, distributed,
                       hierarchical, mesh, hybrid
  --max-agents <n>     Maximum number of agents (default: 5)
  --parallel           Enable parallel execution (2.8-4.4x speed improvement)
  --monitor            Real-time swarm monitoring
  --background         Run in background with progress tracking
  --claude             Open Claude Code CLI
  --executor           Use built-in executor instead of Claude Code
  --analysis           Enable analysis/read-only mode (no code changes)
  --read-only          Enable read-only mode (alias for --analysis)

EXAMPLES:
  hive-flow swarm "Build a REST API with authentication"
  hive-flow swarm "Research cloud architecture patterns" --strategy research
  hive-flow swarm "Optimize database queries" --max-agents 3 --parallel
  hive-flow swarm "Develop feature X" --strategy development --monitor
  hive-flow swarm "Build API" --claude  # Open Claude Code CLI
  hive-flow swarm "Create service" --executor  # Use built-in executor
  hive-flow swarm "Analyze codebase for security issues" --analysis
  hive-flow swarm "Review architecture patterns" --read-only --strategy research

AGENT TYPES:
  researcher    Research with web access and data analysis
  coder         Code development with neural patterns
  analyst       Performance analysis and optimization
  architect     System design with enterprise patterns
  tester        Comprehensive testing with automation
  coordinator   Multi-agent orchestration

ANALYSIS MODE:
  When using --analysis or --read-only flags, the swarm operates in a safe
  read-only mode that prevents all code modifications. Perfect for:
  
  • Code reviews and security audits
  • Architecture analysis and documentation
  • Performance bottleneck identification
  • Technical debt assessment
  • Dependency mapping and analysis
  • "What-if" scenario exploration
  
  In analysis mode, agents can only read files, search codebases, and
  generate reports - no Write, Edit, or system-modifying operations.
`,

  github: `
🐙 GITHUB COMMAND - Workflow Automation

USAGE:
  hive-flow github <mode> <objective> [options]

DESCRIPTION:
  Automate GitHub workflows with 6 specialized AI-powered modes.
  Each mode handles specific aspects of repository management.

MODES:
  init                Initialize GitHub-enhanced checkpoint system (NEW!)
  gh-coordinator      GitHub workflow orchestration and CI/CD
  pr-manager          Pull request management with reviews
  issue-tracker       Issue management and project coordination
  release-manager     Release coordination and deployment
  repo-architect      Repository structure optimization
  sync-coordinator    Multi-package synchronization

OPTIONS:
  --auto-approve      Automatically approve safe changes
  --dry-run           Preview changes without applying
  --verbose           Detailed operation logging
  --config <file>     Custom configuration file

EXAMPLES:
  hive-flow github init                                        # Initialize GitHub checkpoint hooks
  hive-flow github pr-manager "create feature PR with tests"
  hive-flow github gh-coordinator "setup CI/CD pipeline" --auto-approve
  hive-flow github release-manager "prepare v2.0.0 release"
  hive-flow github repo-architect "optimize monorepo structure"
  hive-flow github issue-tracker "analyze and label issues"
  hive-flow github sync-coordinator "sync versions across packages"
`,

  agent: `
🤖 AGENT COMMAND - AI Agent Management

USAGE:
  hive-flow agent <action> [options]

ACTIONS:
  spawn <type>      Create new AI agent
  list              List all active agents
  terminate <id>    Terminate specific agent
  info <id>         Show agent details
  hierarchy         Manage agent hierarchies
  ecosystem         View agent ecosystem

OPTIONS:
  --name <name>     Custom agent name
  --verbose         Detailed output
  --json            JSON output format

AGENT TYPES:
  researcher        Research and data analysis
  coder            Code generation and refactoring
  analyst          Performance and security analysis
  architect        System design and architecture
  tester           Test creation and execution
  coordinator      Task coordination
  reviewer         Code and design review
  optimizer        Performance optimization

EXAMPLES:
  hive-flow agent spawn researcher --name "DataBot"
  hive-flow agent list --verbose
  hive-flow agent terminate agent-123
  hive-flow agent hierarchy create enterprise
  hive-flow agent ecosystem status
`,

  memory: `
💾 MEMORY COMMAND - Persistent Memory Management

USAGE:
  hive-flow memory <action> [options]

ACTIONS:
  store <key> <value>     Store data in memory
  get <key>               Retrieve stored data
  query <search>          Search memory contents
  list                    List all stored items
  delete <key>            Delete specific entry
  stats                   Memory usage statistics
  export <file>           Export memory to file
  import <file>           Import memory from file
  cleanup                 Clean old entries

OPTIONS:
  --namespace <ns>        Use specific namespace
  --format <type>         Output format (json, table)
  --verbose               Detailed output

EXAMPLES:
  hive-flow memory store architecture "microservices pattern"
  hive-flow memory get architecture
  hive-flow memory query "API design"
  hive-flow memory stats
  hive-flow memory export backup.json
  hive-flow memory cleanup --older-than 30d
`,

  sparc: `
🚀 SPARC COMMAND - Development Mode Operations

USAGE:
  hive-flow sparc [mode] [objective]
  hive-flow sparc <action>

DESCRIPTION:
  SPARC provides 17 specialized development modes for different workflows.
  Each mode optimizes AI assistance for specific tasks.

MODES:
  architect      System architecture and design
  code           Code generation and implementation
  tdd            Test-driven development workflow
  debug          Debugging and troubleshooting
  security       Security analysis and fixes
  refactor       Code refactoring and optimization
  docs           Documentation generation
  review         Code review and quality checks
  data           Data modeling and analysis
  api            API design and implementation
  ui             UI/UX development
  ops            DevOps and infrastructure
  ml             Machine learning workflows
  blockchain     Blockchain development
  mobile         Mobile app development
  game           Game development
  iot            IoT system development

ACTIONS:
  modes          List all available modes
  info <mode>    Show mode details
  run <mode>     Run specific mode

EXAMPLES:
  hive-flow sparc "design authentication system"    # Auto-select mode
  hive-flow sparc architect "design microservices"  # Use architect mode
  hive-flow sparc tdd "user registration feature"   # TDD workflow
  hive-flow sparc modes                            # List all modes
  hive-flow sparc info security                    # Mode details
`,

  init: `
🎯 INIT COMMAND - Initialize Hive Flow Environment

USAGE:
  hive-flow init [options]

DESCRIPTION:
  Initialize Hive Flow v2.0.0 in your project with full MCP integration.
  By default creates standard setup with local Git checkpoints.
  
  TWO INITIALIZATION MODES:
  • hive-flow init         Standard init with local Git checkpoints
  • hive-flow github init  GitHub-enhanced with automatic releases (NEW!)

OPTIONS:
  --force          Overwrite existing configuration
  --dry-run        Preview what will be created
  --basic          Use basic initialization (pre-v2.0.0)
  --sparc          SPARC enterprise setup with additional features
  --minimal        Minimal setup without examples
  --template <t>   Use specific project template

WHAT hive-flow init CREATES (DEFAULT):
  📄 CLAUDE.md          AI-readable project instructions & context
  📁 .claude/           Enterprise configuration directory containing:
    └── commands/       Custom commands and automation scripts
    └── settings.json   Advanced configuration and hooks
    └── hooks/          Pre/post operation automation
  📋 .roomodes          17 specialized SPARC development modes
  
  CLAUDE.md CONTENTS:
  • Project overview and objectives
  • Technology stack and architecture
  • Development guidelines and patterns
  • AI-specific instructions for better assistance
  • Integration with ruv-swarm MCP tools
  
  .claude/commands INCLUDES:
  • Custom project-specific commands
  • Automated workflow scripts
  • Integration hooks for Claude Code
  • Team collaboration tools
  
  Features enabled:
  • ruv-swarm integration with 27 MCP tools
  • Neural network processing with WASM
  • Multi-agent coordination topologies
  • Cross-session memory persistence
  • GitHub workflow automation
  • Performance monitoring
  • Enterprise security features

EXAMPLES:
  npx hive-flow init              # Standard init with local checkpoints
  npx hive-flow github init       # GitHub-enhanced init with releases
  hive-flow init --force                # Overwrite existing configuration
  hive-flow github init --force         # Force GitHub mode (overwrite)
  hive-flow init --dry-run              # Preview what will be created
  hive-flow init --monitoring           # Initialize with token tracking
  hive-flow init --sparc                # SPARC enterprise setup
  hive-flow init --minimal              # Basic setup only
`,

  start: `
🚀 START COMMAND - Start Orchestration System

USAGE:
  hive-flow start [options]

DESCRIPTION:
  Start the Hive Flow orchestration system with optional swarm intelligence.

OPTIONS:
  --swarm          Enable swarm intelligence features
  --daemon         Run as background daemon
  --port <port>    MCP server port (default: 3000)
  --verbose        Detailed logging
  --config <file>  Custom configuration file

EXAMPLES:
  hive-flow start                      # Basic start
  hive-flow start --swarm              # Start with swarm features
  hive-flow start --daemon             # Background daemon
  hive-flow start --port 8080          # Custom MCP port
  hive-flow start --config prod.json   # Production config
`,

  status: `
📊 STATUS COMMAND - System Status

USAGE:
  hive-flow status [options]

DESCRIPTION:
  Show comprehensive system status including agents, tasks, and resources.

OPTIONS:
  --verbose        Detailed system information
  --json           JSON output format
  --watch          Live updates
  --interval <ms>  Update interval (with --watch)

OUTPUT INCLUDES:
  • Orchestrator status
  • Active agents and their state
  • Task queue and progress
  • Memory usage statistics
  • MCP server status
  • System resources
  • Performance metrics

EXAMPLES:
  hive-flow status                     # Basic status
  hive-flow status --verbose           # Detailed information
  hive-flow status --json              # Machine-readable format
  hive-flow status --watch             # Live monitoring
`,

  training: `
🧠 TRAINING COMMAND - Neural Pattern Learning & Model Updates

USAGE:
  hive-flow training <command> [options]

DESCRIPTION:
  Train neural patterns from operations, learn from outcomes, and update agent models 
  with real ruv-swarm integration for continuous learning and optimization.

COMMANDS:
  neural-train      Train neural patterns from operations data
  pattern-learn     Learn from specific operation outcomes  
  model-update      Update agent models with new insights

NEURAL TRAIN OPTIONS:
  --data <source>   Training data source (default: recent)
                    Options: recent, historical, custom, swarm-<id>
  --model <name>    Target model (default: general-predictor)
                    Options: task-predictor, agent-selector, performance-optimizer
  --epochs <n>      Training epochs (default: 50)

PATTERN LEARN OPTIONS:
  --operation <op>  Operation type to learn from
  --outcome <result> Operation outcome (success/failure/partial)

MODEL UPDATE OPTIONS:
  --agent-type <type>      Agent type to update (coordinator, coder, researcher, etc.)
  --operation-result <res> Result from operation execution

EXAMPLES:
  hive-flow training neural-train --data recent --model task-predictor
  hive-flow training pattern-learn --operation "file-creation" --outcome "success"
  hive-flow training model-update --agent-type coordinator --operation-result "efficient"
  hive-flow training neural-train --data "swarm-123" --epochs 100 --model "coordinator-predictor"

🎯 Neural training improves:
  • Task selection accuracy
  • Agent performance prediction  
  • Coordination efficiency
  • Error prevention patterns
`,

  coordination: `
🐝 COORDINATION COMMAND - Swarm & Agent Orchestration

USAGE:
  hive-flow coordination <command> [options]

DESCRIPTION:
  Initialize swarms, spawn coordinated agents, and orchestrate task execution 
  across agents with real ruv-swarm MCP integration for optimal performance.

COMMANDS:
  swarm-init        Initialize swarm coordination infrastructure
  agent-spawn       Spawn and coordinate new agents
  task-orchestrate  Orchestrate task execution across agents

SWARM-INIT OPTIONS:
  --swarm-id <id>      Swarm identifier (auto-generated if not provided)
  --topology <type>    Coordination topology (default: hierarchical)
                       Options: hierarchical, mesh, ring, star, hybrid
  --max-agents <n>     Maximum number of agents (default: 5)
  --strategy <strategy> Coordination strategy (default: balanced)

AGENT-SPAWN OPTIONS:
  --type <type>        Agent type (default: general)
                       Options: coordinator, coder, developer, researcher, analyst, analyzer, 
                       tester, architect, reviewer, optimizer, general
  --name <name>        Custom agent name (auto-generated if not provided)
  --swarm-id <id>      Target swarm for agent coordination
  --capabilities <cap> Custom capabilities specification

TASK-ORCHESTRATE OPTIONS:
  --task <description> Task description (required)
  --swarm-id <id>      Target swarm for task execution
  --strategy <strategy> Coordination strategy (default: adaptive)
                       Options: adaptive, parallel, sequential, hierarchical
  --share-results      Enable result sharing across swarm

EXAMPLES:
  hive-flow coordination swarm-init --topology hierarchical --max-agents 8
  hive-flow coordination agent-spawn --type developer --name "api-dev" --swarm-id swarm-123
  hive-flow coordination task-orchestrate --task "Build REST API" --strategy parallel --share-results
  hive-flow coordination swarm-init --topology mesh --max-agents 12

🎯 Coordination enables:
  • Intelligent task distribution
  • Agent synchronization
  • Shared memory coordination
  • Performance optimization
  • Fault tolerance
`,

  analysis: `
📊 ANALYSIS COMMAND - Performance & Usage Analytics

USAGE:
  hive-flow analysis <command> [options]

DESCRIPTION:
  Detect performance bottlenecks, generate comprehensive reports, and analyze 
  token consumption using real ruv-swarm analytics for system optimization.

COMMANDS:
  bottleneck-detect    Detect performance bottlenecks in the system
  performance-report   Generate comprehensive performance reports
  token-usage          Analyze token consumption and costs

BOTTLENECK DETECT OPTIONS:
  --scope <scope>      Analysis scope (default: system)
                       Options: system, swarm, agent, task, memory
  --target <target>    Specific target to analyze (default: all)
                       Examples: agent-id, swarm-id, task-type

PERFORMANCE REPORT OPTIONS:
  --timeframe <time>   Report timeframe (default: 24h)
                       Options: 1h, 6h, 24h, 7d, 30d
  --format <format>    Report format (default: summary)
                       Options: summary, detailed, json, csv

TOKEN USAGE OPTIONS:
  --agent <agent>      Filter by agent type or ID (default: all)
  --breakdown          Include detailed breakdown by agent type
  --cost-analysis      Include cost projections and optimization

EXAMPLES:
  hive-flow analysis bottleneck-detect --scope system
  hive-flow analysis bottleneck-detect --scope agent --target coordinator-1
  hive-flow analysis performance-report --timeframe 7d --format detailed
  hive-flow analysis token-usage --breakdown --cost-analysis
  hive-flow analysis bottleneck-detect --scope swarm --target swarm-123

🎯 Analysis helps with:
  • Performance optimization
  • Cost management
  • Resource allocation
  • Bottleneck identification
  • Trend analysis
`,

  automation: `
🤖 AUTOMATION COMMAND - Intelligent Agent & Workflow Management

USAGE:
  hive-flow automation <command> [options]

DESCRIPTION:
  Automatically spawn optimal agents, intelligently manage workflows, and select 
  optimal configurations with real ruv-swarm intelligence for maximum efficiency.

COMMANDS:
  auto-agent        Automatically spawn optimal agents based on task complexity
  smart-spawn       Intelligently spawn agents based on specific requirements
  workflow-select   Select and configure optimal workflows for project types

AUTO-AGENT OPTIONS:
  --task-complexity <level>  Task complexity level (default: medium)
                             Options: low, medium, high, enterprise
  --swarm-id <id>           Target swarm ID for agent spawning

SMART-SPAWN OPTIONS:
  --requirement <req>       Specific requirement description
                           Examples: "web-development", "data-analysis", "enterprise-api"
  --max-agents <n>         Maximum number of agents to spawn (default: 10)

WORKFLOW-SELECT OPTIONS:
  --project-type <type>     Project type (default: general)
                           Options: web-app, api, data-analysis, enterprise, general
  --priority <priority>     Optimization priority (default: balanced)
                           Options: speed, quality, cost, balanced

EXAMPLES:
  hive-flow automation auto-agent --task-complexity enterprise --swarm-id swarm-123
  hive-flow automation smart-spawn --requirement "web-development" --max-agents 8
  hive-flow automation workflow-select --project-type api --priority speed
  hive-flow automation auto-agent --task-complexity low

🎯 Automation benefits:
  • Optimal resource allocation
  • Intelligent agent selection
  • Workflow optimization
  • Reduced manual configuration
  • Performance-based scaling
`,

  hooks: `
🔗 HOOKS COMMAND - Lifecycle Event Management

USAGE:
  hive-flow hooks <command> [options]

DESCRIPTION:
  Execute lifecycle hooks before and after tasks, edits, and sessions with 
  real ruv-swarm integration for automated preparation, tracking, and cleanup.

COMMANDS:
  pre-task      Execute before task begins (preparation & setup)
  post-task     Execute after task completion (analysis & cleanup)
  pre-edit      Execute before file modifications (backup & validation)
  post-edit     Execute after file modifications (tracking & coordination)
  session-end   Execute at session termination (cleanup & export)

PRE-TASK OPTIONS:
  --description <desc>     Task description
  --task-id <id>          Task identifier
  --agent-id <id>         Executing agent identifier
  --auto-spawn-agents     Auto-spawn agents for task (default: true)

POST-TASK OPTIONS:
  --task-id <id>               Task identifier
  --analyze-performance        Generate performance analysis
  --generate-insights          Create AI-powered insights

PRE-EDIT OPTIONS:
  --file <path>           Target file path
  --operation <type>      Edit operation type (edit, create, delete)

POST-EDIT OPTIONS:
  --file <path>           Modified file path
  --memory-key <key>      Coordination memory key for storing edit info

SESSION-END OPTIONS:
  --export-metrics        Export session performance metrics
  --swarm-id <id>         Swarm identifier for coordination cleanup
  --generate-summary      Create comprehensive session summary

EXAMPLES:
  hive-flow hooks pre-task --description "Build API" --task-id task-123 --agent-id agent-456
  hive-flow hooks post-task --task-id task-123 --analyze-performance --generate-insights
  hive-flow hooks pre-edit --file "src/api.js" --operation edit
  hive-flow hooks post-edit --file "src/api.js" --memory-key "swarm/123/edits/timestamp"
  hive-flow hooks session-end --export-metrics --generate-summary --swarm-id swarm-123

🎯 Hooks enable:
  • Automated preparation & cleanup
  • Performance tracking
  • Coordination synchronization
  • Error prevention
  • Insight generation
`,
};

export function getCommandHelp(command) {
  // Return legacy format for now - to be updated
  return COMMAND_HELP[command] || `Help not available for command: ${command}`;
}

export function getStandardizedCommandHelp(command) {
  const commandConfigs = {
    agent: {
      name: 'hive-flow agent',
      description: 'Manage agents with agentic-flow integration (66+ agents, ultra-fast editing, ReasoningBank memory)',
      usage: 'hive-flow agent <action> [options]',
      commands: [
        { name: 'run <agent> "<task>"', description: 'Execute agent with multi-provider (NEW)' },
        { name: 'agents', description: 'List all 66+ agentic-flow agents (NEW)' },
        { name: 'booster edit <file>', description: 'Ultra-fast editing - 352x faster (NEW)' },
        { name: 'booster batch <pattern>', description: 'Batch edit multiple files (NEW)' },
        { name: 'memory init', description: 'Initialize ReasoningBank learning memory - 46% faster execution (NEW)' },
        { name: 'memory status', description: 'Show ReasoningBank status and statistics (NEW)' },
        { name: 'memory list', description: 'List stored ReasoningBank memories (NEW)' },
        { name: 'config wizard', description: 'Interactive setup wizard (NEW)' },
        { name: 'mcp start', description: 'Start MCP server (NEW)' },
        { name: 'spawn', description: 'Create internal agent' },
        { name: 'list', description: 'List active internal agents' },
        { name: 'info', description: 'Show agent details' },
        { name: 'terminate', description: 'Stop an agent' },
        { name: 'hierarchy', description: 'Manage agent hierarchies' },
        { name: 'ecosystem', description: 'View agent ecosystem' },
      ],
      options: [
        {
          flags: '--type <type>',
          description: 'Agent type',
          validValues: [
            'coordinator',
            'researcher',
            'coder',
            'analyst',
            'architect',
            'tester',
            'reviewer',
            'optimizer',
          ],
        },
        {
          flags: '--name <name>',
          description: 'Agent name',
        },
        {
          flags: '--verbose',
          description: 'Detailed output',
        },
        {
          flags: '--json',
          description: 'Output in JSON format',
        },
        {
          flags: '--help',
          description: 'Show this help message',
        },
      ],
      examples: [
        'hive-flow agent spawn researcher --name "Research Bot"',
        'hive-flow agent list --json',
        'hive-flow agent terminate agent-123',
        'hive-flow agent info agent-456 --verbose',
      ],
    },
    sparc: {
      name: 'hive-flow sparc',
      description: 'Execute SPARC development modes',
      usage: 'hive-flow sparc <mode> [task] [options]',
      commands: [
        { name: 'spec', description: 'Specification mode - Requirements analysis' },
        { name: 'architect', description: 'Architecture mode - System design' },
        { name: 'tdd', description: 'Test-driven development mode' },
        { name: 'integration', description: 'Integration mode - Component connection' },
        { name: 'refactor', description: 'Refactoring mode - Code improvement' },
        { name: 'modes', description: 'List all available SPARC modes' },
      ],
      options: [
        {
          flags: '--file <path>',
          description: 'Input/output file path',
        },
        {
          flags: '--format <type>',
          description: 'Output format',
          validValues: ['markdown', 'json', 'yaml'],
        },
        {
          flags: '--verbose',
          description: 'Detailed output',
        },
        {
          flags: '--help',
          description: 'Show this help message',
        },
      ],
      examples: [
        'hive-flow sparc spec "User authentication system"',
        'hive-flow sparc tdd "Payment processing module"',
        'hive-flow sparc architect "Microservices architecture"',
        'hive-flow sparc modes',
      ],
    },
    memory: {
      name: 'hive-flow memory',
      description: 'Manage persistent memory operations',
      usage: 'hive-flow memory <action> [key] [value] [options]',
      commands: [
        { name: 'store', description: 'Store data in memory' },
        { name: 'query', description: 'Search memory by pattern' },
        { name: 'list', description: 'List memory namespaces' },
        { name: 'export', description: 'Export memory to file' },
        { name: 'import', description: 'Import memory from file' },
        { name: 'clear', description: 'Clear memory namespace' },
      ],
      options: [
        {
          flags: '--namespace <name>',
          description: 'Memory namespace',
          defaultValue: 'default',
        },
        {
          flags: '--ttl <seconds>',
          description: 'Time to live in seconds',
        },
        {
          flags: '--format <type>',
          description: 'Export format',
          validValues: ['json', 'yaml'],
        },
        {
          flags: '--help',
          description: 'Show this help message',
        },
      ],
      examples: [
        'hive-flow memory store "api_design" "REST endpoints specification"',
        'hive-flow memory query "authentication"',
        'hive-flow memory export backup.json',
        'hive-flow memory list --namespace project',
      ],
    },
  };

  const config = commandConfigs[command];
  if (!config) {
    return HelpFormatter.formatError(
      `Unknown command: ${command}`,
      'hive-flow',
      'hive-flow <command> --help',
    );
  }

  return HelpFormatter.formatHelp(config);
}

export function getMainHelp(plain = false) {
  // Return the vibrant, emoji-rich version by default
  if (!plain) {
    return MAIN_HELP;
  }

  // Return plain standardized format when requested
  const helpInfo = {
    name: 'hive-flow',
    description: 'Advanced AI agent orchestration system',
    usage: `hive-flow <command> [<args>] [options]
    hive-flow <command> --help
    hive-flow --version`,
    commands: [
      {
        name: 'hive-mind',
        description: 'Manage hive mind swarm intelligence',
        aliases: ['hm'],
      },
      {
        name: 'init',
        description: 'Initialize Hive Flow configuration',
      },
      {
        name: 'start',
        description: 'Start orchestration system',
      },
      {
        name: 'swarm',
        description: 'Execute multi-agent swarm coordination',
      },
      {
        name: 'agent',
        description: 'Manage individual agents',
      },
      {
        name: 'sparc',
        description: 'Execute SPARC development modes',
      },
      {
        name: 'memory',
        description: 'Manage persistent memory operations',
      },
      {
        name: 'github',
        description: 'Automate GitHub workflows',
      },
      {
        name: 'status',
        description: 'Show system status and health',
      },
      {
        name: 'config',
        description: 'Manage configuration settings',
      },
      {
        name: 'session',
        description: 'Manage sessions and state persistence',
      },
      {
        name: 'terminal',
        description: 'Terminal pool management',
      },
      {
        name: 'workflow',
        description: 'Manage automated workflows',
      },
      {
        name: 'training',
        description: 'Neural pattern training',
      },
      {
        name: 'coordination',
        description: 'Swarm coordination commands',
      },
      {
        name: 'help',
        description: 'Show help information',
      },
    ],
    globalOptions: [
      {
        flags: '--config <path>',
        description: 'Configuration file path',
        defaultValue: '.claude/config.json',
      },
      {
        flags: '--verbose',
        description: 'Enable verbose output',
      },
      {
        flags: '--quiet',
        description: 'Suppress non-error output',
      },
      {
        flags: '--json',
        description: 'Output in JSON format',
      },
      {
        flags: '--plain',
        description: 'Show plain help without emojis',
      },
      {
        flags: '--help',
        description: 'Show help information',
      },
      {
        flags: '--version',
        description: 'Show version information',
      },
    ],
    examples: [
      'npx hive-flow init',
      'hive-flow hive-mind wizard',
      'hive-flow swarm "Build REST API"',
      'hive-flow agent spawn researcher --name "Research Bot"',
      'hive-flow status --json',
      'hive-flow memory query "API design"',
    ],
  };

  return HelpFormatter.formatHelp(helpInfo);
}

# @hive-flow/cli/claims

Issue-claiming and work-coordination helpers preserved from the retired standalone claims workspace package.

## Usage

The maintained CLI surface remains the built-in `hive-flow claims` command:

```bash
hive-flow claims list
hive-flow claims check -c swarm:create
hive-flow claims grant -c agent:spawn -r developer
hive-flow claims revoke -c admin:* -r guest
```

For TypeScript consumers that need the preserved ADR-016 domain and application helpers, import the CLI subpath:

```typescript
import { ClaimService, claimsTools } from '@hive-flow/cli/claims';
```

`ClaimService` is the event-sourced application service and expects repository and event-store dependencies in its constructor. The CLI command and live MCP server do not instantiate it directly.

## Exported Areas

- `domain/*`: claim, issue, handoff, event, repository, and validation types.
- `application/*`: claim service, work-stealing service, and load-balancing service contracts.
- `infrastructure/*`: JSON-backed claim repository and event-store implementations.
- `api/*`: preserved ADR-016 MCP tool definitions and helper registration functions.

The live CLI MCP server currently registers its built-in underscore-name claims tools from `src/mcp-tools/claims-tools.ts`. The preserved slash-name tool definitions in this subpath are exported for compatibility and future integration, but they are not automatically registered into the live MCP server.

## License

MIT

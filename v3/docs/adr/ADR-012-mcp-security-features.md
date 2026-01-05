# ADR-012: MCP Security and Feature Implementation

## Status
Accepted

## Date
2026-01-05

## Context

The `@claude-flow/mcp` package implements the Model Context Protocol (MCP) 2025-11-25 specification. A security audit identified several vulnerabilities and missing features that need to be addressed to ensure production readiness.

### Security Vulnerabilities Identified
1. **Path Traversal (Critical)** - Fixed in createFileResource
2. **ReDoS (Critical)** - Fixed with regex escaping
3. **WebSocket Auth Bypass (High)** - Fixed with token validation
4. **Timing Attack (Medium)** - Fixed with crypto.timingSafeEqual
5. **Cache Exhaustion (Medium)** - Fixed with LRU eviction
6. **Missing Tool Input Validation (High)** - Needs implementation
7. **No Rate Limiting (Medium)** - Needs implementation

### Missing MCP 2025-11-25 Features
1. **Sampling** - Server-initiated LLM calls
2. **OAuth 2.1** - Full authentication flow
3. **Tool Schema Validation** - JSON Schema enforcement

## Decision

### 1. JSON Schema Validation for Tool Inputs

**Decision**: Implement runtime JSON Schema validation using a lightweight validator.

**Rationale**:
- Tools define `inputSchema` but it wasn't enforced
- Invalid inputs can cause crashes or security issues
- Schema validation provides defense-in-depth

**Implementation**:
```typescript
// Validate before execution
const validationResult = validateSchema(input, tool.inputSchema);
if (!validationResult.valid) {
  throw new MCPServerError('Invalid input', ErrorCodes.INVALID_PARAMS, validationResult.errors);
}
```

### 2. Sampling (Server-Initiated LLM Calls)

**Decision**: Implement `sampling/createMessage` per MCP 2025-11-25 spec.

**Rationale**:
- Required for servers that need to invoke LLM during tool execution
- Enables agentic workflows where server needs AI assistance
- Part of complete MCP 2025-11-25 compliance

**Implementation**:
- Add `SamplingHandler` callback to server config
- Implement `sampling/createMessage` method
- Support model preferences and context inclusion

### 3. Rate Limiting

**Decision**: Implement token bucket rate limiting with configurable limits.

**Rationale**:
- Prevents DoS attacks
- Protects against runaway clients
- Industry standard for API security

**Implementation**:
- Token bucket algorithm (efficient, fair)
- Per-session and global limits
- Configurable via `rateLimitConfig`
- Returns 429 with Retry-After header

### 4. OAuth 2.1 Flow

**Decision**: Implement OAuth 2.1 with PKCE for secure authentication.

**Rationale**:
- Industry standard for API authentication
- Required for enterprise deployments
- More secure than static tokens

**Implementation**:
- Authorization code flow with PKCE
- Token refresh support
- Configurable providers (custom, GitHub, Google)

## Consequences

### Positive
- Full MCP 2025-11-25 compliance
- Production-ready security posture
- Enterprise authentication support
- Protection against common attacks

### Negative
- Increased complexity
- Additional dependencies (ajv for schema validation)
- Slight performance overhead for validation

### Risks
- OAuth implementation complexity
- Rate limiting tuning for different use cases

## Implementation Plan

1. **Phase 1**: JSON Schema validation (security priority)
2. **Phase 2**: Rate limiting (security priority)
3. **Phase 3**: Sampling support (feature)
4. **Phase 4**: OAuth 2.1 (feature)

## References

- [MCP 2025-11-25 Specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [OAuth 2.1 Draft](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-07)
- [JSON Schema Validation](https://json-schema.org/draft/2020-12/json-schema-validation.html)
- [Token Bucket Algorithm](https://en.wikipedia.org/wiki/Token_bucket)

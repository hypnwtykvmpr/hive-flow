# Hive Flow v3.5 — Optimized Production Image
# Multi-stage Alpine build with --omit=optional for <100MB image
#
# Build:
#   docker build -t hive-flow:lite -f cli/docker/Dockerfile .
#
# Run:
#   docker run --rm hive-flow:lite hive-flow --version
#   docker run --rm hive-flow:lite hive-flow doctor
#   echo '{"jsonrpc":"2.0","id":1,"method":"initialize"}' | docker run --rm -i hive-flow:lite
#
# Size comparison:
#   hive-flow (cold): ~1.3GB, 914 packages, 35s startup
#   hive-flow:lite image:        <100MB, ~60 packages, <5s startup

# ── Stage 1: Install ─────────────────────────────────────────────
FROM node:22-alpine AS build

RUN apk add --no-cache git

WORKDIR /install

# Install hive-flow globally with --omit=optional to skip heavy deps.
# --ignore-scripts skips preinstall cache scanning (no-op in CI)
RUN npm install -g hive-flow@latest \
      --omit=optional \
      --ignore-scripts \
      --no-audit \
      --no-fund \
    && npm cache clean --force

# Prune heavy optional transitive deps that npm still resolves.
# These are all optionalDependencies of @hive-flow/cli — the CLI
# works fine without them (graceful fallbacks built in).
#   hive-flow: 238MB (ONNX runtimes, OpenTelemetry, Anthropic SDK)
#   @opentelemetry: 135MB (transitive via hive-flow)
#   onnxruntime-node/web: 158MB (ML inference, not needed for CLI)
#   @anthropic-ai: 72MB (SDK, only needed when calling API directly)
#   @xenova: 45MB (transformers.js, not needed for CLI)
#   hivememory: 37MB (optional memory backend)
#   onnx-proto: 22MB (protobuf for ONNX)
#   tiktoken: 23MB (token counting, optional)
#   @img: 16MB (image processing, not needed)
#   better-sqlite3: 10MB (native, optional — sql.js used instead)
RUN GLOBAL_PREFIX=$(npm config get prefix) \
    && CLI_NM="${GLOBAL_PREFIX}/lib/node_modules/hive-flow/node_modules" \
    && rm -rf \
      "${CLI_NM}/hive-flow" \
      "${CLI_NM}/@opentelemetry" \
      "${CLI_NM}/onnxruntime-node" \
      "${CLI_NM}/onnxruntime-web" \
      "${CLI_NM}/onnx-proto" \
      "${CLI_NM}/@anthropic-ai" \
      "${CLI_NM}/@xenova" \
      "${CLI_NM}/hivememory" \
      "${CLI_NM}/tiktoken" \
      "${CLI_NM}/@img" \
      "${CLI_NM}/better-sqlite3" \
      "${CLI_NM}/sharp" \
      "${CLI_NM}/@google" \
    && rm -rf \
      "${CLI_NM}/@hive-flow/embeddings" \
      "${CLI_NM}/@hive-flow/plugin-gastown-bridge" \
    && NESTED="${CLI_NM}/@hive-flow/cli/node_modules" \
    && rm -rf \
      "${NESTED}/hive-flow" \
      "${NESTED}/hivememory" \
    && rm -rf \
      "${CLI_NM}/@grpc" \
      "${CLI_NM}/gun"

# Stage the pruned install for the production image
RUN GLOBAL_PREFIX=$(npm config get prefix) \
    && mkdir -p /staged/lib /staged/bin \
    && cp -a "${GLOBAL_PREFIX}/lib/node_modules" /staged/lib/ \
    && cp -a "${GLOBAL_PREFIX}/bin/hive-flow" /staged/bin/ 2>/dev/null || true \
    && cp -a "${GLOBAL_PREFIX}/bin/hive-flow" /staged/bin/ 2>/dev/null || true \
    && cp -a "${GLOBAL_PREFIX}/bin/cli" /staged/bin/ 2>/dev/null || true

# ── Stage 2: Production ──────────────────────────────────────────
FROM node:22-alpine AS production

# dumb-init for proper PID 1 signal handling
RUN apk add --no-cache dumb-init git bash ca-certificates curl

# Non-root user
RUN addgroup -g 1001 -S hive-flow \
    && adduser -S -D -H -u 1001 -h /home/hive-flow -s /bin/bash -G hive-flow hive-flow \
    && mkdir -p /home/hive-flow/.hive-flow /workspace \
    && chown -R hive-flow:hive-flow /home/hive-flow /workspace

# Copy only the global node_modules and bin links from build stage
COPY --from=build /staged/lib/node_modules /usr/local/lib/node_modules
COPY --from=build /staged/bin/ /usr/local/bin/

# Ensure bin symlinks point to the right place
RUN ln -sf /usr/local/lib/node_modules/hive-flow/bin/hive-flow.js /usr/local/bin/hive-flow 2>/dev/null || true \
    && ln -sf /usr/local/lib/node_modules/@hive-flow/cli/bin/cli.js /usr/local/bin/hive-flow 2>/dev/null || true \
    && chmod +x /usr/local/bin/hive-flow 2>/dev/null || true \
    && chmod +x /usr/local/bin/hive-flow 2>/dev/null || true

ENV NODE_ENV=production \
    HIVE_FLOW_LOG_LEVEL=info \
    HOME=/home/hive-flow

# Healthcheck via CLI doctor (timeout after 10s)
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD hive-flow doctor --quiet || exit 1

USER hive-flow
WORKDIR /workspace

ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Default: start MCP server on stdio (most common Docker use case)
CMD ["hive-flow", "mcp", "start"]

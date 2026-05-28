FROM node:20-bookworm-slim

# MCP server image for Glama directory checks and local Docker.
# Hub API uses Dockerfile.hub-lite (separate).

# Glama runs builds with strict engine checks in some environments.
# Pin mcp-proxy to a Node 20 compatible line (v6+ pulls pipenet which needs Node >=22).
RUN npm install -g mcp-proxy@5.12.5

WORKDIR /app/mcp

COPY mcp/package.json mcp/package-lock.json ./
RUN npm ci --omit=dev

COPY mcp/ ./

ENV KYA_HUB_BASE_URL=https://umbraxon.xyz
ENV KYA_HUB_REQUEST_TIMEOUT_MS=30000

EXPOSE 8080

# Glama introspection expects HTTP; mcp-proxy wraps stdio MCP on port 8080.
CMD ["mcp-proxy", "--port", "8080", "--", "node", "src/index.js"]

FROM node:20-bookworm-slim

# Glama/registry Dockerfile for the MCP server.
# The hub API image is built separately (see Dockerfile.hub-lite).

WORKDIR /app

COPY mcp/package.json mcp/package-lock.json ./
RUN npm ci --omit=dev

COPY mcp/ ./

ENV KYA_HUB_BASE_URL=https://umbraxon.xyz
ENV KYA_HUB_REQUEST_TIMEOUT_MS=30000

CMD ["node", "src/index.js"]


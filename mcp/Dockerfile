FROM node:20-bookworm-slim

WORKDIR /app

# Install dependencies first for better layer caching
COPY mcp/package.json mcp/package-lock.json ./
RUN npm ci --omit=dev

# Copy the MCP source
COPY mcp/ ./

# MCP stdio transport: the process communicates via stdin/stdout.
ENV KYA_HUB_BASE_URL=https://umbraxon.xyz
ENV KYA_HUB_REQUEST_TIMEOUT_MS=30000

CMD ["node", "src/index.js"]

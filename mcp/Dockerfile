FROM node:20-bookworm-slim

# Pin for Node 20 compatibility (newer mcp-proxy versions require Node >=22 via pipenet).
RUN npm install -g mcp-proxy@5.12.5

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . ./

ENV KYA_HUB_BASE_URL=https://umbraxon.xyz
ENV KYA_HUB_REQUEST_TIMEOUT_MS=30000

EXPOSE 8080

CMD ["mcp-proxy", "--port", "8080", "--", "node", "src/index.js"]

#!/usr/bin/env node
/**
 * UMBRAXON KYA-Hub MCP server (stdio). Read-only public API tools.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createHubClient } from './hub-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const KYA_ID = z.string().regex(/^UMBRA-[A-F0-9]{6}$/, 'Expected KYA-ID like UMBRA-ABCDEF');

function okJson(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function errText(message, detail) {
  const text = detail ? `${message}\n${detail}` : message;
  return { content: [{ type: 'text', text }], isError: true };
}

function buildQuery(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

function openapiLocalPath() {
  return join(__dirname, '..', '..', 'openapi', 'openapi.yaml');
}

const PROTOCOL_SUMMARY = `UMBRAXON KYA-Hub (Know Your Agent) — Lightning-paid, Ed25519-anchored agent identity.

Signing rules (three digests): manifest registration uses sha256(canonical JSON with sorted keys); auth challenge signs raw 32-byte nonce; agent actions use sha256(body) with fixed key order from the hub schema.

Reference: https://github.com/UMBRAXON/kya-hub — Python reference client scripts/umbrexon_bot_client.py for register + PoW + signatures.
`;

async function main() {
  const baseUrl = process.env.KYA_HUB_BASE_URL || 'https://umbraxon.xyz';
  const timeoutMs = Number(process.env.KYA_HUB_REQUEST_TIMEOUT_MS) || 30000;
  const userAgent = process.env.KYA_HUB_USER_AGENT;

  const { hubRequest } = createHubClient({
    baseUrl,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 30000,
    userAgent,
  });

  const server = new McpServer({
    name: 'kya-hub',
    version: '1.1.0',
  });

  server.registerTool(
    'kya_health',
    {
      title: 'KYA hub health',
      description: 'GET /api/health — hub liveness and dependency checks.',
      inputSchema: z.object({}),
    },
    async () => okJson(await hubRequest('GET', '/api/health')),
  );

  server.registerTool(
    'kya_tiers',
    {
      title: 'KYA pricing tiers',
      description: 'GET /api/tiers — tier list and pricing metadata.',
      inputSchema: z.object({}),
    },
    async () => okJson(await hubRequest('GET', '/api/tiers')),
  );

  server.registerTool(
    'kya_hub_pubkey',
    {
      title: 'Hub Ed25519 pubkey',
      description: 'GET /api/hub/pubkey — verify hub-signed payloads.',
      inputSchema: z.object({}),
    },
    async () => okJson(await hubRequest('GET', '/api/hub/pubkey')),
  );

  server.registerTool(
    'kya_manifest_schema',
    {
      title: 'Manifest JSON Schema',
      description: 'GET /api/protocol/manifest-schema',
      inputSchema: z.object({}),
    },
    async () => okJson(await hubRequest('GET', '/api/protocol/manifest-schema')),
  );

  server.registerTool(
    'kya_reputation_model',
    {
      title: 'Reputation model',
      description: 'GET /api/protocol/reputation-model',
      inputSchema: z.object({}),
    },
    async () => okJson(await hubRequest('GET', '/api/protocol/reputation-model')),
  );

  server.registerTool(
    'kya_protocol_versions',
    {
      title: 'Protocol versions',
      description: 'GET /api/protocol/versions',
      inputSchema: z.object({}),
    },
    async () => okJson(await hubRequest('GET', '/api/protocol/versions')),
  );

  server.registerTool(
    'kya_l402_delegation_profile',
    {
      title: 'L402 delegated payment profile',
      description:
        'GET /api/protocol/l402-delegation-profile — schema for KYA delegation passes + caveat examples (hub is non-custodial).',
      inputSchema: z.object({}),
    },
    async () => okJson(await hubRequest('GET', '/api/protocol/l402-delegation-profile')),
  );

  server.registerTool(
    'kya_delegation_pass_verify',
    {
      title: 'Verify delegation pass',
      description:
        'POST /api/delegation-pass/verify — verify hub Ed25519 signature and time window on a KYADelegationPass JSON body.',
      inputSchema: z.object({
        delegation_pass: z
          .record(z.unknown())
          .describe('Full delegation pass object including proof.signatureValue'),
      }),
    },
    async ({ delegation_pass }) =>
      okJson(await hubRequest('POST', '/api/delegation-pass/verify', delegation_pass)),
  );

  server.registerTool(
    'kya_discovery_agents',
    {
      title: 'Discovery feed (opt-in agents)',
      description:
        'GET /api/discovery/v1/agents.json — agents with discovery_opt_in; optional capability filter.',
      inputSchema: z.object({
        capability: z.string().min(1).max(64).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
    },
    async ({ capability, limit }) => {
      const q = buildQuery({ capability, limit });
      return okJson(await hubRequest('GET', `/api/discovery/v1/agents.json${q}`));
    },
  );

  server.registerTool(
    'kya_embed_badge_status',
    {
      title: 'Embed badge (JSON)',
      description: 'GET /api/embed/badge/{kya_id}?format=json — compact verified / not_verified for READMEs.',
      inputSchema: z.object({ kya_id: KYA_ID }),
    },
    async ({ kya_id }) =>
      okJson(
        await hubRequest(
          'GET',
          `/api/embed/badge/${encodeURIComponent(kya_id)}?format=json`,
        ),
      ),
  );

  server.registerTool(
    'kya_cert',
    {
      title: 'Certificate by KYA-ID',
      description: 'GET /api/cert/{kya_id}',
      inputSchema: z.object({ kya_id: KYA_ID }),
    },
    async ({ kya_id }) => okJson(await hubRequest('GET', `/api/cert/${encodeURIComponent(kya_id)}`)),
  );

  server.registerTool(
    'kya_cert_status',
    {
      title: 'Certificate status',
      description: 'GET /api/cert/{kya_id}/status',
      inputSchema: z.object({ kya_id: KYA_ID }),
    },
    async ({ kya_id }) =>
      okJson(await hubRequest('GET', `/api/cert/${encodeURIComponent(kya_id)}/status`)),
  );

  server.registerTool(
    'kya_cert_verify',
    {
      title: 'Verify certificate',
      description: 'POST /api/cert/verify with { certificate } object (KYA VC JSON).',
      inputSchema: z.object({
        certificate: z.record(z.unknown()).describe('KYA verifiable credential JSON'),
      }),
    },
    async ({ certificate }) =>
      okJson(await hubRequest('POST', '/api/cert/verify', { certificate })),
  );

  server.registerTool(
    'kya_agent_reputation',
    {
      title: 'Agent reputation',
      description: 'GET /api/agent/{kya_id}/reputation',
      inputSchema: z.object({ kya_id: KYA_ID }),
    },
    async ({ kya_id }) =>
      okJson(await hubRequest('GET', `/api/agent/${encodeURIComponent(kya_id)}/reputation`)),
  );

  server.registerTool(
    'kya_agent_events',
    {
      title: 'Reputation events',
      description: 'GET /api/agent/{kya_id}/events — optional limit (max 200) and offset.',
      inputSchema: z.object({
        kya_id: KYA_ID,
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    },
    async ({ kya_id, limit, offset }) => {
      const q = buildQuery({ limit, offset });
      return okJson(await hubRequest('GET', `/api/agent/${encodeURIComponent(kya_id)}/events${q}`));
    },
  );

  server.registerTool(
    'kya_agent_actions',
    {
      title: 'Agent self-action log',
      description: 'GET /api/agent/{kya_id}/actions — optional limit (max 200) and offset.',
      inputSchema: z.object({
        kya_id: KYA_ID,
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    },
    async ({ kya_id, limit, offset }) => {
      const q = buildQuery({ limit, offset });
      return okJson(await hubRequest('GET', `/api/agent/${encodeURIComponent(kya_id)}/actions${q}`));
    },
  );

  server.registerTool(
    'kya_manufacturers',
    {
      title: 'Manufacturers',
      description: 'GET /api/manufacturers',
      inputSchema: z.object({}),
    },
    async () => okJson(await hubRequest('GET', '/api/manufacturers')),
  );

  server.registerTool(
    'kya_manufacturer',
    {
      title: 'Manufacturer by ID',
      description: 'GET /api/manufacturer/{manufacturer_id}',
      inputSchema: z.object({
        manufacturer_id: z.string().min(1).describe('External manufacturer id'),
      }),
    },
    async ({ manufacturer_id }) =>
      okJson(
        await hubRequest(
          'GET',
          `/api/manufacturer/${encodeURIComponent(manufacturer_id)}`,
        ),
      ),
  );

  server.registerTool(
    'kya_registration_quote',
    {
      title: 'Registration price quote',
      description: 'GET /api/registration/quote — requires tier; optional Ed25519 pubkey hex.',
      inputSchema: z.object({
        tier: z.string().min(1).describe('e.g. BASIC or ELITE'),
        pubkey: z
          .string()
          .regex(/^[0-9a-fA-F]{64}$/)
          .optional()
          .describe('Optional 32-byte Ed25519 pubkey as 64 hex chars'),
      }),
    },
    async ({ tier, pubkey }) => {
      const q = buildQuery({ tier, pubkey });
      return okJson(await hubRequest('GET', `/api/registration/quote${q}`));
    },
  );

  server.registerTool(
    'kya_crl_latest',
    {
      title: 'Latest signed CRL JSON',
      description: 'GET /crl/latest.json when deployed; may 404 on minimal dev setups.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return okJson(await hubRequest('GET', '/crl/latest.json'));
      } catch (e) {
        return errText(
          e instanceof Error ? e.message : String(e),
          e && typeof e === 'object' && 'status' in e ? `HTTP ${e.status}` : undefined,
        );
      }
    },
  );

  server.registerResource(
    'openapi',
    'kya-hub://openapi',
    {
      title: 'KYA-Hub OpenAPI',
      description: 'OpenAPI 3 contract (from local checkout when file exists).',
      mimeType: 'application/yaml',
    },
    async () => {
      const p = openapiLocalPath();
      if (!existsSync(p)) {
        return {
          contents: [
            {
              uri: 'kya-hub://openapi',
              mimeType: 'text/plain',
              text: `OpenAPI file not found at ${p}. Clone the kya-hub repo or fetch docs from GitHub.`,
            },
          ],
        };
      }
      const text = readFileSync(p, 'utf8');
      return { contents: [{ uri: 'kya-hub://openapi', mimeType: 'application/yaml', text }] };
    },
  );

  server.registerResource(
    'protocol-summary',
    'kya-hub://protocol-summary',
    {
      title: 'KYA protocol summary',
      description: 'Short integration summary with pointers.',
      mimeType: 'text/plain',
    },
    async () => ({
      contents: [
        { uri: 'kya-hub://protocol-summary', mimeType: 'text/plain', text: PROTOCOL_SUMMARY },
      ],
    }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

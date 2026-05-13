#!/usr/bin/env node
'use strict';

// Hermetic OpenAPI sanity check (no YAML parser dependency).
// Ensures:
// - file exists
// - uses OpenAPI 3.0.3
// - has a minimum number of /api/* paths to avoid regressions

const fs = require('fs');
const path = require('path');

const SPEC = path.join(__dirname, '..', 'openapi', 'openapi.yaml');

let passed = 0, failed = 0;
function ok(n) { console.log(`  ✓ ${n}`); passed++; }
function fail(n, d) { console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); failed++; }
function truthy(c, n, d) { return c ? ok(n) : fail(n, d); }

truthy(fs.existsSync(SPEC), 'spec file exists');
if (!fs.existsSync(SPEC)) process.exit(1);

const body = fs.readFileSync(SPEC, 'utf8');
truthy(body.includes('openapi: 3.0.3'), 'openapi version 3.0.3');

// Count top-level YAML path keys that look like "  /api/...:".
const pathLines = body.split('\n').filter((l) => /^  \/api\/[^:]+:/.test(l));
const unique = new Set(pathLines.map((l) => l.trim()));
const count = unique.size;

// Current spec is already quite broad; keep a conservative floor to detect
// accidental truncation. Increase only when the spec grows.
const MIN_PATHS = 25;
truthy(count >= MIN_PATHS, `path count >= ${MIN_PATHS} (got ${count})`);

console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);


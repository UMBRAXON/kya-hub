#!/usr/bin/env node
/** Regenerate portal/public/sitemap.xml after adding indexable paths. */
'use strict';

const fs = require('fs');
const path = require('path');

const SITE = (process.env.NEXT_PUBLIC_SITE_URL || 'https://www.umbraxon.xyz').replace(/\/$/, '');
const PATHS = [
  { loc: '/', priority: '1.0', changefreq: 'weekly' },
  { loc: '/integrators', priority: '0.9', changefreq: 'weekly' },
  { loc: '/status', priority: '0.7', changefreq: 'hourly' },
  { loc: '/llms.txt', priority: '0.8', changefreq: 'monthly' },
  { loc: '/.well-known/kya-hub.json', priority: '0.7', changefreq: 'monthly' },
  { loc: '/README_API.md', priority: '0.6', changefreq: 'monthly' },
  { loc: '/AGENTS.md', priority: '0.6', changefreq: 'monthly' },
  { loc: '/docs/FAQ-FOR-BOT-DEVELOPERS.md', priority: '0.7', changefreq: 'monthly' },
  { loc: '/docs/INTEGRATOR-TRUST-GATE.md', priority: '0.7', changefreq: 'monthly' },
  { loc: '/docs/INTEGRATOR-QUICKSTART-5MIN.md', priority: '0.7', changefreq: 'monthly' },
  { loc: '/docs/ECONOMICS-AND-SYBIL.md', priority: '0.6', changefreq: 'monthly' },
  { loc: '/docs/REGISTRATION-QUICKSTART.md', priority: '0.6', changefreq: 'monthly' },
  { loc: '/openapi/openapi.yaml', priority: '0.5', changefreq: 'monthly' },
  { loc: '/terms', priority: '0.4', changefreq: 'yearly' },
  { loc: '/bots/', priority: '0.8', changefreq: 'weekly' },
];

const urls = PATHS.map(
  (p) => `  <url>
    <loc>${SITE}${p.loc}</loc>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`,
).join('\n');

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;

const out = path.join(__dirname, '..', 'portal', 'public', 'sitemap.xml');
fs.writeFileSync(out, xml, 'utf8');
console.log('Wrote', out);

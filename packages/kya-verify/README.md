# @umbraxon/kya-verify

Minimal gate check for platforms: **one GET** before you trust an agent.

```bash
npm install @umbraxon/kya-verify
# or from monorepo: npm install file:../../packages/kya-verify
```

```js
import { verifyAgentStatus } from '@umbraxon/kya-verify';

const { verified, data } = await verifyAgentStatus(
  'https://www.umbraxon.xyz',
  'UMBRA-000467',
);
if (!verified) throw new Error('agent not verified');

// High-value flows:
await verifyAgentStatus('https://www.umbraxon.xyz', 'UMBRA-000467', {
  includeCertProof: true,
});
```

Publish to npm: maintainer runs `npm publish --access public` from this directory.

require('dotenv').config({ path: '/root/kya-hub/.env' });
const alby = require('/root/kya-hub/lib/alby');

(async () => {
    await alby.connect({ info: () => {}, warn: () => {}, error: () => {} });
    
    console.log('═══════════════════════════════════════════');
    console.log('  ALBY HUB STATUS');
    console.log('═══════════════════════════════════════════');
    
    const info = await alby.getInfo();
    console.log('Node alias    :', info.alias);
    console.log('Network       :', info.network);
    console.log('Pubkey        :', (info.pubkey || '?').substring(0, 32) + '...');
    console.log('Block height  :', info.block_height || '?');
    console.log('Methods       :', info.methods?.length, 'supported');
    console.log('Notifications :', info.notifications?.join(', ') || 'none');
    console.log();
    
    // NWC doesn't expose channels directly — use REST API on local Alby Hub
    await alby.disconnect();
    process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });

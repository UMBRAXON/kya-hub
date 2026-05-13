#!/usr/bin/env node
// Quick NWC connectivity test — overí že NWC URI funguje proti Alby Hub
global.WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const URI_FILE = '/root/kya-hub/.secrets/alby-nwc.txt';

async function main() {
    if (!fs.existsSync(URI_FILE)) {
        console.error(`✗ Súbor ${URI_FILE} neexistuje`);
        process.exit(1);
    }

    const uri = fs.readFileSync(URI_FILE, 'utf8').trim();
    console.log('NWC URI prefix:', uri.substring(0, 50) + '...');

    let nwc;
    try {
        const { NWCClient } = require('@getalby/sdk');
        nwc = new NWCClient({ nostrWalletConnectUrl: uri });
    } catch (e) {
        console.error('✗ Nepodarilo sa inicializovať NWC client:', e.message);
        process.exit(2);
    }

    try {
        console.log('→ Posielam getInfo() cez Nostr relay...');
        const info = await Promise.race([
            nwc.getInfo(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 15s')), 15000)),
        ]);
        console.log('✓ getInfo OK');
        console.log('  - alias:', info.alias || '(no alias)');
        console.log('  - color:', info.color || '(no color)');
        console.log('  - network:', info.network || '(?)');
        console.log('  - methods:', (info.methods || []).join(', '));
    } catch (e) {
        console.error('✗ getInfo FAIL:', e.message);
        if (typeof nwc.close === 'function') nwc.close();
        process.exit(3);
    }

    try {
        console.log('→ Skúšam getBalance()...');
        const bal = await Promise.race([
            nwc.getBalance(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 10s')), 10000)),
        ]);
        console.log('✓ getBalance OK — balance:', bal.balance, 'msats (=', Math.floor(bal.balance / 1000), 'SAT)');
    } catch (e) {
        console.warn('⚠ getBalance FAIL:', e.message, '(môže byť permission issue, ale getInfo prešiel)');
    }

    if (typeof nwc.close === 'function') nwc.close();
    console.log('\n✓ Test DONE — NWC URI je funkčný.');
    process.exit(0);
}

main().catch(e => {
    console.error('✗ Unexpected error:', e);
    process.exit(99);
});

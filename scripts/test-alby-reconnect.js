#!/usr/bin/env node
/**
 * Offline unit test for Alby NWC reconnect supervisor (mocked NWCClient).
 * Run: node scripts/test-alby-reconnect.js
 */
'use strict';

process.env.ALBY_NWC_URI = 'nostr+walletconnect://0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef?relay=wss://relay.example&secret=00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
process.env.ALBY_RECONNECT_BASE_MS = '50';
process.env.ALBY_RECONNECT_MAX_MS = '200';
process.env.ALBY_CONNECT_TIMEOUT_MS = '500';

// Fresh require after env is set (module reads env in loadNwcUri).
delete require.cache[require.resolve('../lib/alby')];
const alby = require('../lib/alby');

let failed = 0;
function assert(cond, msg) {
    if (!cond) {
        failed += 1;
        console.error('FAIL:', msg);
    } else {
        console.log('OK  :', msg);
    }
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function main() {
    alby._resetForTests();

    let calls = 0;
    alby._setClientFactory(() => {
        calls += 1;
        if (calls < 3) {
            return {
                getInfo: async () => { throw new Error('relay timeout'); },
                close: async () => {},
                subscribeNotifications: async () => ({ unsubscribe: async () => {} }),
            };
        }
        return {
            getInfo: async () => ({ alias: 'mock-hub', methods: ['make_invoice'], network: 'bitcoin' }),
            makeInvoice: async ({ amount }) => ({
                invoice: 'lnbc1mock',
                payment_hash: 'ab'.repeat(32),
                amount,
                description: '',
                expires_at: Math.floor(Date.now() / 1000) + 600,
                created_at: Math.floor(Date.now() / 1000),
            }),
            close: async () => {},
            subscribeNotifications: async () => ({ unsubscribe: async () => {} }),
        };
    });

    assert(alby.isConfigured() === true, 'isConfigured with env URI');
    assert(alby.isConnected() === false, 'starts disconnected');

    const quiet = { info() {}, warn() {}, error() {} };
    const first = await alby.ensureReady(quiet);
    assert(first === false, 'first ensureReady fails (mock throw)');
    assert(alby.isConnected() === false, 'still disconnected after fail');
    assert(alby.getStatus().reconnect_pending === true || alby.getStatus().reconnect_attempt >= 1,
        'reconnect scheduled or attempt counted');

    alby.startReconnectSupervisor(quiet);

    // Wait for backoff retries until mock allows success on 3rd connect.
    const deadline = Date.now() + 5000;
    while (!alby.isConnected() && Date.now() < deadline) {
        await sleep(40);
    }
    assert(alby.isConnected() === true, 'auto-reconnect eventually succeeds');
    assert(calls >= 3, `clientFactory called >=3 times (got ${calls})`);

    const inv = await alby.createInvoice({ amountSats: 1000, description: 'test' });
    assert(inv.paymentHash && inv.invoice === 'lnbc1mock', 'createInvoice works after reconnect');

    // Transport error → markDisconnected + schedule reconnect
    alby._setClientFactory(() => ({
        getInfo: async () => { throw new Error('socket closed'); },
        close: async () => {},
        subscribeNotifications: async () => ({ unsubscribe: async () => {} }),
    }));
    // Force live client into failing probe path: swap connected client by marking
    // disconnected via probe after replacing factory requires reconnect path.
    // Simulate: call markDisconnected directly and ensure schedule fires.
    alby.markDisconnected('test_drop', quiet);
    assert(alby.isConnected() === false, 'markDisconnected clears connected');

    // Force reconnect with new good factory
    let reconnectCalls = 0;
    alby._setClientFactory(() => {
        reconnectCalls += 1;
        return {
            getInfo: async () => ({ alias: 'mock-hub-2' }),
            close: async () => {},
            subscribeNotifications: async () => ({ unsubscribe: async () => {} }),
        };
    });
    const ok = await alby.ensureReady(quiet, { forceReconnect: true });
    assert(ok === true && alby.isConnected(), 'forceReconnect via ensureReady');
    assert(reconnectCalls >= 1, 'forceReconnect used new factory');

    const status = alby.getStatus();
    assert(status.configured === true && status.connected === true, 'getStatus reflects connected');
    assert(status.uri_source === 'env', 'uri_source=env');

    await alby.disconnect();
    assert(alby.isConnected() === false, 'disconnect clears state');

    if (failed) {
        console.error(`\n${failed} assertion(s) failed`);
        process.exit(1);
    }
    console.log('\nAll alby reconnect tests passed');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

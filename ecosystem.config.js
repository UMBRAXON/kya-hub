// PM2 ecosystem pre celý KYA-Hub stack (KYA backend + Alby Hub Lightning node)
// Hub release: 1.1.0 (Integrations v1) — po bump verzie v package.json reštartuj kya-hub.
// Použitie:
//   pm2 start ecosystem.config.js
//   pm2 restart kya-hub
//   pm2 restart alby-hub
//   pm2 stop alby-hub
//   pm2 logs --lines 50

module.exports = {
    apps: [
        {
            name: 'kya-hub',
            script: 'server.js',
            cwd: '/root/kya-hub',
            instances: 1,
            exec_mode: 'fork',
            autorestart: true,
            max_restarts: 10,
            min_uptime: '10s',
            env: {
                NODE_ENV: 'production',
                // Vyčistiť proxy premenné — server musí mať priamy outbound prístup na BTCPay
                HTTP_PROXY: '',
                HTTPS_PROXY: '',
                http_proxy: '',
                https_proxy: '',
                ALL_PROXY: '',
                all_proxy: '',
                SOCKS_PROXY: '',
                socks_proxy: '',
                socks5_proxy: '',
                NO_PROXY: '*',
                no_proxy: '*',
                // Quiet dotenv runtime banner: "◇ injected env (N) from .env ..."
                DOTENV_CONFIG_QUIET: 'true'
            },
            error_file: '/root/.pm2/logs/kya-hub-error.log',
            out_file: '/root/.pm2/logs/kya-hub-out.log',
            merge_logs: true,
            time: true
        },
        {
            name: 'kya-anchor-worker',
            script: 'scripts/anchor-worker.js',
            cwd: '/root/kya-hub',
            instances: 1,
            exec_mode: 'fork',
            autorestart: true,
            max_restarts: 10,
            min_uptime: '15s',
            // Bezpečnostná konfigurácia (Phase 4):
            //   ANCHOR_WORKER_BROADCAST_ENABLED je default false — worker beží v DRY_RUN.
            //   Pre LIVE OP_RETURN broadcast pridať do .env:
            //       ANCHOR_WORKER_BROADCAST_ENABLED=true
            //   a `pm2 restart kya-anchor-worker --update-env`.
            // ELITE listing init (migration 016) používa ELITE_LISTING_HEARTBEAT_DAYS z .env
            // (zdieľaný súbor s kya-hub; po zmene hodnôt reštart oboch alebo aspoň worker + hub).
            env: {
                NODE_ENV: 'production',
                HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
                ALL_PROXY: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*',
                DOTENV_CONFIG_QUIET: 'true'
            },
            error_file: '/root/.pm2/logs/kya-anchor-worker-error.log',
            out_file: '/root/.pm2/logs/kya-anchor-worker-out.log',
            merge_logs: true,
            time: true
        },
        {
            // CRL transparency worker (Phase 5). Beží ako PM2 daemon (NIE cron) —
            // aplikácia má vlastné dlhé sleep slučky (anchorLoop = 24 h,
            // confirmLoop = 10 min) a obsluhuje vlastný SIGTERM. PM2 ho len drží
            // online a reštartuje pri páde.
            //
            // DRY_RUN by default. Pre LIVE OP_RETURN broadcast pridať do .env:
            //   CRL_WORKER_BROADCAST_ENABLED=true
            // a `pm2 restart kya-crl-worker --update-env`.
            name: 'kya-crl-worker',
            script: 'scripts/crl-worker.js',
            cwd: '/root/kya-hub',
            instances: 1,
            exec_mode: 'fork',
            autorestart: true,
            max_restarts: 10,
            min_uptime: '15s',
            env: {
                NODE_ENV: 'production',
                HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
                ALL_PROXY: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*',
                DOTENV_CONFIG_QUIET: 'true'
            },
            error_file: '/root/.pm2/logs/kya-crl-worker-error.log',
            out_file: '/root/.pm2/logs/kya-crl-worker-out.log',
            merge_logs: true,
            time: true,
        },
        {
            // Top-up monitor pre bitcoind kya-anchor wallet (Phase 4 follow-up).
            // Beží ako PM2 cron, 1× za 30 minút (cron_restart). Pri prvom spustení
            // urobí jednu kontrolu (single-shot) a exit-ne — PM2 ho znova
            // spustí podľa cron expression.
            //   - balance ≥ 3000 sat  → OK (no notification)
            //   - 1000 ≤ balance < 3000 → Telegram warning
            //   - 500 ≤ balance < 1000  → Telegram critical
            //   - balance < 500         → AUTO-PAUSE worker (DRY_RUN) + critical alert
            name: 'kya-anchor-wallet-monitor',
            script: 'scripts/anchor-wallet-monitor.js',
            cwd: '/root/kya-hub',
            instances: 1,
            exec_mode: 'fork',
            autorestart: false,           // single-shot; cron_restart triggers next run
            cron_restart: '*/30 * * * *', // every 30 minutes
            env: {
                NODE_ENV: 'production',
                HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
                ALL_PROXY: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*',
                DOTENV_CONFIG_QUIET: 'true'
            },
            error_file: '/root/.pm2/logs/kya-anchor-wallet-monitor-error.log',
            out_file: '/root/.pm2/logs/kya-anchor-wallet-monitor-out.log',
            merge_logs: true,
            time: true,
        },
        {
            // UMBRAXON-PR-AMBASSADOR — Moltbook comments (every 3h).
            name: 'kya-pr-engage',
            script: 'scripts/prod/pr-agent-engage.sh',
            cwd: '/root/kya-hub',
            interpreter: 'bash',
            instances: 1,
            exec_mode: 'fork',
            // Single-shot; PM2 cron schedules the next run.
            autorestart: false,
            cron_restart: '15 */3 * * *',
            env: {
                NODE_ENV: 'production',
                HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
                ALL_PROXY: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*',
            },
            error_file: '/root/.pm2/logs/kya-pr-engage-error.log',
            out_file: '/root/.pm2/logs/kya-pr-engage-out.log',
            merge_logs: true,
            time: true,
        },
        {
            // UMBRAXON-PR-AMBASSADOR — daily themed Moltbook post (10:00 UTC).
            name: 'kya-pr-agent',
            script: 'scripts/prod/pr-agent-daily-post.sh',
            cwd: '/root/kya-hub',
            interpreter: 'bash',
            instances: 1,
            exec_mode: 'fork',
            // Single-shot; PM2 cron schedules the next run.
            autorestart: false,
            cron_restart: '0 10 * * *',
            env: {
                NODE_ENV: 'production',
                HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
                ALL_PROXY: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*',
            },
            error_file: '/root/.pm2/logs/kya-pr-agent-error.log',
            out_file: '/root/.pm2/logs/kya-pr-agent-out.log',
            merge_logs: true,
            time: true,
        },
        {
            // Developer webhook outbox — retry integrator HTTPS callbacks (every minute).
            name: 'kya-dev-webhook-worker',
            script: 'scripts/prod/developer-webhook-worker.sh',
            cwd: '/root/kya-hub',
            interpreter: 'bash',
            instances: 1,
            exec_mode: 'fork',
            autorestart: false,
            cron_restart: '*/1 * * * *',
            env: {
                NODE_ENV: 'production',
                HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
                ALL_PROXY: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*',
            },
            error_file: '/root/.pm2/logs/kya-dev-webhook-worker-error.log',
            out_file: '/root/.pm2/logs/kya-dev-webhook-worker-out.log',
            merge_logs: true,
            time: true,
        },
        {
            // UMBRAXON-PR-AMBASSADOR — themed Nostr note (Mon/Wed/Fri 14:00 UTC).
            name: 'kya-pr-nostr',
            script: 'scripts/prod/pr-agent-nostr-post.sh',
            cwd: '/root/kya-hub',
            interpreter: 'bash',
            instances: 1,
            exec_mode: 'fork',
            autorestart: false,
            cron_restart: '0 14 * * 1,3,5',
            env: {
                NODE_ENV: 'production',
                HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
                ALL_PROXY: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*',
            },
            error_file: '/root/.pm2/logs/kya-pr-nostr-error.log',
            out_file: '/root/.pm2/logs/kya-pr-nostr-out.log',
            merge_logs: true,
            time: true,
        },
        {
            // Strategic Sprint §30 Item 6 — Lightning inbound liquidity monitor.
            // PM2 cron: every 15 min. Uses Alby Hub HTTP API (/api/start) when
            // ALBY_UNLOCK_PASSWORD or .secrets/alby-unlock.txt is set; else NWC
            // outbound-only. File lock prevents overlapping cron + ?fresh=1.
            name: 'kya-liquidity-monitor',
            script: 'scripts/lightning-liquidity-monitor.js',
            cwd: '/root/kya-hub',
            instances: 1,
            exec_mode: 'fork',
            autorestart: false,
            cron_restart: '*/15 * * * *',
            env: {
                NODE_ENV: 'production',
                HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
                ALL_PROXY: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*',
                DOTENV_CONFIG_QUIET: 'true'
            },
            error_file: '/root/.pm2/logs/kya-liquidity-monitor-error.log',
            out_file: '/root/.pm2/logs/kya-liquidity-monitor-out.log',
            merge_logs: true,
            time: true,
        },
        {
            // P2 watchtower monitoring (low-risk): watches Alby Hub logs and
            // alerts if the watchtower "connected" signal disappears.
            //
            // Opt-in via `.env`:
            //   WATCHTOWER_MONITOR_ENABLED=true
            // (otherwise this single-shot exits 0 without doing anything)
            name: 'kya-watchtower-monitor',
            script: 'scripts/watchtower-monitor.js',
            cwd: '/root/kya-hub',
            instances: 1,
            exec_mode: 'fork',
            autorestart: false,
            cron_restart: '*/30 * * * *',
            env: {
                NODE_ENV: 'production',
                HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
                ALL_PROXY: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*',
                DOTENV_CONFIG_QUIET: 'true'
            },
            error_file: '/root/.pm2/logs/kya-watchtower-monitor-error.log',
            out_file: '/root/.pm2/logs/kya-watchtower-monitor-out.log',
            merge_logs: true,
            time: true,
        },
        {
            // Strategic Sprint §30 Item 5 — Bitcoin fork detector cron.
            // PM2 cron-style: runs once per restart, exits, PM2 reschedules
            // 10 minutes later. `autorestart: false` prevents a tight crash loop
            // between cron ticks (similar to kya-anchor-wallet-monitor).
            //
            // Set `FORK_DETECTOR_AUTOPAUSE=true` in .env to authorise the
            // detector to flip ANCHOR_WORKER_BROADCAST_ENABLED=false on
            // FORK_DETECTED. Default false — operator must opt in.
            name: 'kya-fork-detector',
            script: 'scripts/fork-detector-worker.js',
            cwd: '/root/kya-hub',
            instances: 1,
            exec_mode: 'fork',
            autorestart: false,
            cron_restart: '*/10 * * * *',
            env: {
                NODE_ENV: 'production',
                HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
                ALL_PROXY: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*',
                DOTENV_CONFIG_QUIET: 'true'
            },
            error_file: '/root/.pm2/logs/kya-fork-detector-error.log',
            out_file: '/root/.pm2/logs/kya-fork-detector-out.log',
            merge_logs: true,
            time: true,
        },
        {
            // Strategic Sprint §30 Item 11 — DAC8 daily accounting export.
            // PM2 cron-style: 01:00 UTC daily. Exports yesterday's settled
            // payments to CSV+JSON+manifest in /root/kya-hub/exports/, then
            // optionally encrypt-uploads to Backblaze B2 (same passphrase as
            // Items 1+2). `autorestart: false` keeps it strictly daily.
            name: 'kya-dac8-export',
            script: 'scripts/dac8-export.js',
            args: '--from-cron',
            cwd: '/root/kya-hub',
            instances: 1,
            exec_mode: 'fork',
            autorestart: false,
            cron_restart: '0 1 * * *',
            env: {
                NODE_ENV: 'production',
                HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
                ALL_PROXY: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*',
                DOTENV_CONFIG_QUIET: 'true'
            },
            error_file: '/root/.pm2/logs/kya-dac8-export-error.log',
            out_file: '/root/.pm2/logs/kya-dac8-export-out.log',
            merge_logs: true,
            time: true,
        },
        {
            // Growth: demo witness + HN/Reddit listener + GitHub issue scout (dry-run drafts).
            name: 'kya-growth-cycle',
            script: 'scripts/growth/run-cycle.sh',
            interpreter: 'bash',
            cwd: '/root/kya-hub',
            instances: 1,
            exec_mode: 'fork',
            autorestart: false,
            cron_restart: '0 8 * * *',
            env: {
                NODE_ENV: 'production',
                HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
                ALL_PROXY: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*',
            },
            error_file: '/root/.pm2/logs/kya-growth-cycle-error.log',
            out_file: '/root/.pm2/logs/kya-growth-cycle-out.log',
            merge_logs: true,
            time: true,
        },
        {
            // Growth: post a couple of scout drafts as real GitHub comments (requires `gh auth login`).
            // Safe limits via env:
            //   SCOUT_POST_MAX_PER_RUN=2 (default)
            name: 'kya-growth-gh-comments',
            script: 'scripts/growth/post-scout-drafts.sh',
            interpreter: 'bash',
            cwd: '/root/kya-hub',
            instances: 1,
            exec_mode: 'fork',
            autorestart: false,
            cron_restart: '30 8 * * *', // after scout run; UTC
            env: {
                NODE_ENV: 'production',
                HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
                ALL_PROXY: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*',
            },
            error_file: '/root/.pm2/logs/kya-growth-gh-comments-error.log',
            out_file: '/root/.pm2/logs/kya-growth-gh-comments-out.log',
            merge_logs: true,
            time: true,
        },
        {
            // Operator daily digest — agents, registrations, integrator requests,
            // heartbeats, reputation, rejected API → Telegram (07:00 UTC ≈ 09:00 CET).
            name: 'kya-operator-daily-report',
            script: 'scripts/prod/operator-daily-report.sh',
            interpreter: 'bash',
            cwd: '/root/kya-hub',
            instances: 1,
            exec_mode: 'fork',
            autorestart: false,
            cron_restart: '0 7 * * *',
            env: {
                NODE_ENV: 'production',
                HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
                ALL_PROXY: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*',
                DOTENV_CONFIG_QUIET: 'true',
            },
            error_file: '/root/.pm2/logs/kya-operator-daily-report-error.log',
            out_file: '/root/.pm2/logs/kya-operator-daily-report-out.log',
            merge_logs: true,
            time: true,
        },
        {
            // Strategic Sprint §31 A.3 — Quarterly DB-restore drill.
            // Picks the most recent kyahub/db/*.dump.gz.enc from R2, downloads
            // to /tmp/restore-drill-<ts>/, verifies HMAC tail + decrypts +
            // pg_restore --list (no actual restore). Inserts backup_log row
            // with kind='restore_drill' and sends Telegram OK / FAIL.
            //
            // PM2 cron: 09:00 UTC on day 1 of every 3rd month (Jan, Apr, Jul,
            // Oct). `autorestart: false` keeps it strictly quarterly.
            //
            // Manual trigger: `pm2 trigger kya-restore-drill` or just
            // `bash scripts/restore-drill.sh`.
            name: 'kya-restore-drill',
            script: 'scripts/restore-drill.sh',
            interpreter: 'bash',
            cwd: '/root/kya-hub',
            instances: 1,
            exec_mode: 'fork',
            autorestart: false,
            cron_restart: '0 9 1 */3 *',
            env: {
                NODE_ENV: 'production',
                HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
                ALL_PROXY: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*'
            },
            error_file: '/root/.pm2/logs/kya-restore-drill-error.log',
            out_file: '/root/.pm2/logs/kya-restore-drill-out.log',
            merge_logs: true,
            time: true,
        },
        {
            name: 'kya-portal',
            script: 'node_modules/next/dist/bin/next',
            args: 'start -p 3001',
            cwd: '/root/kya-hub/portal',
            instances: 1,
            exec_mode: 'fork',
            autorestart: true,
            max_restarts: 10,
            min_uptime: '10s',
            env: {
                NODE_ENV: 'production',
                PORT: '3001',
                HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
                ALL_PROXY: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*'
            },
            error_file: '/root/.pm2/logs/kya-portal-error.log',
            out_file: '/root/.pm2/logs/kya-portal-out.log',
            merge_logs: true,
            time: true
        },
        {
            name: 'alby-hub',
            script: '/root/kya-hub/albyhub/bin/albyhub',
            cwd: '/root/kya-hub/albyhub',
            interpreter: 'none',
            instances: 1,
            exec_mode: 'fork',
            autorestart: true,
            max_restarts: 10,
            min_uptime: '15s',
            env: {
                LD_LIBRARY_PATH: '/root/kya-hub/albyhub/lib',
                WORK_DIR: '/root/kya-hub/albyhub/workdir',
                PORT: '8080',
                LOG_EVENTS: 'true',
                HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
                ALL_PROXY: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*',
                DOTENV_CONFIG_QUIET: 'true'
            },
            error_file: '/root/.pm2/logs/alby-hub-error.log',
            out_file: '/root/.pm2/logs/alby-hub-out.log',
            merge_logs: true,
            time: true
        }
    ]
};

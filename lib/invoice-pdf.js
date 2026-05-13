// ============================================================================
// UMBRAXON KYA-Hub — PDF Invoice Generator (Strategic Sprint §31 C)
// ----------------------------------------------------------------------------
// Generates a single-page A4 tax invoice for an agent registration payment and
// stores it locally (chmod 600) + mirrors to R2 via the existing aws/rclone
// helper script. Inserts a row into `invoices`.
//
// Hooks:
//   - server.js InvoiceSettled (BTCPay)
//   - server.js Alby NWC settled callback
// Both call:
//     await invoicePdf.issueForPayment(pool, hubkeys, opts)
//
// Idempotency: payment_hash is the natural key. If a row already exists for
// the same payment_hash, the function returns it without regenerating. The
// admin /regenerate endpoint bumps regenerated_count + overwrites the file.
//
// Threat model:
//   - No PII besides agent_name + kya_id + pubkey_prefix lands in the PDF.
//   - PDF file mode = 600. Directory mode = 700. Only root can read.
//   - QR code links to a PUBLIC verifier URL — by design, anyone with the
//     KYA-ID can check the live cert state.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const REQUIRED_HEADER_KEYS = [
    'INVOICE_SELLER_NAME', 'INVOICE_SELLER_EMAIL',
];

function cfg() {
    return {
        sellerName:        process.env.INVOICE_SELLER_NAME || 'Umbraxon',
        sellerAddress:     process.env.INVOICE_SELLER_ADDRESS || '',
        sellerTaxId:       process.env.INVOICE_SELLER_TAX_ID || '',
        sellerVatId:       process.env.INVOICE_SELLER_VAT_ID || '',
        sellerIban:        process.env.INVOICE_SELLER_IBAN || '',
        sellerEmail:       process.env.INVOICE_SELLER_EMAIL || '',
        sellerWebsite:     process.env.INVOICE_SELLER_WEBSITE || 'https://umbraxon.xyz',
        sellerLogoPath:    process.env.INVOICE_SELLER_LOGO_PATH || '',
        numberPrefix:      process.env.INVOICE_NUMBER_PREFIX || 'UMX-2026-',
        currency:          process.env.INVOICE_CURRENCY || 'EUR',
        verifierBase:      process.env.INVOICE_VERIFIER_BASE || 'https://umbraxon.xyz/api/cert',
        localDir:          process.env.INVOICE_LOCAL_DIR || '/root/kya-hub/invoices',
        pushToR2:          process.env.INVOICE_PUSH_TO_R2 !== 'false',
        fxProvider:        process.env.INVOICE_FX_PROVIDER || 'coingecko',
        fixedBtcRateEur:   process.env.INVOICE_BTC_RATE_EUR ? parseFloat(process.env.INVOICE_BTC_RATE_EUR) : null,
        docTitle:          process.env.INVOICE_DOC_TITLE || 'TAX INVOICE / FAKTURA',
        legalNote:         process.env.INVOICE_LEGAL_NOTE || '',
    };
}

function _ensureDir(p) {
    try { fs.mkdirSync(p, { recursive: true, mode: 0o700 }); } catch (_) {}
    try { fs.chmodSync(p, 0o700); } catch (_) {}
}

// ----------------------------------------------------------------------------
// FX cache (5 min in-process). Always tolerates failures.
// ----------------------------------------------------------------------------
let _fxCache = { rate: null, ts: 0 };
async function getBtcRateEur() {
    const c = cfg();
    if (c.fxProvider === 'fixed' && c.fixedBtcRateEur) {
        return { rate: c.fixedBtcRateEur, source: 'fixed' };
    }
    const ageMs = Date.now() - _fxCache.ts;
    if (_fxCache.rate && ageMs < 5 * 60 * 1000) {
        return { rate: _fxCache.rate, source: 'cached-coingecko' };
    }
    try {
        const r = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
            params: { ids: 'bitcoin', vs_currencies: 'eur' },
            timeout: 4000,
        });
        const rate = r.data && r.data.bitcoin && r.data.bitcoin.eur;
        if (rate && Number.isFinite(rate)) {
            _fxCache = { rate, ts: Date.now() };
            return { rate, source: 'coingecko' };
        }
    } catch (_) {}
    // Fallback to whatever fixed rate is in env, or null.
    return { rate: c.fixedBtcRateEur || null, source: 'fallback' };
}

function satsToEur(sats, btcRateEur) {
    if (!btcRateEur || !Number.isFinite(btcRateEur)) return null;
    return Math.round((sats / 100_000_000) * btcRateEur * 100) / 100;
}

// ----------------------------------------------------------------------------
// Invoice numbering: UMX-YYYYMMDD-NNNN  (NNNN = per-day sequence based on
// existing rows). Guarantees uniqueness via DB UNIQUE on invoice_number.
// ----------------------------------------------------------------------------
async function nextInvoiceNumber(pool, issuedDate) {
    const c = cfg();
    const day = issuedDate.toISOString().slice(0, 10).replace(/-/g, '');
    const prefix = `${c.numberPrefix}${day}-`;
    const r = await pool.query(
        `SELECT invoice_number FROM invoices
         WHERE invoice_number LIKE $1 || '%'
         ORDER BY invoice_number DESC LIMIT 1`,
        [prefix]
    );
    let n = 1;
    if (r.rowCount > 0) {
        const tail = r.rows[0].invoice_number.slice(prefix.length);
        const parsed = parseInt(tail, 10);
        if (Number.isFinite(parsed)) n = parsed + 1;
    }
    return `${prefix}${String(n).padStart(4, '0')}`;
}

// ----------------------------------------------------------------------------
// PDF rendering
// ----------------------------------------------------------------------------
function fmtEur(eur) {
    if (eur == null || !Number.isFinite(eur)) return '-';
    return `EUR ${eur.toFixed(2)}`;
}
function fmtSats(sats) {
    if (!Number.isFinite(sats)) return '-';
    return `${sats.toLocaleString('en-US')} sats`;
}

async function renderPdfToFile({ outPath, ctx }) {
    return new Promise(async (resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: 50 });
            const stream = fs.createWriteStream(outPath, { mode: 0o600 });
            stream.on('error', reject);
            doc.pipe(stream);

            const c = cfg();
            const PAGE_W = doc.page.width;

            // -------- Logo (top-right, optional) ----------------------------
            let logoBottomY = 50;
            if (c.sellerLogoPath) {
                try {
                    if (fs.existsSync(c.sellerLogoPath)) {
                        const LOGO_W = 140;
                        const LOGO_X = PAGE_W - 50 - LOGO_W;
                        doc.image(c.sellerLogoPath, LOGO_X, 35, { fit: [LOGO_W, 70] });
                        logoBottomY = 35 + 70 + 6;
                    }
                } catch (_) { /* logo failures are non-fatal */ }
            }

            // -------- Header band: seller (left) + invoice meta (right) --------
            doc.font('Helvetica-Bold').fontSize(18).fillColor('#111111');
            doc.text(c.sellerName, 50, 50, { width: PAGE_W - 250 });

            doc.font('Helvetica').fontSize(9).fillColor('#444444');
            const addrLines = (c.sellerAddress || '').split(/[;,]/).map(s => s.trim()).filter(Boolean);
            let y = 73;
            for (const line of addrLines) { doc.text(line, 50, y, { width: PAGE_W - 250 }); y += 12; }
            if (c.sellerTaxId)  { doc.text(`IČO: ${c.sellerTaxId}`, 50, y); y += 12; }
            if (c.sellerVatId)  { doc.text(`DIČ / IČ DPH: ${c.sellerVatId}`, 50, y); y += 12; }
            if (c.sellerIban)   { doc.text(`IBAN: ${c.sellerIban}`, 50, y); y += 12; }
            if (c.sellerEmail)  { doc.text(c.sellerEmail, 50, y); y += 12; }
            if (c.sellerWebsite){ doc.text(c.sellerWebsite, 50, y); y += 12; }

            // Top-right: document title + invoice number + dates (under logo)
            const titleY = Math.max(logoBottomY, 50);
            doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111')
               .text(c.docTitle, 360, titleY, { width: 200, align: 'right' });
            doc.font('Helvetica').fontSize(10).fillColor('#222222');
            doc.text(`No: ${ctx.invoiceNumber}`, 360, titleY + 18, { width: 200, align: 'right' });
            doc.text(`Issued: ${ctx.issuedDate.toISOString().slice(0, 19).replace('T', ' ')} UTC`,
                360, titleY + 32, { width: 200, align: 'right' });
            if (ctx.paidAt) {
                doc.text(`Paid:   ${ctx.paidAt.toISOString().slice(0, 19).replace('T', ' ')} UTC`,
                    360, titleY + 46, { width: 200, align: 'right' });
            }
            y = Math.max(y, titleY + 62);

            // Divider
            const dividerY = Math.max(y + 6, 130);
            doc.moveTo(50, dividerY).lineTo(PAGE_W - 50, dividerY)
               .strokeColor('#cccccc').lineWidth(0.5).stroke();

            // -------- Buyer block (no PII; KYA-ID is the on-hub identifier) ----
            let by = dividerY + 16;
            doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111')
               .text('Bill to / Buyer', 50, by);
            by += 16;
            doc.font('Helvetica').fontSize(10).fillColor('#222222');
            doc.text(`KYA ID:   ${ctx.kyaId}`, 50, by); by += 13;
            if (ctx.agentName) { doc.text(`Agent:    ${ctx.agentName}`, 50, by); by += 13; }
            doc.text(`Tier:     ${ctx.tier}`, 50, by); by += 13;
            if (ctx.anchorTxid) {
                doc.text(`Anchor TXID: ${ctx.anchorTxid}`, 50, by, { width: 480 });
                by += 13;
            }

            // -------- Service line table -----------------------------------
            const tableTopY = by + 16;
            const COL_DESC_X = 50;
            const COL_QTY_X  = 360;
            const COL_UNIT_X = 410;
            const COL_TOT_X  = 480;
            doc.font('Helvetica-Bold').fontSize(10).fillColor('#111111');
            doc.text('Description',      COL_DESC_X, tableTopY);
            doc.text('Qty',               COL_QTY_X, tableTopY, { width: 40, align: 'right' });
            doc.text('Unit',              COL_UNIT_X, tableTopY, { width: 60, align: 'right' });
            doc.text('Total',             COL_TOT_X, tableTopY, { width: 80, align: 'right' });

            doc.moveTo(50, tableTopY + 14).lineTo(PAGE_W - 50, tableTopY + 14)
               .strokeColor('#cccccc').lineWidth(0.5).stroke();

            doc.font('Helvetica').fontSize(10).fillColor('#222222');
            const descLines = [
                `AI Agent KYA Registration — ${ctx.tier}`,
                `1 year reputation tracking on Umbraxon hub`,
                ctx.tier === 'ELITE' ? '+ Bitcoin OP_RETURN cert anchor' : '+ Signed Ed25519 cert',
            ];
            let lineY = tableTopY + 22;
            doc.text(descLines.join('\n'), COL_DESC_X, lineY, { width: 300 });
            doc.text('1',                COL_QTY_X, lineY, { width: 40, align: 'right' });
            doc.text(fmtSats(ctx.amountSats), COL_UNIT_X, lineY, { width: 60, align: 'right' });
            doc.text(fmtSats(ctx.amountSats), COL_TOT_X, lineY, { width: 80, align: 'right' });
            lineY += descLines.length * 14 + 4;

            // Totals block (sats prominently; EUR equivalent secondary)
            doc.moveTo(360, lineY).lineTo(PAGE_W - 50, lineY)
               .strokeColor('#cccccc').lineWidth(0.5).stroke();
            lineY += 6;
            doc.font('Helvetica').fontSize(10).fillColor('#222222');
            doc.text('Subtotal:', 360, lineY, { width: 100, align: 'right' });
            doc.text(fmtSats(ctx.amountSats), 460, lineY, { width: 100, align: 'right' });
            lineY += 14;
            // VAT
            const vatNotice = (ctx.sellerVatId && ctx.sellerVatId.length > 0)
                ? 'VAT 0% - reverse charge / digital service to legal entity per Slovak VAT Act (operator: verify treatment for AI-agent recipients)'
                : 'VAT not applied (seller not VAT-registered)';
            doc.text('VAT:', 360, lineY, { width: 100, align: 'right' });
            doc.text('0%', 460, lineY, { width: 100, align: 'right' });
            lineY += 14;
            doc.moveTo(360, lineY).lineTo(PAGE_W - 50, lineY)
               .strokeColor('#888888').lineWidth(0.8).stroke();
            lineY += 6;
            doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111');
            doc.text('TOTAL (sats):', 360, lineY, { width: 100, align: 'right' });
            doc.text(fmtSats(ctx.amountSats), 460, lineY, { width: 100, align: 'right' });
            lineY += 14;
            doc.font('Helvetica').fontSize(10).fillColor('#444444');
            doc.text(`~ ${fmtEur(ctx.amountEur)} @ ${ctx.btcRateEur ? `EUR ${ctx.btcRateEur.toLocaleString('en-US')} / BTC` : '-'}`,
                360, lineY, { width: 200, align: 'right' });
            lineY += 18;

            // -------- Payment proof ---------------------------------------
            doc.font('Helvetica-Bold').fontSize(10).fillColor('#111111')
               .text('Payment proof', 50, lineY);
            lineY += 14;
            doc.font('Helvetica').fontSize(9).fillColor('#222222');
            doc.text(`Method:           Bitcoin Lightning Network (${ctx.paymentMethod})`, 50, lineY); lineY += 11;
            if (ctx.paymentHash) {
                doc.text(`Payment hash:     ${ctx.paymentHash}`, 50, lineY, { width: 480 }); lineY += 11;
            }
            if (ctx.paymentPreimageSha) {
                doc.text(`Preimage sha (16): ${ctx.paymentPreimageSha.slice(-16)}`, 50, lineY); lineY += 11;
            }
            if (ctx.paidAt) {
                doc.text(`Settled (UTC):    ${ctx.paidAt.toISOString().replace('T',' ').slice(0,19)}`, 50, lineY); lineY += 11;
            }

            // VAT explanation block (long note)
            lineY += 8;
            doc.font('Helvetica-Oblique').fontSize(8).fillColor('#666666');
            doc.text(vatNotice, 50, lineY, { width: PAGE_W - 100, align: 'left' });

            // -------- QR code (verifier link) -----------------------------
            const verifierUrl = `${cfg().verifierBase}/${ctx.kyaId}`;
            const qrPng = await QRCode.toBuffer(verifierUrl, {
                errorCorrectionLevel: 'M', margin: 1, scale: 4,
            });
            const QR_SIZE = 95;
            const QR_X = PAGE_W - 50 - QR_SIZE;
            const QR_Y = doc.page.height - 50 - QR_SIZE - 60; // bottom-right above footer
            doc.image(qrPng, QR_X, QR_Y, { width: QR_SIZE, height: QR_SIZE });
            doc.font('Helvetica').fontSize(8).fillColor('#444444');
            doc.text('Scan to verify cert', QR_X - 5, QR_Y + QR_SIZE + 3, { width: QR_SIZE + 10, align: 'center' });
            doc.text(verifierUrl, 50, QR_Y + QR_SIZE - 12, { width: QR_X - 60 });

            // -------- Footer ----------------------------------------------
            const footY = doc.page.height - 70;
            doc.moveTo(50, footY).lineTo(PAGE_W - 50, footY)
               .strokeColor('#cccccc').lineWidth(0.5).stroke();
            doc.font('Helvetica').fontSize(7).fillColor('#666666');
            const footerLines = [
                'Paid in full via Bitcoin Lightning Network. No refund per Terms of Service at https://umbraxon.xyz/terms.',
            ];
            if (c.legalNote) footerLines.push(c.legalNote);
            doc.text(footerLines.join('  '), 50, footY + 4,
                { width: PAGE_W - 100, align: 'left', lineBreak: true, height: 60 }
            );

            doc.end();
            stream.on('finish', resolve);
        } catch (err) {
            reject(err);
        }
    });
}

// ----------------------------------------------------------------------------
// Optional R2 mirror (re-uses the existing scripts/lib/s3-backup-upload.sh
// path indirectly via aws CLI).
// ----------------------------------------------------------------------------
function r2RelKeyFor(localPath) {
    const base = path.basename(localPath);
    const m = base.match(/^UMX-\d+T?\d*Z?-/);
    // Reconstruct the YYYY/MM partition that we just used on disk:
    const segs = localPath.split(path.sep);
    const month = segs[segs.length - 2];
    const year = segs[segs.length - 3];
    return `invoices/${year}/${month}/${base}`;
}

async function uploadToR2(localPath, log) {
    if (process.env.INVOICE_PUSH_TO_R2 === 'false') return { skipped: true };
    if (!process.env.BACKUP_S3_ENDPOINT
        || !process.env.BACKUP_S3_BUCKET
        || !process.env.BACKUP_S3_ACCESS_KEY_ID) return { skipped: true, reason: 'r2 unconfigured' };

    const relKey = r2RelKeyFor(localPath);
    const objectUri = `s3://${process.env.BACKUP_S3_BUCKET}/${(process.env.BACKUP_S3_PREFIX || 'kyahub/').replace(/^\/+|\/+$/g,'')}/${relKey}`;
    try {
        const { spawn } = require('child_process');
        const env = {
            ...process.env,
            AWS_ACCESS_KEY_ID: process.env.BACKUP_S3_ACCESS_KEY_ID,
            AWS_SECRET_ACCESS_KEY: process.env.BACKUP_S3_SECRET_ACCESS_KEY,
            AWS_DEFAULT_REGION: process.env.BACKUP_S3_REGION || 'auto',
            HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
            ALL_PROXY: '', all_proxy: '', SOCKS_PROXY: '', socks_proxy: '',
            socks5_proxy: '', SOCKS5_PROXY: '',
            NO_PROXY: '*', no_proxy: '*',
        };
        const child = spawn('aws', [
            '--endpoint-url', process.env.BACKUP_S3_ENDPOINT,
            's3', 'cp', localPath, objectUri,
            '--only-show-errors',
        ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', d => { stderr += d.toString(); });
        const code = await new Promise(res => child.on('close', res));
        if (code === 0) return { ok: true, uri: objectUri };
        if (log && log.warn) log.warn({ code, stderr: stderr.slice(0, 200) }, 'r2 upload failed (non-fatal)');
        return { ok: false, uri: objectUri, stderr };
    } catch (e) {
        if (log && log.warn) log.warn({ err: e.message }, 'r2 upload threw (non-fatal)');
        return { ok: false, error: e.message };
    }
}

// ----------------------------------------------------------------------------
// Public: issueForPayment
// ----------------------------------------------------------------------------
/**
 * @param {pg.Pool} pool
 * @param {object} opts
 *   - agent           { id, kya_id, agent_name, tier, anchor_txid? }
 *   - paymentMethod   'btcpay' | 'lightning' | 'backfill'
 *   - amountSats      integer (the snapshotted price the bot actually paid)
 *   - paymentHash     unique key for idempotency
 *   - paymentPreimage optional 32-byte hex
 *   - paidAt          Date
 *   - logger
 * @returns { ok, invoice_number, pdf_local_path, pdf_sha256, pdf_bytes,
 *            pdf_r2_uri?, paid_amount_eur, btc_rate_eur, already_existed? }
 */
async function issueForPayment(pool, opts) {
    const { agent, paymentMethod, amountSats, paymentHash, paymentPreimage, paidAt, logger } = opts || {};
    if (!agent || !agent.kya_id) throw new Error('agent.kya_id required');
    if (!Number.isFinite(amountSats) || amountSats <= 0) throw new Error('amountSats invalid');
    if (!paymentHash) throw new Error('paymentHash required for idempotency');
    const log = logger || console;

    // 1. Idempotency: existing row for this payment_hash → return it.
    {
        const r = await pool.query(
            `SELECT id, invoice_number, pdf_local_path, pdf_r2_uri, pdf_sha256, pdf_bytes,
                    paid_amount_eur, btc_rate_at_payment
             FROM invoices WHERE payment_hash = $1`,
            [paymentHash]);
        if (r.rowCount > 0) {
            return { ok: true, already_existed: true, ...r.rows[0] };
        }
    }

    // 2. FX
    const fx = await getBtcRateEur();
    const eur = satsToEur(amountSats, fx.rate);

    // 3. Filesystem path
    const c = cfg();
    const issuedDate = paidAt instanceof Date ? paidAt : new Date();
    const yyyy = String(issuedDate.getUTCFullYear());
    const mm = String(issuedDate.getUTCMonth() + 1).padStart(2, '0');
    const dirPath = path.join(c.localDir, yyyy, mm);
    _ensureDir(dirPath);
    const tsTag = issuedDate.toISOString().replace(/[^0-9TZ]/g, '').slice(0, 15);
    const baseName = `UMX-${tsTag}-${agent.kya_id}.pdf`;
    const filePath = path.join(dirPath, baseName);

    // 4. Invoice number (per-day sequence)
    const invoiceNumber = await nextInvoiceNumber(pool, issuedDate);

    // 5. PDF render
    const preimageSha = paymentPreimage && /^[0-9a-fA-F]{64}$/.test(paymentPreimage)
        ? crypto.createHash('sha256').update(Buffer.from(paymentPreimage, 'hex')).digest('hex')
        : null;

    const ctx = {
        invoiceNumber,
        kyaId: agent.kya_id,
        agentName: agent.agent_name || null,
        tier: agent.tier || 'BASIC',
        anchorTxid: agent.anchor_txid || null,
        amountSats,
        amountEur: eur,
        btcRateEur: fx.rate,
        paymentMethod,
        paymentHash,
        paymentPreimageSha: preimageSha,
        paidAt: paidAt instanceof Date ? paidAt : null,
        issuedDate,
        sellerVatId: c.sellerVatId,
    };
    await renderPdfToFile({ outPath: filePath, ctx });

    const pdfBuf = fs.readFileSync(filePath);
    const pdfSha = crypto.createHash('sha256').update(pdfBuf).digest('hex');
    const pdfBytes = pdfBuf.length;

    // 6. Optional R2 mirror
    let r2Uri = null;
    if (c.pushToR2) {
        const up = await uploadToR2(filePath, log);
        if (up && up.ok) r2Uri = up.uri;
    }

    // 7. DB row
    const ins = await pool.query(
        `INSERT INTO invoices
            (invoice_number, agent_id, kya_id, tier, issued_at, paid_at,
             paid_amount_sats, paid_amount_eur, btc_rate_at_payment,
             payment_method, payment_hash, payment_preimage_sha,
             pdf_local_path, pdf_r2_uri, pdf_sha256, pdf_bytes, meta)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (payment_hash) DO NOTHING
         RETURNING id, invoice_number, pdf_local_path, pdf_r2_uri, pdf_sha256, pdf_bytes,
                   paid_amount_eur, btc_rate_at_payment`,
        [
            invoiceNumber, agent.id || null, agent.kya_id, agent.tier || 'BASIC',
            issuedDate, paidAt || null,
            amountSats, eur, fx.rate,
            paymentMethod || 'unknown', paymentHash, preimageSha,
            filePath, r2Uri, pdfSha, pdfBytes,
            JSON.stringify({ fx_source: fx.source, anchor_txid: agent.anchor_txid || null }),
        ]
    );
    // ON CONFLICT race: re-fetch.
    if (ins.rowCount === 0) {
        const r2 = await pool.query(
            `SELECT id, invoice_number, pdf_local_path, pdf_r2_uri, pdf_sha256, pdf_bytes,
                    paid_amount_eur, btc_rate_at_payment FROM invoices WHERE payment_hash = $1`,
            [paymentHash]);
        return { ok: true, already_existed: true, ...r2.rows[0] };
    }
    return { ok: true, already_existed: false, ...ins.rows[0] };
}

/**
 * Re-render PDF from existing DB row (e.g. after template change). Bumps
 * regenerated_count.
 */
async function regenerate(pool, invoice_number, opts) {
    const r = await pool.query(
        `SELECT i.*, a.agent_name, a.tier AS agent_tier, a.anchor_txid
         FROM invoices i LEFT JOIN agents a ON a.id = i.agent_id
         WHERE i.invoice_number = $1`,
        [invoice_number]);
    if (r.rowCount === 0) return { error: 'INVOICE_NOT_FOUND' };
    const inv = r.rows[0];

    const c = cfg();
    const issuedDate = new Date(inv.issued_at);
    const yyyy = String(issuedDate.getUTCFullYear());
    const mm = String(issuedDate.getUTCMonth() + 1).padStart(2, '0');
    const dirPath = path.join(c.localDir, yyyy, mm);
    _ensureDir(dirPath);
    const filePath = inv.pdf_local_path || path.join(dirPath, `UMX-${issuedDate.toISOString().replace(/[^0-9TZ]/g, '').slice(0,15)}-${inv.kya_id}.pdf`);

    const ctx = {
        invoiceNumber: inv.invoice_number,
        kyaId: inv.kya_id,
        agentName: inv.agent_name || null,
        tier: inv.tier || inv.agent_tier || 'BASIC',
        anchorTxid: inv.anchor_txid || null,
        amountSats: parseInt(inv.paid_amount_sats, 10),
        amountEur: inv.paid_amount_eur ? parseFloat(inv.paid_amount_eur) : null,
        btcRateEur: inv.btc_rate_at_payment ? parseFloat(inv.btc_rate_at_payment) : null,
        paymentMethod: inv.payment_method,
        paymentHash: inv.payment_hash,
        paymentPreimageSha: inv.payment_preimage_sha,
        paidAt: inv.paid_at ? new Date(inv.paid_at) : null,
        issuedDate,
        sellerVatId: c.sellerVatId,
    };
    await renderPdfToFile({ outPath: filePath, ctx });
    const buf = fs.readFileSync(filePath);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const bytes = buf.length;
    let r2Uri = inv.pdf_r2_uri;
    if (c.pushToR2) {
        const up = await uploadToR2(filePath, opts && opts.logger);
        if (up && up.ok) r2Uri = up.uri;
    }
    await pool.query(
        `UPDATE invoices SET pdf_local_path=$2, pdf_sha256=$3, pdf_bytes=$4,
            pdf_r2_uri=$5, regenerated_count=regenerated_count+1
         WHERE invoice_number=$1`,
        [invoice_number, filePath, sha, bytes, r2Uri]
    );
    return { ok: true, invoice_number, pdf_local_path: filePath, pdf_sha256: sha, pdf_bytes: bytes, pdf_r2_uri: r2Uri };
}

async function listInvoices(pool, { limit = 50, offset = 0, kya_id } = {}) {
    const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    if (kya_id) {
        const r = await pool.query(
            `SELECT invoice_number, kya_id, tier, issued_at, paid_at, paid_amount_sats,
                    paid_amount_eur, payment_method, pdf_sha256, pdf_bytes, pdf_r2_uri,
                    regenerated_count
             FROM invoices WHERE kya_id = $1 ORDER BY issued_at DESC LIMIT $2 OFFSET $3`,
            [kya_id, lim, off]);
        const total = await pool.query(`SELECT COUNT(*)::int AS c FROM invoices WHERE kya_id = $1`, [kya_id]);
        return { items: r.rows, total: total.rows[0].c, limit: lim, offset: off };
    }
    const r = await pool.query(
        `SELECT invoice_number, kya_id, tier, issued_at, paid_at, paid_amount_sats,
                paid_amount_eur, payment_method, pdf_sha256, pdf_bytes, pdf_r2_uri,
                regenerated_count
         FROM invoices ORDER BY issued_at DESC LIMIT $1 OFFSET $2`,
        [lim, off]);
    const total = await pool.query(`SELECT COUNT(*)::int AS c FROM invoices`);
    return { items: r.rows, total: total.rows[0].c, limit: lim, offset: off };
}

async function getByNumber(pool, invoice_number) {
    const r = await pool.query(
        `SELECT i.*, a.agent_name, a.tier AS agent_tier
         FROM invoices i LEFT JOIN agents a ON a.id = i.agent_id
         WHERE i.invoice_number = $1`,
        [invoice_number]);
    return r.rowCount > 0 ? r.rows[0] : null;
}

async function streamPdfToResponse(pool, invoice_number, res) {
    const inv = await getByNumber(pool, invoice_number);
    if (!inv) {
        res.status(404).json({ error: 'INVOICE_NOT_FOUND' });
        return;
    }
    if (inv.pdf_local_path && fs.existsSync(inv.pdf_local_path)) {
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', `attachment; filename="${path.basename(inv.pdf_local_path)}"`);
        res.set('X-Invoice-SHA256', inv.pdf_sha256 || '');
        fs.createReadStream(inv.pdf_local_path).pipe(res);
        return;
    }
    // Fallback to R2 (download via aws CLI then stream)
    if (inv.pdf_r2_uri) {
        const tmpPath = `/tmp/invoice-${invoice_number}.pdf`;
        const { spawn } = require('child_process');
        const env = {
            ...process.env,
            AWS_ACCESS_KEY_ID: process.env.BACKUP_S3_ACCESS_KEY_ID,
            AWS_SECRET_ACCESS_KEY: process.env.BACKUP_S3_SECRET_ACCESS_KEY,
            AWS_DEFAULT_REGION: process.env.BACKUP_S3_REGION || 'auto',
        };
        const child = spawn('aws', [
            '--endpoint-url', process.env.BACKUP_S3_ENDPOINT,
            's3', 'cp', inv.pdf_r2_uri, tmpPath, '--only-show-errors',
        ], { env });
        const rc = await new Promise(r => child.on('close', r));
        if (rc === 0 && fs.existsSync(tmpPath)) {
            res.set('Content-Type', 'application/pdf');
            res.set('Content-Disposition', `attachment; filename="${path.basename(inv.pdf_local_path || tmpPath)}"`);
            res.set('X-Invoice-SHA256', inv.pdf_sha256 || '');
            const s = fs.createReadStream(tmpPath);
            s.on('end', () => fs.unlink(tmpPath, () => {}));
            s.pipe(res);
            return;
        }
        res.status(503).json({ error: 'R2_FETCH_FAILED' });
        return;
    }
    res.status(410).json({ error: 'PDF_GONE', message: 'No local or R2 copy found' });
}

module.exports = {
    cfg,
    issueForPayment,
    regenerate,
    listInvoices,
    getByNumber,
    streamPdfToResponse,
    getBtcRateEur,
    satsToEur,
    nextInvoiceNumber,
    renderPdfToFile, // exported for tests
    REQUIRED_HEADER_KEYS,
};

"use client";

import { useState } from "react";

type StepResult = { ok: boolean; label: string; detail: string };

const SANDBOX_VERIFIED = "UMBRA-TEST-0001";
const SANDBOX_FAIL = "UMBRA-TEST-0005";
const PROD_DEMO_ID = "UMBRA-000467";

export function IntegratorQuickstart({ hubBase }: { hubBase: string }) {
  const [results, setResults] = useState<StepResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    organization: "",
    contact_email: "",
    use_case: "",
    website: "",
  });
  const [formMsg, setFormMsg] = useState("");

  async function fetchJson(path: string, init?: RequestInit) {
    const r = await fetch(`${hubBase}${path}`, {
      ...init,
      headers: { Accept: "application/json", ...(init?.headers || {}) },
    });
    const text = await r.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: r.status, json };
  }

  async function runSteps() {
    setLoading(true);
    const out: StepResult[] = [];
    try {
      const profile = await fetchJson("/api/protocol/integrator-sandbox");
      out.push({
        ok: profile.status === 200,
        label: "1. Sandbox profile (docs)",
        detail: JSON.stringify(profile.json, null, 2),
      });

      const s1 = await fetchJson(`/api/v1/agents/${SANDBOX_VERIFIED}/status`);
      const j1 = s1.json as { verified?: boolean; error?: string };
      if (s1.status === 400 && j1.error === "SANDBOX_ID_IN_PRODUCTION") {
        const live = await fetchJson(`/api/v1/agents/${PROD_DEMO_ID}/status`);
        const lv = live.json as { verified?: boolean; agent_name?: string };
        out.push({
          ok: live.status === 200 && lv.verified === true,
          label: `2. Gate (production demo ${PROD_DEMO_ID})`,
          detail:
            "Sandbox IDs blocked on production (expected).\n" +
            JSON.stringify(lv, null, 2),
        });
      } else {
        out.push({
          ok: s1.status === 200 && j1.verified === true,
          label: "2. Gate (sandbox verified)",
          detail: JSON.stringify(j1, null, 2),
        });
      }

      const s2 = await fetchJson(`/api/v1/agents/${SANDBOX_FAIL}/status`);
      const j2 = s2.json as { verified?: boolean; error?: string };
      if (j2.error === "SANDBOX_ID_IN_PRODUCTION") {
        out.push({
          ok: true,
          label: "3. Sandbox revoked ID (skipped on prod)",
          detail:
            "UMBRA-TEST-0005 not callable on production — use local/staging hub for fixture tests.",
        });
      } else {
        out.push({
          ok: s2.status === 200 && j2.verified === false,
          label: "3. Gate (sandbox revoked)",
          detail: JSON.stringify(j2, null, 2),
        });
      }

      const proof = await fetchJson(
        `/api/v1/agents/${PROD_DEMO_ID}/status?include=cert_proof`,
      );
      const pj = proof.json as {
        verified?: boolean;
        cert_proof?: { cert_signature_valid?: boolean };
      };
      out.push({
        ok:
          proof.status === 200 &&
          pj.verified === true &&
          pj.cert_proof?.cert_signature_valid === true,
        label: "4. Strict gate (cert_proof)",
        detail: JSON.stringify(
          {
            verified: pj.verified,
            cert_signature_valid: pj.cert_proof?.cert_signature_valid,
          },
          null,
          2,
        ),
      });

      const econ = await fetchJson("/api/protocol/economics");
      out.push({
        ok: econ.status === 200,
        label: "5. Economics / Sybil disclosure",
        detail: JSON.stringify(econ.json, null, 2),
      });
    } catch (e) {
      out.push({
        ok: false,
        label: "Network error",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
    setResults(out);
    setLoading(false);
  }

  async function submitKeyRequest(e: React.FormEvent) {
    e.preventDefault();
    setFormMsg("");
    try {
      const r = await fetchJson("/api/v1/integrator/key-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const j = r.json as { ok?: boolean; request_id?: string; error?: string };
      if (r.status === 201 && j.ok) {
        setFormMsg(
          `Request submitted (${j.request_id}). Operator reviews via Telegram; API key is sent to your email after approval.`,
        );
        setForm({ organization: "", contact_email: "", use_case: "", website: "" });
      } else {
        setFormMsg(`Error: ${j.error || r.status}`);
      }
    } catch (err) {
      setFormMsg(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-10">
      <section className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-6">
        <h2 className="mb-2 text-lg font-semibold text-foreground">5-minute flow</h2>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
          <li>
            <code className="text-primary">GET /api/v1/agents/{"{kya_id}"}/status</code> — fast
            snapshot (~60s cache).
          </li>
          <li>
            High value: add <code className="text-primary">?include=cert_proof</code> or use{" "}
            <code>plugin-gate-strict.js</code>.
          </li>
          <li>
            On production, <code className="text-primary">UMBRA-TEST-*</code> returns 400 — tests
            below use <code className="text-primary">{PROD_DEMO_ID}</code> when needed.
          </li>
          <li>
            <code className="text-primary">umb_live_…</code> keys are optional (platform rate
            limits only).
          </li>
        </ol>
        <button
          type="button"
          onClick={runSteps}
          disabled={loading}
          className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
        >
          {loading ? "Running…" : "Run API tests"}
        </button>
        {results.length > 0 && (
          <div className="mt-4 space-y-3">
            {results.map((r) => (
              <div
                key={r.label}
                className={`rounded-lg border p-3 text-xs font-mono ${
                  r.ok ? "border-emerald-500/40" : "border-red-500/40"
                }`}
              >
                <div className="mb-1 font-sans font-semibold">
                  {r.ok ? "OK" : "FAIL"} — {r.label}
                </div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap">{r.detail}</pre>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card/50 p-6">
        <h2 className="mb-4 text-lg font-semibold">Request partner API key</h2>
        <form onSubmit={submitKeyRequest} className="grid gap-3 text-sm">
          <input
            required
            placeholder="Organization / project name"
            className="rounded-lg border border-border bg-background px-3 py-2"
            value={form.organization}
            onChange={(e) => setForm({ ...form, organization: e.target.value })}
          />
          <input
            required
            type="email"
            placeholder="Contact email"
            className="rounded-lg border border-border bg-background px-3 py-2"
            value={form.contact_email}
            onChange={(e) => setForm({ ...form, contact_email: e.target.value })}
          />
          <input
            placeholder="Website (optional)"
            className="rounded-lg border border-border bg-background px-3 py-2"
            value={form.website}
            onChange={(e) => setForm({ ...form, website: e.target.value })}
          />
          <textarea
            required
            minLength={20}
            rows={4}
            placeholder="Use case (min 20 chars)"
            className="rounded-lg border border-border bg-background px-3 py-2"
            value={form.use_case}
            onChange={(e) => setForm({ ...form, use_case: e.target.value })}
          />
          <button
            type="submit"
            className="rounded-lg border border-primary/50 bg-primary/10 px-4 py-2 font-semibold text-primary"
          >
            Submit request
          </button>
        </form>
        {formMsg && <p className="mt-3 text-sm text-muted-foreground">{formMsg}</p>}
      </section>
    </div>
  );
}

import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "UMBRAXON KYA Hub — Know Your Agent";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: 64,
          background: "linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%)",
          color: "#f8fafc",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div style={{ fontSize: 28, opacity: 0.85, marginBottom: 16 }}>UMBRAXON · Lightning M2M</div>
        <div style={{ fontSize: 56, fontWeight: 700, lineHeight: 1.1, maxWidth: 900 }}>
          Know Your Agent
        </div>
        <div style={{ fontSize: 28, marginTop: 24, opacity: 0.9, maxWidth: 800 }}>
          Verified identity for autonomous bots — Ed25519 + Lightning
        </div>
        <div style={{ fontSize: 22, marginTop: 40, color: "#38bdf8" }}>www.umbraxon.xyz</div>
      </div>
    ),
    { ...size },
  );
}

import { SITE_URL } from "@/lib/site";

const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "UMBRAXON KYA Hub",
  alternateName: "Know Your Agent Hub",
  url: SITE_URL,
  description:
    "Lightning-paid M2M identity registry for autonomous AI agents. Ed25519 certificates and integrator verify API.",
  publisher: {
    "@type": "Organization",
    name: "UMBRAXON",
    url: SITE_URL,
  },
};

export function JsonLd() {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
    />
  );
}

import { SITE_URL } from "@/lib/site";

const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "UMBRAXON KYA Hub",
  alternateName: "Know Your Agent Hub",
  url: SITE_URL,
  description:
    "Lightning-paid M2M identity registry for software agents and bots. Ed25519 certificates and integrator status API.",
  publisher: {
    "@type": "Organization",
    name: "UMBRAXON",
    url: "https://github.com/UMBRAXON",
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

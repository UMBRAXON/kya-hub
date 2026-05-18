import Link from "next/link";
import { Play } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import { PROMO_VIDEO_EMBED_URL, PROMO_VIDEO_WATCH_URL } from "@/lib/promo";

export function PromoVideo({ t }: { t: Dictionary["promoVideo"] }) {
  return (
    <section
      id="intro-video"
      className="relative scroll-mt-20 px-4 py-12 sm:py-16"
      aria-labelledby="promo-video-heading"
    >
      <div className="mx-auto max-w-4xl text-center">
        <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-primary">
          {t.eyebrow}
        </p>
        <h2
          id="promo-video-heading"
          className="text-2xl font-semibold tracking-tight sm:text-3xl"
        >
          {t.title}
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-sm text-muted-foreground sm:text-base">
          {t.subtitle}
        </p>
        <div className="neon-card mt-8 overflow-hidden rounded-xl border border-cyan-500/25 shadow-[0_0_32px_rgba(0,255,255,0.1)]">
          <div className="relative aspect-video w-full bg-black">
            <iframe
              title={t.iframeTitle}
              src={`${PROMO_VIDEO_EMBED_URL}?rel=0`}
              className="absolute inset-0 h-full w-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
        </div>
        <Link
          href={PROMO_VIDEO_WATCH_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex items-center gap-2 text-sm text-primary hover:underline"
        >
          <Play className="size-4" aria-hidden />
          {t.watchOnYoutube}
        </Link>
      </div>
    </section>
  );
}

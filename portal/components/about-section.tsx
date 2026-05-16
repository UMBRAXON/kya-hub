import type { ReactNode } from "react";
import Link from "next/link";
import {
  Anchor,
  Bitcoin,
  Check,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { TierInfo } from "@/lib/hub-api";
import type { Dictionary, Locale } from "@/lib/i18n";
import { formatSats } from "@/lib/i18n";
import { fill } from "@/lib/template";

const PILLAR_ICONS = [ShieldCheck, Zap, Anchor, Bitcoin] as const;

export interface AboutSectionProps {
  locale: Locale;
  t: Dictionary["about"];
  hubVersion?: string;
  hubPhase?: string;
  tiers?: { basic: TierInfo; elite: TierInfo };
}

function BenefitItem({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2.5 text-sm leading-relaxed text-muted-foreground">
      <Check
        className="mt-0.5 size-4 shrink-0 text-primary"
        aria-hidden
      />
      <span>{children}</span>
    </li>
  );
}

function BenefitLine({
  lead,
  rest,
  vars,
}: {
  lead: string;
  rest: string;
  vars?: Record<string, string | number>;
}) {
  const L = vars ? fill(lead, vars) : lead;
  const R = vars ? fill(rest, vars) : rest;
  return (
    <BenefitItem>
      <strong className="font-medium text-foreground">{L}</strong> {R}
    </BenefitItem>
  );
}

export function AboutSection({
  locale,
  t,
  hubVersion,
  hubPhase,
  tiers,
}: AboutSectionProps) {
  const basic = tiers?.basic;
  const elite = tiers?.elite;
  const basicPrice = basic
    ? formatSats(basic.total, locale)
    : formatSats(10_000, locale);
  const elitePrice = elite
    ? formatSats(elite.total, locale)
    : formatSats(80_000, locale);
  const basicRep = basic?.startingReputation ?? 500;
  const eliteRep = elite?.startingReputation ?? 900;
  const basicGrade = basic?.grade ?? "B";
  const eliteGrade = elite?.grade ?? "S";
  return (
    <section id="about" className="relative px-4 py-20">
      <div className="glow-divider mx-auto mb-16 max-w-4xl" />
      <div className="mx-auto max-w-6xl">
        <div className="mb-12 text-center">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            {t.title}
          </h2>
          {(hubVersion || hubPhase) && (
            <p className="mt-3">
              <Badge
                variant="outline"
                className="border-cyan-500/30 bg-cyan-500/10 font-mono text-xs text-primary"
              >
                {t.hubLabel} {hubVersion ?? "—"}
                {hubPhase ? ` · ${hubPhase}` : ""}
              </Badge>
            </p>
          )}
        </div>

        <p className="mx-auto max-w-3xl text-center text-base leading-relaxed text-muted-foreground sm:text-lg">
          <strong className="font-medium text-foreground">{t.introLead}</strong>{" "}
          {t.intro}
        </p>

        <div className="mt-14 grid gap-5 sm:grid-cols-2">
          {t.pillars.map((pillar, i) => {
            const Icon = PILLAR_ICONS[i];
            return (
              <Card key={pillar.title} className="neon-card border-0 ring-0">
                <CardHeader>
                  <Icon
                    className="size-8 text-primary drop-shadow-[0_0_8px_rgba(0,255,255,0.35)]"
                    aria-hidden
                  />
                  <CardTitle className="mt-3 text-lg">{pillar.title}</CardTitle>
                  <CardDescription className="text-sm leading-relaxed">
                    {pillar.description}
                  </CardDescription>
                </CardHeader>
                <CardContent />
              </Card>
            );
          })}
        </div>

        <div id="tiers" className="mt-16 scroll-mt-24">
          <div className="text-center">
            <h3 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {t.tiersTitle}
            </h3>
            <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              {t.tiersIntro}
            </p>
          </div>

          <div className="mt-10 grid gap-6 lg:grid-cols-2">
            <Card className="neon-card border border-cyan-500/10">
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-xl">{t.basic.name}</CardTitle>
                  <Badge
                    variant="outline"
                    className="border-cyan-500/30 bg-cyan-500/10 font-mono text-primary"
                  >
                    {t.basic.grade} {basicGrade}
                  </Badge>
                </div>
                <CardDescription className="text-base text-foreground">
                  <span className="font-mono text-lg font-semibold text-primary">
                    {basicPrice} sats
                  </span>
                  <span className="text-muted-foreground">
                    {" "}
                    {t.basic.priceSuffix}
                  </span>
                </CardDescription>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {t.basic.pitch}
                </p>
              </CardHeader>
              <CardContent>
                <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-primary">
                  {t.basic.whatYouGet}
                </p>
                <ul className="space-y-2.5">
                  {t.basic.benefits.map((b, i) => (
                    <BenefitLine
                      key={i}
                      lead={b.lead}
                      rest={b.rest}
                      vars={i === 2 ? { rep: basicRep } : undefined}
                    />
                  ))}
                </ul>
                <Link
                  href="#docs"
                  className="neon-btn-outline mt-6 inline-flex h-10 w-full items-center justify-center rounded-lg border px-6 text-sm font-medium sm:w-auto"
                >
                  {t.basic.cta}
                </Link>
                <p className="mt-4 text-xs text-muted-foreground">
                  {t.basic.renewNote}
                </p>
              </CardContent>
            </Card>

            <Card className="neon-card relative overflow-hidden border border-amber-500/25 shadow-[0_0_32px_rgba(251,191,36,0.08)]">
              <div
                className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber-400/60 to-transparent"
                aria-hidden
              />
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-xl">
                    <Sparkles
                      className="size-5 text-amber-400"
                      aria-hidden
                    />
                    {t.elite.name}
                  </CardTitle>
                  <Badge className="bg-amber-500/15 font-mono text-amber-200 hover:bg-amber-500/15">
                    {t.elite.grade} {eliteGrade} · {t.elite.recommended}
                  </Badge>
                </div>
                <CardDescription className="text-base text-foreground">
                  <span className="font-mono text-lg font-semibold text-amber-300">
                    {elitePrice} sats
                  </span>
                  <span className="text-muted-foreground">
                    {" "}
                    {t.elite.priceSuffix}
                  </span>
                </CardDescription>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {t.elite.pitch}
                </p>
              </CardHeader>
              <CardContent>
                <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-amber-300/90">
                  {t.elite.plusTitle}
                </p>
                <ul className="space-y-2.5">
                  {t.elite.benefits.map((b, i) => (
                    <BenefitLine
                      key={i}
                      lead={b.lead}
                      rest={b.rest}
                      vars={
                        i === 0
                          ? { rep: eliteRep, delta: eliteRep - basicRep }
                          : i === 5
                            ? { invites: 5 }
                            : undefined
                      }
                    />
                  ))}
                </ul>
                <Link
                  href="#docs"
                  className="neon-btn-cyan mt-6 inline-flex h-10 w-full items-center justify-center rounded-lg text-sm font-medium sm:w-auto sm:px-6"
                >
                  {t.elite.cta}
                </Link>
              </CardContent>
            </Card>
          </div>

          <p className="mx-auto mt-8 max-w-3xl text-center text-xs text-muted-foreground">
            {t.tiersFootnote}{" "}
            <a
              href="/docs/FAQ-FOR-BOT-DEVELOPERS.md"
              className="text-primary hover:underline"
            >
              {t.tiersFaq}
            </a>
            {" · "}
            <a
              href="/docs/FAQ-FOR-BOT-DEVELOPERS.md"
              className="text-primary hover:underline"
            >
              {t.tiersSponsorFaq}
            </a>
            .
          </p>
        </div>

        <div className="mt-14 rounded-xl border border-cyan-500/15 bg-card/40 p-6 sm:p-8">
          <h3 className="font-mono text-sm font-semibold tracking-wider text-primary">
            {t.integrateTitle}
          </h3>
          <ul className="mt-4 grid gap-3 text-sm text-muted-foreground sm:grid-cols-2">
            {t.integrateItems.map((item) => (
              <li key={item} className="flex gap-2">
                <span className="text-primary" aria-hidden>
                  →
                </span>
                {item}
              </li>
            ))}
          </ul>
          <p className="mt-6 border-t border-cyan-500/10 pt-6 text-sm text-muted-foreground">
            {t.integrateFoot}{" "}
            <a href="/README_API.md" className="text-primary hover:underline">
              {t.readme}
            </a>{" "}
            {t.or}{" "}
            <a href="/AGENTS.md" className="text-primary hover:underline">
              {t.agentsMd}
            </a>
            .
          </p>
        </div>
      </div>
    </section>
  );
}

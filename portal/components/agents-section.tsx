"use client";

import { useMemo, useState } from "react";
import { Search, RefreshCw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AgentCard } from "@/lib/data";
import type { Dictionary } from "@/lib/i18n";
import { cn } from "@/lib/utils";

function AgentAvatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <div
      className="flex size-14 shrink-0 items-center justify-center rounded-full border border-cyan-500/30 bg-gradient-to-br from-cyan-500/20 to-transparent text-sm font-semibold text-primary shadow-[0_0_16px_rgba(0,255,255,0.2)]"
      aria-hidden
    >
      {initials}
    </div>
  );
}

function AgentCardItem({
  agent,
  labels,
}: {
  agent: AgentCard;
  labels: { reputation: string; tier: string; verified: string; unverified: string };
}) {
  const verified = agent.status === "verified";
  return (
    <Card className="neon-card border-0 ring-0">
      <CardHeader className="flex flex-row items-start gap-4">
        <AgentAvatar name={agent.name} />
        <div className="min-w-0 flex-1 space-y-1">
          <CardTitle className="truncate text-base">{agent.name}</CardTitle>
          <CardDescription className="font-mono text-xs">{agent.id}</CardDescription>
          <Badge
            variant={verified ? "default" : "secondary"}
            className={cn(
              "mt-1",
              verified
                ? "border-cyan-500/40 bg-cyan-500/15 text-primary hover:bg-cyan-500/20"
                : "border-amber-500/30 bg-amber-500/10 text-amber-200"
            )}
          >
            {verified ? labels.verified : labels.unverified}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm text-muted-foreground">
        <div className="flex justify-between">
          <span>{labels.reputation}</span>
          <span className="font-mono text-foreground">{agent.reputation}</span>
        </div>
        <div className="flex justify-between">
          <span>{labels.tier}</span>
          <span className="font-mono text-primary">{agent.tier}</span>
        </div>
        <div className="flex flex-wrap gap-1 pt-1">
          {agent.capabilities.slice(0, 3).map((c) => (
            <span
              key={c}
              className="rounded-md border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            >
              {c}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export interface AgentsSectionProps {
  agents: AgentCard[];
  hubBaseUrl: string;
  fetchedAt?: string;
  error?: string | null;
  t: Dictionary["agents"];
}

export function AgentsSection({
  agents,
  hubBaseUrl,
  fetchedAt,
  error,
  t,
}: AgentsSectionProps) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q) ||
        a.capabilities.some((c) => c.toLowerCase().includes(q))
    );
  }, [agents, query]);

  return (
    <section id="agents" className="relative px-4 py-20">
      <div className="glow-divider mx-auto mb-16 max-w-4xl" />
      <div className="mx-auto max-w-6xl">
        <div className="mb-10 text-center">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            {t.title}
          </h2>
          <p className="mt-3 text-muted-foreground">
            {t.feedFrom}{" "}
            <a
              href={`${hubBaseUrl}/api/discovery/v1/agents.json`}
              className="text-primary hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              /api/discovery/v1/agents.json
            </a>
            {fetchedAt && (
              <span className="mt-2 block text-xs text-muted-foreground/80">
                <RefreshCw className="mr-1 inline size-3" aria-hidden />
                {t.updated}: {fetchedAt}
                {agents.length > 0 &&
                  ` · ${agents.length} ${t.agentsCount}`}
              </span>
            )}
          </p>
          {error && (
            <p className="mt-2 text-sm text-amber-300/90">
              {t.fetchError.replace("{error}", error)}
            </p>
          )}
        </div>
        <div className="relative mx-auto mb-10 max-w-xl">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder={t.searchPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-11 border-cyan-500/20 bg-card/60 pl-10 backdrop-blur-sm transition-shadow focus-visible:border-primary focus-visible:ring-primary/30 focus-visible:shadow-[0_0_20px_rgba(0,255,255,0.15)]"
          />
        </div>
        {agents.length === 0 && !error ? (
          <p className="py-12 text-center text-muted-foreground">
            {t.empty}
          </p>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((agent) => (
              <AgentCardItem
                key={agent.id}
                agent={agent}
                labels={{
                  reputation: t.reputation,
                  tier: t.tier,
                  verified: t.verified,
                  unverified: t.unverified,
                }}
              />
            ))}
          </div>
        )}
        {filtered.length === 0 && agents.length > 0 && (
          <p className="py-12 text-center text-muted-foreground">
            {t.noMatch}
          </p>
        )}
      </div>
    </section>
  );
}

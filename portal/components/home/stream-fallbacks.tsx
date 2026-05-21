export function HeroMetricsFallback() {
  return (
    <p
      className="mx-auto mt-6 h-5 max-w-md animate-pulse rounded bg-muted/40"
      aria-hidden
    />
  );
}

export function AboutSectionFallback() {
  return (
    <section
      id="about"
      className="section-pro-tight px-4"
      aria-busy="true"
      aria-label="Loading"
    >
      <div className="mx-auto max-w-6xl space-y-8">
        <div className="h-10 w-2/3 max-w-md animate-pulse rounded-lg bg-muted/40" />
        <div className="h-24 animate-pulse rounded-xl bg-muted/30" />
        <div className="grid gap-6 md:grid-cols-2">
          <div className="h-80 animate-pulse rounded-xl bg-muted/30" />
          <div className="h-80 animate-pulse rounded-xl bg-muted/30" />
        </div>
      </div>
    </section>
  );
}

export function AgentsSectionFallback() {
  return (
    <section
      id="agents"
      className="section-pro-tight px-4"
      aria-busy="true"
      aria-label="Loading"
    >
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="h-10 w-1/2 max-w-sm animate-pulse rounded-lg bg-muted/40" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-36 animate-pulse rounded-xl bg-muted/30" />
          ))}
        </div>
      </div>
    </section>
  );
}

import Link from "next/link";
import { FileText, KeyRound, BookOpen } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { DocCard } from "@/lib/data";
import type { Dictionary } from "@/lib/i18n";

function DocIcon({ type }: { type: DocCard["type"] }) {
  const className = "size-8 text-primary drop-shadow-[0_0_8px_rgba(0,255,255,0.4)]";
  if (type === "api") return <KeyRound className={className} aria-hidden />;
  if (type === "pdf") return <FileText className={className} aria-hidden />;
  return <BookOpen className={className} aria-hidden />;
}

export function DocumentsSection({
  documents,
  t,
}: {
  documents: DocCard[];
  t: Dictionary["docs"];
}) {
  return (
    <section id="docs" className="relative px-4 py-20">
      <div className="glow-divider mx-auto mb-16 max-w-4xl" />
      <div className="mx-auto max-w-6xl">
        <div className="mb-12 text-center">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            {t.title}
          </h2>
          <p className="mt-3 text-muted-foreground">{t.subtitle}</p>
        </div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {documents.map((doc) => (
            <Card
              key={doc.id}
              className={
                doc.id === "platform-integrator"
                  ? "neon-card flex flex-col border border-amber-400/35 ring-1 ring-amber-400/20"
                  : "neon-card flex flex-col border-0 ring-0"
              }
            >
              <CardHeader>
                <DocIcon type={doc.type} />
                <CardTitle className="mt-4 leading-snug">{doc.title}</CardTitle>
                <CardDescription>{doc.description}</CardDescription>
              </CardHeader>
              <CardContent className="flex-1" />
              <CardFooter className="border-t border-cyan-500/10 bg-transparent">
                <Link
                  href={doc.href}
                  target={doc.href.startsWith("http") ? "_blank" : undefined}
                  rel={
                    doc.href.startsWith("http") ? "noopener noreferrer" : undefined
                  }
                  className="neon-btn-outline flex h-8 w-full items-center justify-center rounded-lg border text-sm font-medium"
                >
                  {t.read}
                </Link>
              </CardFooter>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

import Link from "next/link";

export function BackLink({ label = "Atelier" }: { label?: string }) {
  return (
    <Link
      href="/"
      className="inline-flex items-center gap-2 text-sm text-ink/60 transition hover:text-ink"
    >
      <span aria-hidden className="font-display text-base">
        ←
      </span>
      <span className="font-medium">{label}</span>
    </Link>
  );
}

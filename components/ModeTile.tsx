import Link from "next/link";

type Props = {
  href: string;
  index: string;
  title: string;
  blurb: string;
  accent?: "crimson" | "gold" | "ink";
};

const accents = {
  crimson: "text-crimson",
  gold: "text-gold",
  ink: "text-ink",
};

export function ModeTile({
  href,
  index,
  title,
  blurb,
  accent = "crimson",
}: Props) {
  return (
    <Link
      href={href}
      className="group relative flex min-h-[112px] items-center gap-5 rounded-2xl border border-ink/10 bg-parchment-deep/40 px-5 py-5 shadow-leaf transition hover:bg-parchment-deep/70 active:scale-[0.99] no-callout"
    >
      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-ink/10 bg-parchment">
        <span className={`font-display text-2xl ${accents[accent]}`}>
          {index}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-display text-2xl leading-tight">{title}</div>
        <p className="mt-1 text-sm leading-snug text-ink/65">{blurb}</p>
      </div>
      <div
        className="font-display text-2xl text-ink/40 transition group-hover:translate-x-0.5 group-hover:text-crimson"
        aria-hidden
      >
        →
      </div>
    </Link>
  );
}

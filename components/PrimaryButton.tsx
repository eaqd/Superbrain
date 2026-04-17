import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

type Variant = "primary" | "ghost";

const base =
  "inline-flex items-center justify-center min-h-[56px] px-6 rounded-full font-display text-lg tracking-wide transition active:scale-[0.97] no-callout select-none";

const variants: Record<Variant, string> = {
  primary:
    "bg-crimson text-parchment shadow-leaf hover:bg-crimson-deep focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-crimson",
  ghost:
    "bg-transparent text-ink border border-ink/15 hover:bg-parchment-deep focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink/40",
};

type Props = {
  variant?: Variant;
  href?: string;
  children: ReactNode;
  className?: string;
} & Omit<ComponentProps<"button">, "className" | "children">;

export function PrimaryButton({
  variant = "primary",
  href,
  children,
  className = "",
  ...rest
}: Props) {
  const cls = `${base} ${variants[variant]} ${className}`.trim();
  if (href) {
    return (
      <Link href={href} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button className={cls} {...rest}>
      {children}
    </button>
  );
}

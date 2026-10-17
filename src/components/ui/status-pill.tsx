import { cva, type VariantProps } from "class-variance-authority";
import { CheckCircle2, AlertTriangle } from "lucide-react";

export const statusPillVariants = cva(
  "inline-flex items-center gap-1.5 border-2 font-bold",
  {
    variants: {
      ok: {
        true: "border-[#D1FAE5] bg-[#D1FAE5] text-[#047857]",
        false: "border-red-200 bg-red-50 text-red-600",
      },
    },
    defaultVariants: { ok: true },
  },
);

export interface StatusPillProps extends VariantProps<typeof statusPillVariants> {
  label: string;
}

/**
 * Shared status pill: reuses the existing Tailwind token palette
 * (`bg-[#D1FAE5]` / `bg-red-50` etc.) and keeps the dashboard and landing
 * pages DRY instead of defining a duplicated local `StatusPill` helper.
 */
export function StatusPill({ ok, label }: StatusPillProps) {
  return (
    <span className={statusPillVariants({ ok })}>
      {ok ? <CheckCircle2 className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
      {label}
    </span>
  );
}

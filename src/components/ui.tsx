import React, { useEffect, useState } from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { coverSrc } from "@/services/cover";
import { BookOpen } from "lucide-react";

export function cn(...classes: (string | undefined | null | false | Record<string, boolean>)[]): string {
  return twMerge(clsx(...classes));
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost" | "danger";
}

export function Button({ className, variant = "primary", disabled, children, ...props }: ButtonProps) {
  const base = "inline-flex items-center justify-center gap-2 rounded-xl font-medium text-sm transition-all active:scale-95 disabled:opacity-50 disabled:pointer-events-none";
  const variants: Record<string, string> = {
    primary: "bg-gradient-to-br from-pink-500 via-purple-600 to-pink-700 text-white shadow-lg shadow-purple-600/25 hover:from-pink-400 hover:via-purple-500 hover:to-purple-600",
    ghost: "bg-white/5 border border-white/10 text-white hover:bg-white/10",
    danger: "bg-white/5 border border-white/10 text-red-400 hover:bg-red-500/10",
  };
  return (
    <button className={cn(base, variants[variant], className)} disabled={disabled} {...props}>
      {children}
    </button>
  );
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn("w-full rounded-xl bg-white/[0.04] border border-white/10 px-4 py-3 text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-pink-500/50 focus:border-transparent", className)}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn("w-full rounded-xl bg-white/[0.04] border border-white/10 px-4 py-3 text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-pink-500/50 focus:border-transparent min-h-[120px]", className)}
      {...props}
    />
  );
}

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  padded?: boolean;
}
export function Card({ children, padded = true, className, ...props }: CardProps) {
  return (
    <div className={cn("card", padded ? "p-5" : "", className)} {...props}>
      {children}
    </div>
  );
}

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: "ok" | "warn" | "bad" | "muted";
}
export function Badge({ children, variant = "muted", className, ...props }: BadgeProps) {
  const variants: Record<string, string> = {
    ok: "bg-green-500/10 text-green-400 border border-green-500/20",
    warn: "bg-amber-500/10 text-amber-400 border border-amber-500/20",
    bad: "bg-red-500/10 text-red-400 border border-red-500/20",
    muted: "bg-white/5 text-white/50 border border-white/10",
  };
  return (
    <span className={cn("rounded-full px-2.5 py-0.5 text-[11px] font-medium border", variants[variant], className)} {...props}>
      {children}
    </span>
  );
}

export function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn("w-full bg-white/[0.06] rounded-full h-3 overflow-hidden", className)}>
      <div className={cn("h-full bg-gradient-to-r from-pink-500 to-purple-600 transition-all duration-300", value < 100 ? "animate-pulse" : false)} style={{ width: Math.max(0, Math.min(100, value)) + "%" }} />
    </div>
  );
}

export function SectionTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return <h2 className={cn("section-title", className)}>{children}</h2>;
}

export function Spinner() {
  return <div className="w-6 h-6 border-2 border-white/20 border-t-pink-500 rounded-full animate-spin" />;
}

/**
 * Zobrazí obálku knihy načtenou z Documents jako data: URI.
 *
 * Dřív se používalo `capacitor://${coverPath}`, což je neplatná URL (relativní
 * cesta se interpretovala jako hostname) – obálky se proto nezobrazovaly.
 * `coverSrc` soubor přečte a vrátí data: URI, které funguje vždy.
 */
export function Cover({
  coverPath,
  className,
  iconSize = 22,
}: {
  coverPath?: string | null;
  className?: string;
  iconSize?: number;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setSrc(null);
    if (!coverPath) return;
    coverSrc(coverPath).then((uri) => {
      if (alive) setSrc(uri);
    });
    return () => {
      alive = false;
    };
  }, [coverPath]);

  if (!src) {
    return (
      <div className={cn("bg-white/5 flex items-center justify-center text-white/20 rounded-xl", className)}>
        <BookOpen size={iconSize} />
      </div>
    );
  }
  return <img src={src} alt="" className={cn("object-cover rounded-xl bg-white/5", className)} />;
}

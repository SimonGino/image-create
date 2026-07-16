"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { UsageChip } from "@/components/usage-chip";
import type { ProviderId } from "@/providers/types";

interface ProviderStatus {
  providerId: ProviderId;
  hasKey: boolean;
}

const TABS = [
  { href: "/", label: "生成" },
  { href: "/compare", label: "对比" },
  { href: "/gallery", label: "图库" },
];

export function AppHeader({ providers }: { providers: ProviderStatus[] }) {
  const pathname = usePathname();

  return (
    <header className="mx-auto flex max-w-6xl items-center justify-between px-6 pt-8">
      <div className="flex items-center gap-6">
        <h1 className="text-xl font-semibold tracking-tight">image-create</h1>
        <nav className="flex gap-1">
          {TABS.map((t) => {
            const active = pathname === t.href;
            return (
              <Link
                key={t.href}
                href={t.href}
                className={
                  "rounded-md px-3 py-1 text-sm " +
                  (active
                    ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                    : "text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-200")
                }
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="flex items-center gap-3">
        {/* USAGE_CHIP_SLOT — the cumulative-usage chip mounts here */}
        <UsageChip />
        <div className="flex gap-2 text-xs">
          {providers.map((p) => (
            <span
              key={p.providerId}
              className="rounded-full border border-neutral-200 px-2.5 py-1 dark:border-neutral-800"
            >
              {p.providerId}
              <span className={p.hasKey ? "ml-1.5 text-green-600" : "ml-1.5 text-neutral-400"}>
                {p.hasKey ? "●" : "○"}
              </span>
            </span>
          ))}
        </div>
      </div>
    </header>
  );
}

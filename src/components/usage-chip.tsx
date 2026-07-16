"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** Mirrors GET /api/usage (SPEC §6). Kept local — the route is the contract. */
interface UsageBucket {
  costUsd: number;
  count: number;
}
interface UsageSummary {
  total: UsageBucket;
  byProvider: (UsageBucket & { providerId: string })[];
  byModel: (UsageBucket & { modelId: string })[];
  byMonth: (UsageBucket & { month: string })[];
}

const fmtUsd = (v: number): string => `$${v.toFixed(3)}`;

/**
 * Cumulative-usage chip for the top bar (SPEC §7). Shows `累计 $x.xxx`; on hover
 * or click reveals a popover breaking cost/count down by provider and model.
 * Client-only — fetches /api/usage on mount; never touches the DB directly.
 */
export function UsageChip() {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/usage")
      .then((r) => (r.ok ? (r.json() as Promise<UsageSummary>) : Promise.reject(new Error(String(r.status)))))
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch(() => {
        /* silent — the chip simply stays hidden if usage can't be read */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Dismiss a click-pinned popover when clicking elsewhere.
  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setPinned(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [pinned]);

  if (loading) {
    return (
      <span className="rounded-full border border-neutral-200 px-2.5 py-1 text-xs text-neutral-400 dark:border-neutral-800">
        累计 …
      </span>
    );
  }

  // Nothing recorded yet — keep the header clean.
  if (!data || data.total.count === 0) return null;

  const open = hovered || pinned;

  return (
    <div
      ref={rootRef}
      className="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={() => setPinned((p) => !p)}
        aria-expanded={open}
        className="rounded-full border border-neutral-200 px-2.5 py-1 text-xs tabular-nums text-neutral-600 transition-colors hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-800 dark:text-neutral-300 dark:hover:border-neutral-700 dark:hover:text-neutral-100"
      >
        累计 <span className="font-medium">{fmtUsd(data.total.costUsd)}</span>
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-2 w-56 rounded-xl border border-neutral-200 bg-white p-3 text-xs shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <span className="text-neutral-500">累计花费</span>
            <span className="font-medium tabular-nums">
              {fmtUsd(data.total.costUsd)} · {data.total.count} 次
            </span>
          </div>

          {data.byProvider.length > 0 && (
            <Section title="按提供商">
              {data.byProvider.map((p) => (
                <Row key={p.providerId} label={p.providerId} cost={p.costUsd} count={p.count} />
              ))}
            </Section>
          )}

          {data.byModel.length > 0 && (
            <Section title="按模型">
              {data.byModel.map((m) => (
                <Row key={m.modelId} label={m.modelId} cost={m.costUsd} count={m.count} />
              ))}
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-2 border-t border-neutral-100 pt-2 dark:border-neutral-800">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400">{title}</p>
      <ul className="space-y-0.5">{children}</ul>
    </div>
  );
}

function Row({ label, cost, count }: { label: string; cost: number; count: number }) {
  return (
    <li className="flex items-baseline justify-between gap-2">
      <span className="truncate text-neutral-600 dark:text-neutral-300">{label}</span>
      <span className="shrink-0 tabular-nums text-neutral-500">
        {fmtUsd(cost)} · {count}
      </span>
    </li>
  );
}

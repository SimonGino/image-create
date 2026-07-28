"use client";

import { useCallback, useEffect, useState } from "react";

import { listGenerations, type ListGenerationsQuery } from "@/lib/api/client";
import { partialFailureCode, type WireGenerationRow } from "@/lib/api/wire";
import { fmtDate, fmtDuration, fmtSize, fmtUsd, modeLabel } from "@/lib/format";
import type { GenerationStatus } from "@/db/schema";
import { PROVIDER_IDS, type Mode, type ProviderId } from "@/providers/types";

const PAGE_SIZE = 50;

const labelClass = "block text-xs font-medium text-neutral-500 mb-1";
const controlClass =
  "rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900";

const PROVIDERS: readonly ProviderId[] = PROVIDER_IDS;
const MODES: Mode[] = ["t2i", "reference"];
const STATUSES: GenerationStatus[] = ["success", "error", "pending"];

const STATUS_LABEL: Record<GenerationStatus, string> = {
  success: "成功",
  error: "失败",
  pending: "进行中",
};

/**
 * History (记录) — the ledger projection of Generation: a full-status table of
 * what was run, whether it worked and what it cost. The image-centric view of
 * the same entity is the Gallery.
 *
 * Unlike the Gallery this filters and pages server-side, so the table stays
 * honest about totals no matter how many Generations exist.
 */
export function History({ modelIds }: { modelIds: string[] }) {
  const [rows, setRows] = useState<WireGenerationRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [providerId, setProviderId] = useState<ProviderId | "">("");
  const [modelId, setModelId] = useState("");
  const [mode, setMode] = useState<Mode | "">("");
  const [status, setStatus] = useState<GenerationStatus | "">("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query: ListGenerationsQuery = {
      limit: PAGE_SIZE,
      offset,
      ...(providerId ? { providerId } : {}),
      ...(modelId ? { modelId } : {}),
      ...(mode ? { mode } : {}),
      ...(status ? { status } : {}),
    };
    try {
      const page = await listGenerations(query);
      setRows(page.generations);
      setTotal(page.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [offset, providerId, modelId, mode, status]);

  useEffect(() => {
    void load();
  }, [load]);

  // Any filter change starts over at the first page.
  function applyFilter(set: () => void) {
    set();
    setOffset(0);
  }

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + rows.length, total);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      {/* ---- Filter bar ---- */}
      <div className="mb-6 flex flex-wrap items-end gap-4">
        <div>
          <span className={labelClass}>Provider</span>
          <select
            className={controlClass}
            value={providerId}
            onChange={(e) => applyFilter(() => setProviderId(e.target.value as ProviderId | ""))}
          >
            <option value="">全部</option>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div>
          <span className={labelClass}>模型</span>
          <select
            className={controlClass}
            value={modelId}
            onChange={(e) => applyFilter(() => setModelId(e.target.value))}
          >
            <option value="">全部</option>
            {modelIds.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div>
          <span className={labelClass}>模式</span>
          <select
            className={controlClass}
            value={mode}
            onChange={(e) => applyFilter(() => setMode(e.target.value as Mode | ""))}
          >
            <option value="">全部</option>
            {MODES.map((m) => (
              <option key={m} value={m}>
                {modeLabel(m)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <span className={labelClass}>状态</span>
          <select
            className={controlClass}
            value={status}
            onChange={(e) => applyFilter(() => setStatus(e.target.value as GenerationStatus | ""))}
          >
            <option value="">全部</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="ml-auto text-xs text-neutral-400">
          {total === 0 ? "0 条" : `${from}–${to} / 共 ${total} 条`}
        </div>
      </div>

      {/* ---- Table / states ---- */}
      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
          加载失败 · {error}
        </div>
      ) : loading ? (
        <div className="flex min-h-[200px] items-center justify-center rounded-xl border border-neutral-200 text-sm text-neutral-500 dark:border-neutral-800">
          加载中…
        </div>
      ) : rows.length === 0 ? (
        <div className="flex min-h-[200px] items-center justify-center rounded-xl border border-dashed border-neutral-200 text-sm text-neutral-400 dark:border-neutral-800">
          没有符合条件的记录
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="border-b border-neutral-200 bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/60">
              <tr>
                <Th>时间</Th>
                <Th>模型</Th>
                <Th>模式</Th>
                <Th>提示词</Th>
                <Th>状态</Th>
                <Th align="right">耗时</Th>
                <Th align="right">费用</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <Row key={g.id} row={g} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- Pagination ---- */}
      {total > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
            disabled={offset === 0 || loading}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300"
          >
            上一页
          </button>
          <button
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
            disabled={offset + PAGE_SIZE >= total || loading}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300"
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <th className={`px-3 py-2 font-medium ${align === "right" ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}

function Row({ row }: { row: WireGenerationRow }) {
  const partial = partialFailureCode(row.errorCode);

  return (
    <tr className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50 dark:border-neutral-800/60 dark:hover:bg-neutral-900/40">
      <td className="whitespace-nowrap px-3 py-2 tabular-nums text-neutral-500">
        {fmtDate(row.createdAt)}
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        <span className="text-neutral-700 dark:text-neutral-200">{row.modelId}</span>
        <span className="ml-1.5 text-xs text-neutral-400">{fmtSize(row.sizeSpec)}</span>
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-neutral-500">{modeLabel(row.mode)}</td>
      <td className="max-w-[280px] truncate px-3 py-2 text-neutral-600 dark:text-neutral-300" title={row.prompt}>
        {row.prompt}
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        <StatusCell row={row} partial={partial} />
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-neutral-500">
        {fmtDuration(row.timingMs)}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
        <span className="text-neutral-700 dark:text-neutral-200">{fmtUsd(row.costUsd)}</span>
        {row.costSource === "estimated" && (
          <span className="ml-1 text-xs text-neutral-400">≈</span>
        )}
      </td>
    </tr>
  );
}

function StatusCell({ row, partial }: { row: WireGenerationRow; partial: string | undefined }) {
  if (partial) {
    return (
      <span className="text-amber-600 dark:text-amber-400" title={`部分失败: ${partial}`}>
        部分成功 {row.images.length}/{row.nRequested}
      </span>
    );
  }
  if (row.status === "success") {
    return (
      <span className="text-green-600 dark:text-green-500">
        成功
        {row.images.length > 1 && (
          <span className="ml-1 text-xs text-neutral-400">{row.images.length} 张</span>
        )}
      </span>
    );
  }
  if (row.status === "error") {
    return (
      <span className="text-red-600 dark:text-red-400" title={row.errorCode ?? undefined}>
        失败{row.errorCode ? ` · ${row.errorCode}` : ""}
      </span>
    );
  }
  return <span className="text-neutral-400">进行中</span>;
}

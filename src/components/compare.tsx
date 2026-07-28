"use client";

import { useMemo, useState } from "react";

import { generate, mediaUrl } from "@/lib/api/client";
import type { ProviderKeyStatus, WireGenerationDetail } from "@/lib/api/wire";
import { fmtDuration, fmtUsd } from "@/lib/format";
import { estimateCostUSD } from "@/providers/pricing";
import { defaultRequestFor } from "@/providers/request";
import type { ModelDescriptor, ProviderId } from "@/providers/types";

interface CompareProps {
  models: ModelDescriptor[];
  providers: ProviderKeyStatus[];
}

type Cell =
  | { status: "loading" }
  | { status: "done"; result: WireGenerationDetail }
  | { status: "error"; message: string };

/**
 * One prompt per model at that model's own defaults — the comparison is only
 * fair if every cell asks for what its model considers standard.
 */
const buildRequest = (model: ModelDescriptor, prompt: string) =>
  defaultRequestFor(model, { mode: "t2i", prompt, n: 1 });

const PREFERRED = ["gemini-3.1-flash-image-preview", "gemini-3-pro-image-preview"];

export function Compare({ models, providers }: CompareProps) {
  const hasKey = useMemo(() => {
    const map = new Map(providers.map((p) => [p.providerId, p.hasKey]));
    return (id: ProviderId) => map.get(id) ?? false;
  }, [providers]);

  const availableModels = useMemo(
    () => models.filter((m) => m.capabilities.modes.includes("t2i") && hasKey(m.providerId)),
    [models, hasKey],
  );

  const [prompt, setPrompt] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => {
    const preferred = availableModels.filter((m) => PREFERRED.includes(m.id)).map((m) => m.id);
    return new Set(preferred.length >= 2 ? preferred : availableModels.slice(0, 2).map((m) => m.id));
  });
  const [cells, setCells] = useState<Record<string, Cell>>({});
  const [running, setRunning] = useState(false);

  const chosen = availableModels.filter((m) => selected.has(m.id));

  const estimate = useMemo(() => {
    let total: number | undefined;
    for (const m of chosen) {
      const c = estimateCostUSD(m, buildRequest(m, prompt || "x"));
      if (c !== undefined) total = (total ?? 0) + c;
    }
    return total;
  }, [chosen, prompt]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function run() {
    if (!prompt.trim() || chosen.length === 0 || running) return;
    setRunning(true);
    setCells(Object.fromEntries(chosen.map((m) => [m.id, { status: "loading" } as Cell])));
    await Promise.all(
      chosen.map(async (m) => {
        try {
          const result = await generate(buildRequest(m, prompt));
          setCells((prev) => ({ ...prev, [m.id]: { status: "done", result } }));
        } catch (e) {
          setCells((prev) => ({
            ...prev,
            [m.id]: { status: "error", message: e instanceof Error ? e.message : "生成失败" },
          }));
        }
      }),
    );
    setRunning(false);
  }

  const controlClass =
    "w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900";

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-4">
        <span className="mb-1 block text-xs font-medium text-neutral-500">提示词</span>
        <textarea
          className={controlClass + " min-h-[72px] resize-y"}
          placeholder="一个提示词,在下面选中的模型上并排出图对比…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </div>

      <div className="mb-4">
        <span className="mb-1.5 block text-xs font-medium text-neutral-500">对比模型（≥1）</span>
        {availableModels.length === 0 ? (
          <p className="text-sm text-neutral-400">没有可用模型(检查 API key)</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {availableModels.map((m) => (
              <label
                key={m.id}
                className={
                  "flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-sm " +
                  (selected.has(m.id)
                    ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                    : "border-neutral-300 text-neutral-600 dark:border-neutral-700 dark:text-neutral-300")
                }
              >
                <input
                  type="checkbox"
                  className="hidden"
                  checked={selected.has(m.id)}
                  onChange={() => toggle(m.id)}
                />
                {m.label}
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="mb-6 flex items-center gap-4">
        <button
          onClick={run}
          disabled={running || !prompt.trim() || chosen.length === 0}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
        >
          {running ? "对比生成中…" : `对比生成（${chosen.length} 张）`}
        </button>
        <span className="text-sm text-neutral-500">
          预估合计 ≈ {fmtUsd(estimate)}
          {estimate === undefined && <span className="ml-1 text-xs text-neutral-400">(生成后按实际计)</span>}
        </span>
      </div>

      {chosen.length > 0 && Object.keys(cells).length > 0 && (
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: `repeat(${Math.min(chosen.length, 3)}, minmax(0, 1fr))` }}
        >
          {chosen.map((m) => {
            const cell = cells[m.id];
            return (
              <div
                key={m.id}
                className="space-y-2 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800"
              >
                <div className="text-sm font-medium">{m.label}</div>
                {!cell || cell.status === "loading" ? (
                  <div className="flex aspect-square items-center justify-center rounded-lg border border-neutral-200 text-sm text-neutral-400 dark:border-neutral-800">
                    <span className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-600" />
                  </div>
                ) : cell.status === "error" ? (
                  <div className="flex aspect-square items-center justify-center rounded-lg border border-red-200 bg-red-50 p-3 text-center text-xs text-red-600 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
                    {cell.message}
                  </div>
                ) : cell.result.images.length === 0 ? (
                  <div className="flex aspect-square items-center justify-center rounded-lg border border-neutral-200 text-xs text-neutral-400 dark:border-neutral-800">
                    无图
                  </div>
                ) : (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={mediaUrl(cell.result.images[0]!.filePath)}
                      alt={m.label}
                      className="w-full rounded-lg border border-neutral-200 dark:border-neutral-800"
                    />
                    <div className="text-xs text-neutral-500">
                      {fmtDuration(cell.result.timingMs)}
                      {" · 实际 "}
                      {fmtUsd(cell.result.costUsd)}
                      {" · "}
                      {cell.result.usage.imageOutputTokens ?? "—"} tok
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

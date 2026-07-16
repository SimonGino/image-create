"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useRouter } from "next/navigation";

import type { ProviderId, SizeSpec } from "@/providers/types";

// ---- API shapes (mirrors /api/generations + /api/generations/[id]) ----

interface GalleryImage {
  idx: number;
  filePath: string;
  thumbPath: string | null;
  width: number | null;
  height: number | null;
  mimeType: string;
}

interface GalleryItem {
  id: string;
  createdAt: string;
  providerId: ProviderId;
  modelId: string;
  mode: string;
  prompt: string;
  sizeSpec: SizeSpec;
  status: string;
  costUsd: number | null;
  costSource: string | null;
  timingMs: number | null;
  imageOutputTokens: number | null;
  images: GalleryImage[];
}

interface RefImage {
  idx: number;
  filePath: string;
  role: string;
}

interface GalleryDetail extends GalleryItem {
  quality: string | null;
  outputFormat: string | null;
  nRequested: number;
  providerParams: Record<string, unknown> | null;
  errorCode: string | null;
  textInputTokens: number | null;
  imageInputTokens: number | null;
  refImages: RefImage[];
}

// ---- helpers ----

/** stored path is "data/images/{id}/{file}"; the media route serves under images/. */
function mediaUrl(filePath: string): string {
  return "/api/images/" + filePath.replace(/^data\/images\//, "");
}

function fmtUsd(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `$${v.toFixed(3)}`;
}

function fmtSize(s: SizeSpec): string {
  return s.kind === "pixels" ? `${s.width}×${s.height}` : `${s.aspectRatio} · ${s.imageSize}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDuration(ms: number | null): string {
  return ms ? `${(ms / 1000).toFixed(1)}s` : "—";
}

function modeLabel(m: string): string {
  return m === "t2i" ? "文生图" : m === "reference" ? "参考图" : m;
}

async function downloadImage(filePath: string, filename: string): Promise<void> {
  const res = await fetch(mediaUrl(filePath));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Must match console.tsx: hands a gallery image to the console as a reference.
const PENDING_REF_KEY = "imageCreate:pendingRef";

const labelClass = "block text-xs font-medium text-neutral-500 mb-1";
const controlClass =
  "rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900";

const PROVIDER_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "openai", label: "openai" },
  { value: "google", label: "google" },
];

const MODE_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "t2i", label: "文生图" },
  { value: "reference", label: "参考图" },
];

export function Gallery() {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [provider, setProvider] = useState("all");
  const [model, setModel] = useState("all");
  const [mode, setMode] = useState("all");

  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GalleryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/generations?limit=200");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { generations: GalleryItem[] };
      setItems(json.generations ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Distinct model ids present, respecting the current provider filter.
  const modelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const g of items) {
      if (provider !== "all" && g.providerId !== provider) continue;
      set.add(g.modelId);
    }
    return Array.from(set).sort();
  }, [items, provider]);

  // Drop a stale model selection when the provider filter narrows the options.
  useEffect(() => {
    if (model !== "all" && !modelOptions.includes(model)) setModel("all");
  }, [modelOptions, model]);

  const filtered = useMemo(
    () =>
      items.filter(
        (g) =>
          (provider === "all" || g.providerId === provider) &&
          (model === "all" || g.modelId === model) &&
          (mode === "all" || g.mode === mode),
      ),
    [items, provider, model, mode],
  );

  const openDetail = useCallback(async (id: string) => {
    setDetailId(id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/generations/${id}`);
      if (res.ok) setDetail((await res.json()) as GalleryDetail);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const closeDetail = useCallback(() => {
    setDetailId(null);
    setDetail(null);
  }, []);

  // Close the detail overlay on Escape.
  useEffect(() => {
    if (!detailId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDetail();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailId, closeDetail]);

  const remove = useCallback(
    async (id: string) => {
      if (!window.confirm("确定删除这条生成记录?此操作不可撤销。")) return;
      setDeleting(true);
      try {
        await fetch(`/api/generations/${id}`, { method: "DELETE" });
        closeDetail();
        await load();
      } finally {
        setDeleting(false);
      }
    },
    [closeDetail, load],
  );

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      {/* ---- Filter bar ---- */}
      <div className="mb-6 flex flex-wrap items-end gap-4">
        <div>
          <span className={labelClass}>Provider</span>
          <select className={controlClass} value={provider} onChange={(e) => setProvider(e.target.value)}>
            {PROVIDER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <span className={labelClass}>模型</span>
          <select className={controlClass} value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="all">全部</option>
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div>
          <span className={labelClass}>模式</span>
          <select className={controlClass} value={mode} onChange={(e) => setMode(e.target.value)}>
            {MODE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="ml-auto text-xs text-neutral-400">{filtered.length} 条</div>
      </div>

      {/* ---- Grid / states ---- */}
      {loading ? (
        <div className="flex min-h-[300px] items-center justify-center rounded-xl border border-neutral-200 text-sm text-neutral-500 dark:border-neutral-800">
          加载中…
        </div>
      ) : error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
          加载失败 · {error}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex min-h-[300px] items-center justify-center rounded-xl border border-dashed border-neutral-200 text-sm text-neutral-400 dark:border-neutral-800">
          还没有生成记录
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {filtered.map((g) => {
            const cover = g.images[0];
            return (
              <button
                key={g.id}
                onClick={() => void openDetail(g.id)}
                title={g.prompt}
                className="group relative aspect-square overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900"
              >
                {cover ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={mediaUrl(cover.thumbPath ?? cover.filePath)}
                    alt={g.prompt}
                    className="h-full w-full object-cover transition group-hover:opacity-90"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center px-2 text-center text-xs text-neutral-400">
                    {g.status === "error" ? "生成失败" : g.status === "pending" ? "生成中…" : "无图"}
                  </div>
                )}
                {g.status !== "success" && (
                  <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
                    {g.status}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* ---- Detail overlay ---- */}
      {detailId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={closeDetail}
          role="presentation"
        >
          <div
            className="relative max-h-[90vh] w-full max-w-3xl overflow-auto rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={closeDetail}
              aria-label="关闭"
              className="absolute right-3 top-3 rounded-md px-2 py-1 text-sm text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
            >
              ✕
            </button>

            {detailLoading || !detail ? (
              <div className="flex min-h-[200px] items-center justify-center text-sm text-neutral-500">
                加载中…
              </div>
            ) : (
              <DetailView detail={detail} deleting={deleting} onDelete={() => void remove(detail.id)} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DetailView({
  detail,
  deleting,
  onDelete,
}: {
  detail: GalleryDetail;
  deleting: boolean;
  onDelete: () => void;
}) {
  const router = useRouter();
  const params = detail.providerParams;
  const hasParams = params && Object.keys(params).length > 0;

  function useAsRef(filePath: string) {
    sessionStorage.setItem(PENDING_REF_KEY, mediaUrl(filePath));
    router.push("/");
  }

  return (
    <div className="space-y-4 pr-6">
      {/* Images */}
      {detail.images.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {detail.images.map((img) => (
            <div key={img.idx} className="space-y-1.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={mediaUrl(img.filePath)}
                alt={`image ${img.idx}`}
                className="w-full rounded-lg border border-neutral-200 dark:border-neutral-800"
              />
              <div className="flex items-center justify-between text-xs text-neutral-400">
                <span>
                  {img.width ?? "?"}×{img.height ?? "?"}
                </span>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => useAsRef(img.filePath)}
                    className="rounded-md border border-neutral-300 px-2 py-1 font-medium text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  >
                    用作参考图
                  </button>
                  <button
                    onClick={() =>
                      void downloadImage(
                        img.filePath,
                        `${detail.id.slice(0, 8)}-${img.idx}.${(img.filePath.split(".").pop() ?? "png").toLowerCase()}`,
                      )
                    }
                    className="rounded-md border border-neutral-300 px-2 py-1 font-medium text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  >
                    下载
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex min-h-[120px] items-center justify-center rounded-lg border border-dashed border-neutral-200 text-sm text-neutral-400 dark:border-neutral-800">
          {detail.status === "error" ? `生成失败${detail.errorCode ? ` · ${detail.errorCode}` : ""}` : "无图"}
        </div>
      )}

      {/* Reference images */}
      {detail.refImages.length > 0 && (
        <div>
          <span className={labelClass}>参考图</span>
          <div className="flex flex-wrap gap-2">
            {detail.refImages.map((ref) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={ref.idx}
                src={mediaUrl(ref.filePath)}
                alt={`ref ${ref.idx}`}
                className="h-16 w-16 rounded-md border border-neutral-200 object-cover dark:border-neutral-800"
              />
            ))}
          </div>
        </div>
      )}

      {/* Parameters */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
        <Field label="模型">
          {detail.providerId} · {detail.modelId}
        </Field>
        <Field label="尺寸">{fmtSize(detail.sizeSpec)}</Field>
        <Field label="模式">{modeLabel(detail.mode)}</Field>
        <Field label="质量">{detail.quality ?? "—"}</Field>
        <Field label="格式">{detail.outputFormat ?? "—"}</Field>
        <Field label="状态">{detail.status}</Field>
        <Field label="耗时">{fmtDuration(detail.timingMs)}</Field>
        <Field label="时间">{fmtDate(detail.createdAt)}</Field>
      </dl>

      {/* Prompt */}
      <div>
        <span className={labelClass}>提示词</span>
        <p className="whitespace-pre-wrap rounded-lg border border-neutral-200 bg-neutral-50 p-2.5 text-sm text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-200">
          {detail.prompt}
        </p>
      </div>

      {/* Provider params */}
      {hasParams && (
        <div>
          <span className={labelClass}>Provider 参数</span>
          <pre className="overflow-auto rounded-lg border border-neutral-200 bg-neutral-50 p-2.5 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-300">
            {JSON.stringify(params, null, 2)}
          </pre>
        </div>
      )}

      {/* Usage + actual cost */}
      <div className="rounded-lg border border-neutral-200 p-3 text-xs text-neutral-500 dark:border-neutral-800">
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <span>
            文本输入 <b className="text-neutral-700 dark:text-neutral-300">{detail.textInputTokens ?? "—"}</b> tok
          </span>
          <span>
            图像输入 <b className="text-neutral-700 dark:text-neutral-300">{detail.imageInputTokens ?? "—"}</b> tok
          </span>
          <span>
            图像输出 <b className="text-neutral-700 dark:text-neutral-300">{detail.imageOutputTokens ?? "—"}</b> tok
          </span>
          <span>
            实际成本{" "}
            <b className="text-neutral-700 dark:text-neutral-300">{fmtUsd(detail.costUsd)}</b>
            {detail.costSource ? ` (${detail.costSource})` : ""}
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex justify-end border-t border-neutral-100 pt-3 dark:border-neutral-800">
        <button
          onClick={onDelete}
          disabled={deleting}
          className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-40 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/30"
        >
          {deleting ? "删除中…" : "删除"}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-neutral-400">{label}</dt>
      <dd className="mt-0.5 font-medium text-neutral-700 dark:text-neutral-200">{children}</dd>
    </div>
  );
}

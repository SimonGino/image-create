"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ApiError,
  blobToBase64,
  createTemplate,
  deleteGeneration,
  deleteTemplate,
  downloadImage,
  generate as postGenerate,
  listTemplates,
  mediaUrl,
  refImageFromUrl,
  updateTemplate,
} from "@/lib/api/client";
import {
  partialFailureCode,
  type ProviderKeyStatus,
  type WireGenerationDetail,
  type WireImage,
  type WirePromptTemplate,
} from "@/lib/api/wire";
import { fmtDuration, fmtUsd } from "@/lib/format";
import { takePendingRef } from "@/lib/pending-ref";
import { estimateCostUSD } from "@/providers/pricing";
import {
  clampRequest,
  defaultRequestFor,
  effectiveMaxN,
  parsePixelSize,
  pixelSizeKey,
  type ParamValue,
} from "@/providers/request";
import type {
  AspectRatio,
  GenerateRequest,
  ImageSizeTier,
  ModelDescriptor,
  Mode,
  OutputFormat,
  ParamSchema,
  Quality,
  RefImage,
} from "@/providers/types";

interface ConsoleProps {
  models: ModelDescriptor[];
  providers: ProviderKeyStatus[];
}

/** A reference-image input: an uploaded file, or a URL to an already-generated image. */
type RefInput =
  | { id: string; kind: "file"; file: File; previewUrl: string }
  | { id: string; kind: "url"; url: string };

/**
 * Stand-in for the impossible case of no registered model — the page hands us
 * the whole registry, and with no model every control is hidden anyway.
 */
const BLANK_DRAFT: GenerateRequest = {
  providerId: "openai",
  modelId: "",
  mode: "t2i",
  prompt: "",
  sizeSpec: { kind: "pixels", width: 1024, height: 1024 },
  n: 1,
};

function labelClass() {
  return "block text-xs font-medium text-neutral-500 mb-1";
}
function controlClass() {
  return "w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900";
}

export function Console({ models, providers }: ConsoleProps) {
  const hasKey = useMemo(() => {
    const map = new Map(providers.map((p) => [p.providerId, p.hasKey]));
    return (id: ModelDescriptor["providerId"]) => map.get(id) ?? false;
  }, [providers]);

  // The draft *is* the outgoing request (minus ref inputs, which are Files
  // until submit). No mirror state to keep in sync with the capability metadata
  // — @/providers/request answers "what does this model accept" (SPEC §7).
  const [draft, setDraft] = useState<GenerateRequest>(() => {
    const first = models.find((m) => m.capabilities.modes.includes("t2i") && hasKey(m.providerId)) ?? models[0];
    return first ? defaultRequestFor(first, { mode: "t2i" }) : BLANK_DRAFT;
  });

  const model = useMemo(() => models.find((m) => m.id === draft.modelId), [models, draft.modelId]);

  // Models usable in the current mode with a configured key.
  const availableModels = useMemo(
    () => models.filter((m) => m.capabilities.modes.includes(draft.mode) && hasKey(m.providerId)),
    [models, draft.mode, hasKey],
  );

  // Free-form pixel entry is UI state: a custom size that happens to equal a
  // preset shouldn't flip the control back on its own.
  const [useCustom, setUseCustom] = useState(false);
  const [refInputs, setRefInputs] = useState<RefInput[]>([]);

  /** Patch the draft. Fields the model can't take are fixed on the next switch. */
  const patch = (fields: Partial<GenerateRequest>) => setDraft((d) => ({ ...d, ...fields }));

  /** Patch and re-fit to the current model — for controls with a hard range (n). */
  const patchClamped = (fields: Partial<GenerateRequest>) =>
    setDraft((d) => (model ? clampRequest(model, { ...d, ...fields }) : { ...d, ...fields }));

  /**
   * Switch model, keeping every setting the new one still accepts. `base`
   * lets a caller fold in other field changes atomically — passing the
   * closure `draft` after a patch() would clobber that patch.
   */
  function selectModel(next: ModelDescriptor, base: GenerateRequest = draft) {
    const clamped = clampRequest(next, base);
    setDraft(clamped);
    setUseCustom(
      clamped.sizeSpec.kind === "pixels" &&
        Boolean(next.capabilities.pixelBounds) &&
        !next.capabilities.pixelSizes?.includes(
          pixelSizeKey(clamped.sizeSpec.width, clamped.sizeSpec.height),
        ),
    );
  }

  // Mode is derived, not chosen: a reference image in the tray means
  // reference mode, an empty tray means t2i (CONTEXT.md "Mode").
  useEffect(() => {
    const m: Mode = refInputs.length > 0 ? "reference" : "t2i";
    setDraft((d) => (d.mode === m ? d : { ...d, mode: m }));
  }, [refInputs.length]);

  // Keep the selection valid when mode or keys change.
  useEffect(() => {
    if (availableModels.some((m) => m.id === draft.modelId)) return;
    const next = availableModels[0];
    if (next) selectModel(next);
    else if (draft.modelId !== "") patch({ modelId: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableModels, draft.modelId]);

  const maxN = model ? effectiveMaxN(model) : 1;
  const pixels = draft.sizeSpec.kind === "pixels" ? draft.sizeSpec : undefined;
  const ratio = draft.sizeSpec.kind === "ratio" ? draft.sizeSpec : undefined;
  const params = (draft.providerParams ?? {}) as Record<string, ParamValue>;

  const estimate = useMemo(() => (model ? estimateCostUSD(model, draft) : undefined), [model, draft]);

  /** Provider-private param: an emptied field drops the key entirely. */
  function setParam(key: string, value: ParamValue) {
    const next: Record<string, unknown> = { ...draft.providerParams };
    if (value === "") delete next[key];
    else next[key] = value;
    patch({ providerParams: next });
  }

  /** Leaving free-form entry snaps an off-list size back to a preset. */
  function toggleCustom(on: boolean) {
    setUseCustom(on);
    if (on || !pixels) return;
    const caps = model?.capabilities;
    if (caps?.pixelSizes?.includes(pixelSizeKey(pixels.width, pixels.height))) return;
    const preset = parsePixelSize(caps?.pixelSizes?.[0]);
    if (preset) patch({ sizeSpec: preset });
  }

  // Submission
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<WireGenerationDetail | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Input chrome
  const [paramsOpen, setParamsOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  // Templates ("开始使用" cards + save-from-result)
  const [templates, setTemplates] = useState<WirePromptTemplate[]>([]);
  const refreshTemplates = useCallback(async () => {
    try {
      setTemplates(await listTemplates());
    } catch {
      // ignore — templates are non-critical
    }
  }, []);
  useEffect(() => {
    void refreshTemplates();
  }, [refreshTemplates]);

  useEffect(() => () => void (timerRef.current && clearInterval(timerRef.current)), []);

  // Reset the selected preview whenever a new batch arrives.
  useEffect(() => setSelectedIdx(0), [result]);

  // Pick up an image handed over from the gallery ("用作参考图") — adding it
  // flips the derived mode to reference on its own.
  useEffect(() => {
    const pending = takePendingRef();
    if (pending) addRefUrl(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canGenerate = Boolean(model && draft.prompt.trim() && !loading);

  async function generate() {
    if (!model || !canGenerate) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setElapsed(0);
    const started = Date.now();
    timerRef.current = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);

    try {
      const refImages: RefImage[] | undefined =
        draft.mode === "reference"
          ? await Promise.all(
              refInputs.map(async (r) => {
                if (r.kind === "file") {
                  return { data: await blobToBase64(r.file), mimeType: r.file.type || "image/png" };
                }
                return refImageFromUrl(r.url);
              }),
            )
          : undefined;

      setResult(await postGenerate(draft, refImages));
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e
          : new ApiError({ code: "error", message: e instanceof Error ? e.message : "生成失败" }, 0),
      );
    } finally {
      if (timerRef.current) clearInterval(timerRef.current);
      setLoading(false);
    }
  }

  async function downloadCurrent(img: WireImage) {
    const ext = img.mimeType.split("/")[1] ?? "png";
    await downloadImage(img.filePath, `${result?.id ?? "image"}-${img.idx}.${ext}`);
  }

  async function deleteCurrent() {
    if (!result || deleting) return;
    setDeleting(true);
    try {
      await deleteGeneration(result.id);
      setResult(null);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e
          : new ApiError({ code: "error", message: e instanceof Error ? e.message : "删除失败" }, 0),
      );
    } finally {
      setDeleting(false);
    }
  }

  // Fill the prompt (and default model, if usable in the current mode) from a template.
  function applyTemplate(t: WirePromptTemplate) {
    const target = availableModels.find((m) => m.id === t.defaultModelId);
    if (target) selectModel(target, { ...draft, prompt: t.body });
    else patch({ prompt: t.body });
    promptRef.current?.focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function addRefFiles(files: File[]) {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    setRefInputs((prev) => [
      ...prev,
      ...images.map((file) => ({
        id: crypto.randomUUID(),
        kind: "file" as const,
        file,
        previewUrl: URL.createObjectURL(file),
      })),
    ]);
  }

  function addRefUrl(url: string) {
    setRefInputs((prev) =>
      prev.some((r) => r.kind === "url" && r.url === url)
        ? prev
        : [...prev, { id: crypto.randomUUID(), kind: "url" as const, url }],
    );
  }

  function removeRef(id: string) {
    setRefInputs((prev) => {
      const target = prev.find((r) => r.id === id);
      if (target?.kind === "file") URL.revokeObjectURL(target.previewUrl);
      return prev.filter((r) => r.id !== id);
    });
  }

  // Feed a generated image back in as a reference — mode follows on its own.
  function useAsReference(img: WireImage) {
    addRefUrl(mediaUrl(img.filePath));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const caps = model?.capabilities;
  const currentImage = result?.images[selectedIdx] ?? result?.images[0];
  const partialFailure = partialFailureCode(result?.errorCode);

  // Pill summary: what the next generation will produce, and for roughly how much.
  const paramsSummary = [
    pixels ? `${pixels.width}×${pixels.height}` : ratio ? `${ratio.aspectRatio} ${ratio.imageSize}` : null,
    draft.n && draft.n > 1 ? `${draft.n}张` : null,
    estimate !== undefined ? `≈${fmtUsd(estimate)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mx-auto max-w-3xl px-6 pb-16 pt-10">
      {/* ---- Hero ---- */}
      <header className="mb-8 text-center">
        <h1 className="font-serif text-4xl font-bold tracking-tight text-neutral-900 sm:text-5xl dark:text-neutral-50">
          从文字，到图像
        </h1>
        <p className="mx-auto mt-3 max-w-md text-sm text-neutral-500 dark:text-neutral-400">
          描述你想要的画面，其余交给模型；拖入一张图即可改图。
        </p>
      </header>

      {/* ---- Input card ---- */}
      <div
        className={
          "relative rounded-3xl border bg-white p-4 shadow-sm transition-shadow dark:bg-neutral-900 " +
          (dragActive
            ? "border-neutral-900 ring-2 ring-neutral-900/20 dark:border-white dark:ring-white/20"
            : "border-neutral-200 dark:border-neutral-800")
        }
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragActive(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragActive(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          addRefFiles(Array.from(e.dataTransfer.files));
        }}
      >
        {/* Reference tray — its mere presence is what makes this a reference run */}
        {refInputs.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {refInputs.map((r) => (
              <div key={r.id} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={r.kind === "file" ? r.previewUrl : r.url}
                  alt="参考图"
                  className="h-14 w-14 rounded-lg border border-neutral-200 object-cover dark:border-neutral-700"
                />
                <button
                  type="button"
                  onClick={() => removeRef(r.id)}
                  aria-label="移除参考图"
                  className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-neutral-900 text-[10px] leading-none text-white dark:bg-white dark:text-neutral-900"
                >
                  ✕
                </button>
              </div>
            ))}
            {caps && refInputs.length > (caps.maxRefImages ?? 1) && (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                该模型最多 {caps.maxRefImages} 张参考图
              </span>
            )}
          </div>
        )}

        <textarea
          ref={promptRef}
          className="min-h-[72px] w-full resize-none bg-transparent px-1 pt-1 text-base outline-none placeholder:text-neutral-400"
          placeholder="描述你想要的图像…（可直接拖入参考图）"
          value={draft.prompt}
          onChange={(e) => patch({ prompt: e.target.value })}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void generate();
          }}
        />

        {/* Control row */}
        <div className="mt-2 flex items-center gap-2">
          {/* + reference images */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              addRefFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="添加参考图"
            aria-label="添加参考图"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-neutral-200 text-xl leading-none text-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            +
          </button>

          {/* Model pill */}
          <select
            aria-label="模型"
            className="h-9 max-w-[180px] appearance-none truncate rounded-full border border-neutral-200 bg-transparent px-3.5 text-sm text-neutral-700 outline-none hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
            value={draft.modelId}
            onChange={(e) => {
              const next = models.find((m) => m.id === e.target.value);
              if (next) selectModel(next);
            }}
          >
            {availableModels.length === 0 && <option value="">无可用模型</option>}
            {availableModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>

          {/* Params pill + popover */}
          <div className="relative min-w-0">
            <button
              type="button"
              onClick={() => setParamsOpen((v) => !v)}
              className="flex h-9 items-center gap-1 truncate rounded-full border border-neutral-200 px-3.5 text-sm text-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              <span className="truncate">{paramsSummary || "参数"}</span>
              <span className="text-neutral-400">▾</span>
            </button>
            {paramsOpen && caps && (
              <>
                <button
                  type="button"
                  aria-label="关闭参数面板"
                  className="fixed inset-0 z-20 cursor-default"
                  onClick={() => setParamsOpen(false)}
                />
                <div className="absolute left-0 top-full z-30 mt-2 w-[340px] max-w-[85vw] space-y-3 rounded-xl border border-neutral-200 bg-white p-4 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
                  <p className="text-xs text-neutral-400">
                    {caps.sizeSpecKind === "pixels" ? "像素尺寸" : "宽高比"} ·{" "}
                    {caps.supportsN ? `一次 ≤${caps.maxN} 张` : "单次 1 张(并发出 N)"} ·{" "}
                    参考图 ≤{caps.maxRefImages} · {caps.supportsMask ? "支持 mask" : "无 mask"}
                  </p>

                  {caps.sizeSpecKind === "pixels" ? (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="col-span-2">
                        <span className={labelClass()}>尺寸</span>
                        {caps.pixelBounds && (
                          <label className="mb-1.5 flex items-center gap-1.5 text-xs text-neutral-500">
                            <input type="checkbox" checked={useCustom} onChange={(e) => toggleCustom(e.target.checked)} />
                            自定义尺寸（{caps.pixelBounds.min}–{caps.pixelBounds.max}px）
                          </label>
                        )}
                        {useCustom && caps.pixelBounds ? (
                          <div className="flex items-center gap-2">
                            <input type="number" className={controlClass()} value={pixels?.width ?? 1024}
                              min={caps.pixelBounds.min} max={caps.pixelBounds.max}
                              onChange={(e) => patch({ sizeSpec: { kind: "pixels", width: Number(e.target.value), height: pixels?.height ?? 1024 } })} />
                            <span className="text-neutral-400">×</span>
                            <input type="number" className={controlClass()} value={pixels?.height ?? 1024}
                              min={caps.pixelBounds.min} max={caps.pixelBounds.max}
                              onChange={(e) => patch({ sizeSpec: { kind: "pixels", width: pixels?.width ?? 1024, height: Number(e.target.value) } })} />
                          </div>
                        ) : (
                          <select
                            className={controlClass()}
                            value={pixels ? pixelSizeKey(pixels.width, pixels.height) : ""}
                            onChange={(e) => {
                              const preset = parsePixelSize(e.target.value);
                              if (preset) patch({ sizeSpec: preset });
                            }}
                          >
                            {caps.pixelSizes?.map((s) => (
                              <option key={s} value={s}>{s}</option>
                            ))}
                          </select>
                        )}
                      </div>
                      {caps.qualities && (
                        <div>
                          <span className={labelClass()}>质量</span>
                          <select className={controlClass()} value={draft.quality ?? ""} onChange={(e) => patch({ quality: e.target.value as Quality })}>
                            {caps.qualities.map((q) => (
                              <option key={q} value={q}>{q}</option>
                            ))}
                          </select>
                        </div>
                      )}
                      <div>
                        <span className={labelClass()}>张数 n</span>
                        <input type="number" className={controlClass()} value={draft.n ?? 1} min={1} max={maxN}
                          onChange={(e) => patchClamped({ n: Number(e.target.value) })} />
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <span className={labelClass()}>宽高比</span>
                        <select
                          className={controlClass()}
                          value={ratio?.aspectRatio ?? ""}
                          onChange={(e) =>
                            ratio && patch({ sizeSpec: { ...ratio, aspectRatio: e.target.value as AspectRatio } })
                          }
                        >
                          {caps.aspectRatios?.map((a) => (
                            <option key={a} value={a}>{a}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <span className={labelClass()}>分辨率</span>
                        <select
                          className={controlClass()}
                          value={ratio?.imageSize ?? ""}
                          onChange={(e) =>
                            ratio && patch({ sizeSpec: { ...ratio, imageSize: e.target.value as ImageSizeTier } })
                          }
                        >
                          {caps.imageSizeTiers?.map((t) => (
                            <option key={t} value={t}>{t}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <span className={labelClass()}>张数 n</span>
                        <input type="number" className={controlClass()} value={draft.n ?? 1} min={1} max={maxN}
                          onChange={(e) => patchClamped({ n: Number(e.target.value) })} />
                      </div>
                    </div>
                  )}

                  {caps.outputFormats.length > 1 && (
                    <div>
                      <span className={labelClass()}>输出格式</span>
                      <select className={controlClass()} value={draft.outputFormat ?? ""} onChange={(e) => patch({ outputFormat: e.target.value as OutputFormat })}>
                        {caps.outputFormats.map((f) => (
                          <option key={f} value={f}>{f}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {caps.extraParams?.length ? (
                    <div className="space-y-3 border-t border-neutral-100 pt-3 dark:border-neutral-800">
                      {caps.extraParams.map((p) => (
                        <ExtraParamField
                          key={p.key}
                          schema={p}
                          value={params[p.key]}
                          onChange={(v) => setParam(p.key, v)}
                        />
                      ))}
                    </div>
                  ) : null}

                  <div className="flex items-baseline justify-between border-t border-neutral-100 pt-3 text-sm dark:border-neutral-800">
                    <span className="text-neutral-500">预估成本</span>
                    <span className="font-medium">
                      ≈ {fmtUsd(estimate)}
                      {estimate === undefined && <span className="ml-1 text-xs text-neutral-400">(生成后按实际计)</span>}
                    </span>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Submit */}
          <button
            type="button"
            onClick={() => void generate()}
            disabled={!canGenerate}
            title="生成 (⌘↵)"
            aria-label="生成"
            className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white transition-opacity disabled:opacity-30 dark:bg-white dark:text-neutral-900"
          >
            {loading ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white dark:border-neutral-900/40 dark:border-t-neutral-900" />
            ) : (
              "↑"
            )}
          </button>
        </div>
      </div>

      {/* ---- Loading / error / result, between the input and the cards ---- */}
      {loading && (
        <div className="mt-6 flex min-h-[200px] flex-col items-center justify-center gap-3 rounded-xl border border-neutral-200 text-sm text-neutral-500 dark:border-neutral-800">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-600 dark:border-neutral-700 dark:border-t-neutral-300" />
          生成中… {elapsed}s
        </div>
      )}
      {error && (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm dark:border-red-900/50 dark:bg-red-950/30">
          <p className="font-medium text-red-700 dark:text-red-400">生成失败 · {error.code}</p>
          <p className="mt-1 text-red-600 dark:text-red-300">{error.message}</p>
          {error.issues && (
            <ul className="mt-2 list-disc pl-5 text-red-600 dark:text-red-300">
              {error.issues.map((i, idx) => (
                <li key={idx}>{i.path ? `${i.path}: ` : ""}{i.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {result && currentImage && (
        <div className="mt-6 space-y-3">
          {/* Large preview of the selected image */}
          <div className="flex items-center justify-center rounded-xl border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-800 dark:bg-neutral-900/40">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={currentImage.idx}
              src={mediaUrl(currentImage.filePath)}
              alt={`result ${currentImage.idx}`}
              className="max-h-[68vh] w-auto max-w-full rounded-lg object-contain"
            />
          </div>

          {/* Batch thumbnail strip */}
          {result.images.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {result.images.map((img, i) => (
                <button
                  key={img.idx}
                  onClick={() => setSelectedIdx(i)}
                  aria-label={`选择第 ${i + 1} 张`}
                  className={
                    "overflow-hidden rounded-lg border-2 transition-colors " +
                    (i === selectedIdx
                      ? "border-neutral-900 dark:border-white"
                      : "border-transparent hover:border-neutral-300 dark:hover:border-neutral-600")
                  }
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={mediaUrl(img.filePath)}
                    alt={`缩略图 ${i + 1}`}
                    className="h-16 w-16 object-cover"
                  />
                </button>
              ))}
            </div>
          )}

          {/* Partial fan-out failure — billed siblings were kept (SPEC §3). */}
          {partialFailure && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
              请求了 {result.nRequested} 张,成功 {result.images.length} 张（{partialFailure}）。
              已出的图与费用已记录。
            </div>
          )}

          {/* Result meta */}
          <div className="rounded-lg border border-neutral-200 p-3 text-xs text-neutral-500 dark:border-neutral-800">
            <span className="font-medium text-neutral-700 dark:text-neutral-300">{result.modelId}</span>
            {" · "}
            {currentImage.width && currentImage.height ? `${currentImage.width}×${currentImage.height}` : "—"}
            {result.images.length > 1 && ` · 第 ${selectedIdx + 1}/${result.images.length} 张`}
            {" · "}
            {fmtDuration(result.timingMs)}
            {" · "}
            实际 {fmtUsd(result.costUsd)}
            {result.costSource ? ` (${result.costSource})` : ""}
            {" · "}
            out {result.usage.imageOutputTokens ?? "—"} tok
          </div>

          {/* Actions */}
          <ResultActions
            result={result}
            currentImage={currentImage}
            canGenerate={canGenerate}
            deleting={deleting}
            onDownload={() => void downloadCurrent(currentImage)}
            onUseAsRef={() => useAsReference(currentImage)}
            onRegenerate={() => void generate()}
            onDelete={() => void deleteCurrent()}
            onTemplateSaved={refreshTemplates}
          />
        </div>
      )}

      {/* ---- Template cards ---- */}
      <section className="mt-12">
        <h2 className="mb-4 text-sm font-medium text-neutral-500">开始使用</h2>
        {templates.length === 0 ? (
          <p className="rounded-xl border border-dashed border-neutral-200 p-6 text-center text-sm text-neutral-400 dark:border-neutral-800">
            还没有模板——生成一张满意的图后,在结果里点「存为模板」,它就会出现在这里。
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {templates.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                onApply={() => applyTemplate(t)}
                onToggleFavorite={async () => {
                  await updateTemplate(t.id, { favorite: !t.favorite });
                  await refreshTemplates();
                }}
                onDelete={async () => {
                  await deleteTemplate(t.id);
                  await refreshTemplates();
                }}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** Result action row, including save-as-template (title prompt + cover capture). */
function ResultActions({
  result,
  currentImage,
  canGenerate,
  deleting,
  onDownload,
  onUseAsRef,
  onRegenerate,
  onDelete,
  onTemplateSaved,
}: {
  result: WireGenerationDetail;
  currentImage: WireImage;
  canGenerate: boolean;
  deleting: boolean;
  onDownload: () => void;
  onUseAsRef: () => void;
  onRegenerate: () => void;
  onDelete: () => void;
  onTemplateSaved: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const secondary =
    "rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800";

  async function save() {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      // The template remembers the prompt that actually produced this image,
      // with the selected image as its card cover.
      await createTemplate({
        title: title.trim(),
        body: result.prompt,
        defaultProviderId: result.providerId,
        defaultModelId: result.modelId,
        coverImagePath: currentImage.filePath,
      });
      setTitle("");
      setSaving(false);
      setSaved(true);
      await onTemplateSaved();
    } catch {
      // ignore — templates are non-critical
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button onClick={onDownload} className={secondary}>
          下载
        </button>
        <button onClick={onUseAsRef} className={secondary}>
          用作参考图
        </button>
        <button
          onClick={() => {
            setSaving((v) => !v);
            setSaved(false);
          }}
          className={secondary}
        >
          {saved ? "已存为模板 ✓" : "存为模板"}
        </button>
        <button
          onClick={onRegenerate}
          disabled={!canGenerate}
          className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
        >
          重生
        </button>
        <button
          onClick={onDelete}
          disabled={deleting}
          className="rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-40 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-950/30"
        >
          {deleting ? "删除中…" : "删除"}
        </button>
      </div>
      {saving && (
        <div className="flex items-center gap-2">
          <input
            className={controlClass()}
            placeholder="模板标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
            autoFocus
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={!title.trim() || busy}
            className="whitespace-nowrap rounded-lg bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
          >
            保存
          </button>
        </div>
      )}
    </div>
  );
}

/** One "开始使用" card. A dangling cover (deleted generation) hides itself. */
function TemplateCard({
  template,
  onApply,
  onToggleFavorite,
  onDelete,
}: {
  template: WirePromptTemplate;
  onApply: () => void;
  onToggleFavorite: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [coverBroken, setCoverBroken] = useState(false);
  const cover = template.coverImagePath && !coverBroken ? mediaUrl(template.coverImagePath) : undefined;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onApply}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onApply();
        }
      }}
      className="group flex cursor-pointer items-stretch justify-between gap-3 rounded-xl border border-neutral-200 bg-white p-4 text-left transition-colors hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-600"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <h3 className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {template.title}
          </h3>
          <span className="text-neutral-300 transition-transform group-hover:translate-x-0.5">›</span>
        </div>
        <p className="mt-1 line-clamp-2 text-sm text-neutral-500" title={template.body}>
          {template.body}
        </p>
        <div className="mt-2 flex gap-2 text-xs">
          <button
            type="button"
            title="收藏"
            onClick={(e) => {
              e.stopPropagation();
              void onToggleFavorite();
            }}
            className={template.favorite ? "text-yellow-500" : "text-neutral-300 hover:text-neutral-400"}
          >
            {template.favorite ? "★" : "☆"}
          </button>
          <button
            type="button"
            title="删除模板"
            onClick={(e) => {
              e.stopPropagation();
              void onDelete();
            }}
            className="text-neutral-300 hover:text-red-500"
          >
            ✕
          </button>
        </div>
      </div>
      {cover && (
        <div className="flex shrink-0 items-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={cover}
            alt=""
            onError={() => setCoverBroken(true)}
            className="h-20 w-24 rounded-lg border border-neutral-100 object-cover dark:border-neutral-800"
          />
        </div>
      )}
    </div>
  );
}

function ExtraParamField({
  schema,
  value,
  onChange,
}: {
  schema: ParamSchema;
  value: string | number | boolean | undefined;
  onChange: (v: string | number | boolean) => void;
}) {
  if (schema.type === "enum") {
    return (
      <div>
        <span className={labelClass()}>{schema.label}</span>
        <select className={controlClass()} value={String(value ?? schema.default ?? "")} onChange={(e) => onChange(e.target.value)}>
          {schema.options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {schema.description && <p className="mt-1 text-xs text-neutral-400">{schema.description}</p>}
      </div>
    );
  }
  if (schema.type === "number") {
    return (
      <div>
        <span className={labelClass()}>{schema.label}</span>
        <input
          type="number"
          className={controlClass()}
          value={value === undefined ? "" : Number(value)}
          min={schema.min}
          max={schema.max}
          step={schema.step}
          placeholder={schema.description}
          onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
        />
        {schema.description && <p className="mt-1 text-xs text-neutral-400">{schema.description}</p>}
      </div>
    );
  }
  if (schema.type === "boolean") {
    return (
      <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        {schema.label}
      </label>
    );
  }
  return (
    <div>
      <span className={labelClass()}>{schema.label}</span>
      <input className={controlClass()} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

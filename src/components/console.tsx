"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  ApiError,
  blobToBase64,
  deleteGeneration,
  downloadImage,
  generate as postGenerate,
  mediaUrl,
  refImageFromUrl,
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
import { TemplateBar } from "@/components/template-bar";

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

  /** Switch model, keeping every setting the new one still accepts. */
  function selectModel(next: ModelDescriptor) {
    const clamped = clampRequest(next, draft);
    setDraft(clamped);
    setUseCustom(
      clamped.sizeSpec.kind === "pixels" &&
        Boolean(next.capabilities.pixelBounds) &&
        !next.capabilities.pixelSizes?.includes(
          pixelSizeKey(clamped.sizeSpec.width, clamped.sizeSpec.height),
        ),
    );
  }

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

  useEffect(() => () => void (timerRef.current && clearInterval(timerRef.current)), []);

  // Reset the selected preview whenever a new batch arrives.
  useEffect(() => setSelectedIdx(0), [result]);

  // Pick up an image handed over from the gallery ("用作参考图").
  useEffect(() => {
    const pending = takePendingRef();
    if (pending) {
      patch({ mode: "reference" });
      addRefUrl(pending);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canGenerate = Boolean(model && draft.prompt.trim() && !loading &&
    (draft.mode !== "reference" || refInputs.length > 0));

  async function generate() {
    if (!model) return;
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
    patch({ prompt: t.body });
    const target = availableModels.find((m) => m.id === t.defaultModelId);
    if (target) selectModel(target);
  }

  function addRefFiles(files: File[]) {
    if (files.length === 0) return;
    setRefInputs((prev) => [
      ...prev,
      ...files.map((file) => ({
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

  // Feed a generated image back in as a reference, and switch to reference mode.
  function useAsReference(img: WireImage) {
    addRefUrl(mediaUrl(img.filePath));
    patch({ mode: "reference" });
  }

  const caps = model?.capabilities;
  const currentImage = result?.images[selectedIdx] ?? result?.images[0];
  const partialFailure = partialFailureCode(result?.errorCode);

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-6 py-8 lg:grid-cols-[380px_1fr]">
      {/* ---- Left: control panel ---- */}
      <section className="space-y-4 rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900/40">
        {/* Mode */}
        <div>
          <span className={labelClass()}>Mode</span>
          <div className="inline-flex rounded-lg border border-neutral-200 p-0.5 dark:border-neutral-700">
            {(["t2i", "reference"] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => patch({ mode: m })}
                className={
                  "rounded-md px-3 py-1 text-sm " +
                  (draft.mode === m ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900" : "text-neutral-500")
                }
              >
                {m === "t2i" ? "文生图" : "参考图"}
              </button>
            ))}
          </div>
        </div>

        {/* Model */}
        <div>
          <span className={labelClass()}>Model</span>
          <select
            className={controlClass()}
            value={draft.modelId}
            onChange={(e) => {
              const next = models.find((m) => m.id === e.target.value);
              if (next) selectModel(next);
            }}
          >
            {availableModels.length === 0 && <option value="">该模式无可用模型</option>}
            {availableModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {caps && (
            <p className="mt-1.5 text-xs text-neutral-400">
              {caps.sizeSpecKind === "pixels" ? "像素尺寸" : "宽高比"} ·{" "}
              {caps.supportsN ? `一次 ≤${caps.maxN} 张` : `单次 1 张(并发出 N)`} ·{" "}
              参考图 ≤{caps.maxRefImages} · {caps.supportsMask ? "支持 mask" : "无 mask"}
            </p>
          )}
        </div>

        {/* Prompt templates / favorites */}
        <TemplateBar
          currentPrompt={draft.prompt}
          currentProviderId={model?.providerId}
          currentModelId={draft.modelId}
          onApply={applyTemplate}
        />

        {/* Prompt */}
        <div>
          <span className={labelClass()}>提示词</span>
          <textarea
            className={controlClass() + " min-h-[90px] resize-y"}
            placeholder="描述你想要的图像…"
            value={draft.prompt}
            onChange={(e) => patch({ prompt: e.target.value })}
          />
        </div>

        {/* Reference images */}
        {draft.mode === "reference" && (
          <div>
            <span className={labelClass()}>参考图（≤{caps?.maxRefImages ?? 1}）</span>
            {refInputs.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {refInputs.map((r) => (
                  <div key={r.id} className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={r.kind === "file" ? r.previewUrl : r.url}
                      alt="参考图"
                      className="h-14 w-14 rounded-md border border-neutral-200 object-cover dark:border-neutral-700"
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
              </div>
            )}
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => {
                addRefFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
              className="block w-full text-xs text-neutral-500 file:mr-3 file:rounded-md file:border-0 file:bg-neutral-100 file:px-3 file:py-1.5 file:text-sm dark:file:bg-neutral-800"
            />
            <p className="mt-1 text-xs text-neutral-400">上传,或用下方生成结果的「用作参考图」</p>
          </div>
        )}

        {/* Dynamic parameter panel (capabilities-driven) */}
        {caps?.sizeSpecKind === "pixels" ? (
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
        ) : caps?.sizeSpecKind === "ratio" ? (
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
        ) : null}

        {/* Output format */}
        {caps && caps.outputFormats.length > 1 && (
          <div>
            <span className={labelClass()}>输出格式</span>
            <select className={controlClass()} value={draft.outputFormat ?? ""} onChange={(e) => patch({ outputFormat: e.target.value as OutputFormat })}>
              {caps.outputFormats.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </div>
        )}

        {/* Provider-private params */}
        {caps?.extraParams?.length ? (
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

        {/* Cost estimate + generate */}
        <div className="border-t border-neutral-100 pt-3 dark:border-neutral-800">
          <div className="mb-2 flex items-baseline justify-between text-sm">
            <span className="text-neutral-500">预估成本</span>
            <span className="font-medium">
              ≈ {fmtUsd(estimate)}
              {estimate === undefined && <span className="ml-1 text-xs text-neutral-400">(生成后按实际计)</span>}
            </span>
          </div>
          <button
            onClick={generate}
            disabled={!canGenerate}
            className="w-full rounded-lg bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
          >
            {loading ? `生成中… ${elapsed}s` : "生成"}
          </button>
        </div>
      </section>

      {/* ---- Right: result preview ---- */}
      <section className="min-h-[300px]">
        {!result && !error && !loading && (
          <div className="flex h-full min-h-[300px] items-center justify-center rounded-xl border border-dashed border-neutral-200 text-sm text-neutral-400 dark:border-neutral-800">
            结果会显示在这里
          </div>
        )}
        {loading && (
          <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-3 rounded-xl border border-neutral-200 text-sm text-neutral-500 dark:border-neutral-800">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-600 dark:border-neutral-700 dark:border-t-neutral-300" />
            生成中… {elapsed}s
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm dark:border-red-900/50 dark:bg-red-950/30">
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
          <div className="space-y-3">
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
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => void downloadCurrent(currentImage)}
                className="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                下载
              </button>
              <button
                onClick={() => useAsReference(currentImage)}
                className="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                用作参考图
              </button>
              <button
                onClick={generate}
                disabled={!canGenerate}
                className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
              >
                重生
              </button>
              <button
                onClick={() => void deleteCurrent()}
                disabled={deleting}
                className="rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-40 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-950/30"
              >
                {deleting ? "删除中…" : "删除"}
              </button>
            </div>
          </div>
        )}
      </section>
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

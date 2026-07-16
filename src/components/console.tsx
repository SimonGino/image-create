"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { estimateCostUSD } from "@/providers/pricing";
import type {
  AspectRatio,
  GenerateRequest,
  ImageSizeTier,
  ModelDescriptor,
  Mode,
  OutputFormat,
  ParamSchema,
  ProviderId,
  Quality,
  SizeSpec,
} from "@/providers/types";
import { TemplateBar, type PromptTemplate } from "@/components/template-bar";

// Client-side ceiling for Gemini-style fan-out (mirrors MAX_FANOUT_N in the adapter).
const MAX_FANOUT_N = 8;

interface ProviderStatus {
  providerId: ProviderId;
  hasKey: boolean;
}

interface ConsoleProps {
  models: ModelDescriptor[];
  providers: ProviderStatus[];
}

interface GenImage {
  idx: number;
  filePath: string;
  width?: number;
  height?: number;
  mimeType: string;
}

interface GenResult {
  generationId: string;
  status: string;
  providerId: string;
  modelId: string;
  mode: string;
  images: GenImage[];
  usage: { textInputTokens?: number; imageInputTokens?: number; imageOutputTokens?: number };
  costUsd?: number;
  costSource?: string;
  timingMs?: number;
}

interface ApiError {
  code: string;
  message: string;
  issues?: { path?: string; code: string; message: string }[];
}

/** stored path is "data/images/{id}/{file}"; the media route serves under images/. */
function mediaUrl(filePath: string): string {
  return "/api/images/" + filePath.replace(/^data\/images\//, "");
}

function fmtUsd(v: number | undefined): string {
  return v === undefined ? "—" : `$${v.toFixed(3)}`;
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function labelClass() {
  return "block text-xs font-medium text-neutral-500 mb-1";
}
function controlClass() {
  return "w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900";
}

export function Console({ models, providers }: ConsoleProps) {
  const hasKey = useMemo(() => {
    const map = new Map(providers.map((p) => [p.providerId, p.hasKey]));
    return (id: ProviderId) => map.get(id) ?? false;
  }, [providers]);

  const [mode, setMode] = useState<Mode>("t2i");

  // Models usable in the current mode with a configured key.
  const availableModels = useMemo(
    () => models.filter((m) => m.capabilities.modes.includes(mode) && hasKey(m.providerId)),
    [models, mode, hasKey],
  );

  const [modelId, setModelId] = useState<string>(() => availableModels[0]?.id ?? models[0]?.id ?? "");
  const model = useMemo(() => models.find((m) => m.id === modelId), [models, modelId]);

  // Keep selection valid when mode/keys change.
  useEffect(() => {
    if (!availableModels.some((m) => m.id === modelId)) {
      setModelId(availableModels[0]?.id ?? "");
    }
  }, [availableModels, modelId]);

  const [prompt, setPrompt] = useState("");
  const [refFiles, setRefFiles] = useState<File[]>([]);

  // Size + params (reset when the model changes, in the effect below).
  const [pixelSize, setPixelSize] = useState("1024x1024");
  const [useCustom, setUseCustom] = useState(false);
  const [customW, setCustomW] = useState(1024);
  const [customH, setCustomH] = useState(1024);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("1:1");
  const [imageSize, setImageSize] = useState<ImageSizeTier>("1K");
  const [quality, setQuality] = useState<Quality>("high");
  const [n, setN] = useState(1);
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("png");
  const [providerParams, setProviderParams] = useState<Record<string, string | number | boolean>>({});

  // Reset controls to the selected model's defaults.
  useEffect(() => {
    if (!model) return;
    const caps = model.capabilities;
    setPixelSize(caps.pixelSizes?.[0] ?? "1024x1024");
    setUseCustom(false);
    setAspectRatio(caps.aspectRatios?.[0] ?? "1:1");
    setImageSize(caps.imageSizeTiers?.[0] ?? "1K");
    setQuality(caps.qualities?.includes("high") ? "high" : (caps.qualities?.[0] ?? "high"));
    setOutputFormat(caps.outputFormats[0] ?? "png");
    setN(1);
    const defaults: Record<string, string | number | boolean> = {};
    for (const p of caps.extraParams ?? []) {
      if (p.type === "enum" && p.default !== undefined) defaults[p.key] = p.default;
      if (p.type === "boolean" && p.default !== undefined) defaults[p.key] = p.default;
    }
    setProviderParams(defaults);
  }, [model]);

  const sizeSpec: SizeSpec | undefined = useMemo(() => {
    if (!model) return undefined;
    if (model.capabilities.sizeSpecKind === "pixels") {
      if (useCustom) return { kind: "pixels", width: customW, height: customH };
      const [w, h] = pixelSize.split("x").map(Number);
      return { kind: "pixels", width: w ?? 1024, height: h ?? 1024 };
    }
    return { kind: "ratio", aspectRatio, imageSize };
  }, [model, useCustom, customW, customH, pixelSize, aspectRatio, imageSize]);

  const maxN = model ? (model.capabilities.supportsN ? model.capabilities.maxN : MAX_FANOUT_N) : 1;

  const request: GenerateRequest | undefined = useMemo(() => {
    if (!model || !sizeSpec) return undefined;
    const caps = model.capabilities;
    const cleanedParams: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(providerParams)) {
      if (v !== "" && v !== undefined) cleanedParams[k] = v;
    }
    return {
      providerId: model.providerId,
      modelId: model.id,
      mode,
      prompt,
      sizeSpec,
      n,
      ...(caps.qualities ? { quality } : {}),
      outputFormat,
      ...(Object.keys(cleanedParams).length ? { providerParams: cleanedParams } : {}),
    };
  }, [model, sizeSpec, mode, prompt, n, quality, outputFormat, providerParams]);

  const estimate = useMemo(
    () => (model && request ? estimateCostUSD(model, request) : undefined),
    [model, request],
  );

  // Submission
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<GenResult | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => void (timerRef.current && clearInterval(timerRef.current)), []);

  // Reset the selected preview whenever a new batch arrives.
  useEffect(() => setSelectedIdx(0), [result]);

  const canGenerate = Boolean(model && request && prompt.trim() && !loading &&
    (mode !== "reference" || refFiles.length > 0));

  async function generate() {
    if (!model || !request) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setElapsed(0);
    const started = Date.now();
    timerRef.current = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);

    try {
      const refImages =
        mode === "reference"
          ? await Promise.all(
              refFiles.map(async (f) => ({ data: await fileToBase64(f), mimeType: f.type || "image/png" })),
            )
          : undefined;

      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...request, ...(refImages ? { refImages } : {}) }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? { code: "error", message: "Request failed" });
      } else {
        setResult(json as GenResult);
      }
    } catch (e) {
      setError({ code: "network", message: e instanceof Error ? e.message : "Network error" });
    } finally {
      if (timerRef.current) clearInterval(timerRef.current);
      setLoading(false);
    }
  }

  // Download the currently-previewed image to disk (client-side blob).
  async function downloadCurrent(img: GenImage) {
    const res = await fetch(mediaUrl(img.filePath));
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    try {
      const ext = img.mimeType.split("/")[1] ?? "png";
      const a = document.createElement("a");
      a.href = url;
      a.download = `${result?.generationId ?? "image"}-${img.idx}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Delete the whole generation record (endpoint owned by another teammate).
  async function deleteCurrent() {
    if (!result || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/generations/${result.generationId}`, { method: "DELETE" });
      if (res.ok) setResult(null);
    } finally {
      setDeleting(false);
    }
  }

  // Fill the prompt (and default model, if usable in the current mode) from a template.
  function applyTemplate(t: PromptTemplate) {
    setPrompt(t.body);
    if (t.defaultModelId && availableModels.some((m) => m.id === t.defaultModelId)) {
      setModelId(t.defaultModelId);
    }
  }

  const caps = model?.capabilities;
  const currentImage = result?.images[selectedIdx] ?? result?.images[0];

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
                onClick={() => setMode(m)}
                className={
                  "rounded-md px-3 py-1 text-sm " +
                  (mode === m ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900" : "text-neutral-500")
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
          <select className={controlClass()} value={modelId} onChange={(e) => setModelId(e.target.value)}>
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
          currentPrompt={prompt}
          currentProviderId={model?.providerId}
          currentModelId={modelId}
          onApply={applyTemplate}
        />

        {/* Prompt */}
        <div>
          <span className={labelClass()}>提示词</span>
          <textarea
            className={controlClass() + " min-h-[90px] resize-y"}
            placeholder="描述你想要的图像…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>

        {/* Reference images */}
        {mode === "reference" && (
          <div>
            <span className={labelClass()}>参考图（≤{caps?.maxRefImages ?? 1}）</span>
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => setRefFiles(Array.from(e.target.files ?? []))}
              className="block w-full text-xs text-neutral-500 file:mr-3 file:rounded-md file:border-0 file:bg-neutral-100 file:px-3 file:py-1.5 file:text-sm dark:file:bg-neutral-800"
            />
            {refFiles.length > 0 && (
              <p className="mt-1 text-xs text-neutral-400">已选 {refFiles.length} 张</p>
            )}
          </div>
        )}

        {/* Dynamic parameter panel (capabilities-driven) */}
        {caps?.sizeSpecKind === "pixels" ? (
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <span className={labelClass()}>尺寸</span>
              {caps.arbitraryPixelSize && (
                <label className="mb-1.5 flex items-center gap-1.5 text-xs text-neutral-500">
                  <input type="checkbox" checked={useCustom} onChange={(e) => setUseCustom(e.target.checked)} />
                  自定义尺寸
                </label>
              )}
              {useCustom ? (
                <div className="flex items-center gap-2">
                  <input type="number" className={controlClass()} value={customW} min={256} max={3840}
                    onChange={(e) => setCustomW(Number(e.target.value))} />
                  <span className="text-neutral-400">×</span>
                  <input type="number" className={controlClass()} value={customH} min={256} max={3840}
                    onChange={(e) => setCustomH(Number(e.target.value))} />
                </div>
              ) : (
                <select className={controlClass()} value={pixelSize} onChange={(e) => setPixelSize(e.target.value)}>
                  {caps.pixelSizes?.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              )}
            </div>
            {caps.qualities && (
              <div>
                <span className={labelClass()}>质量</span>
                <select className={controlClass()} value={quality} onChange={(e) => setQuality(e.target.value as Quality)}>
                  {caps.qualities.map((q) => (
                    <option key={q} value={q}>{q}</option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <span className={labelClass()}>张数 n</span>
              <input type="number" className={controlClass()} value={n} min={1} max={maxN}
                onChange={(e) => setN(Math.max(1, Math.min(maxN, Number(e.target.value))))} />
            </div>
          </div>
        ) : caps?.sizeSpecKind === "ratio" ? (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className={labelClass()}>宽高比</span>
              <select className={controlClass()} value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}>
                {caps.aspectRatios?.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
            <div>
              <span className={labelClass()}>分辨率</span>
              <select className={controlClass()} value={imageSize} onChange={(e) => setImageSize(e.target.value as ImageSizeTier)}>
                {caps.imageSizeTiers?.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div>
              <span className={labelClass()}>张数 n</span>
              <input type="number" className={controlClass()} value={n} min={1} max={maxN}
                onChange={(e) => setN(Math.max(1, Math.min(maxN, Number(e.target.value))))} />
            </div>
          </div>
        ) : null}

        {/* Output format */}
        {caps && caps.outputFormats.length > 1 && (
          <div>
            <span className={labelClass()}>输出格式</span>
            <select className={controlClass()} value={outputFormat} onChange={(e) => setOutputFormat(e.target.value as OutputFormat)}>
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
                value={providerParams[p.key]}
                onChange={(v) => setProviderParams((prev) => ({ ...prev, [p.key]: v }))}
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

            {/* Result meta */}
            <div className="rounded-lg border border-neutral-200 p-3 text-xs text-neutral-500 dark:border-neutral-800">
              <span className="font-medium text-neutral-700 dark:text-neutral-300">{result.modelId}</span>
              {" · "}
              {currentImage.width && currentImage.height ? `${currentImage.width}×${currentImage.height}` : "—"}
              {result.images.length > 1 && ` · 第 ${selectedIdx + 1}/${result.images.length} 张`}
              {" · "}
              {result.timingMs ? `${(result.timingMs / 1000).toFixed(1)}s` : "—"}
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

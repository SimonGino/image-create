/**
 * Display formatters shared by the views. One signature each — the wire
 * contract (@/lib/api/wire) guarantees absent values arrive as `undefined`, so
 * these don't need to also handle `null`.
 */

import type { Mode, SizeSpec } from "@/providers/types";

export function fmtUsd(v: number | undefined): string {
  return v === undefined ? "—" : `$${v.toFixed(3)}`;
}

export function fmtSize(s: SizeSpec): string {
  return s.kind === "pixels" ? `${s.width}×${s.height}` : `${s.aspectRatio} · ${s.imageSize}`;
}

export function fmtDuration(ms: number | undefined): string {
  return ms ? `${(ms / 1000).toFixed(1)}s` : "—";
}

export function fmtDate(iso: string): string {
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

export function modeLabel(m: Mode | string): string {
  return m === "t2i" ? "文生图" : m === "reference" ? "参考图" : m;
}

"use client";

import { useCallback, useEffect, useState } from "react";

import type { ProviderId } from "@/providers/types";

export interface PromptTemplate {
  id: string;
  title: string;
  body: string;
  favorite: boolean;
  variables?: string[] | null;
  defaultProviderId?: ProviderId | null;
  defaultModelId?: string | null;
  createdAt?: string | number;
}

interface Props {
  currentPrompt: string;
  currentProviderId?: ProviderId;
  currentModelId?: string;
  onApply: (t: PromptTemplate) => void;
}

const control =
  "w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900";

/** Save / apply / favorite prompt templates (SPEC §7). Local CRUD, no generation. */
export function TemplateBar({ currentPrompt, currentProviderId, currentModelId, onApply }: Props) {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/prompt-templates");
      const json = await res.json();
      setTemplates(json.templates ?? []);
    } catch {
      // ignore — templates are non-critical
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save() {
    if (!currentPrompt.trim() || !title.trim() || busy) return;
    setBusy(true);
    try {
      await fetch("/api/prompt-templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          body: currentPrompt,
          defaultProviderId: currentProviderId,
          defaultModelId: currentModelId,
        }),
      });
      setTitle("");
      setSaving(false);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function toggleFav(t: PromptTemplate) {
    await fetch(`/api/prompt-templates/${t.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ favorite: !t.favorite }),
    });
    await refresh();
  }

  async function remove(t: PromptTemplate) {
    await fetch(`/api/prompt-templates/${t.id}`, { method: "DELETE" });
    await refresh();
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className={control + " flex items-center justify-between text-left"}
          >
            <span className="text-neutral-500">模板{templates.length ? ` (${templates.length})` : ""}</span>
            <span className="text-neutral-400">▾</span>
          </button>
          {open && (
            <div className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
              {templates.length === 0 && (
                <p className="px-2 py-2 text-xs text-neutral-400">还没有模板</p>
              )}
              {templates.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  <button
                    type="button"
                    onClick={() => toggleFav(t)}
                    title="收藏"
                    className={
                      "px-1 text-sm " +
                      (t.favorite ? "text-yellow-500" : "text-neutral-300 hover:text-neutral-400")
                    }
                  >
                    {t.favorite ? "★" : "☆"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onApply(t);
                      setOpen(false);
                    }}
                    className="flex-1 truncate py-1 text-left text-sm"
                    title={t.body}
                  >
                    {t.title}
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(t)}
                    title="删除"
                    className="px-1 text-xs text-neutral-300 hover:text-red-500"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setSaving((v) => !v)}
          disabled={!currentPrompt.trim()}
          className="whitespace-nowrap rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm text-neutral-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300"
        >
          存为模板
        </button>
      </div>

      {saving && (
        <div className="mt-2 flex items-center gap-2">
          <input
            className={control}
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
            className="whitespace-nowrap rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
          >
            保存
          </button>
        </div>
      )}
    </div>
  );
}

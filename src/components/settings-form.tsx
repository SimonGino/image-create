"use client";

import { useCallback, useEffect, useState } from "react";

interface ProviderStatus {
  providerId: "openai" | "google";
  hasKey: boolean;
  keyMasked: string | null;
  baseUrl: string;
  keyInFile: boolean;
}

const LABELS: Record<string, string> = { openai: "OpenAI", google: "Google Gemini" };
const control =
  "w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900";

export function SettingsForm() {
  const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
  const [keyInput, setKeyInput] = useState<Record<string, string>>({});
  const [baseInput, setBaseInput] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/settings");
    const json = await res.json();
    const list: ProviderStatus[] = json.providers ?? [];
    setStatuses(list);
    setBaseInput(Object.fromEntries(list.map((p) => [p.providerId, p.baseUrl])));
    setKeyInput({});
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      const body: Record<string, { apiKey?: string; baseUrl: string }> = {};
      for (const p of statuses) {
        const key = keyInput[p.providerId]?.trim();
        body[p.providerId] = { baseUrl: baseInput[p.providerId] ?? "", ...(key ? { apiKey: key } : {}) };
      }
      await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      await load();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  async function clearKey(id: string) {
    await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [id]: { apiKey: null } }),
    });
    await load();
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h2 className="text-lg font-semibold">设置</h2>
      <p className="mb-6 mt-1 text-sm text-neutral-500">
        密钥写入 <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">~/.image-create/config.json</code>
        （0600，覆盖 .env）。API Key 留空表示不修改。
      </p>

      <div className="space-y-6">
        {statuses.map((p) => (
          <div key={p.providerId} className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
            <div className="mb-3 flex items-center justify-between">
              <span className="font-medium">{LABELS[p.providerId] ?? p.providerId}</span>
              <span className={p.hasKey ? "text-xs text-green-600" : "text-xs text-neutral-400"}>
                {p.hasKey ? `已配置 ${p.keyMasked ?? ""}` : "未配置"}
                {p.hasKey && !p.keyInFile ? "（来自 .env）" : ""}
              </span>
            </div>

            <label className="mb-1 block text-xs font-medium text-neutral-500">API Key</label>
            <div className="flex gap-2">
              <input
                type="password"
                className={control}
                autoComplete="off"
                placeholder={p.hasKey ? "已配置（留空则不改）" : "输入 API Key 或中转 key"}
                value={keyInput[p.providerId] ?? ""}
                onChange={(e) => setKeyInput((prev) => ({ ...prev, [p.providerId]: e.target.value }))}
              />
              {p.keyInFile && (
                <button
                  type="button"
                  onClick={() => void clearKey(p.providerId)}
                  className="whitespace-nowrap rounded-md border border-neutral-300 px-2.5 text-sm text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                >
                  清除
                </button>
              )}
            </div>

            <label className="mb-1 mt-3 block text-xs font-medium text-neutral-500">
              Base URL（代理 / 中转，可留空走官方）
            </label>
            <input
              type="text"
              className={control}
              autoComplete="off"
              placeholder={p.providerId === "openai" ? "https://your-proxy/v1" : "https://your-proxy"}
              value={baseInput[p.providerId] ?? ""}
              onChange={(e) => setBaseInput((prev) => ({ ...prev, [p.providerId]: e.target.value }))}
            />
          </div>
        ))}
      </div>

      <div className="mt-6 flex items-center gap-4">
        <button
          onClick={() => void save()}
          disabled={saving}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
        >
          {saving ? "保存中…" : "保存"}
        </button>
        {saved && <span className="text-sm text-green-600">已保存</span>}
      </div>
    </div>
  );
}

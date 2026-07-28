import { AppHeader } from "@/components/app-header";
import { History } from "@/components/history";
import { distinctModelIds } from "@/lib/generation-store";
import { providerKeyStatuses } from "@/lib/provider-status";

export const dynamic = "force-dynamic";

export default function HistoryPage() {
  return (
    <main>
      <AppHeader providers={providerKeyStatuses()} />
      {/* Model options come from the whole table, so paging can't shrink them. */}
      <History modelIds={distinctModelIds()} />
    </main>
  );
}

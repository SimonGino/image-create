import { AppHeader } from "@/components/app-header";
import { Compare } from "@/components/compare";
import { providerKeyStatuses } from "@/lib/provider-status";
import { listAllModels } from "@/providers/registry";

export const dynamic = "force-dynamic";

export default function ComparePage() {
  const providers = providerKeyStatuses();

  return (
    <main>
      <AppHeader providers={providers} />
      <Compare models={listAllModels()} providers={providers} />
    </main>
  );
}

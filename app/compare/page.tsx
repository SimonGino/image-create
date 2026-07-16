import { AppHeader } from "@/components/app-header";
import { Compare } from "@/components/compare";
import { hasCredentials } from "@/lib/credentials";
import { listAdapters, listAllModels } from "@/providers/registry";

export const dynamic = "force-dynamic";

export default function ComparePage() {
  const providers = listAdapters().map((a) => ({
    providerId: a.providerId,
    hasKey: hasCredentials(a.providerId),
  }));
  const models = listAllModels();

  return (
    <main>
      <AppHeader providers={providers} />
      <Compare models={models} providers={providers} />
    </main>
  );
}

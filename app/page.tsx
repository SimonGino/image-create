import { AppHeader } from "@/components/app-header";
import { Console } from "@/components/console";
import { providerKeyStatuses } from "@/lib/provider-status";
import { listAllModels } from "@/providers/registry";

// Reads env / config.json (key status) at request time.
export const dynamic = "force-dynamic";

export default function Home() {
  const providers = providerKeyStatuses();

  return (
    <main>
      <AppHeader providers={providers} />
      <Console models={listAllModels()} providers={providers} />
    </main>
  );
}

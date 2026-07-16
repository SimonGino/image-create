import { AppHeader } from "@/components/app-header";
import { Console } from "@/components/console";
import { hasCredentials } from "@/lib/credentials";
import { listAdapters, listAllModels } from "@/providers/registry";

// Reads env / config.json (key status) at request time.
export const dynamic = "force-dynamic";

export default function Home() {
  const providers = listAdapters().map((a) => ({
    providerId: a.providerId,
    hasKey: hasCredentials(a.providerId),
  }));
  const models = listAllModels();

  return (
    <main>
      <AppHeader providers={providers} />
      <Console models={models} providers={providers} />
    </main>
  );
}

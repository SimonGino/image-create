import { AppHeader } from "@/components/app-header";
import { SettingsForm } from "@/components/settings-form";
import { hasCredentials } from "@/lib/credentials";
import { listAdapters } from "@/providers/registry";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const providers = listAdapters().map((a) => ({
    providerId: a.providerId,
    hasKey: hasCredentials(a.providerId),
  }));

  return (
    <main>
      <AppHeader providers={providers} />
      <SettingsForm />
    </main>
  );
}

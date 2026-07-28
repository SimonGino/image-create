import { AppHeader } from "@/components/app-header";
import { SettingsForm } from "@/components/settings-form";
import { providerKeyStatuses } from "@/lib/provider-status";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <main>
      <AppHeader providers={providerKeyStatuses()} />
      <SettingsForm />
    </main>
  );
}

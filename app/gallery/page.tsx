import { AppHeader } from "@/components/app-header";
import { Gallery } from "@/components/gallery";
import { hasCredentials } from "@/lib/credentials";
import { listAdapters } from "@/providers/registry";

// Reads env / config.json (key status) at request time.
export const dynamic = "force-dynamic";

export default function GalleryPage() {
  const providers = listAdapters().map((a) => ({
    providerId: a.providerId,
    hasKey: hasCredentials(a.providerId),
  }));

  return (
    <main>
      <AppHeader providers={providers} />
      <Gallery />
    </main>
  );
}

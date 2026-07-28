import { AppHeader } from "@/components/app-header";
import { Gallery } from "@/components/gallery";
import { providerKeyStatuses } from "@/lib/provider-status";

// Reads env / config.json (key status) at request time.
export const dynamic = "force-dynamic";

export default function GalleryPage() {
  return (
    <main>
      <AppHeader providers={providerKeyStatuses()} />
      <Gallery />
    </main>
  );
}

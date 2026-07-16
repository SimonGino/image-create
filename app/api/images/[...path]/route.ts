import fs from "node:fs/promises";
import path from "node:path";

import { IMAGES_DIR } from "@/lib/paths";

export const runtime = "nodejs";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/** Serve generated images / thumbnails from DATA_DIR/images with traversal guard. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path: segments } = await params;
  const resolved = path.resolve(IMAGES_DIR, segments.join("/"));

  // Must stay inside IMAGES_DIR.
  if (resolved !== IMAGES_DIR && !resolved.startsWith(IMAGES_DIR + path.sep)) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const data = new Uint8Array(await fs.readFile(resolved));
    const ext = path.extname(resolved).toLowerCase();
    return new Response(data, {
      headers: {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "cache-control": "private, max-age=3600",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

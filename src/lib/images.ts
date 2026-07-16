/**
 * Image persistence (SPEC §4). Base64 from the provider → filesystem:
 *   data/images/{generationId}/{idx}.{ext}          (original)
 *   data/images/{generationId}/{idx}.thumb.webp     (256–512px thumbnail)
 *   data/images/{generationId}/refs/{idx}.{ext}     (reference inputs)
 * Returns paths RELATIVE to the project root — that's what the DB stores.
 */

import fs from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { ensureDir, generationImageDir, relFromRoot } from "@/lib/paths";

const THUMB_MAX = 512; // longest side; webp (SPEC §4)

function extForMime(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/png":
      return "png";
    default:
      return "png";
  }
}

export interface SavedImage {
  filePath: string;
  thumbPath?: string;
  width?: number;
  height?: number;
}

export async function saveGeneratedImage(
  generationId: string,
  idx: number,
  base64: string,
  mimeType: string,
): Promise<SavedImage> {
  const dir = generationImageDir(generationId);
  ensureDir(dir);

  const buffer = Buffer.from(base64, "base64");
  const ext = extForMime(mimeType);
  const absMain = path.join(dir, `${idx}.${ext}`);
  await fs.writeFile(absMain, buffer);

  const result: SavedImage = { filePath: relFromRoot(absMain) };

  try {
    const meta = await sharp(buffer).metadata();
    result.width = meta.width;
    result.height = meta.height;

    const absThumb = path.join(dir, `${idx}.thumb.webp`);
    await sharp(buffer)
      .resize({ width: THUMB_MAX, height: THUMB_MAX, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(absThumb);
    result.thumbPath = relFromRoot(absThumb);
  } catch {
    // Non-fatal: keep the original even if thumbnailing fails.
  }

  return result;
}

export async function saveRefImage(
  generationId: string,
  idx: number,
  base64: string,
  mimeType: string,
): Promise<string> {
  const dir = path.join(generationImageDir(generationId), "refs");
  ensureDir(dir);

  const buffer = Buffer.from(base64, "base64");
  const ext = extForMime(mimeType);
  const abs = path.join(dir, `${idx}.${ext}`);
  await fs.writeFile(abs, buffer);
  return relFromRoot(abs);
}

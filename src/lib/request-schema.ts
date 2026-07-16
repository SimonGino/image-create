/**
 * Structural validation for the untrusted API boundary (zod). Capability-level
 * checks (size membership, n limits, ...) happen later in the adapter's
 * validate(); this just guarantees the shape before we touch the DB.
 */

import { z } from "zod";

import type { GenerateRequest } from "@/providers/types";

const aspectRatio = z.enum([
  "1:1",
  "3:2",
  "2:3",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
]);
const imageSizeTier = z.enum(["0.5K", "1K", "2K", "4K"]);

const sizeSpec = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("pixels"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("ratio"),
    aspectRatio,
    imageSize: imageSizeTier,
  }),
]);

const refImage = z.object({
  data: z.string().min(1),
  mimeType: z.string().min(1),
  role: z.enum(["image", "mask"]).optional(),
});

export const generateRequestSchema = z.object({
  providerId: z.enum(["openai", "google"]),
  modelId: z.string().min(1),
  mode: z.enum(["t2i", "reference"]),
  prompt: z.string(),
  refImages: z.array(refImage).optional(),
  sizeSpec,
  n: z.number().int().optional(),
  quality: z.enum(["low", "medium", "high", "auto"]).optional(),
  outputFormat: z.enum(["png", "jpeg", "webp"]).optional(),
  providerParams: z.record(z.string(), z.unknown()).optional(),
});

export function parseGenerateRequest(body: unknown): GenerateRequest {
  return generateRequestSchema.parse(body);
}

import { open } from "node:fs/promises";

import { desktopImageAttachmentPaths } from "@codexhost/shared-contracts";

import type { PiImageContent } from "./pi-rpc-session.js";

/** Same cap as remote Desktop attachments; larger files stay path text. */
const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024;
/**
 * All images of one Turn travel in a single RPC line, which Pi reads within the prompt timeout;
 * images that would exceed this total stay path text.
 */
const MAX_TURN_IMAGE_BYTES = 32 * 1024 * 1024;
/** Enough for every recognized signature. */
const HEADER_BYTES = 12;

/** The image formats Pi passes through without conversion, identified by file signature. */
function imageMimeType(data: Buffer): PiImageContent["mimeType"] | null {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  const head = data.subarray(0, 12).toString("latin1");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8) === "WEBP") return "image/webp";
  return null;
}

async function imageContent(
  file: string,
  maxBytes: number,
): Promise<{ image: PiImageContent; bytes: number } | null> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    return null;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maxBytes) return null;
    const header = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, HEADER_BYTES, 0);
    const mimeType = imageMimeType(header.subarray(0, bytesRead));
    if (!mimeType) return null;
    const data = await handle.readFile();
    // The file can grow after stat.
    if (data.length > maxBytes) return null;
    return {
      image: { type: "image", data: data.toString("base64"), mimeType },
      bytes: data.length,
    };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Desktop names attached images only as paths in its attachment context; Pi takes images as a
 * separate RPC field next to the unchanged prompt text. Each distinct attached PNG, JPEG, GIF or
 * WebP up to 20 MiB becomes one image in attachment order while the Turn's images stay within
 * 32 MiB; Pi resizes them for the model. Any other file (unreadable, larger, past the Turn total,
 * or another format) stays only a path in the text, which Pi can still read with its tools.
 */
export async function piPromptImages(text: string): Promise<PiImageContent[]> {
  const images: PiImageContent[] = [];
  let remaining = MAX_TURN_IMAGE_BYTES;
  for (const file of new Set(desktopImageAttachmentPaths(text))) {
    const read = await imageContent(file, Math.min(MAX_IMAGE_FILE_BYTES, remaining));
    if (!read) continue;
    images.push(read.image);
    remaining -= read.bytes;
  }
  return images;
}

import { chmod, mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { piPromptImages } from "../src/pi-turn-input.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const WEBP = Buffer.from("RIFF\x18\x00\x00\x00WEBPVP8 ", "latin1");

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function files(entries: Record<string, Buffer>): Promise<Record<string, string>> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-turn-input-"));
  directories.push(directory);
  const paths: Record<string, string> = {};
  for (const [name, data] of Object.entries(entries)) {
    paths[name] = path.join(directory, name);
    await writeFile(paths[name], data);
  }
  return paths;
}

function desktopPrompt(images: string[], request: string): string {
  const context = images
    .map((file) => `## ${path.basename(file)}: ${file}\nImage attachment: true\n`)
    .join("\n");
  return `# Files mentioned by the user:\n\n${context}\n## My request:\n${request}`;
}

function image(mimeType: string, data: Buffer) {
  return { type: "image", data: data.toString("base64"), mimeType };
}

describe("Pi prompt images", () => {
  it("sends no images for a prompt without Desktop image attachments", async () => {
    const { "shot.png": shot = "" } = await files({ "shot.png": PNG });
    await expect(piPromptImages(`Compare with ${shot}\nImage attachment: true`)).resolves.toEqual(
      [],
    );
  });

  it("reads each distinct attached image in order, by file header rather than extension", async () => {
    const paths = await files({ "a.png": PNG, "b.jpg": JPEG, "c.gif": GIF, "d.png": WEBP });
    const a = paths["a.png"] ?? "";
    const text = desktopPrompt(
      [a, paths["b.jpg"] ?? "", a, paths["c.gif"] ?? "", paths["d.png"] ?? ""],
      "What changed?",
    );
    await expect(piPromptImages(text)).resolves.toEqual([
      image("image/png", PNG),
      image("image/jpeg", JPEG),
      image("image/gif", GIF),
      image("image/webp", WEBP),
    ]);
  });

  it("leaves unsupported, oversized, missing, unreadable and directory attachments as path text", async () => {
    const paths = await files({
      "ok.png": PNG,
      "photo.heic": Buffer.from("\0\0\0\x18ftypheic", "latin1"),
      "big.png": PNG,
      "locked.png": PNG,
    });
    await truncate(paths["big.png"] ?? "", 20 * 1024 * 1024 + 1);
    const locked = paths["locked.png"] ?? "";
    await chmod(locked, 0o000);
    const directory = path.join(path.dirname(locked), "folder.png");
    await mkdir(directory);
    const text = desktopPrompt(
      [
        paths["photo.heic"] ?? "",
        paths["big.png"] ?? "",
        path.join(path.dirname(locked), "missing.png"),
        locked,
        directory,
        paths["ok.png"] ?? "",
      ],
      "Describe",
    );
    await expect(piPromptImages(text)).resolves.toEqual([image("image/png", PNG)]);
  });

  it("accepts an image of exactly 20 MiB", async () => {
    const { "edge.png": edge = "" } = await files({ "edge.png": PNG });
    await truncate(edge, 20 * 1024 * 1024);
    const images = await piPromptImages(desktopPrompt([edge], "Describe"));
    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe("image/png");
  });

  it("caps a Turn at 32 MiB of images; later ones that would exceed it stay path text", async () => {
    const paths = await files({ "a.png": PNG, "b.png": PNG, "c.png": PNG, "d.jpg": JPEG });
    for (const name of ["a.png", "b.png", "c.png"]) {
      await truncate(paths[name] ?? "", 12 * 1024 * 1024);
    }
    const images = await piPromptImages(
      desktopPrompt(
        [paths["a.png"] ?? "", paths["b.png"] ?? "", paths["c.png"] ?? "", paths["d.jpg"] ?? ""],
        "Compare",
      ),
    );
    expect(images.map((item) => item.mimeType)).toEqual(["image/png", "image/png", "image/jpeg"]);
  });
});

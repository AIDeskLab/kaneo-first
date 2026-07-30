import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");
const sourceSvg = path.join(publicDir, "favicon.svg");

function pngBuffersToIco(images) {
  const numImages = images.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  let offset = headerSize + dirEntrySize * numImages;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(numImages, 4);

  const entries = [];
  const imageData = [];

  for (const { size, buffer } of images) {
    const entry = Buffer.alloc(dirEntrySize);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    imageData.push(buffer);
    offset += buffer.length;
  }

  return Buffer.concat([header, ...entries, ...imageData]);
}

async function generateIcon(size, outputName, paddingPercent = 0) {
  const padding = Math.round(size * paddingPercent);
  const innerSize = size - padding * 2;

  const buffer = await sharp(sourceSvg)
    .resize(innerSize, innerSize, { fit: "contain", background: "#141414" })
    .extend({
      top: padding,
      bottom: padding,
      left: padding,
      right: padding,
      background: "#141414",
    })
    .png()
    .toBuffer();

  await writeFile(path.join(publicDir, outputName), buffer);
  console.log(`Generated ${outputName}`);
}

async function generateFaviconIco() {
  const sizes = [16, 32, 48];
  const images = await Promise.all(
    sizes.map(async (size) => ({
      size,
      buffer: await sharp(sourceSvg)
        .resize(size, size, { fit: "contain", background: "#141414" })
        .png()
        .toBuffer(),
    })),
  );

  const ico = pngBuffersToIco(images);
  await writeFile(path.join(publicDir, "favicon.ico"), ico);
  console.log("Generated favicon.ico");
}

async function main() {
  await generateIcon(192, "web-app-manifest-192x192.png");
  await generateIcon(512, "web-app-manifest-512x512.png");
  await generateIcon(192, "web-app-manifest-192x192-maskable.png", 0.1);
  await generateIcon(512, "web-app-manifest-512x512-maskable.png", 0.1);
  await generateIcon(180, "apple-touch-icon.png", 0.05);
  await generateIcon(96, "favicon-96x96.png");
  await generateFaviconIco();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

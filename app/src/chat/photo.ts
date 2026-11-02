import { hasExif, PHOTO_MAX_BYTES, stripMetadata } from './chat';

/** Long edge, in pixels. Plenty to judge a photo question by. */
const MAX_EDGE = 1280;
/**
 * Tried in turn until the photo is small enough to send comfortably. It goes
 * phone to phone through a relay that carries ~100 KB a second for the whole
 * project (chat.ts, PHOTO_CHUNK_BYTES).
 */
const QUALITIES = [0.8, 0.65, 0.5];
const TARGET_BYTES = 250_000;

/**
 * Turns a photo off the camera into the JPEG that is uploaded.
 *
 * Not optional, and not only for size. A phone camera writes the position it
 * was taken at into the file's EXIF block, and the hider is the one player
 * whose position must never reach the others. Two independent steps: the
 * pixels are drawn onto a canvas and encoded again, which leaves the
 * original's metadata behind; then every metadata segment is cut out of the
 * new file byte by byte, in case a browser's encoder writes some of its own.
 * A photo that cannot be decoded is refused rather than sent as it came —
 * the original is exactly the file that must not go.
 */
export async function preparePhoto(file: Blob): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    // Applies the EXIF orientation before the metadata is dropped, so a
    // portrait shot does not arrive on its side.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('This phone could not read that photo. Try taking it again with the camera.');
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  let bytes: Uint8Array | null = null;
  for (const quality of QUALITIES) {
    const encoded = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!encoded || encoded.type !== 'image/jpeg') throw new Error('Could not prepare the photo.');
    try {
      bytes = stripMetadata(new Uint8Array(await encoded.arrayBuffer()));
    } catch {
      throw new Error('Could not prepare the photo.');
    }
    if (bytes.length <= TARGET_BYTES) break;
  }
  if (!bytes || bytes.length > PHOTO_MAX_BYTES) throw new Error('That photo is too large to send. Try again with less in the frame.');
  if (hasExif(bytes)) throw new Error('The photo still carried its location data, so it was not sent.');
  return new Blob([bytes as BlobPart], { type: 'image/jpeg' });
}

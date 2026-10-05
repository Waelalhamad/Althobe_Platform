// Product photos (ADR-010). A phone photo is 3–8 MB; the browser shrinks it to a 1600 px image
// and a 400 px thumbnail (a few hundred KB together) before it leaves the device, so uploads are
// quick on a weak connection. No library: the browser's own canvas does it.

/** The photo as an <img> source: the API checks the session, then redirects to S3. */
export const photoSrc = (id: string, size: 'thumb' | 'full' = 'thumb') =>
  `/api/v1/photos/${id}?size=${size}`;

export function PhotoThumb({
  id,
  size = 40,
  className = '',
}: {
  id: string | null;
  size?: number;
  className?: string;
}) {
  const box = { width: size, height: size };
  if (!id) return <div style={box} className={`shrink-0 rounded-lg bg-blush ${className}`} />;
  return (
    <img
      src={photoSrc(id)}
      alt=""
      loading="lazy"
      style={box}
      className={`shrink-0 rounded-lg bg-blush object-cover ${className}`}
    />
  );
}

export interface ShrunkPhoto {
  image: string;
  thumb: string;
  width: number;
  height: number;
}

/** Both sizes, base64, ready for the API. Throws if the browser cannot read the file. */
export async function shrinkPhoto(file: File): Promise<ShrunkPhoto> {
  // from-image: phone photos are stored sideways with a rotation flag; apply it.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const full = await encode(bitmap, 1600, 0.82);
    const thumb = await encode(bitmap, 400, 0.75);
    return { image: full.base64, thumb: thumb.base64, width: full.width, height: full.height };
  } finally {
    bitmap.close();
  }
}

async function encode(bitmap: ImageBitmap, maxSide: number, quality: number) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  // WebP is smaller; browsers that cannot encode it hand back PNG, so fall back to JPEG.
  let blob = await toBlob(canvas, 'image/webp', quality);
  if (blob?.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', quality);
  if (!blob) throw new Error('could not encode the photo');
  return { base64: await toBase64(blob), width, height };
}

const toBlob = async (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

const toBase64 = async (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    // readAsDataURL always yields a string: "data:image/webp;base64,<data>".
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });

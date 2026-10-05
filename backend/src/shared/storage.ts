import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Product photos live in a private S3 bucket (ADR-010). The app uploads them and hands browsers a
// short-lived signed link; the bucket is never public and the keys never leave the server.

export interface PhotoStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** A link that works for at least `seconds`; anyone holding it can read the object until then. */
  signedUrl(key: string, seconds: number): Promise<string>;
  delete(keys: string[]): Promise<void>;
}

const HOUR = 3_600_000;

/**
 * S3 from the environment, or null when photos are not configured (the app runs without them).
 * `prefix` keeps practice (`practice/`) and test runs (`S3_PREFIX=test/`) apart from real photos
 * in the same bucket.
 */
export function createS3Storage(
  env: NodeJS.ProcessEnv = process.env,
  prefix = env.S3_PREFIX ?? '',
): PhotoStorage | null {
  const { AWS_REGION, S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } = env;
  if (!AWS_REGION || !S3_BUCKET || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) return null;

  const client = new S3Client({
    region: AWS_REGION,
    credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
  });
  const Bucket = S3_BUCKET;

  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key: prefix + key,
          Body: body,
          ContentType: contentType,
          // A key is never reused for different bytes, so browsers may keep the image.
          CacheControl: 'private, max-age=31536000, immutable',
        }),
      );
    },

    async signedUrl(key, seconds) {
      // Signed as of the start of the hour: every request in that hour gets the same link, so
      // the browser's image cache works. Valid for the rest of the hour plus `seconds`.
      const signingDate = new Date(Math.floor(Date.now() / HOUR) * HOUR);
      return getSignedUrl(client, new GetObjectCommand({ Bucket, Key: prefix + key }), {
        signingDate,
        expiresIn: HOUR / 1000 + seconds,
      });
    },

    async delete(keys) {
      if (!keys.length) return;
      await client.send(
        new DeleteObjectsCommand({
          Bucket,
          Delete: { Objects: keys.map((key) => ({ Key: prefix + key })), Quiet: true },
        }),
      );
    },
  };
}

/** For tests and local runs without S3: objects in a Map, links that name the key. */
export function createMemoryStorage(): PhotoStorage & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async put(key, body) {
      objects.set(key, body);
      return Promise.resolve();
    },
    async signedUrl(key) {
      return Promise.resolve(`memory://${key}`);
    },
    async delete(keys) {
      for (const key of keys) objects.delete(key);
      return Promise.resolve();
    },
  };
}

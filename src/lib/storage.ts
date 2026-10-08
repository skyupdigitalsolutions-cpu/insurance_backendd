// Where uploaded files (customer KYC documents) are kept.
//   local → a folder on this server (development and staging)
//   s3    → a PRIVATE bucket on AWS S3 (Mumbai region), Cloudflare R2 or any S3-compatible storage (production)
// Files are never public: the app opens them through the API's short-lived signed links.
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { env } from '../config/env.js';

export interface FileStorage {
  save(key: string, data: Buffer): Promise<void>;
  open(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
}

class LocalStorage implements FileStorage {
  private readonly root = path.resolve(env.UPLOADS_DIR);

  private pathOf(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error('Invalid storage key'); // never leave the uploads folder
    return full;
  }

  async save(key: string, data: Buffer): Promise<void> {
    const full = this.pathOf(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data, { flag: 'wx' }); // never overwrite an existing file
  }

  async open(key: string): Promise<Readable> {
    const full = this.pathOf(key);
    await stat(full); // throws if missing
    return createReadStream(full);
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }
}

export class S3Storage implements FileStorage {
  constructor(
    private readonly bucket: string,
    private readonly client: S3Client,
  ) {}

  async save(key: string, data: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: data,
      ServerSideEncryption: env.S3_ENDPOINT ? undefined : 'AES256', // AWS: encrypted at rest (R2 always encrypts)
    }));
  }

  async open(key: string): Promise<Readable> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })); // throws if missing
    if (!(out.Body instanceof Readable)) throw new Error('Unexpected storage response');
    return out.Body;
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

function createStorage(): FileStorage {
  if (env.STORAGE_DRIVER === 'local') return new LocalStorage();
  const client = new S3Client({
    region: env.S3_REGION,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID ?? '', secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '' },
  });
  return new S3Storage(env.S3_BUCKET ?? '', client);
}

export const storage: FileStorage = createStorage();

// Recognises the real file type from its first bytes (the file name and the phone's claim are not trusted)
export function detectFileType(data: Buffer): { mime: string; ext: string } | null {
  const starts = (bytes: number[]) => bytes.every((b, i) => data[i] === b);
  if (starts([0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', ext: 'jpg' };
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', ext: 'png' };
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return { mime: 'application/pdf', ext: 'pdf' };
  return null;
}

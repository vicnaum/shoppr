import { mkdir } from 'fs/promises';

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** Make a filesystem-safe base name from an arbitrary query string. */
export function sanitizeForFilename(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'query'
  );
}

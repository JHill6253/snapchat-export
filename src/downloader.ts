/**
 * Downloader module for fetching Snapchat memories
 */

import { DownloadError, SnapchatMemory } from './types.js';

/**
 * Default delay between downloads in milliseconds
 */
export const DEFAULT_DOWNLOAD_DELAY_MS = 500;

/**
 * Default number of concurrent downloads
 */
export const DEFAULT_CONCURRENCY = 5;

/**
 * Default maximum retries for failed downloads
 */
export const DEFAULT_MAX_RETRIES = 3;

/**
 * Base delay for exponential backoff in milliseconds
 */
export const BACKOFF_BASE_DELAY_MS = 1000;

/**
 * Maximum backoff delay in milliseconds (30 seconds)
 */
export const BACKOFF_MAX_DELAY_MS = 30000;

/**
 * URL expiration threshold in hours
 * Snapchat's overlay URLs typically expire within 6-12 hours
 */
export const URL_EXPIRATION_HOURS = 6;

/**
 * HTTP status codes that should trigger a retry
 */
const RETRYABLE_STATUS_CODES = new Set([
  408, // Request Timeout
  429, // Too Many Requests (rate limited)
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
]);

/**
 * Result of URL expiration check
 */
export interface UrlExpirationInfo {
  readonly isExpired: boolean;
  readonly ageHours: number;
  readonly timestamp: Date | null;
}

/**
 * Check if a Snapchat download URL is likely expired
 * URLs contain a 'ts' (timestamp) parameter that indicates when they were generated
 *
 * @param url - The download URL to check
 * @param thresholdHours - Hours after which URL is considered expired (default: 6)
 * @returns Expiration info including whether URL is expired and its age
 */
export function checkUrlExpiration(
  url: string,
  thresholdHours: number = URL_EXPIRATION_HOURS
): UrlExpirationInfo {
  try {
    // Extract 'ts' parameter from URL
    const urlObj = new URL(url);
    const tsParam = urlObj.searchParams.get('ts');

    if (!tsParam) {
      // No timestamp found, can't determine expiration
      return { isExpired: false, ageHours: 0, timestamp: null };
    }

    const timestamp = parseInt(tsParam, 10);
    if (isNaN(timestamp)) {
      return { isExpired: false, ageHours: 0, timestamp: null };
    }

    const urlDate = new Date(timestamp);
    const now = Date.now();
    const ageMs = now - timestamp;
    const ageHours = ageMs / (1000 * 60 * 60);

    return {
      isExpired: ageHours > thresholdHours,
      ageHours: Math.round(ageHours * 10) / 10, // Round to 1 decimal
      timestamp: urlDate,
    };
  } catch {
    // URL parsing failed, assume not expired
    return { isExpired: false, ageHours: 0, timestamp: null };
  }
}

/**
 * Check if overlay URLs in a set of memories are likely expired
 * Checks the first memory with a mediaDownloadUrl
 *
 * @param memories - Array of memories to check
 * @returns Expiration info, or null if no mediaDownloadUrl found
 */
export function checkOverlayUrlsExpired(
  memories: readonly SnapchatMemory[]
): UrlExpirationInfo | null {
  const memoryWithOverlay = memories.find((m) => m.mediaDownloadUrl);
  if (!memoryWithOverlay?.mediaDownloadUrl) {
    return null;
  }

  return checkUrlExpiration(memoryWithOverlay.mediaDownloadUrl);
}

/**
 * Download result with binary data
 */
export interface DownloadedMedia {
  readonly data: Buffer;
  readonly contentType: string;
  readonly extension: string;
}

/**
 * Determine file extension from content type
 */
export function getExtensionFromContentType(
  contentType: string,
  mediaType: 'Image' | 'Video'
): string {
  const type = contentType.toLowerCase();

  // Image types
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  if (type.includes('png')) return 'png';
  if (type.includes('gif')) return 'gif';
  if (type.includes('webp')) return 'webp';
  if (type.includes('heic')) return 'heic';

  // Video types
  if (type.includes('mp4')) return 'mp4';
  if (type.includes('quicktime') || type.includes('mov')) return 'mov';
  if (type.includes('webm')) return 'webm';

  // Fallback based on media type
  return mediaType === 'Image' ? 'jpg' : 'mp4';
}

/**
 * Calculate exponential backoff delay with jitter
 */
export function calculateBackoffDelay(
  attempt: number,
  baseDelay: number = BACKOFF_BASE_DELAY_MS
): number {
  // Exponential backoff: baseDelay * 2^attempt
  const exponentialDelay = baseDelay * Math.pow(2, attempt);

  // Add jitter (±25%) to prevent thundering herd
  const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1);

  // Cap at maximum delay
  return Math.min(exponentialDelay + jitter, BACKOFF_MAX_DELAY_MS);
}

/**
 * Check if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof DownloadError) {
    return RETRYABLE_STATUS_CODES.has(error.statusCode);
  }

  // Network errors are generally retryable
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('econnreset') ||
      message.includes('econnrefused') ||
      message.includes('socket')
    );
  }

  return false;
}

/**
 * Download a single memory using POST method with retry logic
 * Snapchat's download mechanism requires:
 * 1. POST to the proxy URL with query params as body
 * 2. This returns a signed S3 URL
 * 3. GET the signed S3 URL to download the actual file
 */
export async function downloadMemory(
  memory: SnapchatMemory,
  options: {
    maxRetries?: number;
    onRetry?: (attempt: number, delay: number, error: Error) => void;
  } = {}
): Promise<DownloadedMedia> {
  const { maxRetries = DEFAULT_MAX_RETRIES, onRetry } = options;
  const url = memory.downloadUrl;

  // Split URL at ? to separate base URL and query params
  const [baseUrl, queryString] = url.split('?');

  if (!queryString) {
    throw new DownloadError(url, 0, 'Invalid download URL format - missing query parameters');
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Step 1: POST to get the signed S3 URL
      const proxyResponse = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: queryString,
      });

      if (!proxyResponse.ok) {
        const error = new DownloadError(url, proxyResponse.status, proxyResponse.statusText);

        // Check if we should retry
        if (attempt < maxRetries && isRetryableError(error)) {
          lastError = error;
          const delay = calculateBackoffDelay(attempt);

          if (onRetry) {
            onRetry(attempt + 1, delay, error);
          }

          await sleep(delay);
          continue;
        }

        throw error;
      }

      // The response body is the signed S3 URL
      const signedUrl = await proxyResponse.text();

      if (!signedUrl || !signedUrl.startsWith('http')) {
        throw new DownloadError(
          url,
          0,
          `Invalid signed URL response: ${signedUrl.substring(0, 100)}`
        );
      }

      // Step 2: GET the actual file from the signed S3 URL
      const fileResponse = await fetch(signedUrl.trim());

      if (!fileResponse.ok) {
        const error = new DownloadError(signedUrl, fileResponse.status, fileResponse.statusText);

        // Check if we should retry
        if (attempt < maxRetries && isRetryableError(error)) {
          lastError = error;
          const delay = calculateBackoffDelay(attempt);

          if (onRetry) {
            onRetry(attempt + 1, delay, error);
          }

          await sleep(delay);
          continue;
        }

        throw error;
      }

      const contentType = fileResponse.headers.get('content-type') || 'application/octet-stream';
      const arrayBuffer = await fileResponse.arrayBuffer();
      const data = Buffer.from(arrayBuffer);

      if (data.length === 0) {
        throw new DownloadError(signedUrl, fileResponse.status, 'Empty response body');
      }

      return {
        data,
        contentType,
        extension: getExtensionFromContentType(contentType, memory.mediaType),
      };
    } catch (error) {
      // If it's already a DownloadError we threw, check if we should retry
      if (error instanceof DownloadError) {
        if (attempt < maxRetries && isRetryableError(error)) {
          lastError = error;
          const delay = calculateBackoffDelay(attempt);

          if (onRetry) {
            onRetry(attempt + 1, delay, error);
          }

          await sleep(delay);
          continue;
        }
        throw error;
      }

      // For network errors, check if retryable
      if (error instanceof Error && attempt < maxRetries && isRetryableError(error)) {
        lastError = error;
        const delay = calculateBackoffDelay(attempt);

        if (onRetry) {
          onRetry(attempt + 1, delay, error);
        }

        await sleep(delay);
        continue;
      }

      throw error;
    }
  }

  // Should not reach here, but just in case
  throw lastError || new Error('Download failed after retries');
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Progress callback type
 */
export type ProgressCallback = (completed: number, total: number, memory: SnapchatMemory) => void;

/**
 * Retry callback type
 */
export type RetryCallback = (
  memory: SnapchatMemory,
  attempt: number,
  delay: number,
  error: Error
) => void;

/**
 * Download result for batch operations
 */
export interface BatchDownloadResult {
  readonly memory: SnapchatMemory;
  readonly success: boolean;
  readonly media?: DownloadedMedia;
  readonly error?: string;
  readonly retries?: number;
}

/**
 * Download options
 */
export interface DownloadOptions {
  delay?: number;
  concurrency?: number;
  maxRetries?: number;
  onProgress?: ProgressCallback;
  onRetry?: RetryCallback;
  signal?: AbortSignal;
}

/**
 * Worker function that processes items from a shared queue
 */
async function downloadWorker(
  queue: SnapchatMemory[],
  results: Map<string, BatchDownloadResult>,
  options: {
    delay: number;
    maxRetries: number;
    onComplete: () => void;
    onRetry?: RetryCallback;
    signal?: AbortSignal;
  }
): Promise<void> {
  const { delay, maxRetries, onComplete, onRetry, signal } = options;

  while (queue.length > 0) {
    if (signal?.aborted) {
      break;
    }

    const memory = queue.shift();
    if (!memory) break;

    let retryCount = 0;

    try {
      const media = await downloadMemory(memory, {
        maxRetries,
        onRetry: (attempt, retryDelay, error) => {
          retryCount = attempt;
          if (onRetry) {
            onRetry(memory, attempt, retryDelay, error);
          }
        },
      });
      results.set(memory.mediaId, { memory, success: true, media, retries: retryCount });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      results.set(memory.mediaId, {
        memory,
        success: false,
        error: errorMessage,
        retries: retryCount,
      });
    }

    onComplete();

    // Rate limiting delay between downloads
    if (queue.length > 0 && delay > 0) {
      await sleep(delay);
    }
  }
}

/**
 * Download multiple memories with concurrency, rate limiting, and retry
 */
export async function downloadMemoriesConcurrent(
  memories: readonly SnapchatMemory[],
  options: DownloadOptions = {}
): Promise<BatchDownloadResult[]> {
  const {
    delay = DEFAULT_DOWNLOAD_DELAY_MS,
    concurrency = DEFAULT_CONCURRENCY,
    maxRetries = DEFAULT_MAX_RETRIES,
    onProgress,
    onRetry,
    signal,
  } = options;

  // Create a mutable queue from the memories
  const queue = [...memories];
  const results = new Map<string, BatchDownloadResult>();
  let completed = 0;

  const onComplete = (): void => {
    completed++;
    if (onProgress && results.size > 0) {
      // Get the most recently completed memory for progress reporting
      const lastResult = Array.from(results.values()).pop();
      if (lastResult) {
        onProgress(completed, memories.length, lastResult.memory);
      }
    }
  };

  // Start concurrent workers
  const workers: Promise<void>[] = [];
  const actualConcurrency = Math.min(concurrency, memories.length);

  for (let i = 0; i < actualConcurrency; i++) {
    // Stagger worker start times to avoid burst requests
    await sleep(delay * (i / actualConcurrency));
    workers.push(
      downloadWorker(queue, results, {
        delay,
        maxRetries,
        onComplete,
        onRetry,
        signal,
      })
    );
  }

  // Wait for all workers to complete
  await Promise.all(workers);

  // Return results in original order
  return memories.map(
    (memory) =>
      results.get(memory.mediaId) || {
        memory,
        success: false,
        error: 'Download was cancelled',
      }
  );
}

/**
 * Download multiple memories sequentially (legacy function)
 */
export async function downloadMemories(
  memories: readonly SnapchatMemory[],
  options: {
    delay?: number;
    maxRetries?: number;
    onProgress?: ProgressCallback;
    onRetry?: RetryCallback;
    signal?: AbortSignal;
  } = {}
): Promise<BatchDownloadResult[]> {
  return downloadMemoriesConcurrent(memories, { ...options, concurrency: 1 });
}

/**
 * Contents extracted from a media ZIP file
 */
export interface ExtractedMediaContents {
  readonly baseMedia: Buffer;
  readonly baseMediaType: 'jpg' | 'mp4';
  readonly overlay: Buffer | null;
}

/**
 * Download and extract media from the mediaDownloadUrl (ZIP containing base + overlay)
 *
 * The ZIP typically contains:
 * - main.jpg or main.mp4 (the base media)
 * - overlay.png (optional overlay with transparency)
 */
export async function downloadMediaWithOverlay(
  memory: SnapchatMemory,
  options: {
    maxRetries?: number;
    onRetry?: (attempt: number, delay: number, error: Error) => void;
  } = {}
): Promise<ExtractedMediaContents> {
  const { maxRetries = DEFAULT_MAX_RETRIES, onRetry } = options;

  // Use mediaDownloadUrl if available, otherwise fall back to downloadUrl
  const url = memory.mediaDownloadUrl || memory.downloadUrl;
  const isMediaUrl = !!memory.mediaDownloadUrl;

  // Split URL at ? to separate base URL and query params
  const [baseUrl, queryString] = url.split('?');

  if (!queryString) {
    throw new DownloadError(url, 0, 'Invalid download URL format - missing query parameters');
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // POST to get the signed URL
      const proxyResponse = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: queryString,
      });

      if (!proxyResponse.ok) {
        const error = new DownloadError(url, proxyResponse.status, proxyResponse.statusText);

        if (attempt < maxRetries && isRetryableError(error)) {
          lastError = error;
          const delay = calculateBackoffDelay(attempt);

          if (onRetry) {
            onRetry(attempt + 1, delay, error);
          }

          await sleep(delay);
          continue;
        }

        throw error;
      }

      // The response body is the signed URL
      const signedUrl = await proxyResponse.text();

      if (!signedUrl || !signedUrl.startsWith('http')) {
        throw new DownloadError(
          url,
          0,
          `Invalid signed URL response: ${signedUrl.substring(0, 100)}`
        );
      }

      // GET the actual file from the signed URL
      const fileResponse = await fetch(signedUrl.trim());

      if (!fileResponse.ok) {
        const error = new DownloadError(signedUrl, fileResponse.status, fileResponse.statusText);

        if (attempt < maxRetries && isRetryableError(error)) {
          lastError = error;
          const delay = calculateBackoffDelay(attempt);

          if (onRetry) {
            onRetry(attempt + 1, delay, error);
          }

          await sleep(delay);
          continue;
        }

        throw error;
      }

      const contentType = fileResponse.headers.get('content-type') || 'application/octet-stream';
      const arrayBuffer = await fileResponse.arrayBuffer();
      const data = Buffer.from(arrayBuffer);

      if (data.length === 0) {
        throw new DownloadError(signedUrl, fileResponse.status, 'Empty response body');
      }

      // Check if this is a ZIP file (mediaDownloadUrl returns ZIP)
      if (isMediaUrl && (contentType.includes('zip') || isZipBuffer(data))) {
        return extractMediaFromZip(data, memory.mediaType);
      }

      // Not a ZIP, return as single media without overlay
      const baseMediaType = memory.mediaType === 'Image' ? 'jpg' : 'mp4';
      return {
        baseMedia: data,
        baseMediaType: baseMediaType,
        overlay: null,
      };
    } catch (error) {
      if (error instanceof DownloadError) {
        if (attempt < maxRetries && isRetryableError(error)) {
          lastError = error;
          const delay = calculateBackoffDelay(attempt);

          if (onRetry) {
            onRetry(attempt + 1, delay, error);
          }

          await sleep(delay);
          continue;
        }
        throw error;
      }

      if (error instanceof Error && attempt < maxRetries && isRetryableError(error)) {
        lastError = error;
        const delay = calculateBackoffDelay(attempt);

        if (onRetry) {
          onRetry(attempt + 1, delay, error);
        }

        await sleep(delay);
        continue;
      }

      throw error;
    }
  }

  throw lastError || new Error('Download failed after retries');
}

/**
 * Check if a buffer starts with ZIP magic bytes
 */
function isZipBuffer(buffer: Buffer): boolean {
  // ZIP files start with PK (0x50 0x4B)
  return buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

/**
 * Extract base media and overlay from a ZIP buffer
 */
async function extractMediaFromZip(
  zipBuffer: Buffer,
  mediaType: 'Image' | 'Video'
): Promise<ExtractedMediaContents> {
  // Dynamic import to avoid loading adm-zip until needed
  const AdmZip = (await import('adm-zip')).default;

  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  let baseMedia: Buffer | null = null;
  let baseMediaType: 'jpg' | 'mp4' = mediaType === 'Image' ? 'jpg' : 'mp4';
  let overlay: Buffer | null = null;

  for (const entry of entries) {
    const name = entry.entryName.toLowerCase();

    // Skip directories
    if (entry.isDirectory) continue;

    // Look for overlay PNG
    if (name.endsWith('.png') && (name.includes('overlay') || name === 'overlay.png')) {
      overlay = entry.getData();
      continue;
    }

    // Look for base image (JPG/JPEG)
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) {
      baseMedia = entry.getData();
      baseMediaType = 'jpg';
      continue;
    }

    // Look for base video (MP4)
    if (name.endsWith('.mp4')) {
      baseMedia = entry.getData();
      baseMediaType = 'mp4';
      continue;
    }

    // Fallback: any PNG that's not the overlay might be the base image
    if (name.endsWith('.png') && !overlay) {
      // Check if this could be the overlay (has transparency) or base image
      // For now, assume non-overlay PNGs could be overlays if we haven't found one
      overlay = entry.getData();
    }
  }

  // If we still don't have base media, try to find any image/video file
  if (!baseMedia) {
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const name = entry.entryName.toLowerCase();

      // Take first media file we find
      if (name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png')) {
        baseMedia = entry.getData();
        baseMediaType = 'jpg';
        break;
      }
      if (name.endsWith('.mp4') || name.endsWith('.mov')) {
        baseMedia = entry.getData();
        baseMediaType = 'mp4';
        break;
      }
    }
  }

  if (!baseMedia) {
    throw new DownloadError('zip', 0, 'No media file found in ZIP archive');
  }

  return {
    baseMedia,
    baseMediaType,
    overlay,
  };
}

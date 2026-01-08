/**
 * Core type definitions for Snapchat Memory Export tool
 */

/**
 * GPS coordinates
 */
export interface GpsCoordinates {
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * Media type from Snapchat export
 */
export type MediaType = 'Image' | 'Video';

/**
 * Parsed Snapchat memory with normalized data
 */
export interface SnapchatMemory {
  readonly date: Date;
  readonly mediaType: MediaType;
  readonly location: GpsCoordinates | null;
  readonly downloadUrl: string;
  readonly mediaDownloadUrl: string | null; // Direct URL for ZIP with base media + overlay
  readonly mediaId: string;
}

/**
 * Raw entry from Snapchat JSON export
 */
export interface RawSnapchatEntry {
  readonly Date: string;
  readonly 'Media Type': string;
  readonly Location: string;
  readonly 'Download Link': string;
  readonly 'Media Download Url'?: string;
}

/**
 * Raw Snapchat export JSON structure
 */
export interface RawSnapchatExport {
  readonly 'Saved Media': readonly RawSnapchatEntry[];
}

/**
 * Download result for a single memory
 */
export interface DownloadResult {
  readonly memory: SnapchatMemory;
  readonly success: boolean;
  readonly filePath?: string;
  readonly error?: string;
  readonly contentType?: string;
}

/**
 * Export options from CLI
 */
export interface ExportOptions {
  readonly outputDir: string;
  readonly format: 'date' | 'flat';
  readonly dryRun: boolean;
  readonly skipExisting: boolean;
  readonly delay: number;
  readonly concurrency: number;
  readonly maxRetries: number;
  readonly importToPhotos: boolean;
  readonly limit: number | null;
  readonly skipOverlay: boolean; // Skip overlay download attempts (faster if URLs expired)
  readonly preloadedMemories?: readonly SnapchatMemory[]; // Pre-loaded memories from interactive mode
}

/**
 * Export statistics
 */
export interface ExportStats {
  total: number;
  downloaded: number;
  skipped: number;
  failed: number;
  images: number;
  videos: number;
  retries: number;
}

/**
 * Custom error for download failures
 */
export class DownloadError extends Error {
  constructor(
    public readonly url: string,
    public readonly statusCode: number,
    message: string
  ) {
    super(`Failed to download ${url}: ${message} (status: ${statusCode})`);
    this.name = 'DownloadError';
  }
}

/**
 * Custom error for parsing failures
 */
export class ParseError extends Error {
  constructor(message: string) {
    super(`Failed to parse Snapchat export: ${message}`);
    this.name = 'ParseError';
  }
}

/**
 * Custom error for metadata embedding failures
 */
export class MetadataError extends Error {
  constructor(
    public readonly filePath: string,
    message: string
  ) {
    super(`Failed to embed metadata for ${filePath}: ${message}`);
    this.name = 'MetadataError';
  }
}

/**
 * Record of a successfully downloaded memory in the manifest
 */
export interface ManifestEntry {
  readonly mediaId: string;
  readonly downloadedAt: string; // ISO 8601 timestamp
  readonly filePath: string;
  readonly fileSize: number;
  readonly mediaType: MediaType;
  readonly originalDate: string; // ISO 8601 timestamp of memory date
}

/**
 * Manifest file structure for tracking downloaded memories
 */
export interface ExportManifest {
  readonly version: 1;
  readonly createdAt: string; // ISO 8601 timestamp
  updatedAt: string; // ISO 8601 timestamp
  readonly outputDir: string;
  readonly entries: Record<string, ManifestEntry>; // keyed by mediaId
}

/**
 * Manifest module for tracking downloaded memories
 * Enables resume capability and prevents re-downloading
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExportManifest, ManifestEntry, SnapchatMemory } from './types.js';

const MANIFEST_FILENAME = '.snapchat-export-manifest.json';
const MANIFEST_VERSION = 1 as const;

/**
 * Get the manifest file path for an output directory
 */
export function getManifestPath(outputDir: string): string {
  return join(outputDir, MANIFEST_FILENAME);
}

/**
 * Create a new empty manifest
 */
export function createManifest(outputDir: string): ExportManifest {
  const now = new Date().toISOString();
  return {
    version: MANIFEST_VERSION,
    createdAt: now,
    updatedAt: now,
    outputDir,
    entries: {},
  };
}

/**
 * Load manifest from disk, or create a new one if it doesn't exist
 */
export async function loadManifest(outputDir: string): Promise<ExportManifest> {
  const manifestPath = getManifestPath(outputDir);

  try {
    const content = await readFile(manifestPath, 'utf-8');
    const data = JSON.parse(content) as ExportManifest;

    // Validate version
    if (data.version !== MANIFEST_VERSION) {
      console.warn(
        `Manifest version mismatch: expected ${String(MANIFEST_VERSION)}, got ${String(data.version)}. Creating new manifest.`
      );
      return createManifest(outputDir);
    }

    return data;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      // File doesn't exist, create new manifest
      return createManifest(outputDir);
    }
    throw error;
  }
}

/**
 * Save manifest to disk
 */
export async function saveManifest(manifest: ExportManifest): Promise<void> {
  const manifestPath = getManifestPath(manifest.outputDir);

  // Update the updatedAt timestamp
  manifest.updatedAt = new Date().toISOString();

  const content = JSON.stringify(manifest, null, 2);
  await writeFile(manifestPath, content, 'utf-8');
}

/**
 * Add an entry to the manifest
 */
export function addManifestEntry(
  manifest: ExportManifest,
  memory: SnapchatMemory,
  filePath: string,
  fileSize: number
): ManifestEntry {
  const entry: ManifestEntry = {
    mediaId: memory.mediaId,
    downloadedAt: new Date().toISOString(),
    filePath,
    fileSize,
    mediaType: memory.mediaType,
    originalDate: memory.date.toISOString(),
  };

  manifest.entries[memory.mediaId] = entry;
  return entry;
}

/**
 * Check if a memory has already been downloaded
 */
export function isDownloaded(manifest: ExportManifest, mediaId: string): boolean {
  return mediaId in manifest.entries;
}

/**
 * Get list of media IDs that have been downloaded
 */
export function getDownloadedIds(manifest: ExportManifest): Set<string> {
  return new Set(Object.keys(manifest.entries));
}

/**
 * Filter memories to only those not yet downloaded
 */
export function filterPendingMemories(
  memories: readonly SnapchatMemory[],
  manifest: ExportManifest
): SnapchatMemory[] {
  const downloadedIds = getDownloadedIds(manifest);
  return memories.filter((memory) => !downloadedIds.has(memory.mediaId));
}

/**
 * Get manifest statistics
 */
export function getManifestStats(manifest: ExportManifest): {
  total: number;
  images: number;
  videos: number;
} {
  const entries = Object.values(manifest.entries);
  return {
    total: entries.length,
    images: entries.filter((e) => e.mediaType === 'Image').length,
    videos: entries.filter((e) => e.mediaType === 'Video').length,
  };
}

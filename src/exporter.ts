/**
 * Exporter module for organizing and writing downloaded media
 */

import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { ExportOptions, ExportStats, SnapchatMemory } from './types.js';
import { BatchDownloadResult, DownloadedMedia } from './downloader.js';
import { embedMetadata, supportsExif } from './metadata.js';

/**
 * Generate filename for a memory
 */
export function generateFilename(memory: SnapchatMemory, extension: string): string {
  const date = memory.date;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  const mediaPrefix = memory.mediaType === 'Image' ? 'photo' : 'video';
  const shortId = memory.mediaId.substring(0, 8);

  return `${year}-${month}-${day}_${hours}${minutes}${seconds}_${mediaPrefix}_${shortId}.${extension}`;
}

/**
 * Generate output path for a memory based on format option
 */
export function generateOutputPath(
  memory: SnapchatMemory,
  extension: string,
  options: ExportOptions
): string {
  const filename = generateFilename(memory, extension);

  if (options.format === 'flat') {
    return join(options.outputDir, filename);
  }

  // Date-based organization: YYYY/MM/
  const year = memory.date.getFullYear().toString();
  const month = String(memory.date.getMonth() + 1).padStart(2, '0');

  return join(options.outputDir, year, month, filename);
}

/**
 * Check if a file exists
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure directory exists
 */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * Save a downloaded memory to disk with metadata
 */
export async function saveMemory(
  memory: SnapchatMemory,
  media: DownloadedMedia,
  options: ExportOptions
): Promise<string> {
  const outputPath = generateOutputPath(memory, media.extension, options);

  // Skip if file exists and skipExisting is true
  if (options.skipExisting && (await fileExists(outputPath))) {
    throw new Error('File already exists');
  }

  // Ensure output directory exists
  await ensureDir(dirname(outputPath));

  // Write file
  await writeFile(outputPath, media.data);

  // Embed metadata if supported
  if (supportsExif(media.extension)) {
    try {
      await embedMetadata(outputPath, memory);
    } catch (error) {
      // Log warning but don't fail the export
      console.warn(
        `Warning: Could not embed metadata for ${outputPath}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  return outputPath;
}

/**
 * Process batch download results and save to disk
 */
export async function processDownloadResults(
  results: readonly BatchDownloadResult[],
  options: ExportOptions
): Promise<ExportStats> {
  const stats: ExportStats = {
    total: results.length,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    images: 0,
    videos: 0,
    retries: 0,
  };

  for (const result of results) {
    if (!result.success || !result.media) {
      stats.failed++;
      continue;
    }

    try {
      await saveMemory(result.memory, result.media, options);
      stats.downloaded++;

      if (result.memory.mediaType === 'Image') {
        stats.images++;
      } else {
        stats.videos++;
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'File already exists') {
        stats.skipped++;
      } else {
        stats.failed++;
        console.error(
          `Error saving ${result.memory.mediaId}: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }
  }

  return stats;
}

/**
 * Format export stats for display
 */
export function formatStats(stats: ExportStats): string {
  const lines = [
    `Total memories: ${stats.total}`,
    `  Downloaded: ${stats.downloaded} (${stats.images} images, ${stats.videos} videos)`,
  ];

  if (stats.skipped > 0) {
    lines.push(`  Skipped (existing): ${stats.skipped}`);
  }

  if (stats.failed > 0) {
    lines.push(`  Failed: ${stats.failed}`);
  }

  if (stats.retries > 0) {
    lines.push(`  Retries: ${stats.retries}`);
  }

  return lines.join('\n');
}

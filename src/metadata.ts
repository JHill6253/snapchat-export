/**
 * Metadata module for embedding EXIF data into downloaded media
 */

import { exiftool } from 'exiftool-vendored';
import { GpsCoordinates, MetadataError, SnapchatMemory } from './types.js';

/**
 * Format date for EXIF
 * EXIF format: "YYYY:MM:DD HH:MM:SS"
 */
export function formatExifDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${year}:${month}:${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Build EXIF tags for a memory
 */
export function buildExifTags(memory: SnapchatMemory): Record<string, unknown> {
  const tags: Record<string, unknown> = {};

  // Date/time tags
  const exifDate = formatExifDate(memory.date);
  tags.DateTimeOriginal = exifDate;
  tags.CreateDate = exifDate;
  tags.ModifyDate = exifDate;

  // GPS tags if location available
  if (memory.location) {
    tags.GPSLatitude = memory.location.latitude;
    tags.GPSLongitude = memory.location.longitude;
    tags.GPSLatitudeRef = memory.location.latitude >= 0 ? 'N' : 'S';
    tags.GPSLongitudeRef = memory.location.longitude >= 0 ? 'E' : 'W';
  }

  // Software tag
  tags.Software = 'snapchat-export';

  return tags;
}

/**
 * Embed metadata into a media file
 */
export async function embedMetadata(filePath: string, memory: SnapchatMemory): Promise<void> {
  const tags = buildExifTags(memory);

  try {
    await exiftool.write(filePath, tags, {
      writeArgs: ['-overwrite_original'],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new MetadataError(filePath, message);
  }
}

/**
 * Check if a file type supports EXIF metadata
 */
export function supportsExif(extension: string): boolean {
  const supportedExtensions = ['jpg', 'jpeg', 'png', 'heic', 'mp4', 'mov'];
  return supportedExtensions.includes(extension.toLowerCase());
}

/**
 * Format GPS coordinates for display
 */
export function formatGpsForDisplay(coords: GpsCoordinates): string {
  const latDir = coords.latitude >= 0 ? 'N' : 'S';
  const lonDir = coords.longitude >= 0 ? 'E' : 'W';
  return `${Math.abs(coords.latitude).toFixed(6)}°${latDir}, ${Math.abs(coords.longitude).toFixed(6)}°${lonDir}`;
}

/**
 * Close exiftool process (call on application exit)
 */
export async function closeExiftool(): Promise<void> {
  await exiftool.end();
}

/**
 * Parser module for Snapchat JSON export files
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GpsCoordinates,
  MediaType,
  ParseError,
  RawSnapchatEntry,
  RawSnapchatExport,
  SnapchatMemory,
} from './types.js';

/**
 * Parse location string from Snapchat export
 * Format: "Latitude, Longitude: 41.714947, -93.46679"
 */
export function parseLocation(locationStr: string): GpsCoordinates | null {
  if (!locationStr || locationStr.trim() === '') {
    return null;
  }

  const match = locationStr.match(/Latitude,\s*Longitude:\s*([-\d.]+),\s*([-\d.]+)/);
  if (!match) {
    return null;
  }

  const latitude = parseFloat(match[1]);
  const longitude = parseFloat(match[2]);

  if (isNaN(latitude) || isNaN(longitude)) {
    return null;
  }

  return { latitude, longitude };
}

/**
 * Parse date string from Snapchat export
 * Format: "2025-12-30 16:47:52 UTC"
 */
export function parseDate(dateStr: string): Date {
  // Replace UTC with Z for proper ISO parsing
  const isoString = dateStr.replace(' UTC', 'Z').replace(' ', 'T');
  const date = new Date(isoString);

  if (isNaN(date.getTime())) {
    throw new ParseError(`Invalid date format: ${dateStr}`);
  }

  return date;
}

/**
 * Extract media ID from download URL
 */
export function extractMediaId(url: string): string {
  try {
    const urlObj = new URL(url);
    const mid = urlObj.searchParams.get('mid');
    if (mid) {
      return mid;
    }
  } catch {
    // Fall through to generate ID from URL
  }

  // Fallback: generate ID from URL hash
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16);
}

/**
 * Validate media type
 */
export function validateMediaType(mediaType: string): MediaType {
  if (mediaType === 'Image' || mediaType === 'Video') {
    return mediaType;
  }
  throw new ParseError(`Invalid media type: ${mediaType}`);
}

/**
 * Parse a single raw entry into a SnapchatMemory
 */
export function parseEntry(entry: RawSnapchatEntry): SnapchatMemory {
  return {
    date: parseDate(entry.Date),
    mediaType: validateMediaType(entry['Media Type']),
    location: parseLocation(entry.Location),
    downloadUrl: entry['Download Link'],
    mediaDownloadUrl: entry['Media Download Url'] || null,
    mediaId: extractMediaId(entry['Download Link']),
  };
}

/**
 * Validate that the JSON has the expected structure
 */
function isValidExport(data: unknown): data is RawSnapchatExport {
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj['Saved Media'])) {
    return false;
  }

  return true;
}

/**
 * Parse memories from raw JSON data
 */
export function parseMemories(data: unknown): SnapchatMemory[] {
  if (!isValidExport(data)) {
    throw new ParseError('Invalid Snapchat export format. Expected "Saved Media" array.');
  }

  const entries = data['Saved Media'];
  const memories: SnapchatMemory[] = [];

  for (const entry of entries) {
    try {
      memories.push(parseEntry(entry));
    } catch (error) {
      // Log warning but continue processing other entries
      console.warn(
        `Skipping invalid entry: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  return memories;
}

/**
 * Find the memories_history.json file in a Snapchat export folder
 */
export async function findMemoriesFile(exportPath: string): Promise<string> {
  // Try direct path first
  const directPath = join(exportPath, 'json', 'memories_history.json');

  try {
    await readFile(directPath);
    return directPath;
  } catch {
    // Try to find mydata~ folder
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(exportPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('mydata~')) {
        const nestedPath = join(exportPath, entry.name, 'json', 'memories_history.json');
        try {
          await readFile(nestedPath);
          return nestedPath;
        } catch {
          continue;
        }
      }
    }
  }

  throw new ParseError(
    `Could not find memories_history.json in ${exportPath}. ` +
      'Expected path: <export>/json/memories_history.json or <export>/mydata~*/json/memories_history.json'
  );
}

/**
 * Load and parse Snapchat memories from an export folder
 */
export async function loadMemories(exportPath: string): Promise<SnapchatMemory[]> {
  const memoriesFile = await findMemoriesFile(exportPath);
  const content = await readFile(memoriesFile, 'utf-8');

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    throw new ParseError('Invalid JSON in memories_history.json');
  }

  return parseMemories(data);
}

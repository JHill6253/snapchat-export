/**
 * Parser module for Snapchat JSON and HTML export files
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
 * Result from finding memories file
 */
interface MemoriesFileResult {
  path: string;
  type: 'json' | 'html';
}

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
 * Decode HTML entities in a string
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

/**
 * Extract URL from onclick handler in HTML
 * Format: onclick="downloadMemories('https://...', this, true); return false;"
 */
function extractUrlFromOnclick(onclick: string): string | null {
  const match = onclick.match(/downloadMemories\s*\(\s*'([^']+)'/);
  if (match) {
    return decodeHtmlEntities(match[1]);
  }
  return null;
}

/**
 * Parse memories from HTML table content
 * Parses the memories_history.html format when JSON is not available
 */
export function parseMemoriesFromHtml(html: string): SnapchatMemory[] {
  const memories: SnapchatMemory[] = [];

  // Find all table rows (skip header row)
  // Each data row has format: <tr><td>date</td><td>mediaType</td><td>location</td><td>download link</td></tr>
  const rowRegex =
    /<tr>\s*<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>\s*<td>([^<]*)<\/td>\s*<td>.*?onclick="([^"]+)".*?<\/td>\s*<\/tr>/g;

  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const [, dateStr, mediaTypeStr, locationStr, onclick] = match;

    try {
      const downloadUrl = extractUrlFromOnclick(onclick);
      if (!downloadUrl) {
        console.warn('Skipping row: could not extract download URL from onclick handler');
        continue;
      }

      const memory: SnapchatMemory = {
        date: parseDate(dateStr.trim()),
        mediaType: validateMediaType(mediaTypeStr.trim()),
        location: parseLocation(locationStr.trim()),
        downloadUrl: downloadUrl,
        mediaDownloadUrl: null, // HTML format doesn't have overlay URLs
        mediaId: extractMediaId(downloadUrl),
      };

      memories.push(memory);
    } catch (error) {
      console.warn(
        `Skipping invalid HTML row: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  if (memories.length === 0) {
    throw new ParseError(
      'Could not parse any memories from HTML. The file format may have changed.'
    );
  }

  return memories;
}

/**
 * Try to read a file, returns null if it doesn't exist
 */
async function tryReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Find the memories file (JSON or HTML) in a Snapchat export folder
 * Prefers JSON but falls back to HTML if JSON is not available
 */
export async function findMemoriesFile(exportPath: string): Promise<MemoriesFileResult> {
  const { readdir } = await import('node:fs/promises');

  // Paths to check in order of preference
  const pathsToCheck: Array<{ jsonPath: string; htmlPath: string }> = [];

  // Direct paths
  pathsToCheck.push({
    jsonPath: join(exportPath, 'json', 'memories_history.json'),
    htmlPath: join(exportPath, 'html', 'memories_history.html'),
  });

  // Look for mydata~ folders
  try {
    const entries = await readdir(exportPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('mydata~')) {
        pathsToCheck.push({
          jsonPath: join(exportPath, entry.name, 'json', 'memories_history.json'),
          htmlPath: join(exportPath, entry.name, 'html', 'memories_history.html'),
        });
      }
    }
  } catch {
    // Ignore readdir errors
  }

  // Try each location, preferring JSON over HTML
  for (const { jsonPath, htmlPath } of pathsToCheck) {
    // Try JSON first
    const jsonContent = await tryReadFile(jsonPath);
    if (jsonContent !== null) {
      return { path: jsonPath, type: 'json' };
    }

    // Fall back to HTML
    const htmlContent = await tryReadFile(htmlPath);
    if (htmlContent !== null) {
      return { path: htmlPath, type: 'html' };
    }
  }

  throw new ParseError(
    `Could not find memories_history.json or memories_history.html in ${exportPath}. ` +
      'Expected path: <export>/json/memories_history.json, <export>/html/memories_history.html, ' +
      'or <export>/mydata~*/json/memories_history.json, <export>/mydata~*/html/memories_history.html'
  );
}

/**
 * Load and parse Snapchat memories from an export folder
 * Supports both JSON and HTML export formats
 */
export async function loadMemories(exportPath: string): Promise<SnapchatMemory[]> {
  const fileResult = await findMemoriesFile(exportPath);
  const content = await readFile(fileResult.path, 'utf-8');

  if (fileResult.type === 'json') {
    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch {
      throw new ParseError('Invalid JSON in memories_history.json');
    }
    return parseMemories(data);
  } else {
    // Parse HTML format
    return parseMemoriesFromHtml(content);
  }
}

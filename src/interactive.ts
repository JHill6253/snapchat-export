/**
 * Interactive CLI module for guided user experience
 */

import { input, confirm, select } from '@inquirer/prompts';
import { stat, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { loadMemories } from './parser.js';
import { checkOverlayUrlsExpired } from './downloader.js';
import { SnapchatMemory } from './types.js';

/**
 * Represents a found Snapchat export folder
 */
interface FoundExport {
  readonly path: string;
  readonly name: string;
  readonly timestamp: string;
}

/**
 * Common locations to search for Snapchat exports
 */
function getSearchLocations(): string[] {
  const home = homedir();
  return [
    process.cwd(), // Current working directory (highest priority)
    join(home, 'Downloads'),
    join(home, 'Desktop'),
    home,
    join(home, 'Documents'),
  ];
}

/**
 * Search a directory for Snapchat export folders (mydata~*)
 * Searches the directory itself and one level of subdirectories
 */
async function searchDirectoryForExports(dir: string, depth = 0): Promise<FoundExport[]> {
  const exports: FoundExport[] = [];
  const MAX_DEPTH = 1; // Search one level deep into subdirectories

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = join(dir, entry.name);

        if (entry.name.startsWith('mydata~')) {
          // Found an export folder
          const timestamp = entry.name.replace('mydata~', '');
          exports.push({
            path: fullPath,
            name: entry.name,
            timestamp,
          });
        } else if (depth < MAX_DEPTH && !entry.name.startsWith('.')) {
          // Search one level deeper (skip hidden folders)
          const subExports = await searchDirectoryForExports(fullPath, depth + 1);
          exports.push(...subExports);
        }
      }
    }
  } catch {
    // Directory not accessible, skip silently
  }

  return exports;
}

/**
 * Find all Snapchat export folders in common locations
 */
async function findSnapchatExports(): Promise<FoundExport[]> {
  const searchLocations = getSearchLocations();
  const allExports: FoundExport[] = [];

  // Search all locations in parallel
  const results = await Promise.all(searchLocations.map(searchDirectoryForExports));

  for (const exports of results) {
    allExports.push(...exports);
  }

  // Sort by timestamp descending (newest first)
  allExports.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  // Remove duplicates (in case of overlapping search paths)
  const seen = new Set<string>();
  return allExports.filter((exp) => {
    if (seen.has(exp.path)) return false;
    seen.add(exp.path);
    return true;
  });
}

/**
 * Format a timestamp from folder name to readable date
 */
function formatExportTimestamp(timestamp: string): string {
  // Snapchat uses Unix timestamp in milliseconds
  const ms = parseInt(timestamp, 10);
  if (isNaN(ms)) return timestamp;

  const date = new Date(ms);
  if (isNaN(date.getTime())) return timestamp;

  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Speed presets for download configuration
 */
export interface SpeedPreset {
  readonly name: string;
  readonly concurrency: number;
  readonly delay: number;
  readonly description: string;
}

export const SPEED_PRESETS: Record<string, SpeedPreset> = {
  slow: {
    name: 'Slow',
    concurrency: 2,
    delay: 2000,
    description: 'For unreliable connections',
  },
  normal: {
    name: 'Normal',
    concurrency: 5,
    delay: 500,
    description: 'Recommended',
  },
  fast: {
    name: 'Fast',
    concurrency: 10,
    delay: 250,
    description: 'May hit rate limits',
  },
};

/**
 * Interactive session configuration result
 */
export interface InteractiveConfig {
  readonly exportPath: string;
  readonly outputDir: string;
  readonly format: 'date' | 'flat';
  readonly importToPhotos: boolean;
  readonly concurrency: number;
  readonly delay: number;
  readonly skipOverlay: boolean;
  readonly dateFilter: {
    enabled: boolean;
    startDate?: Date;
    endDate?: Date;
  };
  readonly memories: readonly SnapchatMemory[];
  readonly filteredMemories: readonly SnapchatMemory[];
}

/**
 * Print the welcome banner
 */
function printBanner(): void {
  console.log();
  console.log('===========================================');
  console.log('       Snapchat Memory Export Tool         ');
  console.log('===========================================');
  console.log();
}

/**
 * Validate that a path exists and is a directory
 */
async function validateExportPath(path: string): Promise<boolean> {
  try {
    const resolved = resolve(path.trim());
    const stats = await stat(resolved);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Parse a date string in YYYY-MM-DD format
 */
function parseDate(dateStr: string): Date | null {
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1; // JS months are 0-indexed
  const day = parseInt(match[3], 10);

  const date = new Date(year, month, day);
  if (isNaN(date.getTime())) return null;

  return date;
}

/**
 * Format a date for display
 */
function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Get date range of memories
 */
function getDateRange(memories: readonly SnapchatMemory[]): { earliest: Date; latest: Date } {
  const dates = memories.map((m) => m.date.getTime());
  return {
    earliest: new Date(Math.min(...dates)),
    latest: new Date(Math.max(...dates)),
  };
}

/**
 * Filter memories by date range
 */
function filterByDateRange(
  memories: readonly SnapchatMemory[],
  startDate?: Date,
  endDate?: Date
): SnapchatMemory[] {
  return memories.filter((m) => {
    if (startDate && m.date < startDate) return false;
    if (endDate) {
      // Include the entire end day
      const endOfDay = new Date(endDate);
      endOfDay.setHours(23, 59, 59, 999);
      if (m.date > endOfDay) return false;
    }
    return true;
  });
}

/**
 * Estimate download time
 */
function estimateTime(count: number, delay: number, concurrency: number): string {
  const totalMs = (count / concurrency) * delay;
  const totalSeconds = Math.ceil(totalMs / 1000);

  if (totalSeconds < 60) {
    return `~${totalSeconds} seconds`;
  }

  const minutes = Math.ceil(totalSeconds / 60);
  if (minutes < 60) {
    return `~${minutes} minutes`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `~${hours}h ${remainingMinutes}m`;
}

/**
 * Run the interactive prompts and return configuration
 */
export async function runInteractivePrompts(): Promise<InteractiveConfig | null> {
  printBanner();

  // Step 1: Get export path
  let exportPath = '';
  let memories: SnapchatMemory[] = [];
  let pathValid = false;

  // Search for existing Snapchat exports
  console.log('  Searching for Snapchat exports...');
  const foundExports = await findSnapchatExports();

  if (foundExports.length > 0) {
    console.log(`  Found ${foundExports.length} export${foundExports.length > 1 ? 's' : ''}!`);
    console.log();

    // Build choices for selection
    const choices = [
      ...foundExports.map((exp) => ({
        name: `${exp.name} (${formatExportTimestamp(exp.timestamp)})`,
        value: exp.path,
      })),
      { name: 'Enter a different path...', value: '__manual__' },
    ];

    const selectedPath = await select({
      message: 'Select a Snapchat export:',
      choices,
    });

    if (selectedPath !== '__manual__') {
      exportPath = selectedPath;

      // Try to load memories from selected path
      try {
        console.log();
        console.log('  Loading memories...');
        memories = await loadMemories(exportPath);

        if (memories.length > 0) {
          pathValid = true;
        } else {
          console.log('  No memories found in this export.');
        }
      } catch (error) {
        console.log(`  Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  } else {
    console.log('  No exports found in common locations.');
    console.log();
  }

  // Manual path entry (if no exports found or user chose manual entry)
  while (!pathValid) {
    exportPath = await input({
      message: 'Path to your Snapchat export folder:',
      validate: async (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return 'Please enter a path';
        }
        const isValid = await validateExportPath(trimmed);
        if (!isValid) {
          return 'Path does not exist or is not a directory';
        }
        return true;
      },
    });

    exportPath = resolve(exportPath.trim());

    // Try to load memories
    try {
      console.log();
      console.log('  Loading memories...');
      memories = await loadMemories(exportPath);

      if (memories.length === 0) {
        console.log('  No memories found in this export.');
        const tryAgain = await confirm({
          message: 'Try a different path?',
          default: true,
        });
        if (!tryAgain) {
          return null;
        }
        continue;
      }

      pathValid = true;
    } catch (error) {
      console.log(`  Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      const tryAgain = await confirm({
        message: 'Try a different path?',
        default: true,
      });
      if (!tryAgain) {
        return null;
      }
    }
  }

  // Display summary
  const images = memories.filter((m) => m.mediaType === 'Image').length;
  const videos = memories.filter((m) => m.mediaType === 'Video').length;
  const withLocation = memories.filter((m) => m.location !== null).length;
  const { earliest, latest } = getDateRange(memories);

  console.log();
  console.log(`  Found ${memories.length} memories`);
  console.log(`  - ${images} images`);
  console.log(`  - ${videos} videos`);
  console.log(`  - ${withLocation} with GPS location`);
  console.log(`  - Date range: ${formatDate(earliest)} - ${formatDate(latest)}`);
  console.log();

  // Step 2: Output directory
  const outputDir = await input({
    message: 'Output directory:',
    default: './snapchat-exports',
  });

  // Step 3: Date range filter
  const useDateFilter = await confirm({
    message: 'Filter by date range?',
    default: false,
  });

  let dateFilter: InteractiveConfig['dateFilter'] = { enabled: false };
  let filteredMemories = memories;

  if (useDateFilter) {
    const startDateStr = await input({
      message: 'Start date (YYYY-MM-DD):',
      default: earliest.toISOString().split('T')[0],
      validate: (value) => {
        if (!parseDate(value)) {
          return 'Please enter a valid date in YYYY-MM-DD format';
        }
        return true;
      },
    });

    const endDateStr = await input({
      message: 'End date (YYYY-MM-DD):',
      default: latest.toISOString().split('T')[0],
      validate: (value) => {
        if (!parseDate(value)) {
          return 'Please enter a valid date in YYYY-MM-DD format';
        }
        return true;
      },
    });

    const startDate = parseDate(startDateStr)!;
    const endDate = parseDate(endDateStr)!;

    dateFilter = { enabled: true, startDate, endDate };
    filteredMemories = filterByDateRange(memories, startDate, endDate);

    console.log();
    console.log(`  Filtered to ${filteredMemories.length} memories`);
    console.log();

    if (filteredMemories.length === 0) {
      console.log('  No memories match the date range.');
      return null;
    }
  }

  // Step 4: File organization
  const format = await select({
    message: 'File organization:',
    choices: [
      { name: 'By date (2024/01/photo.jpg)', value: 'date' as const },
      { name: 'Flat (all in one folder)', value: 'flat' as const },
    ],
    default: 'date',
  });

  // Step 5: Apple Photos import
  const importToPhotos = await confirm({
    message: 'Import to Apple Photos after download?',
    default: true,
  });

  // Step 6: Download speed
  const speedChoice = await select({
    message: 'Download speed:',
    choices: [
      {
        name: `Normal - ${SPEED_PRESETS.normal.concurrency} parallel (${SPEED_PRESETS.normal.description})`,
        value: 'normal',
      },
      {
        name: `Fast - ${SPEED_PRESETS.fast.concurrency} parallel (${SPEED_PRESETS.fast.description})`,
        value: 'fast',
      },
      {
        name: `Slow - ${SPEED_PRESETS.slow.concurrency} parallel (${SPEED_PRESETS.slow.description})`,
        value: 'slow',
      },
    ],
    default: 'normal',
  });

  const speedPreset = SPEED_PRESETS[speedChoice];

  // Check overlay URL expiration
  let skipOverlay = false;
  const expirationInfo = checkOverlayUrlsExpired(filteredMemories);
  if (expirationInfo?.isExpired) {
    console.log();
    console.log(`  Note: Overlay URLs appear expired (${expirationInfo.ageHours} hours old).`);
    console.log('  Overlays will not be applied to photos/videos.');
    console.log('  For overlays, request a fresh Snapchat export and run immediately.');
    skipOverlay = true;
  } else if (expirationInfo && expirationInfo.ageHours > 3) {
    console.log();
    console.log(
      `  Note: Export is ${expirationInfo.ageHours} hours old. Overlay URLs may expire soon.`
    );
  }

  // Step 7: Confirmation
  console.log();
  console.log('-------------------------------------------');
  console.log('  Summary');
  console.log('-------------------------------------------');
  console.log(`  Memories to download: ${filteredMemories.length}`);
  console.log(`  Output: ${resolve(outputDir)}`);
  console.log(`  Organization: ${format === 'date' ? 'By date' : 'Flat'}`);
  console.log(`  Apple Photos: ${importToPhotos ? 'Yes' : 'No'}`);
  console.log(`  Speed: ${speedPreset.name} (${speedPreset.concurrency} parallel)`);
  if (skipOverlay) {
    console.log('  Overlays: Disabled (URLs expired)');
  }
  console.log(
    `  Estimated time: ${estimateTime(filteredMemories.length, speedPreset.delay, speedPreset.concurrency)}`
  );
  console.log('-------------------------------------------');
  console.log();

  const proceed = await confirm({
    message: 'Start download?',
    default: true,
  });

  if (!proceed) {
    console.log('  Download cancelled.');
    return null;
  }

  return {
    exportPath,
    outputDir: resolve(outputDir),
    format,
    importToPhotos,
    concurrency: speedPreset.concurrency,
    delay: speedPreset.delay,
    skipOverlay,
    dateFilter,
    memories,
    filteredMemories,
  };
}

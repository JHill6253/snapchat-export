/**
 * Apple Photos integration module
 * Uses AppleScript via osascript to import media into Photos.app
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';

const execAsync = promisify(exec);

/**
 * Check if we're running on macOS
 */
export function isMacOS(): boolean {
  return process.platform === 'darwin';
}

/**
 * Check if Photos.app is available
 */
export async function isPhotosAvailable(): Promise<boolean> {
  if (!isMacOS()) {
    return false;
  }

  // Photos.app can be in different locations depending on macOS version
  const possiblePaths = ['/Applications/Photos.app', '/System/Applications/Photos.app'];

  for (const path of possiblePaths) {
    try {
      await access(path);
      return true;
    } catch {
      // Continue to next path
    }
  }

  return false;
}

/**
 * Import a single file into Apple Photos
 * Returns true if successful, false otherwise
 */
export async function importToPhotos(filePath: string): Promise<boolean> {
  if (!isMacOS()) {
    throw new Error('Apple Photos import is only available on macOS');
  }

  // Escape the file path for AppleScript
  const escapedPath = filePath.replace(/"/g, '\\"');

  // AppleScript to import file into Photos
  // Using POSIX file to handle the path correctly
  const script = `
    tell application "Photos"
      import POSIX file "${escapedPath}"
    end tell
  `;

  try {
    await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
    return true;
  } catch (error) {
    // Log the error but don't throw - caller can handle failures
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Failed to import ${filePath}: ${message}`);
    return false;
  }
}

/**
 * Import multiple files into Apple Photos with progress callback
 */
export async function importBatchToPhotos(
  filePaths: readonly string[],
  options: {
    onProgress?: (current: number, total: number, filePath: string) => void;
    onError?: (filePath: string, error: Error) => void;
    delayMs?: number;
  } = {}
): Promise<{ imported: number; failed: number }> {
  const { onProgress, onError, delayMs = 500 } = options;

  let imported = 0;
  let failed = 0;

  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i];

    if (onProgress) {
      onProgress(i + 1, filePaths.length, filePath);
    }

    try {
      const success = await importToPhotos(filePath);
      if (success) {
        imported++;
      } else {
        failed++;
      }
    } catch (error) {
      failed++;
      if (onError) {
        onError(filePath, error instanceof Error ? error : new Error('Unknown error'));
      }
    }

    // Small delay between imports to avoid overwhelming Photos.app
    if (i < filePaths.length - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return { imported, failed };
}

/**
 * Open Photos.app (useful to show the user their imports)
 */
export async function openPhotosApp(): Promise<void> {
  if (!isMacOS()) {
    throw new Error('Apple Photos is only available on macOS');
  }

  await execAsync('open -a Photos');
}

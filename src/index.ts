#!/usr/bin/env node
/**
 * Snapchat Memory Export Tool
 * CLI entry point
 */

import { createProgram, shouldRunInteractive, runExport } from './cli.js';
import { runInteractivePrompts } from './interactive.js';
import { closeExiftool } from './metadata.js';
import { DEFAULT_MAX_RETRIES } from './downloader.js';

async function main(): Promise<void> {
  // Check if we should run in interactive mode
  if (shouldRunInteractive(process.argv)) {
    try {
      const config = await runInteractivePrompts();

      if (!config) {
        // User cancelled
        process.exitCode = 0;
        return;
      }

      // Run the export with interactive config
      await runExport(config.exportPath, {
        outputDir: config.outputDir,
        format: config.format,
        dryRun: false,
        skipExisting: false,
        delay: config.delay,
        concurrency: config.concurrency,
        maxRetries: DEFAULT_MAX_RETRIES,
        importToPhotos: config.importToPhotos,
        limit: null,
        skipOverlay: config.skipOverlay,
        // Pass pre-loaded memories to avoid re-loading
        preloadedMemories: config.filteredMemories,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') {
        // User pressed Ctrl+C during prompts
        console.log('\nExport cancelled.');
        process.exitCode = 0;
      } else {
        console.error('Error:', error instanceof Error ? error.message : 'Unknown error');
        process.exitCode = 1;
      }
    } finally {
      await closeExiftool();
    }
    return;
  }

  // Standard CLI mode
  const program = createProgram();
  program.parse();
}

void main();

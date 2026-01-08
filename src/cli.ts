/**
 * CLI module for Snapchat Memory Export tool
 */

import { Command } from 'commander';
import ora from 'ora';
import cliProgress from 'cli-progress';
import { loadMemories } from './parser.js';
import {
  downloadMemory,
  downloadMediaWithOverlay,
  sleep,
  checkOverlayUrlsExpired,
  DEFAULT_DOWNLOAD_DELAY_MS,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_RETRIES,
  DownloadedMedia,
} from './downloader.js';
import { saveMemory, formatStats, ensureDir } from './exporter.js';
import { closeExiftool, formatGpsForDisplay } from './metadata.js';
import { ExportOptions, ExportStats, SnapchatMemory, ExportManifest } from './types.js';
import {
  loadManifest,
  saveManifest,
  filterPendingMemories,
  addManifestEntry,
  getManifestStats,
} from './manifest.js';
import { isPhotosAvailable, importToPhotos } from './photos.js';
import { compositeMedia, CompositeError } from './compositor.js';

/**
 * Check if running in interactive mode (no arguments provided)
 */
export function shouldRunInteractive(argv: string[]): boolean {
  // argv[0] = node, argv[1] = script path
  // If only those two, or if -i/--interactive flag is present, run interactive
  const args = argv.slice(2);

  if (args.length === 0) {
    return true;
  }

  if (args.includes('-i') || args.includes('--interactive')) {
    return true;
  }

  return false;
}

/**
 * Create and configure the CLI program
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name('snapchat-export')
    .description('Export Snapchat memories with preserved metadata')
    .version('1.0.0')
    .argument(
      '[path]',
      'Path to Snapchat export folder (containing mydata~ folder or json/ folder)'
    )
    .option('-o, --output <dir>', 'Output directory', './snapchat-exports')
    .option('-f, --format <format>', 'Organization format: date or flat', 'date')
    .option('--dry-run', 'Show what would be downloaded without downloading', false)
    .option('--skip-existing', 'Skip files that already exist in output', false)
    .option(
      '--delay <ms>',
      'Delay between downloads in milliseconds',
      String(DEFAULT_DOWNLOAD_DELAY_MS)
    )
    .option('-c, --concurrency <n>', 'Number of concurrent downloads', String(DEFAULT_CONCURRENCY))
    .option(
      '-r, --max-retries <n>',
      'Max retries for failed downloads (with exponential backoff)',
      String(DEFAULT_MAX_RETRIES)
    )
    .option('--photos', 'Import downloaded files into Apple Photos (macOS only)', false)
    .option('-l, --limit <n>', 'Limit number of memories to process (for testing)')
    .option('--no-overlay', 'Skip overlay compositing (faster if overlay URLs are expired)', false)
    .option('-i, --interactive', 'Run in interactive mode with guided prompts', false)
    .action(async (exportPath: string | undefined, opts: Record<string, unknown>) => {
      // If no path provided and not explicitly interactive, this is handled by index.ts
      if (!exportPath) {
        console.error('Error: No export path provided. Use -i for interactive mode.');
        process.exitCode = 1;
        return;
      }

      await runExport(exportPath, {
        outputDir: opts.output as string,
        format: opts.format as 'date' | 'flat',
        dryRun: opts.dryRun as boolean,
        skipExisting: opts.skipExisting as boolean,
        delay: parseInt(opts.delay as string, 10),
        concurrency: parseInt(opts.concurrency as string, 10),
        maxRetries: parseInt(opts.maxRetries as string, 10),
        importToPhotos: opts.photos as boolean,
        limit: opts.limit ? parseInt(opts.limit as string, 10) : null,
        skipOverlay: opts.overlay === false, // --no-overlay sets overlay to false
      });
    });

  return program;
}

/**
 * Estimate download time
 */
function estimateTime(count: number, delay: number, concurrency: number): string {
  // Each worker processes items with delay between them
  // Effective time = (count / concurrency) * delay
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
 * Main export execution - exported for use by interactive mode
 */
export async function runExport(exportPath: string, options: ExportOptions): Promise<void> {
  const spinner = ora('Loading Snapchat export...').start();

  try {
    // Check Photos availability if requested
    if (options.importToPhotos) {
      const photosAvailable = await isPhotosAvailable();
      if (!photosAvailable) {
        spinner.fail('Apple Photos is not available (macOS only)');
        process.exitCode = 1;
        return;
      }
      spinner.text = 'Apple Photos available. Loading Snapchat export...';
    }

    // Load memories (use preloaded from interactive mode if available)
    let memories: SnapchatMemory[];
    if (options.preloadedMemories && options.preloadedMemories.length > 0) {
      memories = [...options.preloadedMemories];
      spinner.succeed(`Using ${memories.length} pre-loaded memories`);
    } else {
      memories = await loadMemories(exportPath);
      spinner.succeed(`Found ${memories.length} memories`);
    }

    if (memories.length === 0) {
      console.log('No memories to export.');
      return;
    }

    // Show summary
    const images = memories.filter((m) => m.mediaType === 'Image').length;
    const videos = memories.filter((m) => m.mediaType === 'Video').length;
    const withLocation = memories.filter((m) => m.location !== null).length;

    console.log(`  Images: ${images}`);
    console.log(`  Videos: ${videos}`);
    console.log(`  With GPS location: ${withLocation}`);
    console.log(`  Date range: ${formatDateRange(memories)}`);

    // Check overlay URL expiration and warn user
    let effectiveSkipOverlay = options.skipOverlay;
    if (!effectiveSkipOverlay) {
      const expirationInfo = checkOverlayUrlsExpired(memories);
      if (expirationInfo?.isExpired) {
        console.log();
        console.log(
          `  Warning: Overlay URLs appear to be expired (${expirationInfo.ageHours} hours old).`
        );
        console.log('  Overlays will not be applied. Use --no-overlay to skip overlay attempts.');
        console.log('  For overlays, request a fresh Snapchat export and run immediately.');
        effectiveSkipOverlay = true;
      } else if (expirationInfo && expirationInfo.ageHours > 3) {
        console.log();
        console.log(
          `  Note: Export is ${expirationInfo.ageHours} hours old. Overlay URLs may expire soon.`
        );
      }
    }
    console.log();

    // Dry run mode
    if (options.dryRun) {
      const displayMemories = options.limit ? memories.slice(0, options.limit) : memories;
      console.log('Dry run mode - showing what would be downloaded:');
      console.log();
      for (const memory of displayMemories) {
        const location = memory.location ? formatGpsForDisplay(memory.location) : 'No location';
        console.log(`  ${memory.date.toISOString()} | ${memory.mediaType} | ${location}`);
      }
      console.log();
      console.log(`Would download ${displayMemories.length} files to: ${options.outputDir}`);
      if (options.importToPhotos) {
        console.log('Would import to Apple Photos after download');
      }
      console.log(
        `Estimated time: ${estimateTime(displayMemories.length, options.delay, options.concurrency)}`
      );
      return;
    }

    // Ensure output directory exists
    await ensureDir(options.outputDir);

    // Load manifest for resume capability
    const manifest = await loadManifest(options.outputDir);
    const manifestStats = getManifestStats(manifest);

    // Filter out already-downloaded memories
    let pendingMemories = filterPendingMemories(memories, manifest);
    const alreadyDownloaded = memories.length - pendingMemories.length;

    if (alreadyDownloaded > 0) {
      console.log(
        `Previously downloaded: ${alreadyDownloaded} (${manifestStats.images} images, ${manifestStats.videos} videos)`
      );
      console.log(`Remaining: ${pendingMemories.length}`);
      console.log();
    }

    // Apply limit if specified
    if (options.limit && options.limit < pendingMemories.length) {
      console.log(`Limiting to ${options.limit} memories (--limit flag)`);
      pendingMemories = pendingMemories.slice(0, options.limit);
      console.log();
    }

    if (pendingMemories.length === 0) {
      console.log('All memories already downloaded! Nothing to do.');
      return;
    }

    // Download with progress bar
    console.log(`Downloading to: ${options.outputDir}`);
    console.log(`Concurrency: ${options.concurrency} parallel downloads`);
    console.log(`Delay between downloads: ${options.delay}ms`);
    console.log(`Max retries: ${options.maxRetries} (with exponential backoff)`);
    if (effectiveSkipOverlay) {
      console.log('Overlay compositing: disabled');
    }
    if (options.importToPhotos) {
      console.log('Will import to Apple Photos after download');
    }
    console.log(
      `Estimated time: ${estimateTime(pendingMemories.length, options.delay, options.concurrency)}`
    );
    console.log();

    const { stats, importedPaths } = await downloadWithProgress(
      pendingMemories,
      { ...options, skipOverlay: effectiveSkipOverlay },
      manifest
    );

    console.log();
    console.log('Download complete!');
    console.log(formatStats(stats));

    // Import to Apple Photos if requested
    if (options.importToPhotos && importedPaths.length > 0) {
      console.log();
      await importToApplePhotos(importedPaths);
    }
  } catch (error) {
    spinner.fail('Export failed');
    console.error(error instanceof Error ? error.message : 'Unknown error');
    process.exitCode = 1;
  } finally {
    // Clean up exiftool process
    await closeExiftool();
  }
}

/**
 * Format date range for display
 */
function formatDateRange(memories: readonly SnapchatMemory[]): string {
  if (memories.length === 0) return 'N/A';

  const dates = memories.map((m) => m.date.getTime());
  const earliest = new Date(Math.min(...dates));
  const latest = new Date(Math.max(...dates));

  const formatDate = (d: Date): string =>
    d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  if (earliest.toDateString() === latest.toDateString()) {
    return formatDate(earliest);
  }

  return `${formatDate(earliest)} - ${formatDate(latest)}`;
}

/**
 * Download memories with CLI progress bar using concurrent downloads
 */
async function downloadWithProgress(
  memories: readonly SnapchatMemory[],
  options: ExportOptions,
  manifest: ExportManifest
): Promise<{ stats: ExportStats; importedPaths: string[] }> {
  const progressBar = new cliProgress.SingleBar(
    {
      format:
        'Downloading |{bar}| {percentage}% | {value}/{total} | {rate}/s | ETA: {eta_formatted} | Retries: {retries}',
      hideCursor: true,
      etaBuffer: 50,
    },
    cliProgress.Presets.shades_classic
  );

  const stats: ExportStats = {
    total: memories.length,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    images: 0,
    videos: 0,
    retries: 0,
  };

  const importedPaths: string[] = [];

  progressBar.start(memories.length, 0, { retries: 0 });

  // Create a queue of memories to process
  const queue = [...memories];

  /**
   * Process a single memory: download, composite overlay if present, save, update stats
   */
  const processMemory = async (memory: SnapchatMemory): Promise<void> => {
    try {
      let media: DownloadedMedia;

      // Try to download with overlay support if mediaDownloadUrl is available and not skipping overlays
      if (memory.mediaDownloadUrl && !options.skipOverlay) {
        try {
          const extracted = await downloadMediaWithOverlay(memory, {
            maxRetries: options.maxRetries,
            onRetry: (attempt, delay, error) => {
              stats.retries++;
              progressBar.update({ retries: stats.retries });
              console.error(
                `\n  Retry ${attempt}/${options.maxRetries} for ${memory.mediaId.substring(0, 8)}... ` +
                  `(waiting ${Math.round(delay / 1000)}s, error: ${error.message.substring(0, 50)})`
              );
            },
          });

          // Composite the overlay if present
          try {
            const composited = await compositeMedia(
              extracted.baseMedia,
              extracted.overlay,
              memory.mediaType
            );
            media = {
              data: composited.data,
              contentType: composited.contentType,
              extension: composited.extension,
            };
          } catch (compError) {
            // If compositing fails, log warning and use base media
            if (compError instanceof CompositeError) {
              console.error(
                `\n  Warning: Compositing failed for ${memory.mediaId.substring(0, 8)}: ${compError.message}. Using base media.`
              );
            }
            media = {
              data: extracted.baseMedia,
              contentType: memory.mediaType === 'Image' ? 'image/jpeg' : 'video/mp4',
              extension: extracted.baseMediaType,
            };
          }
        } catch (overlayError) {
          // If overlay download fails, fall back to regular download
          // This commonly happens when mediaDownloadUrl has expired
          const errorMsg = overlayError instanceof Error ? overlayError.message : 'Unknown error';
          // Only log on first occurrence to avoid spam
          if (stats.downloaded === 0 && stats.failed === 0) {
            console.error(
              `\n  Note: Overlay download failed (${errorMsg.substring(0, 60)}). ` +
                `Falling back to regular download (overlays will not be applied).`
            );
          }
          media = await downloadMemory(memory, {
            maxRetries: options.maxRetries,
            onRetry: (attempt, delay, error) => {
              stats.retries++;
              progressBar.update({ retries: stats.retries });
              console.error(
                `\n  Retry ${attempt}/${options.maxRetries} for ${memory.mediaId.substring(0, 8)}... ` +
                  `(waiting ${Math.round(delay / 1000)}s, error: ${error.message.substring(0, 50)})`
              );
            },
          });
        }
      } else {
        // No mediaDownloadUrl, use regular download
        media = await downloadMemory(memory, {
          maxRetries: options.maxRetries,
          onRetry: (attempt, delay, error) => {
            stats.retries++;
            progressBar.update({ retries: stats.retries });
            console.error(
              `\n  Retry ${attempt}/${options.maxRetries} for ${memory.mediaId.substring(0, 8)}... ` +
                `(waiting ${Math.round(delay / 1000)}s, error: ${error.message.substring(0, 50)})`
            );
          },
        });
      }

      try {
        const filePath = await saveMemory(memory, media, options);
        stats.downloaded++;
        importedPaths.push(filePath);
        if (memory.mediaType === 'Image') {
          stats.images++;
        } else {
          stats.videos++;
        }

        // Add to manifest and save (ensures resume capability)
        addManifestEntry(manifest, memory, filePath, media.data.length);
        await saveManifest(manifest);
      } catch (error) {
        if (error instanceof Error && error.message === 'File already exists') {
          stats.skipped++;
        } else {
          stats.failed++;
        }
      }
    } catch {
      stats.failed++;
    }

    progressBar.increment();
  };

  /**
   * Worker that pulls from queue and processes with delay
   */
  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const memory = queue.shift();
      if (!memory) break;

      await processMemory(memory);

      // Rate limiting delay
      if (queue.length > 0) {
        await sleep(options.delay);
      }
    }
  };

  // Start concurrent workers with staggered starts
  const workers: Promise<void>[] = [];
  const actualConcurrency = Math.min(options.concurrency, memories.length);

  for (let i = 0; i < actualConcurrency; i++) {
    // Stagger worker starts to avoid burst of requests
    if (i > 0) {
      await sleep(options.delay / actualConcurrency);
    }
    workers.push(worker());
  }

  // Wait for all workers to complete
  await Promise.all(workers);

  progressBar.stop();
  return { stats, importedPaths };
}

/**
 * Import files to Apple Photos with progress - exported for use by interactive mode
 */
export async function importToApplePhotos(filePaths: string[]): Promise<void> {
  const spinner = ora(`Importing ${filePaths.length} files to Apple Photos...`).start();

  const progressBar = new cliProgress.SingleBar(
    {
      format: 'Importing |{bar}| {percentage}% | {value}/{total}',
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic
  );

  let imported = 0;
  let failed = 0;

  progressBar.start(filePaths.length, 0);
  spinner.stop();

  for (const filePath of filePaths) {
    try {
      const success = await importToPhotos(filePath);
      if (success) {
        imported++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
    progressBar.increment();

    // Small delay between imports to avoid overwhelming Photos.app
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  progressBar.stop();

  console.log();
  console.log('Apple Photos import complete!');
  console.log(`  Imported: ${imported}`);
  if (failed > 0) {
    console.log(`  Failed: ${failed}`);
  }
}

/**
 * Compositor module for combining base media with overlay images
 *
 * Handles:
 * - Image compositing: base JPG + overlay PNG -> combined JPG
 * - Video compositing: base MP4 + overlay PNG -> combined MP4 (using ffmpeg)
 */

import { Jimp, JimpMime } from 'jimp';
import { spawn, spawnSync } from 'node:child_process';
import { writeFile, mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Get the ffmpeg path - tries bundled version first, then system ffmpeg
 */
function getFfmpegPath(): string {
  // Try to use @ffmpeg-installer/ffmpeg if available
  try {
    // Dynamic require to avoid bundling issues
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg') as { path?: string };
    if (ffmpegInstaller && ffmpegInstaller.path) {
      return ffmpegInstaller.path;
    }
  } catch {
    // Bundled ffmpeg not available, try system ffmpeg
  }

  // Check if system ffmpeg is available
  const result = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }

  // Fallback to 'ffmpeg' and let it fail at runtime if not in PATH
  return 'ffmpeg';
}

const FFMPEG_PATH = getFfmpegPath();

/**
 * Result of a composite operation
 */
export interface CompositeResult {
  readonly data: Buffer;
  readonly contentType: string;
  readonly extension: string;
}

/**
 * Error thrown when compositing fails
 */
export class CompositeError extends Error {
  constructor(
    public readonly mediaType: 'Image' | 'Video',
    message: string
  ) {
    super(`Failed to composite ${mediaType.toLowerCase()}: ${message}`);
    this.name = 'CompositeError';
  }
}

/**
 * Composite an image with an overlay PNG using Jimp (pure JavaScript)
 *
 * @param baseImage - The base image buffer (JPG/PNG)
 * @param overlay - The overlay image buffer (PNG with transparency)
 * @returns Combined image as JPEG buffer
 */
export async function compositeImage(baseImage: Buffer, overlay: Buffer): Promise<CompositeResult> {
  try {
    // Load both images
    const [base, overlayImg] = await Promise.all([Jimp.read(baseImage), Jimp.read(overlay)]);

    const baseWidth = base.width;
    const baseHeight = base.height;

    if (!baseWidth || !baseHeight) {
      throw new CompositeError('Image', 'Could not determine base image dimensions');
    }

    // Resize overlay to match base image if dimensions differ
    if (overlayImg.width !== baseWidth || overlayImg.height !== baseHeight) {
      overlayImg.resize({ w: baseWidth, h: baseHeight });
    }

    // Composite overlay on top of base image
    base.composite(overlayImg, 0, 0);

    // Convert to JPEG buffer
    const composited = await base.getBuffer(JimpMime.jpeg, { quality: 95 });

    return {
      data: composited,
      contentType: 'image/jpeg',
      extension: 'jpg',
    };
  } catch (error) {
    if (error instanceof CompositeError) {
      throw error;
    }
    throw new CompositeError(
      'Image',
      error instanceof Error ? error.message : 'Unknown error during compositing'
    );
  }
}

/**
 * Composite a video with an overlay PNG using ffmpeg
 *
 * @param baseVideo - The base video buffer (MP4)
 * @param overlay - The overlay image buffer (PNG with transparency)
 * @returns Combined video as MP4 buffer
 */
export async function compositeVideo(baseVideo: Buffer, overlay: Buffer): Promise<CompositeResult> {
  // Create a temporary directory for intermediate files
  const tempDir = await mkdtemp(join(tmpdir(), 'snapchat-composite-'));
  const tempVideoPath = join(tempDir, 'input.mp4');
  const tempOverlayPath = join(tempDir, 'overlay.png');
  const tempOutputPath = join(tempDir, 'output.mp4');

  try {
    // Write input files to temp directory
    await writeFile(tempVideoPath, baseVideo);
    await writeFile(tempOverlayPath, overlay);

    // Run ffmpeg to composite overlay onto video
    await runFfmpeg([
      '-i',
      tempVideoPath,
      '-i',
      tempOverlayPath,
      '-filter_complex',
      // Scale overlay to match video dimensions, then overlay it
      '[1:v]scale=iw:ih[scaled];[0:v][scaled]overlay=0:0:format=auto',
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '23',
      '-c:a',
      'copy', // Copy audio stream without re-encoding
      '-y', // Overwrite output
      tempOutputPath,
    ]);

    // Read the output file
    const outputData = await readFile(tempOutputPath);

    return {
      data: outputData,
      contentType: 'video/mp4',
      extension: 'mp4',
    };
  } catch (error) {
    if (error instanceof CompositeError) {
      throw error;
    }
    throw new CompositeError(
      'Video',
      error instanceof Error ? error.message : 'Unknown error during video compositing'
    );
  } finally {
    // Clean up temp directory
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Run ffmpeg with the given arguments
 */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(FFMPEG_PATH, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';

    ffmpeg.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    ffmpeg.on('error', (error) => {
      reject(new CompositeError('Video', `Failed to start ffmpeg: ${error.message}`));
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        // Extract the last few lines of stderr for error message
        const errorLines = stderr.trim().split('\n').slice(-5).join('\n');
        reject(new CompositeError('Video', `ffmpeg exited with code ${code}: ${errorLines}`));
      }
    });
  });
}

/**
 * Composite media with an overlay
 *
 * @param baseMedia - The base media buffer
 * @param overlay - The overlay PNG buffer (or null if no overlay)
 * @param mediaType - 'Image' or 'Video'
 * @returns Composited media, or original if no overlay
 */
export async function compositeMedia(
  baseMedia: Buffer,
  overlay: Buffer | null,
  mediaType: 'Image' | 'Video'
): Promise<CompositeResult> {
  // If no overlay, return the base media as-is
  if (!overlay) {
    if (mediaType === 'Image') {
      return {
        data: baseMedia,
        contentType: 'image/jpeg',
        extension: 'jpg',
      };
    } else {
      return {
        data: baseMedia,
        contentType: 'video/mp4',
        extension: 'mp4',
      };
    }
  }

  // Composite based on media type
  if (mediaType === 'Image') {
    return compositeImage(baseMedia, overlay);
  } else {
    return compositeVideo(baseMedia, overlay);
  }
}

/**
 * Check if ffmpeg is available
 */
export async function isFfmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const ffmpeg = spawn(FFMPEG_PATH, ['-version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    ffmpeg.on('error', () => {
      resolve(false);
    });

    ffmpeg.on('close', (code) => {
      resolve(code === 0);
    });
  });
}

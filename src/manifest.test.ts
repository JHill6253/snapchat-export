/**
 * Tests for the manifest module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createManifest,
  loadManifest,
  saveManifest,
  addManifestEntry,
  isDownloaded,
  getDownloadedIds,
  filterPendingMemories,
  getManifestStats,
  getManifestPath,
} from './manifest.js';
import { SnapchatMemory } from './types.js';

describe('manifest', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `manifest-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('getManifestPath', () => {
    it('should return correct manifest path', () => {
      const path = getManifestPath('/output/dir');
      expect(path).toBe('/output/dir/.snapchat-export-manifest.json');
    });
  });

  describe('createManifest', () => {
    it('should create empty manifest with correct structure', () => {
      const manifest = createManifest('/output');
      expect(manifest.version).toBe(1);
      expect(manifest.outputDir).toBe('/output');
      expect(manifest.entries).toEqual({});
      expect(manifest.createdAt).toBeDefined();
      expect(manifest.updatedAt).toBeDefined();
    });
  });

  describe('loadManifest', () => {
    it('should create new manifest if file does not exist', async () => {
      const manifest = await loadManifest(testDir);
      expect(manifest.version).toBe(1);
      expect(manifest.outputDir).toBe(testDir);
      expect(manifest.entries).toEqual({});
    });

    it('should load existing manifest from disk', async () => {
      // First save a manifest
      const original = createManifest(testDir);
      await saveManifest(original);

      // Then load it
      const loaded = await loadManifest(testDir);
      expect(loaded.version).toBe(1);
      expect(loaded.outputDir).toBe(testDir);
    });
  });

  describe('saveManifest', () => {
    it('should save manifest to disk as JSON', async () => {
      const manifest = createManifest(testDir);
      await saveManifest(manifest);

      const content = await readFile(getManifestPath(testDir), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.version).toBe(1);
      expect(parsed.outputDir).toBe(testDir);
    });

    it('should update updatedAt timestamp', async () => {
      const manifest = createManifest(testDir);
      const originalUpdatedAt = manifest.updatedAt;

      // Wait a tiny bit to ensure timestamp differs
      await new Promise((r) => setTimeout(r, 10));
      await saveManifest(manifest);

      expect(manifest.updatedAt).not.toBe(originalUpdatedAt);
    });
  });

  describe('addManifestEntry', () => {
    it('should add entry to manifest', () => {
      const manifest = createManifest(testDir);
      const memory: SnapchatMemory = {
        mediaId: 'test-id-123',
        date: new Date('2024-01-15T10:30:00Z'),
        mediaType: 'Image',
        location: { latitude: 41.71, longitude: -93.46 },
        downloadUrl: 'https://example.com/download',
      };

      const entry = addManifestEntry(manifest, memory, '/path/to/file.jpg', 12345);

      expect(entry.mediaId).toBe('test-id-123');
      expect(entry.filePath).toBe('/path/to/file.jpg');
      expect(entry.fileSize).toBe(12345);
      expect(entry.mediaType).toBe('Image');
      expect(manifest.entries['test-id-123']).toBe(entry);
    });
  });

  describe('isDownloaded', () => {
    it('should return true for downloaded media', () => {
      const manifest = createManifest(testDir);
      manifest.entries['existing-id'] = {
        mediaId: 'existing-id',
        downloadedAt: new Date().toISOString(),
        filePath: '/path/to/file.jpg',
        fileSize: 1000,
        mediaType: 'Image',
        originalDate: new Date().toISOString(),
      };

      expect(isDownloaded(manifest, 'existing-id')).toBe(true);
    });

    it('should return false for not-downloaded media', () => {
      const manifest = createManifest(testDir);
      expect(isDownloaded(manifest, 'non-existing-id')).toBe(false);
    });
  });

  describe('getDownloadedIds', () => {
    it('should return set of downloaded IDs', () => {
      const manifest = createManifest(testDir);
      manifest.entries['id-1'] = {
        mediaId: 'id-1',
        downloadedAt: new Date().toISOString(),
        filePath: '/path/1.jpg',
        fileSize: 1000,
        mediaType: 'Image',
        originalDate: new Date().toISOString(),
      };
      manifest.entries['id-2'] = {
        mediaId: 'id-2',
        downloadedAt: new Date().toISOString(),
        filePath: '/path/2.mp4',
        fileSize: 2000,
        mediaType: 'Video',
        originalDate: new Date().toISOString(),
      };

      const ids = getDownloadedIds(manifest);
      expect(ids.size).toBe(2);
      expect(ids.has('id-1')).toBe(true);
      expect(ids.has('id-2')).toBe(true);
    });
  });

  describe('filterPendingMemories', () => {
    it('should filter out already-downloaded memories', () => {
      const manifest = createManifest(testDir);
      manifest.entries['downloaded-id'] = {
        mediaId: 'downloaded-id',
        downloadedAt: new Date().toISOString(),
        filePath: '/path/to/file.jpg',
        fileSize: 1000,
        mediaType: 'Image',
        originalDate: new Date().toISOString(),
      };

      const memories: SnapchatMemory[] = [
        {
          mediaId: 'downloaded-id',
          date: new Date(),
          mediaType: 'Image',
          location: null,
          downloadUrl: 'https://example.com/1',
        },
        {
          mediaId: 'pending-id',
          date: new Date(),
          mediaType: 'Video',
          location: null,
          downloadUrl: 'https://example.com/2',
        },
      ];

      const pending = filterPendingMemories(memories, manifest);
      expect(pending.length).toBe(1);
      expect(pending[0].mediaId).toBe('pending-id');
    });

    it('should return all memories if none are downloaded', () => {
      const manifest = createManifest(testDir);
      const memories: SnapchatMemory[] = [
        {
          mediaId: 'id-1',
          date: new Date(),
          mediaType: 'Image',
          location: null,
          downloadUrl: 'https://example.com/1',
        },
        {
          mediaId: 'id-2',
          date: new Date(),
          mediaType: 'Video',
          location: null,
          downloadUrl: 'https://example.com/2',
        },
      ];

      const pending = filterPendingMemories(memories, manifest);
      expect(pending.length).toBe(2);
    });
  });

  describe('getManifestStats', () => {
    it('should return correct statistics', () => {
      const manifest = createManifest(testDir);
      manifest.entries['img-1'] = {
        mediaId: 'img-1',
        downloadedAt: new Date().toISOString(),
        filePath: '/path/1.jpg',
        fileSize: 1000,
        mediaType: 'Image',
        originalDate: new Date().toISOString(),
      };
      manifest.entries['img-2'] = {
        mediaId: 'img-2',
        downloadedAt: new Date().toISOString(),
        filePath: '/path/2.jpg',
        fileSize: 1500,
        mediaType: 'Image',
        originalDate: new Date().toISOString(),
      };
      manifest.entries['vid-1'] = {
        mediaId: 'vid-1',
        downloadedAt: new Date().toISOString(),
        filePath: '/path/1.mp4',
        fileSize: 5000,
        mediaType: 'Video',
        originalDate: new Date().toISOString(),
      };

      const stats = getManifestStats(manifest);
      expect(stats.total).toBe(3);
      expect(stats.images).toBe(2);
      expect(stats.videos).toBe(1);
    });

    it('should return zeros for empty manifest', () => {
      const manifest = createManifest(testDir);
      const stats = getManifestStats(manifest);
      expect(stats.total).toBe(0);
      expect(stats.images).toBe(0);
      expect(stats.videos).toBe(0);
    });
  });
});

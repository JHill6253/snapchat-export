/**
 * Tests for the parser module
 */

import { describe, it, expect } from 'vitest';
import {
  parseLocation,
  parseDate,
  extractMediaId,
  validateMediaType,
  parseMemories,
} from './parser.js';

describe('parseLocation', () => {
  it('should parse valid coordinates', () => {
    const result = parseLocation('Latitude, Longitude: 41.714947, -93.46679');
    expect(result).toEqual({ latitude: 41.714947, longitude: -93.46679 });
  });

  it('should parse coordinates with different spacing', () => {
    const result = parseLocation('Latitude,Longitude: 41.714947,-93.46679');
    expect(result).toEqual({ latitude: 41.714947, longitude: -93.46679 });
  });

  it('should return null for empty string', () => {
    expect(parseLocation('')).toBeNull();
  });

  it('should return null for whitespace-only string', () => {
    expect(parseLocation('   ')).toBeNull();
  });

  it('should return null for invalid format', () => {
    expect(parseLocation('Some random text')).toBeNull();
  });

  it('should handle negative coordinates', () => {
    const result = parseLocation('Latitude, Longitude: -33.868820, 151.209290');
    expect(result).toEqual({ latitude: -33.86882, longitude: 151.20929 });
  });
});

describe('parseDate', () => {
  it('should parse valid UTC date string', () => {
    const result = parseDate('2025-12-30 16:47:52 UTC');
    expect(result.toISOString()).toBe('2025-12-30T16:47:52.000Z');
  });

  it('should throw for invalid date', () => {
    expect(() => parseDate('not a date')).toThrow('Invalid date format');
  });
});

describe('extractMediaId', () => {
  it('should extract mid from URL', () => {
    const url =
      'https://app.snapchat.com/dmd/memories?uid=abc&mid=7100ED9D-1D95-4723-97AB-5CA9B22FC4A1&ts=123';
    const result = extractMediaId(url);
    expect(result).toBe('7100ED9D-1D95-4723-97AB-5CA9B22FC4A1');
  });

  it('should generate fallback ID for URL without mid', () => {
    const url = 'https://example.com/file';
    const result = extractMediaId(url);
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });
});

describe('validateMediaType', () => {
  it('should accept Image', () => {
    expect(validateMediaType('Image')).toBe('Image');
  });

  it('should accept Video', () => {
    expect(validateMediaType('Video')).toBe('Video');
  });

  it('should throw for invalid type', () => {
    expect(() => validateMediaType('Audio')).toThrow('Invalid media type');
  });
});

describe('parseMemories', () => {
  it('should parse valid export data', () => {
    const data = {
      'Saved Media': [
        {
          Date: '2025-12-30 16:47:52 UTC',
          'Media Type': 'Image',
          Location: 'Latitude, Longitude: 41.714947, -93.46679',
          'Download Link': 'https://app.snapchat.com/dmd/memories?mid=test123',
        },
      ],
    };

    const result = parseMemories(data);
    expect(result).toHaveLength(1);
    expect(result[0].mediaType).toBe('Image');
    expect(result[0].location).toEqual({ latitude: 41.714947, longitude: -93.46679 });
  });

  it('should throw for invalid structure', () => {
    expect(() => parseMemories({})).toThrow('Invalid Snapchat export format');
    expect(() => parseMemories(null)).toThrow('Invalid Snapchat export format');
    expect(() => parseMemories({ 'Saved Media': 'not an array' })).toThrow(
      'Invalid Snapchat export format'
    );
  });

  it('should handle empty saved media array', () => {
    const result = parseMemories({ 'Saved Media': [] });
    expect(result).toHaveLength(0);
  });
});

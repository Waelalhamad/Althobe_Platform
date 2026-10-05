import { describe, expect, it } from 'vitest';
import { sniffImage } from './photo.service.js';

describe('sniffImage', () => {
  it('knows JPEG, WebP and PNG by their first bytes, and nothing else', () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(
      'image/png',
    );
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
    expect(sniffImage(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

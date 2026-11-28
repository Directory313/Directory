import { describe, expect, it } from 'vitest';
import { parseLink } from './online';

describe('parseLink', () => {
  it('reads Pixabay search and item links', () => {
    expect(parseLink('https://pixabay.com/videos/search/ocean%20waves/')).toEqual({ provider: 'pixabay', kind: 'video', query: 'ocean waves' });
    expect(parseLink('https://pixabay.com/photos/search/mountain/')).toEqual({ provider: 'pixabay', kind: 'image', query: 'mountain' });
    expect(parseLink('https://pixabay.com/videos/waves-ocean-sea-12345/')).toEqual({ provider: 'pixabay', kind: 'video', id: '12345' });
  });
  it('reads Pexels links', () => {
    expect(parseLink('https://www.pexels.com/search/videos/city%20night/')).toEqual({ provider: 'pexels', kind: 'video', query: 'city night' });
    expect(parseLink('https://www.pexels.com/search/coffee/')).toEqual({ provider: 'pexels', kind: 'image', query: 'coffee' });
    expect(parseLink('https://www.pexels.com/photo/cup-of-coffee-312418/')).toEqual({ provider: 'pexels', kind: 'image', id: '312418' });
  });
  it('reads Sketchfab model and search links', () => {
    expect(parseLink('https://sketchfab.com/3d-models/old-chair-0123456789abcdef0123456789abcdef')).toEqual({ provider: 'sketchfab', kind: 'model', id: '0123456789abcdef0123456789abcdef' });
    expect(parseLink('https://sketchfab.com/search?q=car&type=models')).toEqual({ provider: 'sketchfab', kind: 'model', query: 'car' });
  });
  it('reads Poly Haven and Openverse links', () => {
    expect(parseLink('https://polyhaven.com/a/wooden_chair')).toEqual({ provider: 'polyhaven', kind: 'model', id: 'wooden_chair' });
    expect(parseLink('https://polyhaven.com/hdris?s=sunset')).toEqual({ provider: 'polyhaven', kind: 'hdri', query: 'sunset' });
    expect(parseLink('https://openverse.org/search/audio?q=rain')).toEqual({ provider: 'openverse', kind: 'audio', query: 'rain' });
  });
  it('ignores text and unsupported sites', () => {
    expect(parseLink('ocean waves')).toBeNull();
    expect(parseLink('https://example.com/video/1')).toBeNull();
  });
});

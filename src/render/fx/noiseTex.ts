// The shared noise atlas as a texture (see noiseMath.ts for the channels).
import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, RepeatWrapping, UnsignedByteType } from 'three/webgpu';
import { NOISE_SIZE, generateNoiseAtlas } from './noiseMath.ts';

let shared: DataTexture | null = null;

/** The shared noise texture: repeat wrapping, trilinear, anisotropic. Never disposed per consumer; it is tiny. */
export function noiseTexture(): DataTexture {
  if (shared) return shared;
  const t = new DataTexture(generateNoiseAtlas(), NOISE_SIZE, NOISE_SIZE, RGBAFormat, UnsignedByteType);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.flipY = false;
  t.needsUpdate = true;
  shared = t;
  return t;
}

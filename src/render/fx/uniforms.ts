// Uniform nodes shared by the sky, water, weather, particles and materials. The Fx manager writes them once a frame;
// everything else only reads. They live in one module so a material can depend on them without importing the manager.
import { Color, Vector2, Vector3 } from 'three/webgpu';
import { uniform } from 'three/tsl';

// The TSL typings reject most mixed-type chains on uniform nodes, so these are loosely typed on purpose.
const u = (v: unknown): any => uniform(v as never);

export const fxU = {
  /** 0 = day, 1 = night: lit windows, signs, streetlights. */
  night: u(0),
  /** 0..1 accumulated rain wetness on roads and ground. */
  wet: u(0),
  /** 0..1 snow cover on upward faces. */
  snow: u(0),
  overcast: u(0),
  /** Lightning envelope 0..1. */
  flash: u(0),
  /** Mean ambient brightness 0..1, used to dim unlit particles at night. */
  ambient: u(1),
  sunDir: u(new Vector3(0, 1, 0)),
  moonDir: u(new Vector3(0, -1, 0)),
  skyZenith: u(new Color(0.08, 0.24, 0.7)),
  skyHorizon: u(new Color(0.62, 0.78, 0.95)),
  skyGlow: u(new Color(0.5, 0.42, 0.3)),
  sunColor: u(new Color(1, 0.95, 0.85)),
  /** Sun disc strength, already faded for horizon and overcast. */
  sunDisc: u(1),
  moonDisc: u(0),
  starAlpha: u(0),
  /** Light on the lit and shaded faces of clouds. */
  cloudLit: u(new Color(1, 1, 1)),
  cloudShade: u(new Color(0.5, 0.55, 0.65)),
  cloudCover: u(0.4),
  cameraRight: u(new Vector3(1, 0, 0)),
  cameraUp: u(new Vector3(0, 1, 0)),
  /** World-space focus the weather drops tile around. */
  weatherCenter: u(new Vector3(0, 0, 0)),
  weatherBox: u(80),
  /** Scales streak width and flake size with camera distance so drops stay visible from the satellite view. */
  dropScale: u(1),
  wind: u(0.1),
  /** Cloud field offset in world units (accumulated drift) and how much sun a cloud shadow removes (0 = no shadows). */
  cloudDrift: u(new Vector2(0, 0)),
  cloudShadow: u(0),
  /** Sun-ray throw to the cloud layer in world units: the shadow lookup is displaced by this. */
  cloudThrow: u(new Vector2(0, 0)),
  /** Sun in-scatter strength for fog and aerial perspective (0 = plain fog). */
  scatter: u(0),
  /** Fog state for the atmosphere node: horizon colour, exp2 density, and extra ground mist (dawn, rain) 0..1. */
  fogColor: u(new Color(0.7, 0.82, 0.95)),
  fogDensity: u(0.0007),
  mist: u(0),
  /** Terrain detail and caustics fade distances follow the camera distance. */
  camDist: u(60),
  /** Seconds, for slow shader flicker (fires). Written by the Fx manager each frame. */
  time: u(0),
};

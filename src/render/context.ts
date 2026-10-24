import { ACESFilmicToneMapping, WebGPURenderer } from 'three/webgpu';
import { pixelRatio, type Backend, type Tier } from './tier.ts';

export type BackendPref = 'auto' | Backend;

export interface RenderContext {
  renderer: WebGPURenderer;
  canvas: HTMLCanvasElement;
  /** The backend actually running, which can differ from the request. */
  backend: Backend;
  software: boolean;
  adapterLabel: string;
  setTier(tier: Tier): void;
  /** Extra resolution factor from the governor (1 = the tier's own pixel ratio). */
  setResolutionFactor(factor: number): void;
  resize(): void;
  dispose(): void;
}

export class RenderInitError extends Error {}

/** Extra pixel-ratio factor for software adapters. */
export const SOFTWARE_SCALE = 0.75;

export interface ContextOptions {
  container: HTMLElement;
  backend: BackendPref;
  tier: () => Tier;
  onLost: (message: string) => void;
}

export function parseBackend(v: string | null): BackendPref {
  return v === 'webgl2' || v === 'webgpu' ? v : 'auto';
}

interface GpuAdapterLike { isFallbackAdapter?: boolean; info?: { isFallbackAdapter?: boolean; description?: string; vendor?: string } }

async function probeWebGPU(): Promise<{ ok: boolean; fallback: boolean; label: string }> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<GpuAdapterLike | null> } }).gpu;
  if (!gpu) return { ok: false, fallback: false, label: 'no navigator.gpu' };
  const adapter = await gpu.requestAdapter().catch(() => null);
  if (!adapter) return { ok: false, fallback: false, label: 'no adapter' };
  const fallback = adapter.isFallbackAdapter ?? adapter.info?.isFallbackAdapter ?? false;
  return { ok: true, fallback, label: [adapter.info?.vendor, adapter.info?.description].filter(Boolean).join(' ') || 'webgpu adapter' };
}

const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|software|basic render/i;

function glRendererString(renderer: WebGPURenderer): string {
  const gl = (renderer.backend as unknown as { gl?: WebGL2RenderingContext }).gl;
  if (!gl) return '';
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
}

function makeCanvas(container: HTMLElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.className = 'game-canvas';
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;outline:none;';
  canvas.tabIndex = 0;
  container.appendChild(canvas);
  return canvas;
}

async function attempt(opt: ContextOptions, want: Backend, probe: { fallback: boolean; label: string } | null): Promise<RenderContext> {
  const canvas = makeCanvas(opt.container);
  let renderer: WebGPURenderer | undefined;
  try {
    renderer = new WebGPURenderer({ canvas, forceWebGL: want === 'webgl2', antialias: false, alpha: false, powerPreference: 'high-performance' });
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.onDeviceLost = (info: { message?: string }) => opt.onLost(info.message ?? 'device lost');
    await renderer.init();
  } catch (e) {
    renderer?.dispose();
    canvas.remove();
    throw e;
  }
  const r = renderer;
  const isGpu = (r.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
  const backend: Backend = isGpu ? 'webgpu' : 'webgl2';
  const glName = isGpu ? '' : glRendererString(r);
  const devInfo = isGpu ? (r.backend as unknown as { device?: { adapterInfo?: GpuAdapterLike['info'] } }).device?.adapterInfo : undefined;
  const software = isGpu ? (devInfo?.isFallbackAdapter ?? probe?.fallback ?? false) : SOFTWARE_GL.test(glName);
  const adapterLabel = isGpu ? ([devInfo?.vendor, devInfo?.description].filter(Boolean).join(' ') || probe?.label || 'webgpu') : glName || 'webgl2';

  let factor = 1;
  // A CPU-rendered page (SwiftShader, llvmpipe) cannot afford the sharper tier scale; real GPUs, phones included, get it in full.
  const softwareScale = software ? SOFTWARE_SCALE : 1;
  const ctx: RenderContext = {
    renderer: r, canvas, backend, software, adapterLabel,
    setTier(tier) {
      r.setPixelRatio(pixelRatio(window.devicePixelRatio || 1, tier, factor * softwareScale));
      ctx.resize();
    },
    setResolutionFactor(f) {
      factor = f;
      ctx.resize();
    },
    resize() {
      const w = Math.max(1, opt.container.clientWidth), h = Math.max(1, opt.container.clientHeight);
      r.setPixelRatio(pixelRatio(window.devicePixelRatio || 1, opt.tier(), factor * softwareScale));
      r.setSize(w, h, false);
    },
    dispose() {
      r.setAnimationLoop(null);
      r.dispose();
      canvas.remove();
    },
  };
  ctx.resize();
  return ctx;
}

/**
 * Create the renderer on a fresh canvas inside `container`. Auto prefers WebGPU only when a non-fallback adapter
 * exists, otherwise WebGL2; an explicit request is never silently swapped (the caller sees `backend`).
 * Throws RenderInitError, after one console.error, when nothing initialises.
 */
export async function createRenderContext(opt: ContextOptions): Promise<RenderContext> {
  const order: Backend[] = [];
  let probe: Awaited<ReturnType<typeof probeWebGPU>> | null = null;
  if (opt.backend === 'webgl2') order.push('webgl2');
  else {
    if (opt.backend === 'webgpu') order.push('webgpu');
    else {
      probe = await probeWebGPU();
      if (probe.ok && !probe.fallback) order.push('webgpu');
      order.push('webgl2');
    }
  }
  const failures: string[] = [];
  for (const want of order) {
    try {
      return await attempt(opt, want, probe);
    } catch (e) {
      failures.push(`${want}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const message = `Could not start the 3D renderer (${failures.join('; ')})`;
  console.error(`[render] ${message}`);
  throw new RenderInitError(message);
}

/** iOS Safari pinch-zoom events fire on the document regardless of touch-action. */
export function blockGestureZoom(): () => void {
  const stop = (e: Event): void => e.preventDefault();
  document.addEventListener('gesturestart', stop);
  document.addEventListener('gesturechange', stop);
  return () => { document.removeEventListener('gesturestart', stop); document.removeEventListener('gesturechange', stop); };
}

import { PerspectiveCamera, RenderPipeline, type Scene, type WebGPURenderer } from 'three/webgpu';
import { pass } from 'three/tsl';

/** Minimal chain: scene pass -> output (tone map + colour space). U4 extends outputNode with AO, bloom, grade. */
export interface Pipeline {
  readonly pipeline: RenderPipeline;
  render(): void;
  dispose(): void;
}

export function createPipeline(renderer: WebGPURenderer, scene: Scene, camera: PerspectiveCamera): Pipeline {
  const pipeline = new RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  pipeline.outputNode = scenePass;
  return {
    pipeline,
    render: () => pipeline.render(),
    dispose: () => pipeline.dispose(),
  };
}

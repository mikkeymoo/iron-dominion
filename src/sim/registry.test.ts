import { describe, expect, it } from 'vitest';
import { createSim } from './engine.ts';
import { bytesOf, hashWorld } from './hash.ts';
import { REGISTRY, SPEC } from './layers.ts';
import { allocWorld } from './world.ts';

describe('layer registry', () => {
  it('declares every typed array held by a World, with the registered type and length', () => {
    const world = allocWorld() as unknown as Record<string, unknown>;
    const names = new Set<string>(REGISTRY.map((l) => l.name));
    for (const [key, value] of Object.entries(world)) {
      expect(ArrayBuffer.isView(value), `${key} is not a typed array`).toBe(true);
      expect(names.has(key), `typed array "${key}" is missing from the registry`).toBe(true);
      const info = REGISTRY.find((l) => l.name === key)!;
      expect(value).toBeInstanceOf(info.ctor);
      expect((value as ArrayLike<number>).length).toBe(info.length);
    }
    expect(Object.keys(world).sort()).toEqual(Object.keys(SPEC).sort());
    expect(REGISTRY.length).toBeGreaterThan(30);
  });

  it('changes the world hash when one cell of any layer flips', () => {
    const sim = createSim(1);
    const base = hashWorld(sim.world);
    for (const l of REGISTRY) {
      const bytes = bytesOf(sim.world[l.name]);
      for (const at of [0, bytes.length - 1]) {
        bytes[at] = bytes[at]! ^ 1;
        expect(hashWorld(sim.world), `${l.name}[byte ${at}]`).not.toBe(base);
        bytes[at] = bytes[at]! ^ 1;
      }
      expect(hashWorld(sim.world), `${l.name} restored`).toBe(base);
    }
  });
});

// A minimal AudioContext stand-in for tests: records the node graph and parameter writes, makes no sound.
export class FakeParam {
  value: number;
  calls: { fn: string; args: number[] }[] = [];
  constructor(v = 0) { this.value = v; }
  setValueAtTime(v: number, t: number): this { this.value = v; this.calls.push({ fn: 'set', args: [v, t] }); return this; }
  linearRampToValueAtTime(v: number, t: number): this { this.calls.push({ fn: 'linear', args: [v, t] }); return this; }
  exponentialRampToValueAtTime(v: number, t: number): this { this.calls.push({ fn: 'exp', args: [v, t] }); return this; }
  setTargetAtTime(v: number, t: number, k: number): this { this.value = v; this.calls.push({ fn: 'target', args: [v, t, k] }); return this; }
  cancelScheduledValues(): this { return this; }
}

export class FakeNode {
  readonly kind: string;
  readonly out: FakeNode[] = [];
  disconnected = false;
  constructor(kind: string) { this.kind = kind; }
  connect<T>(to: T): T { this.out.push(to as unknown as FakeNode); return to; }
  disconnect(): void { this.disconnected = true; this.out.length = 0; }
}

class FakeGain extends FakeNode { gain = new FakeParam(1); constructor() { super('gain'); } }
class FakeOsc extends FakeNode {
  type = 'sine'; frequency = new FakeParam(440); detune = new FakeParam(0); started: number[] = []; stopped: number[] = [];
  constructor() { super('osc'); }
  start(t = 0): void { this.started.push(t); }
  stop(t = 0): void { this.stopped.push(t); }
}
class FakeFilter extends FakeNode { type = 'lowpass'; frequency = new FakeParam(350); Q = new FakeParam(1); constructor() { super('filter'); } }
class FakeSource extends FakeNode {
  buffer: unknown = null; loop = false; started: number[] = []; stopped: number[] = [];
  constructor() { super('source'); }
  start(t = 0): void { this.started.push(t); }
  stop(t = 0): void { this.stopped.push(t); }
}
class FakeConvolver extends FakeNode { buffer: unknown = null; constructor() { super('convolver'); } }
class FakeCompressor extends FakeNode {
  threshold = new FakeParam(); knee = new FakeParam(); ratio = new FakeParam(); attack = new FakeParam(); release = new FakeParam();
  constructor() { super('compressor'); }
}

export class FakeAudioContext {
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  currentTime = 0;
  sampleRate = 8000;
  readonly destination = new FakeNode('destination');
  readonly nodes: FakeNode[] = [];
  resumeCalls = 0;
  suspendCalls = 0;
  /** Set to make resume() reject, as a browser does without a gesture. */
  rejectResume = false;

  private add<T extends FakeNode>(n: T): T { this.nodes.push(n); return n; }
  createGain(): FakeGain { return this.add(new FakeGain()); }
  createOscillator(): FakeOsc { return this.add(new FakeOsc()); }
  createBiquadFilter(): FakeFilter { return this.add(new FakeFilter()); }
  createBufferSource(): FakeSource { return this.add(new FakeSource()); }
  createConvolver(): FakeConvolver { return this.add(new FakeConvolver()); }
  createDynamicsCompressor(): FakeCompressor { return this.add(new FakeCompressor()); }
  createBuffer(channels: number, length: number, rate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate: rate, duration: length / rate, getChannelData: (c: number) => data[c]! };
  }
  async resume(): Promise<void> {
    this.resumeCalls++;
    if (this.rejectResume) throw new Error('NotAllowedError');
    this.state = 'running';
  }
  async suspend(): Promise<void> { this.suspendCalls++; this.state = 'suspended'; }
  async close(): Promise<void> { this.state = 'closed'; }

  ofKind(kind: string): FakeNode[] { return this.nodes.filter((n) => n.kind === kind); }
}

export const asContext = (c: FakeAudioContext): AudioContext => c as unknown as AudioContext;

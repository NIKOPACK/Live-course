type RealtimeAudioBridgeListener = () => void;

let activeRealtimeAudioBridge: RealtimeAudioBridge | null = null;
const activeRealtimeAudioBridgeListeners = new Set<RealtimeAudioBridgeListener>();

function publishActiveRealtimeAudioBridge(bridge: RealtimeAudioBridge | null): void {
  if (activeRealtimeAudioBridge === bridge) return;
  activeRealtimeAudioBridge = bridge;
  for (const listener of activeRealtimeAudioBridgeListeners) listener();
}

export function getActiveRealtimeAudioBridge(): RealtimeAudioBridge | null {
  return activeRealtimeAudioBridge;
}

export function subscribeRealtimeAudioBridge(listener: RealtimeAudioBridgeListener): () => void {
  activeRealtimeAudioBridgeListeners.add(listener);
  return () => activeRealtimeAudioBridgeListeners.delete(listener);
}

export function registerRealtimeAudioBridge(bridge: RealtimeAudioBridge): () => void {
  publishActiveRealtimeAudioBridge(bridge);

  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    if (activeRealtimeAudioBridge === bridge) publishActiveRealtimeAudioBridge(null);
  };
}

export class RealtimeAudioBridge {
  readonly audioElement: HTMLAudioElement;

  #context: AudioContext | null = null;
  #source: MediaElementAudioSourceNode | null = null;
  #closed = false;

  constructor(audioElement: HTMLAudioElement) {
    this.audioElement = audioElement;
    this.audioElement.autoplay = true;
  }

  get context(): AudioContext | null {
    return this.#context;
  }

  get audioNode(): AudioNode | null {
    return this.#source;
  }

  async activate(): Promise<void> {
    if (this.#closed) throw new Error('Realtime audio bridge is closed');

    if (!this.#context) {
      this.#context = new AudioContext();
      this.#source = this.#context.createMediaElementSource(this.audioElement);
      this.#source.connect(this.#context.destination);
    }

    if (this.#context.state === 'suspended') {
      await this.#context.resume();
    }
  }

  connect(destination: AudioNode): () => void {
    const source = this.#source;
    if (!source) throw new Error('Realtime audio bridge must be activated before connecting');
    source.connect(destination);

    let connected = true;
    return () => {
      if (!connected) return;
      connected = false;
      source.disconnect(destination);
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (activeRealtimeAudioBridge === this) publishActiveRealtimeAudioBridge(null);

    if (this.#source && this.#context) {
      this.#source.disconnect(this.#context.destination);
    }
    if (this.#context && this.#context.state !== 'closed') {
      await this.#context.close();
    }

    this.audioElement.pause();
    this.audioElement.srcObject = null;
    this.#source = null;
    this.#context = null;
  }
}

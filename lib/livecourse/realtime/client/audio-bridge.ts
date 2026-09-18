type RealtimeAudioBridgeListener = () => void;

let activeRealtimeAudioBridge: RealtimeAudioBridge | null = null;
let activeLipSyncAudioNode: AudioNode | null = null;
const activeRealtimeAudioBridgeListeners = new Set<RealtimeAudioBridgeListener>();

function notifyRealtimeAudioListeners(): void {
  for (const listener of activeRealtimeAudioBridgeListeners) listener();
}

function publishActiveRealtimeAudioBridge(bridge: RealtimeAudioBridge | null): void {
  if (activeRealtimeAudioBridge === bridge) return;
  activeRealtimeAudioBridge = bridge;
  notifyRealtimeAudioListeners();
}

export function getActiveRealtimeAudioBridge(): RealtimeAudioBridge | null {
  return activeRealtimeAudioBridge;
}

/** Lip-sync source: Volc PCM tap, else the OpenAI realtime media element. */
export function getActiveLipSyncAudioNode(): AudioNode | null {
  return activeLipSyncAudioNode ?? activeRealtimeAudioBridge?.audioNode ?? null;
}

export function registerLipSyncAudioNode(node: AudioNode): () => void {
  if (activeLipSyncAudioNode === node) {
    return () => {
      if (activeLipSyncAudioNode === node) {
        activeLipSyncAudioNode = null;
        notifyRealtimeAudioListeners();
      }
    };
  }
  activeLipSyncAudioNode = node;
  notifyRealtimeAudioListeners();
  return () => {
    if (activeLipSyncAudioNode !== node) return;
    activeLipSyncAudioNode = null;
    notifyRealtimeAudioListeners();
  };
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
      await Promise.race([
        this.#context.resume(),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => {
            reject(new Error('Audio context resume timed out'));
          }, 4_000);
        }),
      ]);
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

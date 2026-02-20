export type PluginLifecycle = {
  onLoad?: () => Promise<void> | void;
  onStart?: () => Promise<void> | void;
  onStop?: () => Promise<void> | void;
  onConfigChange?: (nextConfig: unknown) => Promise<void> | void;
};

export type PluginRuntimeModule = {
  id: string;
  register: (api: unknown) => Promise<void> | void;
  lifecycle?: PluginLifecycle;
};

export class PluginLifecycleManager {
  #modules = new Map<string, PluginRuntimeModule>();

  register(module: PluginRuntimeModule): void {
    this.#modules.set(module.id, module);
  }

  list(): PluginRuntimeModule[] {
    return Array.from(this.#modules.values());
  }

  async startAll(): Promise<void> {
    for (const module of this.#modules.values()) {
      await module.lifecycle?.onLoad?.();
      await module.lifecycle?.onStart?.();
    }
  }

  async stopAll(): Promise<void> {
    for (const module of this.#modules.values()) {
      await module.lifecycle?.onStop?.();
    }
  }
}

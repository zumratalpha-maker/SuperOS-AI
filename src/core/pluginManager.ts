/**
 * 场景插件化架构 — 每个场景（微信/小红书/下载/文档）都是独立插件
 * 支持动态注册/卸载，manifest 声明式描述能力
 */

import { type TaskRecord } from "./taskStore.js";
import { type ValidationSpec } from "./validator.js";

/** 插件清单：声明这个插件能做什么 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  /** 该插件能处理的 task kind 列表 */
  supportedKinds: string[];
  /** 该插件需要的前置条件 */
  requirements?: {
    apps?: string[];
    network?: boolean;
    minDiskGB?: number;
  };
  /** 匹配规则：输入文本匹配这些正则时，路由到此插件 */
  intentPatterns?: string[];
}

/** 插件执行上下文 */
export interface PluginContext {
  task: TaskRecord;
  stepIndex: number;
  say: (message: string) => void;
  askUser: (question: string) => Promise<string>;
}

/** 插件核心接口 */
export interface IPlugin {
  manifest: PluginManifest;

  /** 初始化（加载资源、检查前置条件） */
  init?(): Promise<void>;

  /** 执行任务步骤 */
  execute(context: PluginContext): Promise<{
    success: boolean;
    error?: string;
    data?: Record<string, unknown>;
  }>;

  /** 获取结果校验规则 */
  getValidation?(context: PluginContext): ValidationSpec | null;

  /** 清理（释放资源） */
  destroy?(): Promise<void>;
}

class PluginManager {
  private plugins: Map<string, IPlugin> = new Map();
  private kindToPlugin: Map<string, string> = new Map();

  /** 注册插件 */
  register(plugin: IPlugin): void {
    const { id, supportedKinds } = plugin.manifest;
    if (this.plugins.has(id)) {
      console.warn(`[pluginManager] 插件已存在，覆盖: ${id}`);
    }
    this.plugins.set(id, plugin);
    for (const kind of supportedKinds) {
      this.kindToPlugin.set(kind, id);
    }
    console.log(`[pluginManager] 注册插件: ${id} (${plugin.manifest.name}) → kinds: ${supportedKinds.join(", ")}`);
  }

  /** 卸载插件 */
  async unregister(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return;
    await plugin.destroy?.();
    for (const [kind, id] of this.kindToPlugin.entries()) {
      if (id === pluginId) this.kindToPlugin.delete(kind);
    }
    this.plugins.delete(pluginId);
    console.log(`[pluginManager] 卸载插件: ${pluginId}`);
  }

  /** 根据 task kind 查找插件 */
  findByKind(kind: string): IPlugin | null {
    const id = this.kindToPlugin.get(kind);
    return id ? this.plugins.get(id) ?? null : null;
  }

  /** 根据用户输入匹配插件（用 intentPatterns） */
  matchByInput(input: string): IPlugin | null {
    const t = input.trim().toLowerCase();
    for (const plugin of this.plugins.values()) {
      const patterns = plugin.manifest.intentPatterns;
      if (!patterns) continue;
      for (const pattern of patterns) {
        try {
          if (new RegExp(pattern, "i").test(t)) return plugin;
        } catch { /* invalid regex */ }
      }
    }
    return null;
  }

  /** 获取所有已注册插件 */
  listPlugins(): PluginManifest[] {
    return Array.from(this.plugins.values()).map((p) => p.manifest);
  }

  /** 获取插件实例 */
  getPlugin(id: string): IPlugin | null {
    return this.plugins.get(id) ?? null;
  }

  /** 初始化所有插件 */
  async initAll(): Promise<void> {
    for (const [id, plugin] of this.plugins.entries()) {
      try {
        await plugin.init?.();
      } catch (e) {
        console.error(`[pluginManager] 初始化插件 ${id} 失败:`, (e as Error).message);
      }
    }
  }

  /** 清理所有插件 */
  async destroyAll(): Promise<void> {
    for (const [id, plugin] of this.plugins.entries()) {
      try {
        await plugin.destroy?.();
      } catch (e) {
        console.error(`[pluginManager] 清理插件 ${id} 失败:`, (e as Error).message);
      }
    }
    this.plugins.clear();
    this.kindToPlugin.clear();
  }
}

let _manager: PluginManager | null = null;
export function getPluginManager(): PluginManager {
  if (!_manager) _manager = new PluginManager();
  return _manager;
}

export { PluginManager };

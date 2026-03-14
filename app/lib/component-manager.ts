import { MorphBridge } from './bridge';
import { ComponentStore } from './store';

export class ComponentManager {
  private bridge: MorphBridge;
  private store: ComponentStore;
  private drafts: Map<string, string> = new Map(); // id -> html

  constructor(bridge: MorphBridge, store: ComponentStore) {
    this.bridge = bridge;
    this.store = store;
  }

  /** Called when CC generates a new component */
  addDraft(id: string, html: string): void {
    this.drafts.set(id, html);
    this.bridge.addComponent(id, html, 'draft');
  }

  /** User adopts a draft — persist it */
  async adoptComponent(id: string): Promise<void> {
    const html = this.drafts.get(id);
    if (html) {
      await this.store.saveComponent(id, html);
      this.drafts.delete(id);
    }
  }

  /** User dismisses a draft or removes an adopted component */
  async dismissComponent(id: string): Promise<void> {
    if (this.drafts.has(id)) {
      this.drafts.delete(id);
    } else {
      await this.store.removeComponent(id);
    }
    this.bridge.removeComponent(id);
  }

  /** CC updates an existing component */
  async updateComponent(id: string, html: string): Promise<void> {
    this.bridge.updateComponent(id, html);
    // If already adopted, update the stored version too
    if (!this.drafts.has(id)) {
      await this.store.saveComponent(id, html);
    } else {
      this.drafts.set(id, html);
    }
  }

  /** Load all adopted components on app start */
  async loadAdopted(): Promise<void> {
    const components = await this.store.loadAllComponents();
    if (components.length > 0) {
      this.bridge.loadComponents(components);
    }
  }
}

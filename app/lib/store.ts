import { File, Directory, Paths } from 'expo-file-system';

const MORPH_DIR = new Directory(Paths.document, 'morph-data');
const COMPONENTS_DIR = new Directory(MORPH_DIR, 'components');
const MANIFEST_FILE = new File(MORPH_DIR, 'manifest.json');

export interface ComponentMeta {
  id: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Manifest {
  components: ComponentMeta[];
  order: string[]; // component IDs in display order
}

export class ComponentStore {
  private manifest: Manifest = { components: [], order: [] };

  /** Initialize directories and load manifest */
  async init(): Promise<void> {
    if (!MORPH_DIR.exists) {
      MORPH_DIR.create({ intermediates: true });
    }
    if (!COMPONENTS_DIR.exists) {
      COMPONENTS_DIR.create({ intermediates: true });
    }

    if (MANIFEST_FILE.exists) {
      try {
        const data = await MANIFEST_FILE.text();
        this.manifest = JSON.parse(data);
      } catch {
        this.manifest = { components: [], order: [] };
      }
    } else {
      this.manifest = { components: [], order: [] };
    }
  }

  /** Save a component's HTML and update the manifest */
  async saveComponent(id: string, html: string, description?: string): Promise<void> {
    const file = new File(COMPONENTS_DIR, id + '.html');
    if (!file.exists) {
      file.create();
    }
    file.write(html);

    const now = Date.now();
    const existing = this.manifest.components.find(c => c.id === id);
    if (existing) {
      existing.updatedAt = now;
      if (description) existing.description = description;
    } else {
      this.manifest.components.push({
        id,
        description,
        createdAt: now,
        updatedAt: now,
      });
      this.manifest.order.push(id);
    }

    await this.saveManifest();
  }

  /** Load a single component's HTML */
  async loadComponent(id: string): Promise<string | null> {
    const file = new File(COMPONENTS_DIR, id + '.html');
    if (!file.exists) return null;
    try {
      return file.text();
    } catch {
      return null;
    }
  }

  /** Remove a component and update manifest */
  async removeComponent(id: string): Promise<void> {
    const file = new File(COMPONENTS_DIR, id + '.html');
    if (file.exists) {
      file.delete();
    }

    this.manifest.components = this.manifest.components.filter(c => c.id !== id);
    this.manifest.order = this.manifest.order.filter(oid => oid !== id);
    await this.saveManifest();
  }

  /** Load all adopted components (for startup) */
  async loadAllComponents(): Promise<Array<{ id: string; html: string }>> {
    const results: Array<{ id: string; html: string }> = [];

    for (const id of this.manifest.order) {
      const html = await this.loadComponent(id);
      if (html) {
        results.push({ id, html });
      }
    }

    return results;
  }

  /** Persist manifest to disk */
  async saveManifest(): Promise<void> {
    if (!MANIFEST_FILE.exists) {
      MANIFEST_FILE.create();
    }
    MANIFEST_FILE.write(JSON.stringify(this.manifest, null, 2));
  }

  /** Get the current manifest (in-memory) */
  getManifest(): Manifest {
    return this.manifest;
  }
}

import { File, Directory, Paths } from 'expo-file-system';

const MORPH_DIR = new Directory(Paths.document, 'morph-data');
const COMPONENTS_DIR = new Directory(MORPH_DIR, 'components');
const MANIFEST_FILE = new File(MORPH_DIR, 'manifest.json');
const SNAPSHOTS_DIR = new Directory(MORPH_DIR, 'snapshots');
const LIBRARY_DIR = new Directory(MORPH_DIR, 'library');
const LIBRARY_INDEX = new File(MORPH_DIR, 'library-index.json');

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

  // ===== CANVAS SNAPSHOTS =====

  /** Save a snapshot of the current canvas state */
  async saveSnapshot(name?: string): Promise<CanvasSnapshot> {
    if (!SNAPSHOTS_DIR.exists) {
      SNAPSHOTS_DIR.create({ intermediates: true });
    }

    const id = 'snap-' + Date.now();
    const snapshot: CanvasSnapshot = {
      id,
      name: name || new Date().toLocaleString(),
      createdAt: Date.now(),
      componentCount: this.manifest.components.length,
      componentIds: [...this.manifest.order],
    };

    // Save the full manifest + all component HTML into one file
    const components: Array<{ id: string; html: string }> = [];
    for (const cid of this.manifest.order) {
      const html = await this.loadComponent(cid);
      if (html) components.push({ id: cid, html });
    }

    const data = JSON.stringify({ snapshot, manifest: this.manifest, components });
    const file = new File(SNAPSHOTS_DIR, id + '.json');
    if (!file.exists) file.create();
    file.write(data);

    return snapshot;
  }

  /** List all saved snapshots */
  async listSnapshots(): Promise<CanvasSnapshot[]> {
    if (!SNAPSHOTS_DIR.exists) return [];
    const entries = SNAPSHOTS_DIR.list();
    const snapshots: CanvasSnapshot[] = [];

    for (const entry of entries) {
      if (entry instanceof File && entry.name.endsWith('.json')) {
        try {
          const raw = await entry.text();
          const parsed = JSON.parse(raw);
          snapshots.push(parsed.snapshot);
        } catch { /* skip corrupt */ }
      }
    }

    return snapshots.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Restore a snapshot — replaces current canvas */
  async restoreSnapshot(snapshotId: string): Promise<boolean> {
    const file = new File(SNAPSHOTS_DIR, snapshotId + '.json');
    if (!file.exists) return false;

    try {
      const raw = await file.text();
      const { manifest, components } = JSON.parse(raw);

      // Clear current components
      for (const cid of this.manifest.order) {
        const cf = new File(COMPONENTS_DIR, cid + '.html');
        if (cf.exists) cf.delete();
      }

      // Write restored components
      this.manifest = manifest;
      for (const comp of components) {
        const cf = new File(COMPONENTS_DIR, comp.id + '.html');
        if (!cf.exists) cf.create();
        cf.write(comp.html);
      }

      await this.saveManifest();
      return true;
    } catch {
      return false;
    }
  }

  // ===== COMPONENT LIBRARY =====

  /** Save a component to the reusable library */
  async saveToLibrary(id: string, name: string, description: string, tags: string[] = []): Promise<void> {
    if (!LIBRARY_DIR.exists) {
      LIBRARY_DIR.create({ intermediates: true });
    }

    const html = await this.loadComponent(id);
    if (!html) return;

    const libId = 'lib-' + id + '-' + Date.now();
    const entry: LibraryEntry = {
      id: libId,
      name,
      description,
      tags,
      createdAt: Date.now(),
      sourceComponentId: id,
    };

    // Save HTML
    const file = new File(LIBRARY_DIR, libId + '.html');
    if (!file.exists) file.create();
    file.write(html);

    // Update index
    const index = await this.loadLibraryIndex();
    index.push(entry);
    await this.saveLibraryIndex(index);
  }

  /** List all library entries */
  async listLibrary(): Promise<LibraryEntry[]> {
    return this.loadLibraryIndex();
  }

  /** Load a library component's HTML */
  async loadLibraryComponent(libId: string): Promise<string | null> {
    const file = new File(LIBRARY_DIR, libId + '.html');
    if (!file.exists) return null;
    try {
      return file.text();
    } catch {
      return null;
    }
  }

  /** Use a library component — add it to the current canvas */
  async useFromLibrary(libId: string, newId?: string): Promise<string | null> {
    const html = await this.loadLibraryComponent(libId);
    if (!html) return null;

    const index = await this.loadLibraryIndex();
    const entry = index.find(e => e.id === libId);
    const componentId = newId || entry?.sourceComponentId || 'lib-' + Date.now();

    await this.saveComponent(componentId, html, entry?.description);
    return componentId;
  }

  /** Export a library component as a shareable JSON string */
  async exportLibraryComponent(libId: string): Promise<string | null> {
    const html = await this.loadLibraryComponent(libId);
    if (!html) return null;

    const index = await this.loadLibraryIndex();
    const entry = index.find(e => e.id === libId);
    if (!entry) return null;

    return JSON.stringify({ morph_component: { ...entry, html } }, null, 2);
  }

  /** Import a component from a shared JSON string */
  async importLibraryComponent(json: string): Promise<LibraryEntry | null> {
    try {
      const data = JSON.parse(json);
      if (!data.morph_component?.html) return null;

      const comp = data.morph_component;
      const libId = 'lib-import-' + Date.now();
      const entry: LibraryEntry = {
        id: libId,
        name: comp.name || 'Imported',
        description: comp.description || '',
        tags: comp.tags || ['imported'],
        createdAt: Date.now(),
        sourceComponentId: comp.sourceComponentId || libId,
      };

      if (!LIBRARY_DIR.exists) {
        LIBRARY_DIR.create({ intermediates: true });
      }
      const file = new File(LIBRARY_DIR, libId + '.html');
      if (!file.exists) file.create();
      file.write(comp.html);

      const index = await this.loadLibraryIndex();
      index.push(entry);
      await this.saveLibraryIndex(index);

      return entry;
    } catch {
      return null;
    }
  }

  private async loadLibraryIndex(): Promise<LibraryEntry[]> {
    if (!LIBRARY_INDEX.exists) return [];
    try {
      const data = await LIBRARY_INDEX.text();
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  private async saveLibraryIndex(index: LibraryEntry[]): Promise<void> {
    if (!LIBRARY_INDEX.exists) LIBRARY_INDEX.create();
    LIBRARY_INDEX.write(JSON.stringify(index, null, 2));
  }
}

// ===== Additional Types =====

export interface CanvasSnapshot {
  id: string;
  name: string;
  createdAt: number;
  componentCount: number;
  componentIds: string[];
}

export interface LibraryEntry {
  id: string;
  name: string;
  description: string;
  tags: string[];
  createdAt: number;
  sourceComponentId: string;
}

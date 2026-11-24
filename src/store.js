// Minimal JSON-file persistence (no database needed). Writes are atomic
// (write to a temp file, then rename) and serialized per file.
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

export class JsonStore {
  constructor(dir) {
    this.dir = dir;
    this.queues = new Map();
  }

  #file(name) {
    if (!/^[\w.-]+$/.test(name)) throw new Error(`Invalid store key: ${name}`);
    return path.join(this.dir, `${name}.json`);
  }

  async read(name, fallback) {
    try {
      return JSON.parse(await readFile(this.#file(name), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return fallback;
      throw e;
    }
  }

  async write(name, data, { mode } = {}) {
    const file = this.#file(name);
    const prev = this.queues.get(file) || Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(data), mode ? { mode } : undefined);
      await rename(tmp, file);
    });
    this.queues.set(file, next);
    return next;
  }

  /** Read-modify-write under the same per-file queue. */
  async update(name, fallback, fn) {
    const file = this.#file(name);
    const prev = this.queues.get(file) || Promise.resolve();
    let result;
    const next = prev.catch(() => {}).then(async () => {
      const current = await this.read(name, fallback);
      result = await fn(current);
      await mkdir(this.dir, { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(result));
      await rename(tmp, file);
    });
    this.queues.set(file, next);
    await next;
    return result;
  }

  async remove(name) {
    try { await unlink(this.#file(name)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

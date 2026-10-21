import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const color = z.enum(['yellow', 'pink', 'green', 'blue', 'purple', 'gray']);
const layout = z.object({ x: z.number().finite().min(0).max(20000), y: z.number().finite().min(0).max(20000), width: z.number().finite().min(220).max(1600), height: z.number().finite().min(180).max(1600) }).strict();
export const noteInput = z.object({ title: z.string().max(120), content: z.string().max(8000), color: color.optional(), layout: layout.optional(), quadrant: z.number().int().min(0).max(3).optional(), order: z.number().int().min(0).max(1000000).optional() }).strict();
const noteSchema = noteInput.extend({ color: color.default('yellow'), layout: layout.default({ x: 24, y: 24, width: 240, height: 200 }), quadrant: z.number().int().min(0).max(3).default(0), order: z.number().int().min(0).max(1000000).default(0), id: z.string().uuid(), version: z.number().int().positive(), created: z.number().int(), updated: z.number().int() }).strict();
const notesSchema = z.object({ version: z.literal(1), notes: z.array(noteSchema).max(500) }).strict();
export type Note = z.infer<typeof noteSchema>;
export class NoteError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export class NotesStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {}
  private async read() {
    try { return notesSchema.parse(JSON.parse(await readFile(join(this.directory, 'notes.json'), 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 as const, notes: [] as Note[] };
      throw new NoteError('便签文件读取失败，请检查 notes.json；原文件未被覆盖', 500);
    }
  }
  async list() { await this.queue; return (await this.read()).notes.sort((a, b) => b.updated - a.updated); }
  private change<T>(edit: (notes: Note[]) => T) {
    const task = this.queue.then(async () => {
      const data = await this.read();
      const result = edit(data.notes);
      notesSchema.parse(data);
      const temporary = join(this.directory, `notes.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(data) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temporary, join(this.directory, 'notes.json'));
      } finally { await unlink(temporary).catch(() => {}); }
      return result;
    });
    this.queue = task.catch(() => {});
    return task;
  }
  create() {
    return this.change(notes => {
      if (notes.length >= 500) throw new NoteError('最多保存 500 条便签，请先删除一些便签', 409);
      const colors: Note['color'][] = ['yellow', 'pink', 'green', 'blue', 'purple', 'gray'];
      const counts = [0, 1, 2, 3].map(quadrant => notes.filter(note => note.quadrant === quadrant).length);
      const quadrant = counts.indexOf(Math.min(...counts));
      const order = notes.filter(note => note.quadrant === quadrant).reduce((maximum, note) => Math.max(maximum, note.order), -1) + 1;
      const note: Note = { id: randomUUID(), title: '', content: '', color: colors[Math.floor(Math.random() * colors.length)], layout: { x: 24, y: 24, width: 240, height: 200 }, quadrant, order, version: 1, created: Date.now(), updated: Date.now() };
      notes.push(note); return note;
    });
  }
  update(id: string, input: z.infer<typeof noteInput>, version: number) {
    return this.change(notes => {
      const note = this.find(notes, id, version);
      Object.assign(note, input, { version: note.version + 1, updated: Date.now() });
      return note;
    });
  }
  remove(id: string, version: number) {
    return this.change(notes => { this.find(notes, id, version); notes.splice(notes.findIndex(note => note.id === id), 1); });
  }
  private find(notes: Note[], id: string, version: number) {
    const note = notes.find(note => note.id === id);
    if (!note) throw new NoteError('便签已被删除，请重新打开便签管理', 404);
    if (note.version !== version) throw new NoteError('便签已在另一页面修改，请复制当前内容后重新打开便签管理', 409);
    return note;
  }
}

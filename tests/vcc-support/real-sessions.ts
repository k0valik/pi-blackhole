import { mkdir, mkdtemp, copyFile, chmod, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const SESSION_ROOT = join(process.env.HOME ?? "", ".pi/agent/sessions");

export interface SessionSample {
  source: string;
  copy: string;
  size: number;
  mtimeMs: number;
}

const walk = async (dir: string): Promise<string[]> => {
  const names = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const name of names) {
    const path = join(dir, name.name);
    if (name.isDirectory()) out.push(...await walk(path));
    else if (name.isFile() && path.endsWith(".jsonl")) out.push(path);
  }
  return out;
};

const pickLargest = async (limit: number): Promise<string[]> => {
  const files = await walk(SESSION_ROOT);
  const sized = await Promise.all(
    files.map(async (file) => ({ file, size: (await stat(file)).size })),
  );
  return sized.sort((a, b) => b.size - a.size).slice(0, limit).map((x) => x.file);
};

export const prepareSessionSamples = async (limit = 2): Promise<SessionSample[]> => {
  const selected = await pickLargest(limit);
  const dir = await mkdtemp(join(tmpdir(), "pi-vcc-sessions-"));
  await mkdir(dir, { recursive: true });
  const samples: SessionSample[] = [];
  for (const source of selected) {
    const srcStat = await stat(source);
    const copy = join(dir, basename(source));
    await copyFile(source, copy);
    await chmod(copy, 0o444);
    samples.push({ source, copy, size: srcStat.size, mtimeMs: srcStat.mtimeMs });
  }
  return samples;
};

export const readSourceStat = async (sample: SessionSample) => {
  const s = await stat(sample.source);
  return { size: s.size, mtimeMs: s.mtimeMs };
};

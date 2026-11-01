/** Policy experiment: let a valid learned score correct native retrieval order. */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type QMDStore, type SearchOptions } from "../src/index.js";
import { setConfigSource } from "../src/collections.js";

describe.each(["plain", "structured"] as const)("%s reranker authority", (mode) => {
  let directory: string;
  let store: QMDStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "qmd-rerank-authority-"));
    await writeFile(join(directory, "first.md"), "# First\n\nneedle needle needle retrieval candidate\n");
    await writeFile(join(directory, "second.md"), "# Second\n\nneedle second retrieval candidate\n");
    store = await createStore({
      dbPath: join(directory, "index.sqlite"),
      config: { collections: { docs: { path: directory, pattern: "*.md" } } },
    });
    await store.update();
    vi.spyOn(store.internal, "expandQuery").mockResolvedValue([]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await store.close();
    setConfigSource();
    await rm(directory, { recursive: true, force: true });
  });

  function request(rerank: boolean): SearchOptions {
    return {
      ...(mode === "plain" ? { query: "needle" } : { queries: [{ type: "lex", query: "needle" }] }),
      rerank, explain: true, limit: 2,
    };
  }

  test("a higher learned score can replace the first retrieval candidate", async () => {
    const retrieved = await store.search(request(false));
    expect(retrieved).toHaveLength(2);
    const preferred = retrieved[1]!.file;
    const rerank = vi.spyOn(store.internal, "rerank").mockImplementation(async (_query, documents) =>
      documents.map((doc) => ({ file: doc.file, score: doc.file === preferred ? 1 : 0 })));

    const ranked = await store.search(request(true));

    expect(rerank).toHaveBeenCalledTimes(1);
    expect(ranked.find((row) => row.file === preferred)?.explain?.rerankScore).toBe(1);
    expect(ranked.find((row) => row.file === retrieved[0]!.file)?.explain?.rerankScore).toBe(0);
    expect(ranked.find((row) => row.file === preferred)?.score).toBe(1);
    expect(ranked.find((row) => row.file === retrieved[0]!.file)?.score).toBe(0);
    expect(ranked.every((row) => row.explain?.rrf.weight === 0)).toBe(true);
    expect(ranked[0]?.file).toBe(preferred);
  });

  test("equal learned scores preserve retrieval order", async () => {
    const retrieved = await store.search(request(false));
    expect(retrieved).toHaveLength(2);
    vi.spyOn(store.internal, "rerank").mockImplementation(async (_query, documents) =>
      [...documents].reverse().map((doc) => ({ file: doc.file, score: 0.5 })));

    const ranked = await store.search(request(true));

    expect(ranked.map((row) => row.file)).toEqual(retrieved.map((row) => row.file));
  });

  test("minScore applies to learned relevance", async () => {
    const rerank = vi.spyOn(store.internal, "rerank").mockImplementation(async (_query, documents) =>
      documents.map((doc) => ({ file: doc.file, score: 0.2 })));

    const ranked = await store.search({ ...request(true), minScore: 0.5 });

    expect(rerank).toHaveBeenCalledTimes(1);
    expect(rerank.mock.calls[0]?.[1]).toHaveLength(2);
    expect(ranked).toEqual([]);
  });
});

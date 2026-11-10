import "fake-indexeddb/auto";
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { unzipSync } from "fflate";
import { expect, test } from "vitest";
import { evidenceEvent, parseJson, decodeUtf8, readTraceFiles, utf8, validatePath } from "../src/index.js";
import { EvidenceReader, JsonlStore } from "../src/node/index.js";
import { IndexedDbStore, traceArchive } from "../src/browser/index.js";

const manifest = { schema_version: 3, evidence_id: "trace" };
const run = evidenceEvent("event:run", "test_run_started", { id: "run", producer: "example", source_run: "source", properties: {} });

test("Node writer locks, retries, concurrent appends and explicit unfinished-tail recovery", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "testar-evidence-"));
    try {
        const store = await JsonlStore.create(directory, manifest);
        try {
            expect("apply" in store.evidence).toBe(false);
            expect(Reflect.set(store, "directory", "elsewhere")).toBe(false);
            expect(Reflect.set(store, "evidence", {})).toBe(false);
            await expect(JsonlStore.open(directory)).rejects.toMatchObject({ code: "locked" });
            const [first, retry] = await Promise.all([store.append(run), store.append(run)]);
            expect([first, retry]).toEqual([true, false]);
            const image = await store.saveArtifact(Uint8Array.of(1, 2, 3), "image/png");
            expect((await store.saveArtifact(Uint8Array.of(1, 2, 3), "image/png")).path).toBe(image.path);
        } finally {
            await store.close();
        }
        const log = await readFile(path.join(directory, "evidence.jsonl"));
        await writeFile(path.join(directory, "evidence.jsonl"), Buffer.concat([log, Buffer.from('{"unfinished":')]));
        await expect(EvidenceReader.read(directory)).rejects.toMatchObject({ code: "incomplete_tail" });
        const recovered = await JsonlStore.open(directory, { recoverIncompleteTail: true });
        try {
            expect(recovered.evidence.eventCount).toBe(1);
            expect(await readFile(path.join(directory, "evidence.jsonl"))).toEqual(log);
        } finally {
            await recovered.close();
        }
        await writeFile(path.join(directory, "evidence.jsonl"), Buffer.concat([log, Buffer.from("invalid\n")]));
        await expect(JsonlStore.open(directory, { recoverIncompleteTail: true })).rejects.toMatchObject({ code: "invalid_json" });
    } finally {
        expect(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep + "testar-evidence-")).toBe(true);
        await rm(directory, { recursive: true, force: true });
    }
});

test("browser transactions reject a stale writer and export a readable ZIP", async () => {
    const database = "testar-evidence-test-" + randomUUID();
    const first = await IndexedDbStore.create(database, manifest);
    const second = await IndexedDbStore.open(database);
    try {
        await first.append(run);
        await expect(second.append(run)).rejects.toMatchObject({ code: "concurrent_write" });
        expect(second.evidence.eventCount).toBe(0);
        const files = await first.exportFiles();
        const archive = new Uint8Array(await traceArchive(files).arrayBuffer());
        const extracted = new Map(Object.entries(unzipSync(archive)));
        expect((await readTraceFiles(extracted)).eventCount).toBe(1);
        expect(parseJson(decodeUtf8(extracted.get("manifest.json")!))).toMatchObject(manifest);
    } finally {
        await first.close();
        await second.close();
    }
});

test("unsafe artifact paths, corrupted bytes and invalid UTF-8 cannot enter accepted evidence", async () => {
    for (const name of ["/absolute", "../outside", "artifacts/../outside", "C:/file", "artifacts\\file", "artifacts/NUL.png", "artifacts/x."]) {
        expect(() => validatePath(name)).toThrow();
    }
    const files = new Map([["manifest.json", utf8(JSON.stringify(manifest))], ["evidence.jsonl", Uint8Array.of(255, 10)]]);
    await expect(readTraceFiles(files)).rejects.toMatchObject({ code: "invalid_json" });
    files.set("evidence.jsonl", utf8(JSON.stringify(run) + "\n"));
    expect((await readTraceFiles(files)).eventCount).toBe(1);
});

test("Node reader rejects junctions and artifact hash mismatches", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "testar-evidence-"));
    let store: JsonlStore | undefined;
    try {
        store = await JsonlStore.create(directory, manifest);
        await store.append(run);
        await store.append(evidenceEvent("event:sequence", "test_sequence_started", {
            id: "sequence", test_run: "run", sequence_index: 1, source_sequence: "source", properties: {},
        }));
        const image = await store.saveArtifact(Uint8Array.of(1, 2, 3), "image/png");
        const observation = evidenceEvent("event:observation", "observation_recorded", {
            id: "observation", test_sequence: "sequence", observation_index: 1, timestamp_micros: 0,
            recorded_state: { id: "state", properties: {}, widgets: [], capture: "filtered" },
            available_action_scope: "unknown", available_actions: [], artifacts: [image],
        });
        await writeFile(path.join(directory, image.path), Uint8Array.of(4));
        await expect(store.append(observation)).rejects.toMatchObject({ code: "artifact_integrity" });
        expect(store.evidence.eventCount).toBe(2);
        const outside = path.join(directory, "outside");
        await mkdir(outside);
        await symlink(outside, path.join(directory, "junction"), process.platform === "win32" ? "junction" : "dir");
        await expect(store.append(evidenceEvent("event:junction", "observation_recorded", {
            ...observation.event.data, artifacts: [{ ...image, path: "junction/file.png" }],
        }))).rejects.toMatchObject({ code: "unsafe_path" });
    } finally {
        await store?.close();
        expect(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep + "testar-evidence-")).toBe(true);
        await rm(directory, { recursive: true, force: true });
    }
});

test("a long recorded property is preserved across streamed file chunks", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "testar-evidence-"));
    const value = "recorded data ".repeat(30_000);
    try {
        const store = await JsonlStore.create(directory, manifest);
        try {
            await store.append(evidenceEvent("event:long-run", "test_run_started", {
                id: "run", producer: "example", source_run: "source", properties: { description: value },
            }));
        } finally {
            await store.close();
        }
        const evidence = await EvidenceReader.read(directory);
        expect(evidence.testRun("run")!.test_run.properties.description).toBe(value);
    } finally {
        expect(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep + "testar-evidence-")).toBe(true);
        await rm(directory, { recursive: true, force: true });
    }
});

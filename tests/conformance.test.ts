import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { loadPreparedConformance } from "../tools/specs-conformance.ts";
import {
    decodeUtf8, equalJson, EvidenceError, EvidenceReadError, jsonlEvents, parseJson, readTraceFiles,
} from "../src/index.js";
import type { EvidenceEvent, TraceFiles } from "../src/index.js";
import { EvidenceReader, JsonlStore } from "../src/node/index.js";
import { IndexedDbStore } from "../src/browser/index.js";

const prepared = await loadPreparedConformance();

async function caseFiles(name: string): Promise<Map<string, Uint8Array>> {
    const directory = path.join(prepared.directory, "conformance", "cases", name);
    const files = new Map<string, Uint8Array>();
    async function collect(relative: string): Promise<void> {
        for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
            const name = relative ? relative + "/" + entry.name : entry.name;
            if (entry.isDirectory()) {
                await collect(name);
            } else {
                files.set(name, await readFile(path.join(directory, name)));
            }
        }
    }
    await collect("");
    return files;
}

async function readResult(files: TraceFiles): Promise<{ result: unknown; events: readonly EvidenceEvent[] }> {
    try {
        const evidence = await readTraceFiles(files);
        return { result: evidence.summary(), events: evidence.events };
    } catch (cause) {
        if (!(cause instanceof EvidenceReadError)) {
            throw cause;
        }
        return {
            result: { status: "rejected", error: { code: cause.code, event: cause.eventId, field: cause.field },
                accepted_prefix: cause.acceptedEvidence.summary() },
            events: cause.acceptedEvidence.events,
        };
    }
}

describe("Shared evidence format: supplied traces and recorded output", () => {
    for (const name of prepared.manifest.cases) {
        test(name + " retains the expected facts with Node.js and browser storage", async () => {
            const files = await caseFiles(name);
            const expected = parseJson(decodeUtf8(files.get("expected.json")!));
            const original = await readResult(files);
            expect(equalJson(original.result, expected)).toBe(true);
            const directory = await mkdtemp(path.join(tmpdir(), "testar-evidence-"));
            const database = "testar-evidence-test-" + randomUUID();
            try {
                for (const backend of ["node", "browser"] as const) {
                    const manifest = parseJson(decodeUtf8(files.get("manifest.json")!));
                    const store = backend === "node" ? await JsonlStore.create(directory, manifest) : await IndexedDbStore.create(database, manifest);
                    try {
                        // The source trace is the input. expected.json describes its independently specified result.
                        let rejected: { code: string; event: unknown; field: string | undefined } | undefined;
                        for (const input of jsonlEvents(files.get("evidence.jsonl")!)) {
                            const event = input as EvidenceEvent;
                            if (event.event.event_type === "observation_recorded") {
                                for (const reference of event.event.data.artifacts) {
                                    const bytes = files.get(reference.path)!;
                                    const saved = await store.saveArtifact(bytes, reference.media_type,
                                        { width: reference.width, height: reference.height });
                                    expect(saved.path).toBe(reference.path);
                                    expect(saved.sha256).toBe(reference.sha256);
                                }
                            }
                            const before = await store.exportFiles();
                            try {
                                await store.append(input);
                                const once = await store.exportFiles();
                                expect(await store.append(input)).toBe(false);
                                expect((await store.exportFiles()).get("evidence.jsonl")).toEqual(once.get("evidence.jsonl"));
                            } catch (cause) {
                                if (!(cause instanceof EvidenceError)) {
                                    throw cause;
                                }
                                rejected = { code: cause.code, event: event.id, field: cause.field };
                                expect((await store.exportFiles()).get("evidence.jsonl")).toEqual(before.get("evidence.jsonl"));
                                break;
                            }
                        }
                        const actual = rejected ? { status: "rejected", error: rejected, accepted_prefix: store.evidence.summary() } : store.evidence.summary();
                        expect(equalJson(actual, expected)).toBe(true);
                        expect(equalJson(store.evidence.events, original.events)).toBe(true);
                        const output = await store.exportFiles();
                        const read = await readTraceFiles(output);
                        expect(equalJson(read.summary(), store.evidence.summary())).toBe(true);
                        expect(equalJson(read.events, original.events)).toBe(true);
                        for (const [filename, bytes] of output) {
                            if (filename.startsWith("artifacts/")) {
                                expect(bytes).toEqual(new Uint8Array(files.get(filename)!));
                            }
                        }
                    } finally {
                        await store.close();
                    }
                    const reopened = backend === "node" ? await JsonlStore.open(directory) : await IndexedDbStore.open(database);
                    try {
                        expect(equalJson(reopened.evidence.events, original.events)).toBe(true);
                        expect(equalJson(reopened.evidence.summary(),
                            (expected as { status: string; accepted_prefix?: unknown }).status === "rejected" ?
                                (expected as { accepted_prefix: unknown }).accepted_prefix : expected)).toBe(true);
                        if (backend === "node") {
                            expect(equalJson((await EvidenceReader.read(directory)).events, original.events)).toBe(true);
                        }
                    } finally {
                        await reopened.close();
                    }
                }
            } finally {
                expect(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep + "testar-evidence-")).toBe(true);
                await rm(directory, { recursive: true, force: true });
                await new Promise<void>((resolve, reject) => {
                    const request = indexedDB.deleteDatabase(database);
                    request.onsuccess = () => resolve();
                    request.onerror = () => reject(request.error);
                });
            }
        });
    }
});

import { zipSync } from "fflate";
import { EvidenceError, requireEvidence } from "../errors.js";
import { EvidenceHistory } from "../evidence-history.js";
import { parseJson, encodePreparedJson } from "../json.js";
import type { ArtifactReference } from "../records.js";
import { ReconstructedEvidence } from "../reconstructed-evidence.js";
import { acceptReadEvent, createArtifact, exportTraceFiles, verifyEventArtifacts } from "../trace-files.js";
import type { TraceFiles } from "../trace-files.js";
import { validateManifest, validatePath } from "../validation.js";

interface StoredEvent { id: string; position: number; json: string }

function request<T>(operation: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        operation.onsuccess = () => resolve(operation.result);
        operation.onerror = () => reject(operation.error ?? new EvidenceError("storage_error", "Browser storage request failed"));
    });
}

function completed(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new EvidenceError("storage_error", "Browser storage transaction was aborted"));
        transaction.onerror = () => {};
    });
}

async function openDatabase(name: string, create: boolean): Promise<IDBDatabase> {
    requireEvidence(typeof indexedDB !== "undefined", "storage_unavailable", "IndexedDB is unavailable in this environment");
    return new Promise((resolve, reject) => {
        const operation = indexedDB.open(name, 1);
        operation.onupgradeneeded = () => {
            if (!create) {
                operation.transaction!.abort();
                return;
            }
            operation.result.createObjectStore("metadata");
            const events = operation.result.createObjectStore("events", { keyPath: "id" });
            events.createIndex("position", "position", { unique: true });
            operation.result.createObjectStore("artifacts");
        };
        operation.onsuccess = () => resolve(operation.result);
        operation.onerror = () => reject(new EvidenceError("missing_file", "Browser evidence database could not be opened"));
        operation.onblocked = () => reject(new EvidenceError("locked", "Close other connections before changing this database"));
    });
}

/** Persist evidence locally in a browser or extension; exporting keeps the common trace format. */
export class IndexedDbStore {
    #databaseName: string;
    #history: EvidenceHistory;
    #accepted: ReconstructedEvidence;
    #database: IDBDatabase;
    #queue: Promise<unknown> = Promise.resolve();
    #closed = false;

    private constructor(name: string, database: IDBDatabase, evidence: ReconstructedEvidence) {
        this.#databaseName = name;
        this.#database = database;
        this.#accepted = evidence;
        this.#history = new EvidenceHistory(evidence);
        database.onversionchange = () => {
            this.#closed = true;
            database.close();
        };
    }

    get evidence(): EvidenceHistory { return this.#history; }
    get databaseName(): string { return this.#databaseName; }

    static async create(name: string, manifest: unknown): Promise<IndexedDbStore> {
        const prepared = validateManifest(manifest);
        const database = await openDatabase(name, true);
        try {
            const transaction = database.transaction("metadata", "readwrite");
            const done = completed(transaction);
            const metadata = transaction.objectStore("metadata");
            const previous = await request(metadata.get("manifest"));
            if (previous !== undefined) {
                transaction.abort();
                await done.catch(() => {});
                throw new EvidenceError("already_exists", "Browser evidence already exists; open it to continue recording");
            }
            metadata.put(encodePreparedJson(prepared), "manifest");
            metadata.put(0, "event_count");
            await done;
            return new IndexedDbStore(name, database, new ReconstructedEvidence(prepared));
        } catch (cause) {
            database.close();
            throw cause;
        }
    }

    static async open(name: string): Promise<IndexedDbStore> {
        const database = await openDatabase(name, false);
        try {
            const transaction = database.transaction(["metadata", "events", "artifacts"], "readonly");
            const done = completed(transaction);
            const manifest = request(transaction.objectStore("metadata").get("manifest"));
            const events = request(transaction.objectStore("events").index("position").getAll()) as Promise<StoredEvent[]>;
            const artifacts = request(transaction.objectStore("artifacts").getAll());
            const paths = request(transaction.objectStore("artifacts").getAllKeys());
            const [manifestJson, records, bytes, names] = await Promise.all([manifest, events, artifacts, paths]);
            await done;
            requireEvidence(typeof manifestJson === "string", "missing_file", "Browser evidence manifest is missing");
            const evidence = new ReconstructedEvidence(parseJson(manifestJson));
            const files = new Map(names.map((key, index) => [String(key), new Uint8Array(bytes[index] as Uint8Array)]));
            const load = async (path: string): Promise<Uint8Array> => {
                validatePath(path);
                const value = files.get(path);
                requireEvidence(value, "missing_file", "Missing artifact: " + path);
                return value;
            };
            for (const record of records) {
                await acceptReadEvent(evidence, parseJson(record.json), load);
            }
            return new IndexedDbStore(name, database, evidence);
        } catch (cause) {
            database.close();
            throw cause;
        }
    }

    #enqueue<T>(operation: () => Promise<T>): Promise<T> {
        requireEvidence(!this.#closed, "closed", "Browser evidence storage is closed");
        const result = this.#queue.then(operation);
        this.#queue = result.catch(() => {});
        return result;
    }

    async #loadArtifact(path: string): Promise<Uint8Array> {
        validatePath(path);
        const transaction = this.#database.transaction("artifacts", "readonly");
        const done = completed(transaction);
        const value = await request(transaction.objectStore("artifacts").get(path));
        await done;
        requireEvidence(value !== undefined, "missing_file", "Missing artifact: " + path);
        return new Uint8Array(value as Uint8Array);
    }

    append(event: unknown): Promise<boolean> {
        return this.#enqueue(() => this.#accepted.record(event, async (prepared) => {
            const json = encodePreparedJson(prepared);
            await verifyEventArtifacts(prepared, (path) => this.#loadArtifact(path));
            const transaction = this.#database.transaction(["metadata", "events"], "readwrite");
            const done = completed(transaction);
            const metadata = transaction.objectStore("metadata");
            const count = await request(metadata.get("event_count")) as number;
            if (count !== this.evidence.eventCount) {
                transaction.abort();
                await done.catch(() => {});
                throw new EvidenceError("concurrent_write", "Another writer changed this trace; close and reopen it before recording");
            }
            transaction.objectStore("events").add({ id: prepared.id, position: count, json } satisfies StoredEvent);
            metadata.put(count + 1, "event_count");
            await done;
        }));
    }

    saveArtifact(bytes: Uint8Array, mediaType: string,
        dimensions: { width?: number | bigint | null; height?: number | bigint | null } = {}): Promise<ArtifactReference> {
        const owned = new Uint8Array(bytes);
        return this.#enqueue(async () => {
            const reference = await createArtifact(owned, mediaType, dimensions);
            const transaction = this.#database.transaction("artifacts", "readwrite");
            const done = completed(transaction);
            const artifacts = transaction.objectStore("artifacts");
            const previous = await request(artifacts.get(reference.path)) as Uint8Array | undefined;
            if (previous !== undefined && (previous.length !== owned.length || !owned.every((value, index) => value === previous[index]))) {
                transaction.abort();
                await done.catch(() => {});
                throw new EvidenceError("artifact_integrity", "Existing artifact bytes differ");
            }
            artifacts.put(owned, reference.path);
            await done;
            return reference;
        });
    }

    exportFiles(): Promise<Map<string, Uint8Array>> {
        return this.#enqueue(() => exportTraceFiles(this.evidence, (path) => this.#loadArtifact(path)));
    }

    async close(): Promise<void> {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        await this.#queue;
        this.#database.close();
    }

}

/** Create one downloadable ZIP containing the manifest, JSONL log and referenced artifacts. */
export function traceArchive(files: TraceFiles): Blob {
    const entries: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
    for (const [path, bytes] of files) {
        validatePath(path);
        entries[path] = bytes;
    }
    return new Blob([new Uint8Array(zipSync(entries))], { type: "application/zip" });
}

/** Start an explicit browser download. Calling code decides when users should export their trace. */
export function downloadTrace(files: TraceFiles, filename = "evidence.zip"): void {
    const url = URL.createObjectURL(traceArchive(files));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

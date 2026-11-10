import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, truncate, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { EvidenceError, requireEvidence } from "../errors.js";
import { EvidenceHistory } from "../evidence-history.js";
import { decodeUtf8, MAX_RECORD_BYTES, parseJson, encodePreparedJson, utf8 } from "../json.js";
import type { ArtifactReference } from "../records.js";
import { ReconstructedEvidence } from "../reconstructed-evidence.js";
import {
    acceptReadEvent, createArtifact, EvidenceReadError, exportTraceFiles, verifyEventArtifacts,
} from "../trace-files.js";
import { validateManifest, validatePath } from "../validation.js";

/** Reject symlinks and Windows junctions in every path below the selected trace directory. */
async function safePath(root: string, relative: string): Promise<string> {
    validatePath(relative);
    let current = root;
    for (const part of relative.split("/")) {
        current = path.join(current, part);
        try {
            const information = await lstat(current);
            requireEvidence(!information.isSymbolicLink(), "unsafe_path", "Evidence paths cannot contain symbolic links or junctions");
            const resolved = await realpath(current);
            const inside = path.relative(root, resolved);
            requireEvidence(inside !== ".." && !inside.startsWith(".." + path.sep) && !path.isAbsolute(inside),
                "unsafe_path", "Evidence path leaves its directory");
        } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
                throw cause;
            }
        }
    }
    return current;
}

async function loadFile(root: string, relative: string): Promise<Uint8Array> {
    const filename = await safePath(root, relative);
    try {
        requireEvidence((await lstat(filename)).isFile(), "missing_file", "Evidence path is not a regular file");
        return await readFile(filename);
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
            throw new EvidenceError("missing_file", "Missing evidence file: " + relative);
        }
        throw cause;
    }
}

async function reconstruct(root: string, recoverIncompleteTail = false): Promise<{ evidence: ReconstructedEvidence; completed: number }> {
    const manifestBytes = await loadFile(root, "manifest.json");
    requireEvidence(manifestBytes.length <= MAX_RECORD_BYTES, "limit_exceeded", "Manifest exceeds its size limit");
    const evidence = new ReconstructedEvidence(parseJson(decodeUtf8(manifestBytes)));
    const filename = await safePath(root, "evidence.jsonl");
    requireEvidence((await lstat(filename)).isFile(), "missing_file", "Evidence log is not a regular file");
    let pending: Buffer[] = [];
    let pendingLength = 0;
    let completed = 0;
    try {
        for await (const rawChunk of createReadStream(filename)) {
            const chunk = rawChunk as Buffer;
            let start = 0;
            let newline = chunk.indexOf(10, start);
            while (newline !== -1) {
                const fragment = chunk.subarray(start, newline);
                const length = pendingLength + fragment.length;
                requireEvidence(length <= MAX_RECORD_BYTES + 1, "limit_exceeded", "Evidence record exceeds its size limit");
                const line = pending.length === 0 ? fragment : Buffer.concat([...pending, fragment], length);
                await acceptReadEvent(evidence, parseJson(decodeUtf8(line)), (relative) => loadFile(root, relative));
                completed += length + 1;
                pending = [];
                pendingLength = 0;
                start = newline + 1;
                newline = chunk.indexOf(10, start);
            }
            if (start < chunk.length) {
                pending.push(chunk.subarray(start));
                pendingLength += chunk.length - start;
                requireEvidence(pendingLength <= MAX_RECORD_BYTES + 1, "limit_exceeded", "Evidence record exceeds its size limit");
            }
        }
        requireEvidence(pendingLength === 0 || recoverIncompleteTail, "incomplete_tail",
            "Evidence ends with an unfinished line; recover it explicitly");
    } catch (cause) {
        if (cause instanceof EvidenceError && !(cause instanceof EvidenceReadError)) {
            throw new EvidenceReadError(cause, evidence);
        }
        throw cause;
    }
    return { evidence, completed };
}

export class EvidenceReader {
    static async read(directory: string): Promise<ReconstructedEvidence> {
        return (await reconstruct(await realpath(directory))).evidence;
    }
}

/** Append each event durably before updating memory. Node filesystem code stays in this entry point. */
export class JsonlStore {
    #directory: string;
    #history: EvidenceHistory;
    #accepted: ReconstructedEvidence;
    #output: FileHandle;
    #release: () => Promise<void>;
    #queue: Promise<unknown> = Promise.resolve();
    #closed = false;
    #failed = false;

    private constructor(directory: string, evidence: ReconstructedEvidence, output: FileHandle, release: () => Promise<void>) {
        this.#directory = directory;
        this.#accepted = evidence;
        this.#history = new EvidenceHistory(evidence);
        this.#output = output;
        this.#release = release;
    }

    get evidence(): EvidenceHistory { return this.#history; }
    get directory(): string { return this.#directory; }

    static async #acquire(root: string): Promise<{ release: () => Promise<void>; failed: () => boolean }> {
        let compromised = false;
        try {
            const lockPath = await safePath(root, ".node-writer.lock");
            const release = await lockfile.lock(root, {
                lockfilePath: lockPath, realpath: false, retries: 0,
                onCompromised: () => { compromised = true; },
            });
            return { release, failed: () => compromised };
        } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ELOCKED") {
                throw new EvidenceError("locked", "Another Node.js writer has this trace open");
            }
            throw cause;
        }
    }

    static async create(directory: string, manifest: unknown): Promise<JsonlStore> {
        const prepared = validateManifest(manifest);
        await mkdir(directory, { recursive: true });
        const root = await realpath(directory);
        const lock = await JsonlStore.#acquire(root);
        const created: string[] = [];
        let output: FileHandle | undefined;
        try {
            const metadataPath = await safePath(root, "manifest.json");
            const metadata = await open(metadataPath, "wx");
            created.push(metadataPath);
            try {
                await metadata.writeFile(utf8(encodePreparedJson(prepared) + "\n"));
                await metadata.sync();
            } finally {
                await metadata.close();
            }
            const logPath = await safePath(root, "evidence.jsonl");
            output = await open(logPath, "ax+");
            created.push(logPath);
            const store = new JsonlStore(root, new ReconstructedEvidence(prepared), output, lock.release);
            store.#lockFailed = lock.failed;
            return store;
        } catch (cause) {
            await output?.close();
            for (const filename of created.reverse()) {
                await unlink(filename);
            }
            await lock.release();
            if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
                throw new EvidenceError("already_exists", "Evidence already exists; open it to continue recording");
            }
            throw cause;
        }
    }

    static async open(directory: string, options: { recoverIncompleteTail?: boolean } = {}): Promise<JsonlStore> {
        const root = await realpath(directory);
        const lock = await JsonlStore.#acquire(root);
        try {
            const result = await reconstruct(root, options.recoverIncompleteTail);
            const filename = await safePath(root, "evidence.jsonl");
            if (options.recoverIncompleteTail) {
                await truncate(filename, result.completed);
            }
            const output = await open(filename, "a");
            const store = new JsonlStore(root, result.evidence, output, lock.release);
            store.#lockFailed = lock.failed;
            return store;
        } catch (cause) {
            await lock.release();
            throw cause;
        }
    }

    #lockFailed: () => boolean = () => false;

    #enqueue<T>(operation: () => Promise<T>): Promise<T> {
        requireEvidence(!this.#closed, "closed", "Evidence writer is closed");
        const result = this.#queue.then(async () => {
            requireEvidence(!this.#failed && !this.#lockFailed(), "writer_failed", "Reopen this writer after a persistence or lock failure");
            return operation();
        });
        this.#queue = result.catch(() => {});
        return result;
    }

    append(event: unknown): Promise<boolean> {
        return this.#enqueue(() => this.#accepted.record(event, async (prepared) => {
            const bytes = utf8(encodePreparedJson(prepared) + "\n");
            await verifyEventArtifacts(prepared, (relative) => loadFile(this.directory, relative));
            try {
                let offset = 0;
                while (offset < bytes.length) {
                    const result = await this.#output.write(bytes, offset, bytes.length - offset);
                    requireEvidence(result.bytesWritten > 0, "write_failed", "Evidence write made no progress");
                    offset += result.bytesWritten;
                }
                await this.#output.sync();
            } catch (cause) {
                this.#failed = true;
                throw cause;
            }
        }));
    }

    saveArtifact(bytes: Uint8Array, mediaType: string,
        dimensions: { width?: number | bigint | null; height?: number | bigint | null } = {}): Promise<ArtifactReference> {
        const owned = new Uint8Array(bytes);
        return this.#enqueue(async () => {
            const reference = await createArtifact(owned, mediaType, dimensions);
            const filename = await safePath(this.directory, reference.path);
            await mkdir(path.dirname(filename), { recursive: true });
            const verifiedPath = await safePath(this.directory, reference.path);
            let output: FileHandle;
            try {
                output = await open(verifiedPath, "wx");
            } catch (cause) {
                if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
                    throw cause;
                }
                requireEvidence(Buffer.from(await loadFile(this.directory, reference.path)).equals(Buffer.from(owned)),
                    "artifact_integrity", "Existing artifact bytes differ");
                return reference;
            }
            try {
                await output.writeFile(owned);
                await output.sync();
            } catch (cause) {
                this.#failed = true;
                throw cause;
            } finally {
                await output.close();
            }
            return reference;
        });
    }

    exportFiles(): Promise<Map<string, Uint8Array>> {
        return this.#enqueue(() => exportTraceFiles(this.evidence, (relative) => loadFile(this.directory, relative)));
    }

    async close(): Promise<void> {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        await this.#queue;
        try {
            await this.#output.close();
        } finally {
            await this.#release();
        }
    }

}

import { EvidenceError, requireEvidence } from "./errors.js";
import { decodeUtf8, MAX_RECORD_BYTES, parseJson, encodePreparedJson, utf8 } from "./json.js";
import type { ArtifactReference, EvidenceEvent } from "./records.js";
import { ReconstructedEvidence } from "./reconstructed-evidence.js";
import { validateArtifact, validatePath } from "./validation.js";

export type TraceFiles = ReadonlyMap<string, Uint8Array>;
export type ArtifactLoader = (path: string) => Promise<Uint8Array>;

/** Reading stops at the rejected event; accepted facts remain available for inspection. */
export class EvidenceReadError extends EvidenceError {
    readonly acceptedEvidence: ReconstructedEvidence;
    readonly eventId?: string;

    constructor(cause: EvidenceError, accepted: ReconstructedEvidence, eventId?: string) {
        super(cause.code, cause.message, cause.field);
        this.name = "EvidenceReadError";
        this.acceptedEvidence = accepted;
        this.eventId = eventId;
        this.cause = cause;
    }
}

export async function sha256(bytes: Uint8Array): Promise<string> {
    const hash = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
    return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function verifyArtifact(reference: ArtifactReference, load: ArtifactLoader): Promise<void> {
    const bytes = await load(reference.path);
    requireEvidence(await sha256(bytes) === reference.sha256, "artifact_integrity", "Artifact SHA-256 mismatch", "sha256");
}

export async function verifyEventArtifacts(event: EvidenceEvent, load: ArtifactLoader): Promise<void> {
    if (event.event.event_type === "observation_recorded") {
        for (const artifact of event.event.data.artifacts) {
            await verifyArtifact(artifact, load);
        }
    }
}

export async function createArtifact(bytes: Uint8Array, mediaType: string,
    dimensions: { width?: number | bigint | null; height?: number | bigint | null } = {}): Promise<ArtifactReference> {
    const hash = await sha256(bytes);
    const extension = mediaType === "image/png" ? ".png" : mediaType === "image/jpeg" ? ".jpg" : ".bin";
    return validateArtifact({ id: hash, path: "artifacts/" + hash + extension, media_type: mediaType, sha256: hash, ...(dimensions.width !== undefined ? { width: dimensions.width } : {}),
        ...(dimensions.height !== undefined ? { height: dimensions.height } : {}) });
}

/** Decode complete lines only. Recovery explicitly discards an unfinished final line. */
export function* jsonlEvents(bytes: Uint8Array, recoverIncompleteTail = false): Generator<unknown> {
    let start = 0;
    for (let position = 0; position < bytes.length; position++) {
        requireEvidence(position - start <= MAX_RECORD_BYTES + 1, "limit_exceeded", "Evidence record exceeds its size limit");
        if (bytes[position] === 10) {
            yield parseJson(decodeUtf8(bytes.subarray(start, position)));
            start = position + 1;
        }
    }
    requireEvidence(start === bytes.length || recoverIncompleteTail, "incomplete_tail",
        "Evidence ends with an unfinished line; recover it explicitly");
}

export async function acceptReadEvent(evidence: ReconstructedEvidence, input: unknown, load: ArtifactLoader): Promise<void> {
    try {
        await evidence.record(input, (prepared) => verifyEventArtifacts(prepared, load));
    } catch (cause) {
        if (cause instanceof EvidenceError) {
            const id = input !== null && typeof input === "object" && "id" in input && typeof input.id === "string" ? input.id : undefined;
            throw new EvidenceReadError(cause, evidence, id);
        }
        throw cause;
    }
}

/** Import the same file collection produced by Node.js and browser storage. */
export async function readTraceFiles(files: TraceFiles, options: { recoverIncompleteTail?: boolean } = {}): Promise<ReconstructedEvidence> {
    const load: ArtifactLoader = async (path) => {
        validatePath(path);
        const bytes = files.get(path);
        requireEvidence(bytes, "missing_file", "Missing evidence file: " + path);
        return bytes;
    };
    const evidence = new ReconstructedEvidence(parseJson(decodeUtf8(await load("manifest.json"))));
    try {
        for (const event of jsonlEvents(await load("evidence.jsonl"), options.recoverIncompleteTail)) {
            await acceptReadEvent(evidence, event, load);
        }
    } catch (cause) {
        if (cause instanceof EvidenceError && !(cause instanceof EvidenceReadError)) {
            throw new EvidenceReadError(cause, evidence);
        }
        throw cause;
    }
    return evidence;
}

/** Export original events and verified artifacts without deriving abstract states. */
export async function exportTraceFiles(evidence: Pick<ReconstructedEvidence, "manifest" | "events" | "observations">, load: ArtifactLoader): Promise<Map<string, Uint8Array>> {
    const result = new Map<string, Uint8Array>();
    result.set("manifest.json", utf8(encodePreparedJson(evidence.manifest) + "\n"));
    result.set("evidence.jsonl", utf8(evidence.events.map((event) => encodePreparedJson(event) + "\n").join("")));
    for (const observation of evidence.observations) {
        for (const reference of observation.artifacts) {
            if (!result.has(reference.path)) {
                const bytes = new Uint8Array(await load(reference.path));
                requireEvidence(await sha256(bytes) === reference.sha256, "artifact_integrity", "Artifact SHA-256 mismatch", "sha256");
                result.set(reference.path, bytes);
            }
        }
    }
    return result;
}

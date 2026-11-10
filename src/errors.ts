/** A rejected record includes a stable code and, when applicable, its field. */
export class EvidenceError extends Error {
    readonly code: string;
    readonly field?: string;

    constructor(code: string, message: string, field?: string) {
        super(message);
        this.name = "EvidenceError";
        this.code = code;
        this.field = field;
    }
}

export function requireEvidence(condition: unknown, code: string, message: string, field?: string): asserts condition {
    if (!condition) {
        throw new EvidenceError(code, message, field);
    }
}

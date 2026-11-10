import { EvidenceError, requireEvidence } from "./errors.js";

export const MAX_RECORD_BYTES = 16 * 1024 * 1024;
export const MAX_JSON_DEPTH = 64;
const numberPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;

/** An exact JSON number, for example a decimal supplied by another implementation. */
export class JsonNumber {
    readonly text: string;

    constructor(text: string) {
        requireEvidence(numberPattern.test(text), "invalid_json", "Invalid JSON number");
        this.text = text;
        Object.freeze(this);
    }
}

export type JsonValue = null | boolean | string | number | bigint | JsonNumber | JsonValue[] | { [key: string]: JsonValue };
export type Properties = { [key: string]: JsonValue };

export function utf8(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

export function decodeUtf8(bytes: Uint8Array): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw new EvidenceError("invalid_json", "Evidence must contain valid UTF-8");
    }
}

/** Parse without rounding large numbers or accepting duplicate object keys. */
export function parseJson(text: string): JsonValue {
    requireEvidence(utf8(text).length <= MAX_RECORD_BYTES, "limit_exceeded", "JSON record exceeds its size limit");
    let position = 0;
    const whitespace = () => {
        while (/[\t\n\r ]/u.test(text[position] ?? "") && position < text.length) {
            position++;
        }
    };
    const fail = (): never => {
        throw new EvidenceError("invalid_json", "Invalid JSON at character " + position);
    };
    const readString = (): string => {
        const start = position++;
        while (position < text.length) {
            const character = text[position++];
            if (character === "\\") {
                position++;
            } else if (character === '"') {
                try {
                    return JSON.parse(text.slice(start, position)) as string;
                } catch {
                    return fail();
                }
            }
        }
        return fail();
    };
    const read = (depth: number): JsonValue => {
        requireEvidence(depth <= MAX_JSON_DEPTH, "limit_exceeded", "JSON nesting exceeds its depth limit");
        whitespace();
        const character = text[position];
        if (character === '"') {
            return readString();
        }
        if (character === "{" || character === "[") {
            position++;
            const object = character === "{";
            const result: Properties | JsonValue[] = object ? Object.create(null) as Properties : [];
            const end = object ? "}" : "]";
            whitespace();
            if (text[position] === end) {
                position++;
                return result;
            }
            while (position < text.length) {
                whitespace();
                if (object) {
                    if (text[position] !== '"') {
                        return fail();
                    }
                    const key = readString();
                    requireEvidence(!Object.hasOwn(result, key), "invalid_json", "Duplicate JSON key: " + key);
                    whitespace();
                    if (text[position++] !== ":") {
                        return fail();
                    }
                    (result as Properties)[key] = read(depth + 1);
                } else {
                    (result as JsonValue[]).push(read(depth + 1));
                }
                whitespace();
                const delimiter = text[position++];
                if (delimiter === end) {
                    return result;
                }
                if (delimiter !== ",") {
                    return fail();
                }
            }
            return fail();
        }
        for (const [literal, value] of [["true", true], ["false", false], ["null", null]] as const) {
            if (text.startsWith(literal, position)) {
                position += literal.length;
                return value;
            }
        }
        const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(position))?.[0];
        if (!token) {
            return fail();
        }
        position += token.length;
        if (!/[.eE]/u.test(token)) {
            const integer = BigInt(token);
            return integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(token) : integer;
        }
        return new JsonNumber(token);
    };
    const result = read(0);
    whitespace();
    if (position !== text.length) {
        return fail();
    }
    return result;
}

/** Detach and freeze one incoming event; accepted records cannot change afterwards. */
export function copyJson<T>(input: T): T {
    const ancestors = new Set<object>();
    const copy = (value: unknown, depth: number): unknown => {
        requireEvidence(depth <= MAX_JSON_DEPTH, "limit_exceeded", "JSON nesting exceeds its depth limit");
        if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "bigint" || value instanceof JsonNumber) {
            return value;
        }
        if (typeof value === "number") {
            requireEvidence(Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)),
                "invalid_record", "Use bigint or JsonNumber for an integer outside JavaScript's safe range");
            return value;
        }
        requireEvidence(typeof value === "object" && value !== null, "invalid_record", "Value is not JSON data");
        requireEvidence(!ancestors.has(value), "invalid_record", "JSON data contains a cycle");
        const prototype = Object.getPrototypeOf(value);
        requireEvidence(Array.isArray(value) || prototype === Object.prototype || prototype === null,
            "invalid_record", "JSON objects must be plain data objects");
        requireEvidence(Object.getOwnPropertySymbols(value).length === 0, "invalid_record", "JSON data cannot contain symbol keys");
        ancestors.add(value);
        let result: unknown;
        if (Array.isArray(value)) {
            requireEvidence(value.length === Object.keys(value).length, "invalid_record", "JSON arrays cannot be sparse or have named properties");
            result = Array.from(value, (item) => copy(item, depth + 1));
        } else {
            const record: Properties = Object.create(null) as Properties;
            for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
                requireEvidence("value" in descriptor && descriptor.enumerable, "invalid_record", "JSON data cannot contain getters or hidden fields");
                record[key] = copy(descriptor.value, depth + 1) as JsonValue;
            }
            result = record;
        }
        ancestors.delete(value);
        return Object.freeze(result);
    };
    return copy(input, 0) as T;
}

export function stringifyJson(value: unknown): string {
    return encodePreparedJson(copyJson(value));
}

/** Internal serialization of already-owned data, avoiding another traversal and copy. */
export function encodePreparedJson(value: unknown): string {
    const write = (item: unknown): string => {
        if (item instanceof JsonNumber) {
            return item.text;
        }
        if (typeof item === "bigint") {
            return item.toString();
        }
        if (Array.isArray(item)) {
            return "[" + item.map(write).join(",") + "]";
        }
        if (item !== null && typeof item === "object") {
            return "{" + Object.entries(item).map(([key, child]) => JSON.stringify(key) + ":" + write(child)).join(",") + "}";
        }
        requireEvidence(item === null || ["string", "boolean", "number"].includes(typeof item), "invalid_json", "Value is not JSON data");
        requireEvidence(typeof item !== "number" || Number.isFinite(item), "invalid_json", "JSON numbers must be finite");
        return JSON.stringify(item);
    };
    const result = write(value);
    requireEvidence(utf8(result).length <= MAX_RECORD_BYTES, "limit_exceeded", "JSON record exceeds its size limit");
    return result;
}

function numberKey(value: number | bigint | JsonNumber): string {
    const text = value instanceof JsonNumber ? value.text : value.toString();
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(text)!;
    const digits = (match[2] + (match[3] ?? "")).replace(/^0+/u, "");
    if (digits === "") {
        return "0";
    }
    const trimmed = digits.replace(/0+$/u, "");
    const exponent = BigInt(match[4] ?? "0") - BigInt((match[3] ?? "").length) + BigInt(digits.length - trimmed.length);
    return match[1] + trimmed + "e" + exponent.toString();
}

export function equalJson(left: unknown, right: unknown): boolean {
    const numeric = (value: unknown): value is number | bigint | JsonNumber =>
        typeof value === "number" || typeof value === "bigint" || value instanceof JsonNumber;
    if (numeric(left) && numeric(right)) {
        return numberKey(left) === numberKey(right);
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => equalJson(item, right[index]));
    }
    if (left !== null && right !== null && typeof left === "object" && typeof right === "object" && !numeric(left) && !numeric(right)) {
        const a = Object.keys(left);
        const b = Object.keys(right);
        return a.length === b.length && a.every((key) => Object.hasOwn(right, key) &&
            equalJson((left as Properties)[key], (right as Properties)[key]));
    }
    return left === right;
}

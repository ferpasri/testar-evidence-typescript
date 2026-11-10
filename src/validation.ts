import { requireEvidence } from "./errors.js";
import { copyJson, JsonNumber } from "./json.js";
import type { ArtifactReference, EvidenceEvent, Manifest } from "./records.js";

type Data = Record<string, unknown>;

export function object(value: unknown, field = "record"): Data {
    requireEvidence(value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof JsonNumber),
        "invalid_record", field + " must be an object", field);
    return value as Data;
}

function fields(value: unknown, required: string[], optional: string[] = [], name = "record"): Data {
    const data = object(value, name);
    for (const key of Object.keys(data)) {
        requireEvidence(required.includes(key) || optional.includes(key), "invalid_record", "Unknown field: " + key, key);
    }
    for (const key of required) {
        requireEvidence(Object.hasOwn(data, key), "invalid_record", name + "." + key + " is required", key);
    }
    return data;
}

export function text(value: unknown, field: string): asserts value is string {
    requireEvidence(typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
        "invalid_record", field + " must be nonblank text without control characters", field);
}

function texts(data: Data, names: string[]): void {
    for (const name of names) {
        text(data[name], name);
    }
}

function properties(value: unknown, field = "properties"): void {
    for (const key of Object.keys(object(value, field))) {
        text(key, "Property name");
    }
}

function unsigned(value: unknown, field: string): void {
    requireEvidence((typeof value === "number" && Number.isSafeInteger(value) || typeof value === "bigint") &&
        BigInt(value as number | bigint) >= 0n && BigInt(value as number | bigint) <= 18446744073709551615n,
        "invalid_record", field + " must be an unsigned 64-bit integer", field);
}

function choice(value: unknown, allowed: string[], field: string): void {
    requireEvidence(typeof value === "string" && allowed.includes(value), "invalid_record", "Unsupported " + field, field);
}

function nullableText(value: unknown, field: string): void {
    if (value !== null) {
        text(value, field);
    }
}

function array(value: unknown, field: string): unknown[] {
    requireEvidence(Array.isArray(value), "invalid_record", field + " must be an array", field);
    return value;
}

export function validatePath(value: unknown): string {
    text(value, "path");
    requireEvidence(!value.startsWith("/") && !/[\\:]/u.test(value), "invalid_record", "Artifact path must be relative and portable", "path");
    for (const part of value.split("/")) {
        requireEvidence(part !== "" && part !== "." && part !== ".." && !/[. ]$/u.test(part) &&
            !/[<>"|?*]/u.test(part) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part),
            "invalid_record", "Unsafe artifact path", "path");
    }
    return value;
}

function artifact(value: unknown): void {
    const data = fields(value, ["id", "path", "media_type", "sha256"], ["width", "height"], "artifact");
    texts(data, ["id", "media_type"]);
    validatePath(data.path);
    requireEvidence(typeof data.sha256 === "string" && /^[0-9a-f]{64}$/u.test(data.sha256),
        "invalid_record", "Artifact requires a lowercase SHA-256 hash", "sha256");
    for (const dimension of ["width", "height"]) {
        if (data[dimension] !== null && data[dimension] !== undefined) {
            unsigned(data[dimension], dimension);
        }
    }
}

export function validateArtifact(value: unknown): ArtifactReference {
    const prepared = copyJson(value);
    artifact(prepared);
    return prepared as ArtifactReference;
}

function state(value: unknown): Set<string> {
    const data = fields(value, ["id", "properties", "widgets", "capture"], [], "recorded state");
    text(data.id, "id");
    properties(data.properties);
    choice(data.capture, ["complete", "filtered", "unavailable"], "capture");
    const widgets = array(data.widgets, "widgets");
    requireEvidence(data.capture !== "unavailable" || widgets.length === 0, "invalid_record", "Unavailable capture cannot contain widgets");
    const parents = new Map<string, string | null>();
    for (const item of widgets) {
        const widget = fields(item, ["id", "parent", "properties"], [], "widget");
        text(widget.id, "id");
        nullableText(widget.parent, "parent");
        properties(widget.properties);
        requireEvidence(!parents.has(widget.id), "conflict", "Duplicate widget");
        parents.set(widget.id, widget.parent as string | null);
    }
    const completed = new Set<string>();
    for (const id of parents.keys()) {
        const ancestry = new Set<string>();
        let current: string | null = id;
        while (current !== null && !completed.has(current)) {
            requireEvidence(!ancestry.has(current), "invalid_record", "Widget hierarchy contains a cycle");
            requireEvidence(parents.has(current), "invalid_reference", "Unknown parent widget");
            ancestry.add(current);
            current = parents.get(current)!;
        }
        for (const ancestor of ancestry) {
            completed.add(ancestor);
        }
    }
    return new Set(parents.keys());
}

function observation(value: unknown): void {
    const data = fields(value, ["id", "test_sequence", "observation_index", "timestamp_micros", "recorded_state",
        "available_action_scope", "available_actions", "artifacts"], [], "observation");
    texts(data, ["id", "test_sequence"]);
    unsigned(data.observation_index, "observation_index");
    unsigned(data.timestamp_micros, "timestamp_micros");
    choice(data.available_action_scope, ["unknown", "generated", "eligible"], "available_action_scope");
    const widgets = state(data.recorded_state);
    const bindings = new Set<string>();
    for (const item of array(data.available_actions, "available_actions")) {
        const action = fields(item, ["action_description", "target_widget"]);
        text(action.action_description, "action_description");
        nullableText(action.target_widget, "target_widget");
        requireEvidence(action.target_widget === null || widgets.has(action.target_widget as string),
            "invalid_reference", "Unknown available-action widget", "target_widget");
        const key = JSON.stringify([action.action_description, action.target_widget]);
        requireEvidence(!bindings.has(key), "conflict", "Duplicate available action");
        bindings.add(key);
    }
    const ids = new Set<unknown>();
    for (const item of array(data.artifacts, "artifacts")) {
        artifact(item);
        const id = object(item).id;
        requireEvidence(!ids.has(id), "conflict", "Duplicate artifact ID");
        ids.add(id);
    }
}

function oracleResult(value: unknown): void {
    const data = fields(value, ["test_run", "name", "oracle", "oracle_target", "oracle_status", "oracle_details"],
        ["test_sequence", "expected_value", "observed_value", "oracle_severity"], "oracle result");
    texts(data, ["test_run", "name"]);
    if (Object.hasOwn(data, "test_sequence")) {
        text(data.test_sequence, "test_sequence");
    }
    choice(data.oracle_status, ["passed", "failed", "pending", "unknown", "error"], "oracle_status");
    const oracle = fields(data.oracle, ["id"], ["version", "parameters"], "oracle");
    text(oracle.id, "id");
    if (Object.hasOwn(oracle, "version")) {
        text(oracle.version, "version");
    }
    if (Object.hasOwn(oracle, "parameters")) {
        properties(oracle.parameters, "parameters");
    }
    const target = object(data.oracle_target, "oracle_target");
    const targetFields: Record<string, string[]> = {
        test_run: [], test_sequence: [], observation: ["observation"],
        state_property: ["observation", "property"], widget: ["observation", "widget"],
        widget_property: ["observation", "widget", "property"], action_execution: ["action_execution"],
        observation_range: ["first_observation", "last_observation"],
    };
    choice(target.target_type, Object.keys(targetFields), "oracle_target.target_type");
    const names = targetFields[target.target_type as string];
    fields(target, ["target_type", ...names], [], "oracle_target");
    texts(target, names);
    if (Object.hasOwn(data, "observed_value")) {
        const observed = object(data.observed_value, "observed_value");
        choice(observed.value_status, ["value", "absent", "unknown"], "observed_value.value_status");
        fields(observed, observed.value_status === "value" ? ["value_status", "value"] : ["value_status"]);
    }
    if (Object.hasOwn(data, "oracle_severity")) {
        const severity = fields(data.oracle_severity, ["label"], ["value"], "oracle_severity");
        requireEvidence(typeof severity.label === "string" && severity.label.trim().length > 0 &&
            !/[\u0000-\u001f\u007f-\u009f]/u.test(severity.label), "invalid_oracle_severity",
            "Oracle severity label must be nonblank text", "oracle_severity.label");
        if (Object.hasOwn(severity, "value")) {
            requireEvidence(typeof severity.value === "bigint" || severity.value instanceof JsonNumber ||
                typeof severity.value === "number" && Number.isFinite(severity.value),
                "invalid_oracle_severity", "Oracle severity value must be a finite number", "oracle_severity.value");
        }
    }
    properties(data.oracle_details, "oracle_details");
}

export function validateManifest(value: unknown): Manifest {
    const prepared = copyJson(value);
    const data = fields(prepared, ["schema_version", "evidence_id"], [], "manifest");
    requireEvidence(data.schema_version === 3, "invalid_record", "Unsupported schema version", "schema_version");
    text(data.evidence_id, "evidence_id");
    return prepared as Manifest;
}

export function validateEvent(value: unknown): EvidenceEvent {
    const prepared = copyJson(value);
    const envelope = fields(prepared, ["schema_version", "id", "event"], [], "Evidence Event");
    requireEvidence(envelope.schema_version === 3, "invalid_record", "Unsupported schema version", "schema_version");
    text(envelope.id, "id");
    const event = fields(envelope.event, ["event_type", "data"], [], "event");
    const data = object(event.data, "data");
    switch (event.event_type) {
        case "test_run_started":
            fields(data, ["id", "producer", "source_run", "properties"]);
            texts(data, ["id", "producer", "source_run"]);
            properties(data.properties);
            break;
        case "test_sequence_started":
            fields(data, ["id", "test_run", "sequence_index", "source_sequence", "properties"]);
            texts(data, ["id", "test_run", "source_sequence"]);
            unsigned(data.sequence_index, "sequence_index");
            requireEvidence(BigInt(data.sequence_index as number | bigint) > 0n, "invalid_record", "Sequence index must be positive", "sequence_index");
            properties(data.properties);
            break;
        case "action_described":
            fields(data, ["id", "action_type", "properties"]);
            texts(data, ["id", "action_type"]);
            properties(data.properties);
            break;
        case "observation_recorded":
            observation(data);
            break;
        case "action_selected":
            fields(data, ["id", "test_sequence", "source_observation", "action_description", "target_widget", "parameters"]);
            texts(data, ["id", "test_sequence", "source_observation", "action_description"]);
            nullableText(data.target_widget, "target_widget");
            properties(data.parameters, "parameters");
            break;
        case "action_execution_reported":
            fields(data, ["action_execution", "outcome", "error"]);
            text(data.action_execution, "action_execution");
            choice(data.outcome, ["returned", "error"], "outcome");
            requireEvidence(data.outcome === "returned" ? data.error === null : typeof data.error === "string",
                "invalid_record", "Returned calls have null error; errors retain their reported text", "error");
            break;
        case "transition_recorded":
            fields(data, ["action_execution", "resulting_observation"]);
            texts(data, ["action_execution", "resulting_observation"]);
            break;
        case "oracle_result_recorded":
            oracleResult(data);
            break;
        case "test_sequence_finished":
            fields(data, ["test_sequence", "reason"]);
            texts(data, ["test_sequence", "reason"]);
            break;
        case "test_run_finished":
            fields(data, ["test_run", "reason"]);
            texts(data, ["test_run", "reason"]);
            break;
        default:
            requireEvidence(false, "invalid_record", "Unknown event type", "event_type");
    }
    return prepared as EvidenceEvent;
}

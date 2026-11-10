import type { JsonValue, JsonNumber, Properties } from "./json.js";

export const SCHEMA_VERSION = 3;
export type UnsignedInteger = number | bigint;
export interface Manifest { schema_version: 3; evidence_id: string }
export interface TestRun { id: string; producer: string; source_run: string; properties: Properties }
export interface TestSequence { id: string; test_run: string; sequence_index: UnsignedInteger; source_sequence: string; properties: Properties }
export interface Widget { id: string; parent: string | null; properties: Properties }
export interface RecordedState { id: string; properties: Properties; widgets: Widget[]; capture: "complete" | "filtered" | "unavailable" }
export interface AvailableAction { action_description: string; target_widget: string | null }
export interface ActionDescription { id: string; action_type: string; properties: Properties }
export interface ArtifactReference { id: string; path: string; media_type: string; sha256: string; width?: UnsignedInteger | null; height?: UnsignedInteger | null }
export interface Observation {
    id: string;
    test_sequence: string;
    observation_index: UnsignedInteger;
    timestamp_micros: UnsignedInteger;
    recorded_state: RecordedState;
    available_action_scope: "generated" | "eligible" | "unknown";
    available_actions: AvailableAction[];
    artifacts: ArtifactReference[];
}
export interface ActionExecution {
    id: string;
    test_sequence: string;
    source_observation: string;
    action_description: string;
    target_widget: string | null;
    parameters: Properties;
}
export interface ActionExecutionResult { action_execution: string; outcome: "returned" | "error"; error: string | null }
export interface RecordedTransition { action_execution: string; resulting_observation: string }
export interface Oracle { id: string; version?: string; parameters?: Properties }
export interface OracleSeverity { label: string; value?: number | bigint | JsonNumber }
export type ObservedValue = { value_status: "value"; value: JsonValue } | { value_status: "absent" | "unknown" };
export type OracleTarget =
    | { target_type: "test_run" | "test_sequence" }
    | { target_type: "observation"; observation: string }
    | { target_type: "state_property"; observation: string; property: string }
    | { target_type: "widget"; observation: string; widget: string }
    | { target_type: "widget_property"; observation: string; widget: string; property: string }
    | { target_type: "action_execution"; action_execution: string }
    | { target_type: "observation_range"; first_observation: string; last_observation: string };
export interface OracleResult {
    test_run: string;
    test_sequence?: string;
    name: string;
    oracle: Oracle;
    oracle_target: OracleTarget;
    oracle_status: "passed" | "failed" | "pending" | "unknown" | "error";
    oracle_details: Properties;
    expected_value?: JsonValue;
    observed_value?: ObservedValue;
    oracle_severity?: OracleSeverity;
}
export interface EventData {
    test_run_started: TestRun;
    test_sequence_started: TestSequence;
    action_described: ActionDescription;
    observation_recorded: Observation;
    action_selected: ActionExecution;
    action_execution_reported: ActionExecutionResult;
    transition_recorded: RecordedTransition;
    oracle_result_recorded: OracleResult;
    test_sequence_finished: { test_sequence: string; reason: string };
    test_run_finished: { test_run: string; reason: string };
}
export type EventType = keyof EventData;
export type TypedEvidenceEvent<K extends EventType> = { schema_version: 3; id: string; event: { event_type: K; data: EventData[K] } };
export type EvidenceEvent = { [K in EventType]: TypedEvidenceEvent<K> }[EventType];

/** Describe one occurrence using the generic event format. Validation happens on acceptance. */
export function evidenceEvent<K extends EventType>(id: string, eventType: K, data: EventData[K]): TypedEvidenceEvent<K> {
    return { schema_version: SCHEMA_VERSION, id, event: { event_type: eventType, data } };
}

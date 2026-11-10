import path from "node:path";
import { evidenceEvent } from "testar-evidence";
import { JsonlStore } from "testar-evidence/node";

// This example reports sample observations. A tool or adapter supplies the actual SUT data.
const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
const directory = path.resolve("target", "traces", "example_submit-form_trace-" + timestamp);
const store = await JsonlStore.create(directory, { schema_version: 3, evidence_id: "example:trace:" + timestamp });

try {
    await store.append(evidenceEvent("event:run", "test_run_started", {
        id: "run", producer: "example", source_run: timestamp,
        properties: { "evidence.origin": "example-script", "evidence.test_objective": "Submit a form" },
    }));
    await store.append(evidenceEvent("event:sequence", "test_sequence_started", {
        id: "sequence", test_run: "run", sequence_index: 1, source_sequence: "sequence-1", properties: {},
    }));
    await store.append(evidenceEvent("event:describe", "action_described", {
        id: "submit", action_type: "click", properties: { "ui.name": "Submit" },
    }));

    // Before execution, record the observed state and the action that can be executed there.
    await store.append(evidenceEvent("event:before", "observation_recorded", {
        id: "before", test_sequence: "sequence", observation_index: 1, timestamp_micros: BigInt(Date.now()) * 1000n,
        recorded_state: {
            id: "form", properties: { "ui.title": "Request form" }, capture: "filtered",
            widgets: [{ id: "submit-button", parent: null, properties: { "ui.text": "Submit", "ui.enabled": true } }],
        },
        available_action_scope: "unknown",
        available_actions: [{ action_description: "submit", target_widget: "submit-button" }], artifacts: [],
    }));
    await store.append(evidenceEvent("event:select", "action_selected", {
        id: "execution", test_sequence: "sequence", source_observation: "before",
        action_description: "submit", target_widget: "submit-button", parameters: {},
    }));

    // The tool executes its operation here, then reports whether the call returned or raised an error.
    await store.append(evidenceEvent("event:returned", "action_execution_reported", {
        action_execution: "execution", outcome: "returned", error: null,
    }));
    await store.append(evidenceEvent("event:after", "observation_recorded", {
        id: "after", test_sequence: "sequence", observation_index: 2, timestamp_micros: BigInt(Date.now()) * 1000n,
        recorded_state: {
            id: "confirmation", properties: { "ui.title": "Confirmation" }, capture: "filtered",
            widgets: [{ id: "message", parent: null, properties: { "ui.text": "Request received" } }],
        },
        available_action_scope: "unknown", available_actions: [], artifacts: [],
    }));
    await store.append(evidenceEvent("event:transition", "transition_recorded", {
        action_execution: "execution", resulting_observation: "after",
    }));

    // An oracle result identifies the particular widget property that was checked.
    await store.append(evidenceEvent("event:oracle", "oracle_result_recorded", {
        test_run: "run", test_sequence: "sequence", name: "Confirmation message is correct",
        oracle: { id: "confirmation-text" }, oracle_status: "passed",
        oracle_target: { target_type: "widget_property", observation: "after", widget: "message", property: "ui.text" },
        expected_value: "Request received", observed_value: { value_status: "value", value: "Request received" },
        oracle_details: {},
    }));
    await store.append(evidenceEvent("event:sequence-end", "test_sequence_finished", {
        test_sequence: "sequence", reason: "completed",
    }));
    await store.append(evidenceEvent("event:run-end", "test_run_finished", { test_run: "run", reason: "completed" }));
    console.log("Evidence directory: " + directory);
    console.log("Recorded transitions: " + store.evidence.recordedTransitions.length);
} finally {
    await store.close();
}

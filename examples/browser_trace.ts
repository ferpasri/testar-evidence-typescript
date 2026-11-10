import { evidenceEvent } from "testar-evidence";
import { downloadTrace, IndexedDbStore } from "testar-evidence/browser";

/** Call from a browser application with a button whose click handler is already registered. */
export async function recordButtonClick(button: HTMLButtonElement): Promise<void> {
    const identity = crypto.randomUUID();
    const store = await IndexedDbStore.create("example-trace-" + identity, { schema_version: 3, evidence_id: identity });
    try {
        await store.append(evidenceEvent("event:run", "test_run_started", {
            id: "run", producer: "browser-example", source_run: identity, properties: {},
        }));
        await store.append(evidenceEvent("event:sequence", "test_sequence_started", {
            id: "sequence", test_run: "run", sequence_index: 1, source_sequence: "sequence-1", properties: {},
        }));
        await store.append(evidenceEvent("event:describe", "action_described", {
            id: "click", action_type: "click", properties: {},
        }));

        // DOM reading belongs to this example integration; the library saves the supplied facts.
        async function observe(id: string, index: number): Promise<void> {
            await store.append(evidenceEvent("event:" + id, "observation_recorded", {
                id, test_sequence: "sequence", observation_index: index, timestamp_micros: BigInt(Date.now()) * 1000n,
                recorded_state: {
                    id: "state:" + id, properties: { "ui.url": location.href, "ui.title": document.title },
                    widgets: [{ id: "button", parent: null, properties: { "ui.text": button.textContent, "ui.enabled": !button.disabled } }],
                    capture: "filtered",
                },
                available_action_scope: "unknown", available_actions: [{ action_description: "click", target_widget: "button" }], artifacts: [],
            }));
        }
        await observe("before", 1);
        await store.append(evidenceEvent("event:select", "action_selected", {
            id: "execution", test_sequence: "sequence", source_observation: "before",
            action_description: "click", target_widget: "button", parameters: {},
        }));
        button.click();
        await store.append(evidenceEvent("event:returned", "action_execution_reported", {
            action_execution: "execution", outcome: "returned", error: null,
        }));

        // This example captures synchronous effects. A real integration waits for its SUT to be ready.
        await observe("after", 2);
        await store.append(evidenceEvent("event:transition", "transition_recorded", {
            action_execution: "execution", resulting_observation: "after",
        }));
        await store.append(evidenceEvent("event:sequence-end", "test_sequence_finished", { test_sequence: "sequence", reason: "completed" }));
        await store.append(evidenceEvent("event:run-end", "test_run_finished", { test_run: "run", reason: "completed" }));
        downloadTrace(await store.exportFiles(), "evidence-" + identity + ".zip");
    } finally {
        await store.close();
    }
}

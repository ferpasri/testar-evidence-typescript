import { requireEvidence } from "./errors.js";
import { copyJson, equalJson } from "./json.js";
import type {
    ActionDescription, ActionExecution, ActionExecutionResult, EvidenceEvent, Manifest,
    Observation, OracleResult, RecordedState, RecordedTransition, TestRun, TestSequence,
} from "./records.js";
import { object, validateEvent, validateManifest } from "./validation.js";

export interface RunRecord { readonly test_run: TestRun; readonly status: "running" | "finished"; readonly reason: string | null }
export interface SequenceRecord { readonly test_sequence: TestSequence; readonly status: "running" | "finished"; readonly reason: string | null }
export interface ExecutionRecord {
    readonly action_execution: ActionExecution;
    readonly status: "awaiting_execution_result" | "awaiting_resulting_observation" | "failed" | "completed" | "incomplete";
    readonly execution_result: ActionExecutionResult | null;
    readonly resulting_observation: string | null;
}
export interface TransitionRecord extends RecordedTransition {
    test_sequence: string;
    source_observation: string;
    action_description: string;
    target_widget: string | null;
}

/** Retain accepted facts and check that states, actions and results refer to the right history. */
export class ReconstructedEvidence {
    #manifest: Manifest;
    #events = new Map<string, EvidenceEvent>();
    #runs = new Map<string, RunRecord>();
    #sequences = new Map<string, SequenceRecord>();
    #observations = new Map<string, Observation>();
    #states = new Map<string, RecordedState>();
    #descriptions = new Map<string, ActionDescription>();
    #executions = new Map<string, ExecutionRecord>();
    #transitions: TransitionRecord[] = [];
    #oracles: OracleResult[] = [];
    #latest = new Map<string, string>();
    #awaiting = new Map<string, string>();
    #persisting = false;

    constructor(manifest: unknown) {
        this.#manifest = validateManifest(manifest);
    }

    get manifest(): Manifest { return this.#manifest; }
    get eventCount(): number { return this.#events.size; }
    get events(): readonly EvidenceEvent[] { return Object.freeze([...this.#events.values()]); }
    get testRuns(): readonly RunRecord[] { return Object.freeze([...this.#runs.values()]); }
    get testSequences(): readonly SequenceRecord[] { return Object.freeze([...this.#sequences.values()]); }
    get observations(): readonly Observation[] { return Object.freeze([...this.#observations.values()]); }
    get recordedStates(): readonly RecordedState[] { return Object.freeze([...this.#states.values()]); }
    get actionDescriptions(): readonly ActionDescription[] { return Object.freeze([...this.#descriptions.values()]); }
    get actionExecutions(): readonly ExecutionRecord[] { return Object.freeze([...this.#executions.values()]); }
    get recordedTransitions(): readonly TransitionRecord[] { return Object.freeze([...this.#transitions]); }
    get oracleResults(): readonly OracleResult[] { return Object.freeze([...this.#oracles]); }

    testRun(id: string): RunRecord | undefined { return this.#runs.get(id); }
    testSequence(id: string): SequenceRecord | undefined { return this.#sequences.get(id); }
    observation(id: string): Observation | undefined { return this.#observations.get(id); }
    recordedState(id: string): RecordedState | undefined { return this.#states.get(id); }
    actionDescription(id: string): ActionDescription | undefined { return this.#descriptions.get(id); }
    actionExecution(id: string): ExecutionRecord | undefined { return this.#executions.get(id); }

    availableActions(observation: string): Observation["available_actions"] {
        const record = this.#observations.get(observation);
        requireEvidence(record, "invalid_reference", "Unknown observation", "observation");
        return record.available_actions;
    }

    observationsForSequence(sequence: string): readonly Observation[] {
        return Object.freeze([...this.#observations.values()].filter((value) => value.test_sequence === sequence));
    }

    outgoing(observation: string): readonly TransitionRecord[] {
        return Object.freeze(this.#transitions.filter((value) => value.source_observation === observation));
    }

    incoming(observation: string): readonly TransitionRecord[] {
        return Object.freeze(this.#transitions.filter((value) => value.resulting_observation === observation));
    }

    /** Validate without saving. Identical retries return false. */
    validate(value: unknown): boolean {
        return this.#validate(validateEvent(value));
    }

    apply(value: unknown): boolean {
        requireEvidence(!this.#persisting, "busy", "An event is being saved");
        const event = validateEvent(value);
        if (!this.#validate(event)) {
            return false;
        }
        this.#commit(event);
        return true;
    }

    /** Storage saves the prepared event first; a failed save leaves accepted history unchanged. */
    async record(value: unknown, persist: (prepared: EvidenceEvent) => Promise<void>): Promise<boolean> {
        requireEvidence(!this.#persisting, "busy", "An event is being saved");
        const event = validateEvent(value);
        if (!this.#validate(event)) {
            return false;
        }
        this.#persisting = true;
        try {
            await persist(event);
            this.#commit(event);
            return true;
        } finally {
            this.#persisting = false;
        }
    }

    #activeSequence(id: string): SequenceRecord {
        const sequence = this.#sequences.get(id);
        requireEvidence(sequence, "invalid_reference", "Unknown test sequence", "test_sequence");
        requireEvidence(sequence.status === "running", "invalid_lifecycle", "Test sequence finished", "test_sequence");
        return sequence;
    }

    #execution(id: string): ExecutionRecord {
        const execution = this.#executions.get(id);
        requireEvidence(execution, "invalid_reference", "Unknown action execution", "action_execution");
        return execution;
    }

    #validate(envelope: EvidenceEvent): boolean {
        const previous = this.#events.get(envelope.id);
        if (previous) {
            requireEvidence(equalJson(previous, envelope), "conflict", "Event ID has different content");
            return false;
        }
        const event = envelope.event;
        switch (event.event_type) {
            case "test_run_started":
                requireEvidence(!this.#runs.has(event.data.id), "conflict", "Test run ID already exists");
                break;
            case "test_sequence_started": {
                const data = event.data;
                const run = this.#runs.get(data.test_run);
                requireEvidence(run, "invalid_reference", "Unknown parent run", "test_run");
                requireEvidence(run.status === "running", "invalid_lifecycle", "Parent run finished", "test_run");
                requireEvidence(!this.#sequences.has(data.id), "conflict", "Test sequence ID already exists");
                requireEvidence([...this.#sequences.values()].every((record) => record.test_sequence.test_run !== data.test_run ||
                    record.test_sequence.sequence_index < data.sequence_index),
                    "invalid_order", "Sequence indexes must increase within the run", "sequence_index");
                break;
            }
            case "action_described": {
                const previousAction = this.#descriptions.get(event.data.id);
                requireEvidence(!previousAction || equalJson(previousAction, event.data), "conflict", "Action description has changed");
                break;
            }
            case "observation_recorded": {
                const data = event.data;
                this.#activeSequence(data.test_sequence);
                requireEvidence(!this.#observations.has(data.id), "conflict", "Observation ID already exists");
                const latest = this.#observations.get(this.#latest.get(data.test_sequence) ?? "");
                requireEvidence(!latest || data.observation_index > latest.observation_index,
                    "invalid_order", "Observation index must increase within the sequence", "observation_index");
                const previousState = this.#states.get(data.recorded_state.id);
                requireEvidence(!previousState || equalJson(previousState, data.recorded_state), "conflict", "Recorded-state content has changed");
                for (const action of data.available_actions) {
                    requireEvidence(this.#descriptions.has(action.action_description), "invalid_reference",
                        "Unknown available action description", "available_actions.action_description");
                }
                break;
            }
            case "action_selected": {
                const data = event.data;
                this.#activeSequence(data.test_sequence);
                requireEvidence(!this.#executions.has(data.id), "conflict", "Action execution ID already exists");
                const source = this.#observations.get(data.source_observation);
                requireEvidence(source && source.test_sequence === data.test_sequence && this.#latest.get(data.test_sequence) === source.id,
                    "invalid_reference", "Source must be the sequence's latest observation", "source_observation");
                requireEvidence(source.available_actions.some((action) => action.action_description === data.action_description &&
                    action.target_widget === data.target_widget), "invalid_reference",
                    "Selected action and target are not available at source", "action_description");
                requireEvidence(!this.#awaiting.has(data.test_sequence), "invalid_lifecycle",
                    "Sequence already has an unfinished action execution", "test_sequence");
                break;
            }
            case "action_execution_reported": {
                const execution = this.#execution(event.data.action_execution);
                this.#activeSequence(execution.action_execution.test_sequence);
                requireEvidence(execution.status === "awaiting_execution_result", "invalid_lifecycle",
                    "Execution result already reported", "action_execution");
                break;
            }
            case "transition_recorded": {
                const execution = this.#execution(event.data.action_execution);
                const selection = execution.action_execution;
                this.#activeSequence(selection.test_sequence);
                requireEvidence(execution.status === "awaiting_resulting_observation", "invalid_lifecycle",
                    "Execution is not awaiting a resulting observation", "action_execution");
                const source = this.#observations.get(selection.source_observation)!;
                const result = this.#observations.get(event.data.resulting_observation);
                requireEvidence(result && result.test_sequence === source.test_sequence && result.observation_index > source.observation_index,
                    "invalid_transition", "Result must be later in the same sequence", "resulting_observation");
                break;
            }
            case "oracle_result_recorded":
                this.#validateOracle(event.data);
                break;
            case "test_sequence_finished":
                this.#activeSequence(event.data.test_sequence);
                break;
            case "test_run_finished": {
                const run = this.#runs.get(event.data.test_run);
                requireEvidence(run && run.status === "running", "invalid_lifecycle", "Test run is not active", "test_run");
                requireEvidence([...this.#sequences.values()].every((sequence) =>
                    sequence.test_sequence.test_run !== event.data.test_run || sequence.status === "finished"),
                    "invalid_lifecycle", "Finish the run's sequences first", "test_run");
                break;
            }
        }
        return true;
    }

    #validateOracle(result: OracleResult): void {
        const run = this.#runs.get(result.test_run);
        requireEvidence(run, "invalid_reference", "Unknown oracle test run", "test_run");
        const target = result.oracle_target;
        const reference = (condition: unknown, field: string) => {
            requireEvidence(condition, "invalid_oracle_target", "Oracle target has an invalid reference", field);
        };
        const observation = (id: string, field: string): Observation => {
            const value = this.#observations.get(id);
            reference(value && value.test_sequence === result.test_sequence, field);
            return value!;
        };
        if (target.target_type === "test_run") {
            reference(result.test_sequence === undefined, "test_sequence");
        } else {
            const sequence = this.#sequences.get(result.test_sequence ?? "");
            reference(sequence && sequence.test_sequence.test_run === result.test_run, "test_sequence");
            if ("observation" in target) {
                const recorded = observation(target.observation, "oracle_target.observation");
                if ("widget" in target) {
                    reference(recorded.recorded_state.widgets.some((widget) => widget.id === target.widget), "oracle_target.widget");
                }
            } else if (target.target_type === "action_execution") {
                reference(this.#executions.get(target.action_execution)?.action_execution.test_sequence === result.test_sequence,
                    "oracle_target.action_execution");
            } else if (target.target_type === "observation_range") {
                const first = observation(target.first_observation, "oracle_target.first_observation");
                const last = observation(target.last_observation, "oracle_target.last_observation");
                reference(last.observation_index >= first.observation_index, "oracle_target.last_observation");
            }
        }
        if (Object.hasOwn(result.oracle_details, "evidence.assessment")) {
            const prefix = "oracle_details.evidence.assessment";
            const assessment = object(result.oracle_details["evidence.assessment"], prefix);
            const phase = assessment.phase;
            requireEvidence(["during_run", "end_of_run", "during_sequence", "end_of_sequence"].includes(phase as string),
                "invalid_record", "Unknown reporting phase", prefix + ".phase");
            requireEvidence(["open_ended", "recorded_interval"].includes(assessment.semantics as string),
                "invalid_record", "Unknown temporal semantics", prefix + ".semantics");
            const history = (phase as string).endsWith("sequence") ? this.#sequences.get(result.test_sequence ?? "") : run;
            reference(history, "test_sequence");
            const finished = history!.status === "finished";
            requireEvidence(finished === (phase as string).startsWith("end_"), "invalid_lifecycle",
                "Reporting phase does not match history status", prefix + ".phase");
            if (Object.hasOwn(assessment, "termination_reason")) {
                requireEvidence(finished && typeof assessment.termination_reason === "string" && assessment.termination_reason === history!.reason,
                    "invalid_record", "Reason must match history ending", prefix + ".termination_reason");
            }
        }
    }

    #commit(envelope: EvidenceEvent): void {
        const event = envelope.event;
        switch (event.event_type) {
            case "test_run_started":
                this.#runs.set(event.data.id, Object.freeze({ test_run: event.data, status: "running", reason: null }));
                break;
            case "test_sequence_started":
                this.#sequences.set(event.data.id, Object.freeze({ test_sequence: event.data, status: "running", reason: null }));
                break;
            case "action_described":
                this.#descriptions.set(event.data.id, event.data);
                break;
            case "observation_recorded":
                this.#observations.set(event.data.id, event.data);
                this.#states.set(event.data.recorded_state.id, event.data.recorded_state);
                this.#latest.set(event.data.test_sequence, event.data.id);
                break;
            case "action_selected":
                this.#executions.set(event.data.id, Object.freeze({ action_execution: event.data,
                    status: "awaiting_execution_result", execution_result: null, resulting_observation: null }));
                this.#awaiting.set(event.data.test_sequence, event.data.id);
                break;
            case "action_execution_reported": {
                const previous = this.#executions.get(event.data.action_execution)!;
                this.#executions.set(event.data.action_execution, Object.freeze({ ...previous, execution_result: event.data,
                    status: event.data.outcome === "returned" ? "awaiting_resulting_observation" : "failed" }));
                if (event.data.outcome === "error") {
                    this.#awaiting.delete(previous.action_execution.test_sequence);
                }
                break;
            }
            case "transition_recorded": {
                const previous = this.#executions.get(event.data.action_execution)!;
                const selection = previous.action_execution;
                this.#executions.set(selection.id, Object.freeze({ ...previous, status: "completed",
                    resulting_observation: event.data.resulting_observation }));
                this.#awaiting.delete(selection.test_sequence);
                this.#transitions.push(Object.freeze({ ...event.data, test_sequence: selection.test_sequence,
                    source_observation: selection.source_observation, action_description: selection.action_description,
                    target_widget: selection.target_widget }));
                break;
            }
            case "oracle_result_recorded":
                this.#oracles.push(event.data);
                break;
            case "test_sequence_finished": {
                const previous = this.#sequences.get(event.data.test_sequence)!;
                this.#sequences.set(event.data.test_sequence, Object.freeze({ ...previous, status: "finished", reason: event.data.reason }));
                const unfinished = this.#awaiting.get(event.data.test_sequence);
                if (unfinished) {
                    this.#executions.set(unfinished, Object.freeze({ ...this.#executions.get(unfinished)!, status: "incomplete" }));
                    this.#awaiting.delete(event.data.test_sequence);
                }
                break;
            }
            case "test_run_finished":
                this.#runs.set(event.data.test_run, Object.freeze({ ...this.#runs.get(event.data.test_run)!,
                    status: "finished", reason: event.data.reason }));
                break;
        }
        this.#events.set(envelope.id, envelope);
    }

    /** The same compact result used by the shared evidence conformance cases. */
    summary() {
        const sorted = <T>(values: Map<string, T>): [string, T][] =>
            [...values.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
        return copyJson({
            status: "accepted",
            counts: {
                evidence_events: this.eventCount, test_runs: this.#runs.size, test_sequences: this.#sequences.size,
                observations: this.#observations.size, action_descriptions: this.#descriptions.size,
                action_executions: this.#executions.size, recorded_transitions: this.#transitions.length,
                oracle_results: this.#oracles.length,
                artifact_references: [...this.#observations.values()].reduce((total, value) => total + value.artifacts.length, 0),
                recorded_states: this.#states.size,
            },
            test_runs: sorted(this.#runs).map(([id, value]) => ({ id, status: value.status })),
            test_sequences: sorted(this.#sequences).map(([id, value]) => ({ id, test_run: value.test_sequence.test_run,
                sequence_index: value.test_sequence.sequence_index, status: value.status })),
            observations: sorted(this.#observations).map(([id, value]) => ({
                id, test_sequence: value.test_sequence, observation_index: value.observation_index,
                recorded_state: value.recorded_state.id, capture: value.recorded_state.capture,
                available_action_scope: value.available_action_scope, widget_ids: value.recorded_state.widgets.map((widget) => widget.id),
                available_actions: value.available_actions, artifact_ids: value.artifacts.map((artifact) => artifact.id),
            })),
            action_descriptions: sorted(this.#descriptions).map(([id, value]) => ({ id, action_type: value.action_type })),
            action_executions: [...this.#executions.values()], recorded_transitions: this.#transitions,
            oracle_results: this.#oracles, recorded_states: sorted(this.#states).map(([id]) => id),
        });
    }
}

import type { ReconstructedEvidence } from "./reconstructed-evidence.js";

/** Read accepted facts; new events go through the writer's append method. */
export class EvidenceHistory {
    #evidence: ReconstructedEvidence;

    constructor(evidence: ReconstructedEvidence) {
        this.#evidence = evidence;
        Object.freeze(this);
    }

    get manifest() { return this.#evidence.manifest; }
    get eventCount() { return this.#evidence.eventCount; }
    get events() { return this.#evidence.events; }
    get testRuns() { return this.#evidence.testRuns; }
    get testSequences() { return this.#evidence.testSequences; }
    get observations() { return this.#evidence.observations; }
    get recordedStates() { return this.#evidence.recordedStates; }
    get actionDescriptions() { return this.#evidence.actionDescriptions; }
    get actionExecutions() { return this.#evidence.actionExecutions; }
    get recordedTransitions() { return this.#evidence.recordedTransitions; }
    get oracleResults() { return this.#evidence.oracleResults; }

    testRun(id: string) { return this.#evidence.testRun(id); }
    testSequence(id: string) { return this.#evidence.testSequence(id); }
    observation(id: string) { return this.#evidence.observation(id); }
    recordedState(id: string) { return this.#evidence.recordedState(id); }
    actionDescription(id: string) { return this.#evidence.actionDescription(id); }
    actionExecution(id: string) { return this.#evidence.actionExecution(id); }
    availableActions(observation: string) { return this.#evidence.availableActions(observation); }
    observationsForSequence(sequence: string) { return this.#evidence.observationsForSequence(sequence); }
    outgoing(observation: string) { return this.#evidence.outgoing(observation); }
    incoming(observation: string) { return this.#evidence.incoming(observation); }
    summary() { return this.#evidence.summary(); }
}

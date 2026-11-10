import { describe, expect, test } from "vitest";
import {
    copyJson, equalJson, evidenceEvent, JsonNumber, parseJson, ReconstructedEvidence, stringifyJson, validateEvent,
} from "../src/index.js";

const manifest = { schema_version: 3, evidence_id: "example:trace" };
const run = () => evidenceEvent("event:run", "test_run_started",
    { id: "run", producer: "example", source_run: "source", properties: {} });

describe("Evidence facts retain the supplied values", () => {
    test("large integers and decimal properties survive reading, writing and an identical retry", () => {
        const event = parseJson('{"schema_version":3,"id":"event:run","event":{"event_type":"test_run_started","data":' +
            '{"id":"run","producer":"example","source_run":"source","properties":{"large":18446744073709551615,' +
            '"precise":0.12345678901234567890123456789,"null":null,"empty":"","nested":{"__proto__":"data"}}}}}');
        const evidence = new ReconstructedEvidence(manifest);
        expect(evidence.apply(event)).toBe(true);
        const result = parseJson(stringifyJson(evidence.events[0]));
        expect(equalJson(event, result)).toBe(true);
        expect(stringifyJson(result)).toContain("0.12345678901234567890123456789");
        expect(evidence.apply(result)).toBe(false);
        expect(equalJson(1, new JsonNumber("1.00"))).toBe(true);
        expect(equalJson(true, 1)).toBe(false);
        expect(equalJson([1], { "0": 1 })).toBe(false);
        expect(equalJson(new JsonNumber("1e100000"), new JsonNumber("10e99999"))).toBe(true);
        expect(() => copyJson({ unsafe: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    });

    test("invalid JSON, duplicate keys and non-JSON objects are rejected", () => {
        for (const text of ['{"a":1,"a":2}', "[1,]", "01", "true false", '"bad\nstring"', "NaN", '{"a":1}\n{}']) {
            expect(() => parseJson(text)).toThrow();
        }
        for (const value of [undefined, NaN, Infinity, new Date(), { missing: undefined }, new Array(2)]) {
            expect(() => copyJson(value)).toThrow();
        }
        const cycle: unknown[] = [];
        cycle.push(cycle);
        expect(() => copyJson(cycle)).toThrow();
        expect(() => copyJson({ get property() { throw new Error("Getter must not execute"); } })).toThrow(/getters/u);
        expect(() => parseJson("[".repeat(66) + "0" + "]".repeat(66))).toThrow(/depth/u);
    });

    test("accepted records are independent and immutable while rejected events preserve history", () => {
        const evidence = new ReconstructedEvidence(manifest);
        const event = run();
        evidence.apply(event);
        event.event.data.properties["after"] = "changed";
        expect(evidence.testRun("run")!.test_run.properties).not.toHaveProperty("after");
        expect(() => { evidence.testRun("run")!.test_run.properties["after"] = "changed"; }).toThrow();
        expect(() => evidence.apply({ ...run(), unknown: true })).toThrow(/Unknown field/u);
        expect(evidence.eventCount).toBe(1);
        expect(() => evidence.apply(evidenceEvent("event:run", "test_run_started",
            { id: "run", producer: "changed", source_run: "source", properties: {} }))).toThrow(/different content/u);
    });

    test("a storage failure does not accept the event or reserve its identity", async () => {
        const evidence = new ReconstructedEvidence(manifest);
        await expect(evidence.record(run(), async () => { throw new Error("Disk unavailable"); })).rejects.toThrow("Disk unavailable");
        expect(evidence.eventCount).toBe(0);
        expect(evidence.apply(run())).toBe(true);
        const ending = evidenceEvent("event:finish", "test_run_finished", { test_run: "run", reason: "completed" });
        let finish!: () => void;
        const saving = evidence.record(ending, () => new Promise<void>((resolve) => { finish = resolve; }));
        expect(() => evidence.apply(ending)).toThrow(/being saved/u);
        finish();
        await saving;
        expect(evidence.testRun("run")!.status).toBe("finished");
    });

    test("widget parents and available-action targets must belong to the recorded state", () => {
        const observation = {
            schema_version: 3, id: "event:observation", event: { event_type: "observation_recorded", data: {
                id: "observation", test_sequence: "sequence", observation_index: 0, timestamp_micros: 18446744073709551615n,
                recorded_state: { id: "state", capture: "filtered", properties: {}, widgets: [
                    { id: "button", parent: null, properties: {} },
                ] },
                available_action_scope: "unknown", available_actions: [{ action_description: "click", target_widget: "missing" }], artifacts: [],
            } },
        };
        expect(() => validateEvent(observation)).toThrow(/widget/u);
        observation.event.data.available_actions[0].target_widget = "button";
        expect(() => validateEvent(observation)).not.toThrow();
        observation.event.data.recorded_state.widgets[0].parent = "button" as never;
        expect(() => validateEvent(observation)).toThrow(/cycle/u);
    });
});

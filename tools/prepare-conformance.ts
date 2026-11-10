import { prepareConformance } from "./specs-conformance.ts";

const result = await prepareConformance();
console.log("Prepared " + result.manifest.cases.length + " shared cases from " + result.selection.release);

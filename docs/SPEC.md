# Evidence library specification

The library implements the records and lifecycle defined by [TESTAR evidence specs](https://github.com/ferpasri/testar-evidence-specs). Recorded facts retain their supplied values. Abstraction rules belong to consumers that construct abstract models from those facts.

## Main components

| Component | Responsibility |
| --- | --- |
| Record interfaces and `evidenceEvent` | Describe the generic payloads and create an Evidence Event with its ID and event type. |
| `validateEvent`, `validateManifest` | Check record structure and local references, returning an independent, frozen copy. |
| `ReconstructedEvidence` | Check references and history order, retain accepted events, and expose recorded facts and relationships. |
| `EvidenceHistory` | Provide read-only access to a writer's accepted records. |
| `JsonlStore` | Save incremental evidence and artifacts in a Node.js directory. |
| `EvidenceReader` | Read a directory and reconstruct its accepted evidence. |
| `IndexedDbStore` | Save evidence and artifacts in a named browser database. |
| `readTraceFiles`, `exportTraceFiles` | Import or export a map of portable paths and byte arrays. |
| `traceArchive`, `downloadTrace` | Export that file collection as a ZIP or start a browser download. |

The shared core contains record, validation, JSON, reconstruction, and portable file logic. Node.js filesystem operations are in the Node entry point. IndexedDB and browser downloads are in the browser entry point.

## Accepting an event

An event is copied and frozen before acceptance. Validation checks its structure, identifiers, widget hierarchy, action bindings, and references to existing histories. Unknown structural fields are rejected; property maps preserve their supplied JSON data.

A run starts before its sequences. Each sequence has its own increasing observation indexes and at most one unfinished action execution. Selection identifies an available action at the latest observation. A normally returned execution can connect to a later observation in that sequence. An execution error retains its reported text. Ending a sequence makes an unfinished execution incomplete.

Oracle results retain the oracle, target, status, optional severity, expected value, observed value, and oracle details. Their references must belong to the stated history. Results can be reported after that history ends. Assessment timing, when supplied, must agree with the history's status.

Repeating an identical Evidence Event returns `false`. Conflicting content for that ID is rejected. Reusing a recorded-state or action-description ID requires identical content. Rejected events leave the accepted history unchanged.

`ReconstructedEvidence.apply` accepts an event in memory. Storage calls `record` to validate once, persist the prepared event, and then accept it in memory. Persistence failure leaves the event unaccepted. Queries return immutable accepted records; collecting events or observations creates a new outer array without copying every stored widget and property. `summary()` creates the normalized result used by shared cases.

## Persistence and artifacts

Both writers expose `append`, `saveArtifact`, `exportFiles`, and `close`. Await each operation before depending on its result. Use `append` to save an event; the exposed evidence describes accepted history.

The Node.js writer synchronizes each appended line before changing memory and serializes writes within the writer. An exclusive, heartbeat-based lock prevents another Node.js writer from opening the same directory. A persistence or lock failure requires reopening. The reader processes the JSONL log incrementally.

Browser writes use IndexedDB transactions. The saved event count detects a competing browser writer; a stale writer must close and reopen before continuing. Reopening reconstructs the stored records and verifies referenced artifacts.

Artifact hashing uses Web Crypto, available in HTTPS and localhost browser contexts. Artifact paths are relative and portable. Referenced bytes must match their SHA-256 hash when recording, reading, and exporting. The Node.js implementation rejects symbolic links and junctions below the selected directory. `saveArtifact` names files by their content hash and reuses identical bytes.

A complete invalid JSONL line is rejected. An unfinished final line is an error. `JsonlStore.open(directory, { recoverIncompleteTail: true })` validates the complete prefix before truncating that unfinished tail.

## JSON values and precision

Omitted fields remain omitted, while explicit null remains null. JSON parsing rejects duplicate keys, invalid UTF-8, trailing values, and excessive nesting. Individual JSON records are limited to 16 MiB and nesting to 64 levels.

Use `number` for ordinary finite values, `bigint` for large integers, and `new JsonNumber("0.123456789012345678901")` for an exact decimal. `parseJson` preserves large integers and decimal tokens. `stringifyJson` writes those values as JSON numbers. Unsafe JavaScript integer inputs are rejected because their original precision may already have been lost.

Use these JSON functions when exchanging evidence containing exact numbers. Numeric comparisons treat equivalent values such as `1` and `1.00` as equal.

## Verification

The same published input traces and expected results verify portable reading, Node.js production, and browser production. Checks include full accepted payloads, artifact bytes, identical retries, rejection before append, and reopening. Chromium verification runs the shared cases against real IndexedDB and browser exports.

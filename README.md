# TESTAR Evidence for TypeScript and JavaScript

Record test execution evidence using the shared [TESTAR evidence format](https://github.com/ferpasri/testar-evidence-specs). A tool supplies observed states, widgets, properties, available actions, execution results, oracle results, and artifacts.

The package provides three entry points:

| Import | Purpose |
| --- | --- |
| `testar-evidence` | Records, validation, reconstruction, and portable trace import/export. |
| `testar-evidence/node` | Node.js filesystem reader and incremental JSONL writer. |
| `testar-evidence/browser` | IndexedDB storage and downloadable ZIP export. |

The shared core works in browsers, browser extensions, workers, and Node.js. Browser storage uses IndexedDB and exports files locally. JavaScript consumers use the same imports; TypeScript consumers also receive type declarations.

## Record evidence

```typescript
import { evidenceEvent } from "testar-evidence";
import { JsonlStore } from "testar-evidence/node";

const writer = await JsonlStore.create("target/traces/example", {
    schema_version: 3,
    evidence_id: "example:trace",
});
try {
    await writer.append(evidenceEvent("example:event:1", "test_run_started", {
        id: "example:run",
        producer: "my-integration",
        source_run: "original-run-id",
        properties: { "evidence.test_objective": "Check form submission" },
    }));
} finally {
    await writer.close();
}
```

Use a new directory for a new trace, or `JsonlStore.open(directory)` to continue an existing trace. The [complete Node.js example](examples/local_trace.ts) creates a timestamped directory and records a state?action?state path, an oracle result, and both history endings.

For browser storage, use `IndexedDbStore.create(databaseName, manifest)` with the same `append` and `saveArtifact` methods:

```typescript
import { downloadTrace, IndexedDbStore } from "testar-evidence/browser";

const writer = await IndexedDbStore.create("my-trace", {
    schema_version: 3,
    evidence_id: "example:browser-trace",
});
// Report Evidence Events with await writer.append(event).
downloadTrace(await writer.exportFiles(), "my-trace.zip");
await writer.close();
```

The [browser example](examples/browser_trace.ts) records an existing button's click handler and its synchronous effects. Import it through your application's bundler. The integration controls when the application is ready for an observation.

Exported ZIPs contain `manifest.json`, `evidence.jsonl`, and referenced artifact files. Extracting the ZIP produces the same directory format as the Node.js writer.

## Build and verify

Use Node.js 24 or later for repository development. In PowerShell, `npm.cmd` also works when script execution policy blocks `npm`.

```sh
npm ci
npm run prepare:conformance
npm run check
npm run example
```

Shared cases are downloaded from the newest published [evidence specs release](https://github.com/ferpasri/testar-evidence-specs/releases), including prereleases. The ignored cache records the selected release and verifies file checksums. Tests use that prepared cache.

To verify real browser storage and export:

```sh
npx playwright install chromium
npm run test:browser
```

See the [implementation specification](docs/SPEC.md) for acceptance rules, persistence, precision, and the main classes.

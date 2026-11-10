import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import { loadPreparedConformance } from "./specs-conformance.ts";

const prepared = await loadPreparedConformance();
const bundle = await build({
    entryPoints: ["tools/browser-entry.ts"], bundle: true, platform: "browser",
    format: "esm", write: false, target: "es2022",
});
const script = bundle.outputFiles[0].contents;
const server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/evidence.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/evidence.js" ? script : "<!doctype html><title>Evidence browser check</title>");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const address = server.address();
    assert(address && typeof address !== "string");
    await page.goto("http://127.0.0.1:" + address.port);
    for (const name of prepared.manifest.cases) {
        const directory = path.join(prepared.directory, "conformance", "cases", name);
        const files: [string, number[]][] = [];
        async function collect(relative: string): Promise<void> {
            for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
                const filename = relative ? relative + "/" + entry.name : entry.name;
                if (entry.isDirectory()) {
                    await collect(filename);
                } else {
                    files.push([filename, [...await readFile(path.join(directory, filename))]]);
                }
            }
        }
        await collect("");
        const result = await page.evaluate(async ({ files, name, url }) => {
            const api = await import(url) as typeof import("./browser-entry.ts");
            const input = new Map(files.map(([path, bytes]) => [path, new Uint8Array(bytes)]));
            const expected = api.parseJson(api.decodeUtf8(input.get("expected.json")!));
            const manifest = api.parseJson(api.decodeUtf8(input.get("manifest.json")!));
            const store = await api.IndexedDbStore.create("testar-browser-check-" + name, manifest);
            let rejected: { code: string; event: string; field?: string } | undefined;
            try {
                for (const value of api.jsonlEvents(input.get("evidence.jsonl")!)) {
                    const event = value as import("../src/records.js").EvidenceEvent;
                    if (event.event.event_type === "observation_recorded") {
                        for (const artifact of event.event.data.artifacts) {
                            await store.saveArtifact(input.get(artifact.path)!, artifact.media_type,
                                { width: artifact.width, height: artifact.height });
                        }
                    }
                    try {
                        await store.append(event);
                        if (await store.append(event)) {
                            throw new Error("An identical retry was accepted twice");
                        }
                    } catch (cause) {
                        if (!(cause instanceof api.EvidenceError)) {
                            throw cause;
                        }
                        rejected = { code: cause.code, event: event.id, field: cause.field };
                        break;
                    }
                }
                const actual = rejected ? { status: "rejected", error: rejected, accepted_prefix: store.evidence.summary() } : store.evidence.summary();
                if (!api.equalJson(actual, expected)) {
                    throw new Error("Browser conformance mismatch: " + api.stringifyJson(actual));
                }
                const exported = await store.exportFiles();
                const read = await api.readTraceFiles(exported);
                if (!api.equalJson(read.events, store.evidence.events)) {
                    throw new Error("Browser export changed the accepted events");
                }
                if (api.traceArchive(exported).size === 0) {
                    throw new Error("Browser ZIP export was empty");
                }
            } finally {
                await store.close();
            }
            const reopened = await api.IndexedDbStore.open("testar-browser-check-" + name);
            try {
                return api.equalJson(reopened.evidence.summary(), store.evidence.summary());
            } finally {
                await reopened.close();
            }
        }, { files, name, url: "/evidence.js" });
        assert.equal(result, true, "Reopening browser evidence changed " + name);
    }
    console.log("Chromium: " + prepared.manifest.cases.length + " shared cases passed with IndexedDB, reopening and export.");
} finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

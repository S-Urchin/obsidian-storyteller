// Runs every tests/*.test.ts: each is bundled with esbuild (obsidian stubbed out) and run in Node.
import { build } from "esbuild";
import { readdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const out = mkdtempSync(join(tmpdir(), "st-tests-"));
let failed = false;
try {
	for (const file of readdirSync("tests").filter((f) => f.endsWith(".test.ts"))) {
		console.log(file);
		const outfile = join(out, file.replace(/\.ts$/, ".cjs"));
		await build({ entryPoints: [join("tests", file)], bundle: true, platform: "node", format: "cjs", outfile, external: ["obsidian", "@codemirror/*"], logLevel: "warning" });
		const r = spawnSync(process.execPath, [outfile], { stdio: "inherit" });
		if (r.status !== 0) failed = true;
	}
} finally {
	rmSync(out, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

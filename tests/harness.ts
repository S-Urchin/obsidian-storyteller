/** A tiny test runner: `npm test` bundles each tests/*.test.ts with esbuild and runs it in Node. */
let failed = 0;
let passed = 0;
export function test(name: string, fn: () => void) {
	try {
		fn();
		passed++;
		console.log("  ok   " + name);
	} catch (e) {
		failed++;
		console.log("  FAIL " + name + "\n       " + String((e as Error).message ?? e).split("\n").join("\n       "));
	}
}
process.on("beforeExit", () => {
	console.log(`${passed} passed, ${failed} failed`);
	if (failed) process.exitCode = 1;
});

/** Seeded random numbers, so a failure can be replayed. */
export function rng(seed: number) {
	let s = seed >>> 0 || 1;
	const next = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
	return {
		int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
		bit: () => next() < 0.5,
		pick: <T>(xs: T[]) => xs[Math.floor(next() * xs.length)],
	};
}

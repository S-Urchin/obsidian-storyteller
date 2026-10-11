/*
 * Lightweight motion for a view that re-renders from scratch.
 *
 * Only opacity and transform are animated (compositor-only, no layout work per frame),
 * and only for elements that actually changed: new items fade in, and moved items glide
 * from where they were using FLIP (First, Last, Invert, Play). Layout is read in one
 * batch and then written in one batch, so a re-render costs at most a couple of layouts.
 */

const MAX_TRACKED = 600;
const FALLBACK_MS = 450;

export function motionAllowed(enabled: boolean): boolean {
	if (!enabled) return false;
	try {
		return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	} catch {
		return true;
	}
}

/** Remembers where each keyed element is on screen, before the DOM is rebuilt. */
export function capturePositions(els: HTMLElement[], keyOf: (el: HTMLElement) => string | undefined): Map<string, number> | null {
	const out = new Map<string, number>();
	for (const el of els) {
		const k = keyOf(el);
		if (k) out.set(k, el.getBoundingClientRect().top);
		if (out.size > MAX_TRACKED) return null; // very long scripts: skip the glide, keep it snappy
	}
	return out;
}

/** Runs a one-shot CSS animation class and always cleans it up. */
export function playOnce(el: HTMLElement, cls: string) {
	el.addClass(cls);
	let done = false;
	const end = () => {
		if (done) return;
		done = true;
		el.removeClass(cls);
	};
	el.addEventListener("animationend", end, { once: true });
	// A hidden pane never fires animationend; don't leave the class behind.
	window.setTimeout(end, FALLBACK_MS);
}

/**
 * Animates a freshly rendered list of keyed elements against the previous render.
 * `prev` null means first render: nothing animates. Returns the keys now on screen.
 */
export function animateRender(
	els: HTMLElement[],
	keyOf: (el: HTMLElement) => string | undefined,
	prev: Set<string> | null,
	from: Map<string, number> | null,
	parentKeyOf?: (el: HTMLElement) => string | undefined,
	enterClass = "st-enter"
): Set<string> {
	const next = new Set<string>();
	const entering: HTMLElement[] = [];
	const moves: [HTMLElement, string, number][] = [];

	// Read phase: one layout for every measurement.
	for (const el of els) {
		const k = keyOf(el);
		if (!k) continue;
		next.add(k);
		if (!prev) continue;
		if (!prev.has(k)) entering.push(el);
		else if (from?.has(k)) moves.push([el, k, from.get(k)! - el.getBoundingClientRect().top]);
	}

	// Write phase. A child inside a moved parent only needs its offset relative to that parent.
	const shift = new Map<string, number>();
	const moved: HTMLElement[] = [];
	for (const [el, k, dy] of moves) {
		shift.set(k, dy);
		const parent = parentKeyOf?.(el);
		const rel = dy - (parent ? shift.get(parent) ?? 0 : 0);
		if (Math.abs(rel) < 1 || Math.abs(dy) > 3000) continue;
		el.style.transform = `translateY(${rel}px)`;
		moved.push(el);
	}
	if (moved.length) {
		void moved[0].offsetHeight; // commit the inverted positions before playing
		for (const el of moved) {
			el.addClass("st-flip");
			el.style.transform = "";
			let done = false;
			const end = () => {
				if (done) return;
				done = true;
				el.removeClass("st-flip");
			};
			el.addEventListener("transitionend", end, { once: true });
			window.setTimeout(end, FALLBACK_MS);
		}
	}
	for (const el of entering) playOnce(el, enterClass);
	return next;
}

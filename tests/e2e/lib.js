// Connects to a running Obsidian started with --remote-debugging-port=9222.
const puppeteer = require("puppeteer-core");

async function connect() {
	const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: null });
	const pages = await browser.pages();
	const page = pages.find((p) => p.url().startsWith("app://obsidian.md")) || pages[0];
	return { browser, page };
}

module.exports = { connect, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

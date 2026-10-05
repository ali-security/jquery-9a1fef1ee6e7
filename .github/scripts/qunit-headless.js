/*
 * Headless QUnit driver for CI (Node 18, CommonJS). Not shipped in the npm
 * package (.github is removed before npm pack).
 *
 * Env:
 *   CHROME_BIN        path to Chrome/Chromium (required)
 *   TEST_URL          QUnit page URL (default http://127.0.0.1:8000/test/index.html)
 *   QUNIT_TIMEOUT_MS  overall timeout in ms (default 20 minutes)
 *
 * Exit code: 0 only if at least one test ran and none failed; 1 otherwise.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const puppeteer = require(path.join(__dirname, "browser-runner", "node_modules", "puppeteer-core"));

const CHROME_BIN = process.env.CHROME_BIN;
const TEST_URL = process.env.TEST_URL || "http://127.0.0.1:8000/test/index.html";
const TIMEOUT_MS = parseInt(process.env.QUNIT_TIMEOUT_MS || "", 10) || 20 * 60 * 1000;
const POLL_MS = 1000;
const PROGRESS_EVERY_MS = 30 * 1000;
const MAX_VALUE_LEN = 300;
const MAX_BROWSER_LOG_LINES = 200;
const EXCLUDED_PREFIX = "EXCLUDED:";

const REPORT_PATH = path.join(process.env.TRAVIS_BUILD_DIR || "/tmp", "qunit-report.txt");

// "EXCLUDED: <title> -- <reason>" lines logged by test/data/testinit.js.
const excluded = [];

/*
 * Keep stdout pure printable ASCII: every UTF-16 code unit outside
 * 0x20-0x7E (except "\n") becomes a \uXXXX escape. Iterating code units
 * (not code points) also neutralises lone surrogates and NULs, which can
 * break CI log archiving.
 */
function asciiSafe(value) {
	const s = value === undefined ? "undefined" : String(value);
	let res = "";
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c === 0x0a || (c >= 0x20 && c <= 0x7e)) {
			res += s[i];
		} else {
			res += "\\u" + ("0000" + c.toString(16)).slice(-4);
		}
	}
	return res;
}

let reportFd = null;
try {
	reportFd = fs.openSync(REPORT_PATH, "w");
} catch (e) {
	process.stdout.write(asciiSafe("WARNING: cannot open report file " + REPORT_PATH + ": " + (e && e.message || e)) + "\n");
}

// Single output sink: every line printed by this driver goes through here,
// to stdout and to the report file.
function out(str) {
	const line = asciiSafe(str) + "\n";
	process.stdout.write(line);
	if (reportFd !== null) {
		try {
			fs.writeSync(reportFd, line);
		} catch (e) {
			reportFd = null;
		}
	}
}

function truncate(value, max) {
	const s = value === undefined ? "undefined" : String(value);
	return s.length > max ? s.slice(0, max) + "... [truncated " + (s.length - max) + " chars]" : s;
}

function oneLine(value) {
	return truncate(value, MAX_VALUE_LEN).replace(/\s*\n\s*/g, " \\n ");
}

/*
 * Runs in the page before any page script. QUnit 1.14 ends with
 * `window.QUnit = QUnit;`, so a setter trap on window.QUnit sees the object
 * before testinit.js / loadTests() touch it, and before QUnit.start().
 */
function installQUnitTrap() {
	if (window !== window.top) {
		return;
	}
	var results = window.__qunitResults = {
		hooked: false,
		hookError: null,
		tests: [],
		done: null,
		doneCount: 0
	};
	var stored;
	var pending = [];

	function serialize(q, v) {
		var s;
		try {
			if (q && q.jsDump && typeof q.jsDump.parse === "function") {
				s = q.jsDump.parse(v);
			} else {
				s = String(v);
			}
		} catch (e) {
			try {
				s = String(v);
			} catch (e2) {
				s = "[unserializable]";
			}
		}
		s = String(s);
		return s.length > 4000 ? s.slice(0, 4000) : s;
	}

	function hook(q) {
		if (results.hooked || !q || typeof q.testDone !== "function" ||
				typeof q.log !== "function" || typeof q.done !== "function") {
			return;
		}
		q.log(function(d) {
			if (d.result) {
				return;
			}
			pending.push({
				message: d.message === undefined ? "" : String(d.message),
				hasExpected: d.expected !== undefined,
				expected: serialize(q, d.expected),
				actual: serialize(q, d.actual),
				source: d.source ? String(d.source).slice(0, 2000) : ""
			});
		});
		q.testDone(function(d) {
			results.tests.push({
				module: d.module === undefined ? "" : String(d.module),
				name: String(d.name),
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				runtime: d.runtime,
				failures: pending
			});
			pending = [];
		});
		q.done(function(d) {
			results.doneCount++;
			results.done = {
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				runtime: d.runtime
			};
		});
		results.hooked = true;
	}

	try {
		Object.defineProperty(window, "QUnit", {
			configurable: true,
			enumerable: true,
			get: function() {
				return stored;
			},
			set: function(v) {
				stored = v;
				try {
					hook(v);
				} catch (e) {
					results.hookError = String(e && e.message || e);
				}
			}
		});
	} catch (e) {
		results.hookError = "defineProperty failed: " + String(e && e.message || e);
	}
}

/* Runs in the page: snapshot of hook results plus the DOM fallback. */
function collectFromPage() {
	var r = window.__qunitResults || null;
	var resultEl = document.getElementById("qunit-testresult");
	var resultText = resultEl ? (resultEl.textContent || "") : "";
	var domDone = /completed in/i.test(resultText);
	var out = {
		hooked: !!(r && r.hooked),
		hookError: r ? r.hookError : "window.__qunitResults missing",
		testsCount: r ? r.tests.length : 0,
		done: r ? r.done : null,
		doneCount: r ? r.doneCount : 0,
		domDone: domDone,
		resultText: resultText,
		domTestsCount: document.querySelectorAll("#qunit-tests > li").length
	};
	return out;
}

function collectTestsFromHooks() {
	var r = window.__qunitResults;
	return r ? r.tests : [];
}

function collectTestsFromDom() {
	function txt(el) {
		return el ? (el.textContent || "") : "";
	}
	var items = document.querySelectorAll("#qunit-tests > li");
	var tests = [];
	for (var i = 0; i < items.length; i++) {
		var li = items[i];
		var cls = " " + li.className + " ";
		if (cls.indexOf(" pass ") < 0 && cls.indexOf(" fail ") < 0) {
			// Still running.
			continue;
		}
		var counts = txt(li.querySelector(".counts")).match(/\d+/g) || [];
		var failed = counts.length >= 3 ? +counts[0] : (cls.indexOf(" fail ") >= 0 ? 1 : 0);
		var passed = counts.length >= 3 ? +counts[1] : 0;
		var total = counts.length >= 3 ? +counts[2] : failed + passed;
		var failures = [];
		var asserts = li.querySelectorAll("ol > li.fail");
		for (var j = 0; j < asserts.length; j++) {
			var a = asserts[j];
			var exp = a.querySelector(".test-expected pre");
			var act = a.querySelector(".test-actual pre");
			failures.push({
				message: txt(a.querySelector(".test-message")),
				hasExpected: !!exp,
				expected: txt(exp),
				actual: txt(act),
				source: txt(a.querySelector(".test-source pre"))
			});
		}
		tests.push({
			module: txt(li.querySelector(".module-name")),
			name: txt(li.querySelector(".test-name")),
			failed: failed,
			passed: passed,
			total: total,
			runtime: null,
			failures: failures
		});
	}
	return tests;
}

function parseResultText(text) {
	// "Tests completed in 1234 milliseconds. 99 assertions of 100 passed, 1 failed."
	const m = /completed in (\d+) milliseconds\.\s*(\d+) assertions of (\d+) passed, (\d+) failed/i.exec(text || "");
	if (!m) {
		return null;
	}
	return { runtime: +m[1], passed: +m[2], total: +m[3], failed: +m[4] };
}

function testLabel(t) {
	return (t.module || "(no module)") + " :: " + t.name;
}

function report(tests, done, note) {
	const failing = [];
	let assertTotal = 0;
	let assertFailed = 0;
	let runtimeSum = 0;

	for (const t of tests) {
		assertTotal += t.total || 0;
		assertFailed += t.failed || 0;
		runtimeSum += t.runtime || 0;
		if (t.failed > 0) {
			failing.push(testLabel(t));
		}
	}

	const a = done || { total: assertTotal, failed: assertFailed, passed: assertTotal - assertFailed, runtime: runtimeSum };
	const testsFailed = failing.length;
	const testsPassed = tests.length - testsFailed;
	const summaryLine =
		"QUnit summary: " + tests.length + " tests, " + testsPassed + " passed, " + testsFailed + " failed; " +
		"assertions: " + a.total + " total, " + a.passed + " passed, " + a.failed + " failed; " +
		"runtime " + a.runtime + "ms";

	// Summary first, so a truncated log still shows the outcome.
	if (note) {
		out(note);
	}
	out(summaryLine);
	out("");

	for (const t of tests) {
		const label = testLabel(t);
		if (t.failed > 0) {
			out("FAIL " + label + " (" + t.failed + " failed of " + t.total + ")");
			for (const f of t.failures || []) {
				out("    - message:  " + oneLine(f.message || "(no message)"));
				if (f.hasExpected) {
					out("      expected: " + oneLine(f.expected));
				}
				out("      actual:   " + oneLine(f.actual));
				if (f.source) {
					out("      source:   " + oneLine(f.source.split("\n")[0].trim()));
				}
			}
		} else {
			out("PASS " + label + " (" + t.passed + "/" + t.total + ")");
		}
	}

	out("");
	if (note) {
		out(note);
	}
	out(summaryLine);
	out("Failing tests:");
	if (failing.length) {
		for (const name of failing) {
			out("  " + name);
		}
	} else {
		out("  (none)");
	}
	out("Excluded tests:");
	if (excluded.length) {
		for (const line of excluded) {
			out("  " + line);
		}
	} else {
		out("  (none)");
	}
	return { total: tests.length, failed: testsFailed };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
	if (!CHROME_BIN) {
		out("ERROR: CHROME_BIN is not set.");
		return 1;
	}
	out("QUnit headless: " + TEST_URL + " (timeout " + TIMEOUT_MS + "ms, chrome " + CHROME_BIN + ")");

	const browser = await puppeteer.launch({
		executablePath: CHROME_BIN,
		headless: "new",
		args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]
	});

	try {
		const page = await browser.newPage();
		await page.setViewport({ width: 1280, height: 1024 });

		let browserLogLines = 0;
		const browserLog = (line) => {
			browserLogLines++;
			if (browserLogLines <= MAX_BROWSER_LOG_LINES) {
				out("[browser] " + oneLine(line));
			} else if (browserLogLines === MAX_BROWSER_LOG_LINES + 1) {
				out("[browser] (further browser messages suppressed)");
			}
		};
		page.on("console", (msg) => {
			const type = msg.type();
			const text = msg.text();
			if (type === "log" && text.indexOf(EXCLUDED_PREFIX) === 0) {
				// Always forwarded (not subject to the browser log cap).
				const detail = text.slice(EXCLUDED_PREFIX.length).trim();
				out("[browser] " + oneLine(text));
				if (excluded.indexOf(detail) < 0) {
					excluded.push(detail);
				}
			} else if (type === "error" && text.indexOf("Failed to load resource") !== 0) {
				// "Failed to load resource" comes from the suite's intentional
				// 404/400 requests; everything else is forwarded.
				browserLog("console.error: " + text);
			}
		});
		page.on("pageerror", (err) => browserLog("pageerror: " + (err && err.message || err)));
		page.on("error", (err) => browserLog("page crashed: " + (err && err.message || err)));
		page.on("dialog", (dialog) => {
			browserLog("dialog (" + dialog.type() + "): " + dialog.message());
			dialog.dismiss().catch(() => {});
		});

		await page.evaluateOnNewDocument(installQUnitTrap);

		const started = Date.now();
		await page.goto(TEST_URL, { waitUntil: "load", timeout: Math.min(TIMEOUT_MS, 5 * 60 * 1000) });

		let lastProgress = Date.now();
		let lastState = null;
		let stableDonePolls = 0;
		let finished = false;

		while (Date.now() - started < TIMEOUT_MS) {
			await sleep(POLL_MS);
			let state;
			try {
				state = await page.evaluate(collectFromPage);
			} catch (e) {
				browserLog("evaluate failed: " + (e && e.message || e));
				continue;
			}

			const isDone = state.hooked ? state.done !== null : state.domDone;
			if (isDone) {
				// QUnit 1.x can fire done() again if tests get queued later;
				// require two consecutive unchanged polls before finishing.
				if (lastState && lastState.testsCount === state.testsCount &&
						lastState.doneCount === state.doneCount && lastState.domTestsCount === state.domTestsCount) {
					stableDonePolls++;
				} else {
					stableDonePolls = 0;
				}
				if (stableDonePolls >= 2) {
					lastState = state;
					finished = true;
					break;
				}
			}
			lastState = state;

			if (Date.now() - lastProgress >= PROGRESS_EVERY_MS) {
				lastProgress = Date.now();
				out("[progress] " + Math.round((Date.now() - started) / 1000) + "s elapsed, " +
					(state.hooked ? state.testsCount : state.domTestsCount) + " tests finished" +
					(state.hooked ? "" : " (DOM fallback)"));
			}
		}

		const state = lastState || {};
		let tests;
		let done = null;
		let source;
		try {
			if (state.hooked) {
				tests = await page.evaluate(collectTestsFromHooks);
				done = state.done;
				source = "QUnit hooks";
			} else {
				tests = await page.evaluate(collectTestsFromDom);
				done = parseResultText(state.resultText);
				source = "DOM fallback (" + (state.hookError || "hooks not registered") + ")";
			}
		} catch (e) {
			out("ERROR: could not collect results from page: " + (e && e.message || e));
			tests = [];
		}
		out("Results source: " + source);
		out("");

		const note = finished ? null :
			"TIMEOUT: QUnit did not finish within " + TIMEOUT_MS + "ms; results below are partial.";
		const summary = report(tests, done, note);

		if (!finished) {
			return 1;
		}
		if (summary.total === 0) {
			out("ERROR: no tests were run.");
			return 1;
		}
		return summary.failed === 0 ? 0 : 1;
	} finally {
		await browser.close().catch(() => {});
	}
}

function finish(code) {
	if (reportFd !== null) {
		try {
			fs.closeSync(reportFd);
		} catch (e) {
			// ignore
		}
		reportFd = null;
	}
	// Let stdout drain before exiting so the tail of the report is not lost.
	process.stdout.write("", () => process.exit(code));
}

main().then(
	(code) => finish(code),
	(err) => {
		out("ERROR: " + (err && err.stack || err));
		finish(1);
	}
);

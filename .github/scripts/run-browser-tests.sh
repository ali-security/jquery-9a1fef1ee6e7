#!/usr/bin/env bash
# Run the real QUnit unit suite (test/index.html) in headless Chrome.
#
# Assumes `npm test` (grunt) already ran, so dist/jquery.js exists
# (test/jquery.js loads ../dist/jquery.js). The PHP built-in server serves
# the repo root so the ajax tests can reach test/data/*.php.
#
# A modern Node (18) is installed via nvm for the browser driver only; the
# project build keeps using the node 0.10 that is on PATH.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNNER_DIR="$SCRIPT_DIR/browser-runner"
PHP_HOST="127.0.0.1"
PHP_PORT="8000"
PHP_LOG="$(mktemp "${TMPDIR:-/tmp}/php-server.XXXXXX.log")"
TEST_URL="http://$PHP_HOST:$PHP_PORT/test/index.html"

mkdir -p "$RUNNER_DIR"

if [ ! -f "$REPO_ROOT/dist/jquery.js" ]; then
	echo "ERROR: $REPO_ROOT/dist/jquery.js not found; run 'npm test' (grunt) first." >&2
	exit 1
fi

# --- PHP server --------------------------------------------------------------
if ! command -v php >/dev/null 2>&1; then
	echo "ERROR: php not found on PATH (install php-cli)." >&2
	exit 1
fi

php -S "$PHP_HOST:$PHP_PORT" -t "$REPO_ROOT" >"$PHP_LOG" 2>&1 &
PHP_PID=$!

# shellcheck disable=SC2317  # invoked via trap
cleanup() {
	if kill -0 "$PHP_PID" 2>/dev/null; then
		kill "$PHP_PID" 2>/dev/null || :
		wait "$PHP_PID" 2>/dev/null || :
	fi
}
trap cleanup EXIT

echo "Waiting for PHP server on $PHP_HOST:$PHP_PORT ..."
ready=0
for _ in $(seq 1 30); do
	if curl -fsS -o /dev/null "$TEST_URL"; then
		ready=1
		break
	fi
	if ! kill -0 "$PHP_PID" 2>/dev/null; then
		break
	fi
	sleep 1
done
if [ "$ready" -ne 1 ]; then
	echo "ERROR: PHP server did not answer on $TEST_URL within 30s. Log:" >&2
	cat "$PHP_LOG" >&2 || :
	exit 1
fi
echo "PHP server is up (pid $PHP_PID)."

# --- Node 18 for the browser driver only --------------------------------------
NVM_SH=""
if [ -n "${NVM_DIR:-}" ] && [ -s "$NVM_DIR/nvm.sh" ]; then
	NVM_SH="$NVM_DIR/nvm.sh"
elif [ -s "$HOME/.nvm/nvm.sh" ]; then
	export NVM_DIR="$HOME/.nvm"
	NVM_SH="$NVM_DIR/nvm.sh"
fi
if [ -z "$NVM_SH" ]; then
	echo "ERROR: nvm not found (checked \$NVM_DIR/nvm.sh and ~/.nvm/nvm.sh)." >&2
	exit 1
fi

# nvm.sh is not nounset-safe; relax -u only while talking to nvm.
set +u
# shellcheck disable=SC1090
. "$NVM_SH"
nvm install 18
NODE18="$(nvm which 18)"
set -u

if [ -z "$NODE18" ] || [ ! -x "$NODE18" ]; then
	echo "ERROR: could not resolve the node 18 binary via nvm." >&2
	exit 1
fi
NODE18_BIN_DIR="$(dirname "$NODE18")"
echo "Browser driver node: $("$NODE18" -v) ($NODE18)"

# --- puppeteer-core in an isolated dir ---------------------------------------
cat >"$RUNNER_DIR/package.json" <<'EOF'
{
  "name": "jquery-browser-runner",
  "version": "0.0.0",
  "private": true,
  "description": "Headless QUnit driver for CI only (not shipped)"
}
EOF

# The time-machine registry predates puppeteer, so use the public registry.
PATH="$NODE18_BIN_DIR:$PATH" npm install \
	--prefix "$RUNNER_DIR" \
	--registry=https://registry.npmjs.org/ \
	--no-audit --no-fund --no-save \
	puppeteer-core@21

# --- Chrome ------------------------------------------------------------------
CHROME_BIN="$(command -v google-chrome || command -v google-chrome-stable || command -v chromium-browser || true)"
if [ -z "$CHROME_BIN" ]; then
	echo "ERROR: no Chrome/Chromium binary found (google-chrome, google-chrome-stable, chromium-browser)." >&2
	exit 1
fi
echo "Chrome: $CHROME_BIN ($("$CHROME_BIN" --version 2>/dev/null || echo 'version unknown'))"

# --- Run the suite -----------------------------------------------------------
status=0
CHROME_BIN="$CHROME_BIN" TEST_URL="$TEST_URL" \
	"$NODE18" "$SCRIPT_DIR/qunit-headless.js" || status=$?

if [ "$status" -ne 0 ]; then
	echo "QUnit headless run failed (exit $status). Last PHP server log lines:" >&2
	tail -n 50 "$PHP_LOG" >&2 || :
fi

# Same path rule as qunit-headless.js.
REPORT_FILE="${TRAVIS_BUILD_DIR:-/tmp}/qunit-report.txt"
echo "== tail of qunit report =="
if [ -f "$REPORT_FILE" ]; then
	tail -n 40 "$REPORT_FILE" || :
else
	echo "(report file $REPORT_FILE not found)"
fi
exit "$status"

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');

// Test the actual transitive dependency used by the local development launcher.
const launcherRequire = createRequire(require.resolve('concurrently'));
const { quote, parse } = launcherRequire('shell-quote');

test('development launcher quoting rejects control-character operator tokens', () => {
  for (const separator of ['\n', '\r', '\u2028', '\u2029']) {
    // No shell is executed: this is a pure validation regression.
    assert.throws(() => quote([{ op: `;${separator}unexpected` }]), TypeError);
  }
});

test('ordinary quoted development arguments still round-trip', () => {
  const args = ['node', 'file with spaces.js', 'literal;value', 'single\'quote'];
  assert.deepEqual(parse(quote(args)), args);
});

test('development launcher runs two harmless commands successfully', async () => {
  const concurrently = require('concurrently');
  const { result } = concurrently([
    { command: 'node -e "process.exit(0)"', name: 'first' },
    { command: 'node -e "process.exit(0)"', name: 'second' },
  ], { raw: true });
  const events = await result;
  assert.equal(events.length, 2);
  assert.ok(events.every(event => event.exitCode === 0));
});

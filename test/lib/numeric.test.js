const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseFiniteInteger,
  parseFiniteNumber,
  nonNegativeTimerDelayOrDefault,
  positiveIntegerOrDefault,
  timerDelayOrDefault,
} = require("../../lib/numeric");

test("parseFiniteNumber accepts finite numbers and complete numeric strings", () => {
  assert.equal(parseFiniteNumber(12), 12);
  assert.equal(parseFiniteNumber(" -1.25e2 "), -125);
  assert.equal(parseFiniteNumber(".5"), 0.5);
  assert.equal(parseFiniteNumber("0"), 0);
});

test("parseFiniteNumber rejects partial, empty, non-finite, and non-scalar values", () => {
  for (const value of ["", "  ", "12abc", "0x10", "Infinity", NaN, Infinity, null, {}, ["1"]]) {
    assert.equal(parseFiniteNumber(value), null, `expected ${String(value)} to be rejected`);
  }
});

test("parseFiniteInteger accepts only safe integers", () => {
  assert.equal(parseFiniteInteger(5), 5);
  assert.equal(parseFiniteInteger(" -20 "), -20);
  for (const value of ["1.5", "5abc", "", Infinity, NaN, 9007199254740992, null, ["5"]]) {
    assert.equal(parseFiniteInteger(value), null, `expected ${String(value)} to be rejected`);
  }
});

test("positiveIntegerOrDefault rejects invalid and non-positive values", () => {
  assert.equal(positiveIntegerOrDefault("5", 10), 5);
  assert.equal(positiveIntegerOrDefault("5ms", 10), 10);
  assert.equal(positiveIntegerOrDefault(0, 10), 10);
  assert.equal(positiveIntegerOrDefault(-1, 10), 10);
});

test("timerDelayOrDefault prevents Node timer overflow while preserving short test delays", () => {
  assert.equal(timerDelayOrDefault(500, 1000), 500);
  assert.equal(timerDelayOrDefault("2147483647", 1000), 2147483647);
  assert.equal(timerDelayOrDefault("2147483648", 1000), 1000);
  assert.equal(timerDelayOrDefault("5ms", 1000), 1000);
});

test("nonNegativeTimerDelayOrDefault preserves immediate expiry and rejects overflowing delays", () => {
  assert.equal(nonNegativeTimerDelayOrDefault(0, 1000), 0);
  assert.equal(nonNegativeTimerDelayOrDefault("25", 1000), 25);
  assert.equal(nonNegativeTimerDelayOrDefault("2147483648", 1000), 1000);
  assert.equal(nonNegativeTimerDelayOrDefault("10ms", 1000), 1000);
});

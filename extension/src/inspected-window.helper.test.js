/**
 * Tests for chromeEval adapter and evalCmd.
 *
 * Verifies that evalCmd correctly returns expression values regardless of
 * Chrome callback vs polyfill tuple differences — the root cause of the
 * Chrome 152 DevTools panel crash.
 *
 * Run: node --test extension/src/inspected-window.helper.test.js
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Mock chrome.devtools.inspectedWindow.eval at the global level
// before importing the module under test.
let mockCallback;
globalThis.chrome = {
  devtools: {
    inspectedWindow: {
      eval: (expression, callback) => {
        mockCallback(expression, callback);
      }
    }
  }
};

const { evalCmd, evalDevtoolsCmd, ProtocolError } = await import("./inspected-window.helper.js");

function setupMock(valueFn) {
  mockCallback = (_expr, cb) => {
    const { value, exceptionInfo } = valueFn();
    cb(value, exceptionInfo);
  };
}

describe("evalCmd — value extraction", () => {
  it("returns a multi-element array without truncation", async () => {
    const apps = [{ name: "app-a" }, { name: "app-b" }, { name: "app-c" }];
    setupMock(() => ({ value: apps, exceptionInfo: undefined }));
    const result = await evalCmd("test()", { retries: 0 });
    assert.deepEqual(result, apps);
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 3);
  });

  it("returns a single-element array correctly", async () => {
    const apps = [{ name: "only-app" }];
    setupMock(() => ({ value: apps, exceptionInfo: undefined }));
    const result = await evalCmd("test()", { retries: 0 });
    assert.deepEqual(result, apps);
  });

  it("returns a two-element array without mistaking it for a tuple", async () => {
    const apps = [{ name: "app-a" }, { name: "app-b" }];
    setupMock(() => ({ value: apps, exceptionInfo: undefined }));
    const result = await evalCmd("test()", { retries: 0 });
    assert.deepEqual(result, apps);
    assert.equal(result.length, 2);
  });

  it("returns an empty array", async () => {
    setupMock(() => ({ value: [], exceptionInfo: undefined }));
    const result = await evalCmd("test()", { retries: 0 });
    assert.deepEqual(result, []);
  });

  it("returns a string without truncation to first char", async () => {
    setupMock(() => ({ value: "hello world", exceptionInfo: undefined }));
    const result = await evalCmd("test()", { retries: 0 });
    assert.equal(result, "hello world");
  });

  it("returns a plain object", async () => {
    const obj = { key: "value", nested: { a: 1 } };
    setupMock(() => ({ value: obj, exceptionInfo: undefined }));
    const result = await evalCmd("test()", { retries: 0 });
    assert.deepEqual(result, obj);
  });

  it("returns null", async () => {
    setupMock(() => ({ value: null, exceptionInfo: undefined }));
    const result = await evalCmd("test()", { retries: 0 });
    assert.equal(result, null);
  });

  it("returns undefined", async () => {
    setupMock(() => ({ value: undefined, exceptionInfo: undefined }));
    const result = await evalCmd("test()", { retries: 0 });
    assert.equal(result, undefined);
  });

  it("returns a boolean", async () => {
    setupMock(() => ({ value: true, exceptionInfo: undefined }));
    const result = await evalCmd("test()", { retries: 0 });
    assert.equal(result, true);
  });

  it("returns a number", async () => {
    setupMock(() => ({ value: 42, exceptionInfo: undefined }));
    const result = await evalCmd("test()", { retries: 0 });
    assert.equal(result, 42);
  });
});

describe("evalCmd — error handling", () => {
  it("throws on isException error", async () => {
    setupMock(() => ({
      value: undefined,
      exceptionInfo: { isException: true, value: "ReferenceError: x is not defined" }
    }));
    await assert.rejects(
      () => evalCmd("test()", { retries: 0 }),
      (err) => err instanceof Error && !(err instanceof ProtocolError)
    );
  });

  it("throws on isError with non-recoverable code", async () => {
    setupMock(() => ({
      value: undefined,
      exceptionInfo: { isError: true, code: "E_NOTFOUND" }
    }));
    await assert.rejects(
      () => evalCmd("test()", { retries: 0 }),
      (err) => err instanceof Error && !(err instanceof ProtocolError)
    );
  });

  it("throws ProtocolError on recoverable error after retries exhausted", async () => {
    setupMock(() => ({
      value: undefined,
      exceptionInfo: { isError: true, code: "E_PROTOCOLERROR", details: "uniqueContextId not found in this execution context" }
    }));
    await assert.rejects(
      () => evalCmd("test()", { retries: 1, retryDelay: 10 }),
      (err) => err instanceof ProtocolError && err.isRecoverable === true
    );
  });

  it("retries on recoverable error before exhaustion", async () => {
    let callCount = 0;
    mockCallback = (_expr, cb) => {
      callCount++;
      if (callCount < 3) {
        cb(undefined, { isError: true, code: "E_PROTOCOLERROR", details: "uniqueContextId not found" });
      } else {
        cb([{ name: "app-a" }], undefined);
      }
    };
    const result = await evalCmd("test()", { retries: 2, retryDelay: 10 });
    assert.deepEqual(result, [{ name: "app-a" }]);
    assert.equal(callCount, 3);
  });

  it("does not swallow non-recoverable errors", async () => {
    setupMock(() => ({
      value: undefined,
      exceptionInfo: { isError: true, code: "E_SOMETHING_BAD" }
    }));
    await assert.rejects(
      () => evalCmd("test()", { retries: 2, retryDelay: 10 }),
      (err) => err instanceof Error && !(err instanceof ProtocolError)
    );
  });
});

describe("evalDevtoolsCmd", () => {
  it("prepends window.__SINGLE_SPA_DEVTOOLS__", async () => {
    let capturedExpr;
    mockCallback = (expr, cb) => {
      capturedExpr = expr;
      cb("ok", undefined);
    };
    await evalDevtoolsCmd("exposedMethods?.getRawAppData()");
    assert.equal(capturedExpr, "window.__SINGLE_SPA_DEVTOOLS__.exposedMethods?.getRawAppData()");
  });
});

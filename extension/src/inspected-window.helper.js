/* global chrome */

export class ProtocolError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.details = details;
    this.isRecoverable = true;
  }
}

// Chrome callback form: stable since Chrome 18, always provides (value, exceptionInfo).
// Not affected by browser namespace or polyfill state.
function chromeEval(expression) {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval(expression, (value, exceptionInfo) => {
      resolve({ value, exceptionInfo });
    });
  });
}

function isRecoverableError(errorInfo) {
  if (!errorInfo) return false;
  const { code, details } = errorInfo;

  if (code === "E_PROTOCOLERROR" && details?.includes("uniqueContextId not found")) {
    return true;
  }

  if (details?.some?.(d =>
    d?.includes?.("Cannot find context") ||
    d?.includes?.("Execution context was destroyed") ||
    d?.includes?.("Target closed")
  )) {
    return true;
  }

  return false;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function evalDevtoolsCmd(devToolsCommandString, options = {}) {
  const commandString = `window.__SINGLE_SPA_DEVTOOLS__.${devToolsCommandString}`;
  return evalCmd(commandString, options);
}

export async function evalCmd(commandString, options = {}) {
  const { retries = 2, retryDelay = 500 } = options;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { value, exceptionInfo } = await chromeEval(commandString);

      if (exceptionInfo && (exceptionInfo.isError || exceptionInfo.isException)) {
        if (isRecoverableError(exceptionInfo)) {
          if (attempt < retries) {
            console.debug(
              `[spawriter] Recoverable error on attempt ${attempt + 1}, retrying in ${retryDelay}ms... Code: ${exceptionInfo.code}, Details: ${JSON.stringify(exceptionInfo.details)}`
            );
            await delay(retryDelay);
            continue;
          }

          throw new ProtocolError(
            `evalCmd '${commandString}' failed after ${retries + 1} attempts: ${JSON.stringify(exceptionInfo)}`,
            exceptionInfo.code,
            exceptionInfo.details
          );
        }

        throw new Error(
          `evalCmd '${commandString}' failed: ${JSON.stringify(exceptionInfo)}`
        );
      }

      return value;
    } catch (err) {
      if (err instanceof ProtocolError) {
        throw err;
      }

      if (attempt < retries) {
        console.debug(
          `[spawriter] Unexpected error on attempt ${attempt + 1}, retrying... Error: ${err.message || err}`
        );
        await delay(retryDelay);
        continue;
      }

      throw err;
    }
  }
}

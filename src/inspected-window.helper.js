import browser from "webextension-polyfill";

// 自定义错误类，用于标识可恢复的协议错误
export class ProtocolError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.details = details;
    this.isRecoverable = true;
  }
}

// 判断是否为可恢复的协议错误（如页面导航导致的 context 丢失）
function isRecoverableError(errorInfo) {
  if (!errorInfo) return false;
  const { code, details } = errorInfo;
  
  // uniqueContextId not found - 页面导航/刷新导致的 context 丢失
  if (code === "E_PROTOCOLERROR" && details?.includes("uniqueContextId not found")) {
    return true;
  }
  
  // 其他可能的可恢复错误
  if (details?.some?.(d => 
    d?.includes?.("Cannot find context") ||
    d?.includes?.("Execution context was destroyed") ||
    d?.includes?.("Target closed")
  )) {
    return true;
  }
  
  return false;
}

// 延迟函数
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
      const result = await browser.devtools.inspectedWindow.eval(commandString);
      
      if (result[1] && (result[1].isError || result[1].isException)) {
        const errorInfo = result[1];
        
        // 检查是否为可恢复错误
        if (isRecoverableError(errorInfo)) {
          // 如果还有重试次数，等待后重试
          if (attempt < retries) {
            console.debug(
              `[single-spa-inspector-pro-mcp] Recoverable error on attempt ${attempt + 1}, retrying in ${retryDelay}ms... Code: ${errorInfo.code}, Details: ${JSON.stringify(errorInfo.details)}`
            );
            await delay(retryDelay);
            continue;
          }
          
          // 重试次数用尽，抛出 ProtocolError
          throw new ProtocolError(
            `evalCmd '${commandString}' failed after ${retries + 1} attempts: ${JSON.stringify(errorInfo)}`,
            errorInfo.code,
            errorInfo.details
          );
        }
        
        // 非可恢复错误，直接抛出普通错误
        throw new Error(
          `evalCmd '${commandString}' failed: ${JSON.stringify(errorInfo)}`
        );
      }
      
      return result[0];
    } catch (err) {
      // 如果是我们抛出的 ProtocolError，直接抛出
      if (err instanceof ProtocolError) {
        throw err;
      }
      
      // 其他未预期的错误，如果还有重试次数，尝试重试
      if (attempt < retries) {
        console.debug(
          `[single-spa-inspector-pro-mcp] Unexpected error on attempt ${attempt + 1}, retrying... Error: ${err.message || err}`
        );
        await delay(retryDelay);
        continue;
      }
      
      throw err;
    }
  }
}

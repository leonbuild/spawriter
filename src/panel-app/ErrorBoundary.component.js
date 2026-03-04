import React from "react";

// 判断是否为可恢复的协议错误
function isRecoverableProtocolError(error) {
  if (!error) return false;
  // 检查错误名称或消息中是否包含协议错误相关信息
  return (
    error.name === "ProtocolError" ||
    error.isRecoverable === true ||
    error.message?.includes("E_PROTOCOLERROR") ||
    error.message?.includes("uniqueContextId not found") ||
    error.message?.includes("Execution context was destroyed")
  );
}

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { caughtError: null };
    this.handleReload = this.handleReload.bind(this);
  }

  static getDerivedStateFromError(error) {
    // Update state so the next render will show the fallback UI.
    return { caughtError: error };
  }

  handleReload() {
    // 清除错误状态并重新渲染
    this.setState({ caughtError: null });
  }

  render() {
    if (this.state.caughtError) {
      const isRecoverable = isRecoverableProtocolError(this.state.caughtError);
      
      // You can render any custom fallback UI
      return (
        <div
          style={{
            padding: "16px",
          }}
        >
          <h1>spawriter broke!</h1>
          
          {isRecoverable ? (
            <>
              <p style={{ color: "#e67e22" }}>
                <strong>⚠️ This appears to be a recoverable error.</strong>
              </p>
              <p>
                This error usually occurs when the page navigates or reloads while the DevTools panel is open.
                The execution context was lost, but you can try to reload the inspector.
              </p>
              <button
                onClick={this.handleReload}
                style={{
                  backgroundColor: "#3366ff",
                  color: "#fff",
                  border: "none",
                  borderRadius: "4px",
                  padding: "10px 20px",
                  fontSize: "14px",
                  fontWeight: "bold",
                  cursor: "pointer",
                  marginRight: "10px",
                  marginBottom: "16px",
                }}
              >
                🔄 Reload Inspector
              </button>
            </>
          ) : (
            <p>
              Please close and reopen the devtools to get this working again.
            </p>
          )}
          
          <button
            onClick={this.handleReload}
            style={{
              backgroundColor: isRecoverable ? "#82889a" : "#3366ff",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
              padding: "10px 20px",
              fontSize: "14px",
              fontWeight: "bold",
              cursor: "pointer",
              marginBottom: "16px",
              display: isRecoverable ? "none" : "inline-block",
            }}
          >
            Try Reload Inspector
          </button>
          
          <p>
            Also, report this error{" "}
            <a
              href={`https://github.com/gzl333/spawriter/issues/new?title=spawriter%20bug%20report&body=${encodeURIComponent(
                this.state.caughtError.message
              )}%0A%0A%60%60%60%0A${encodeURIComponent(
                this.state.caughtError.stack
              )}%60%60%60`}
            >
              here
            </a>{" "}
            if you don't mind, and copy the information below into that report:
          </p>
          <details style={{ marginTop: "8px" }}>
            <summary style={{ cursor: "pointer", color: "#82889a" }}>
              Error Details
            </summary>
            <p style={{ marginTop: "8px" }}>
              Error message: <em>{this.state.caughtError.message}</em>
              <br />
              <pre style={{ 
                overflow: "auto", 
                maxHeight: "200px",
                backgroundColor: "#f5f5f5",
                padding: "8px",
                borderRadius: "4px",
                fontSize: "12px"
              }}>
                {this.state.caughtError.stack}
              </pre>
            </p>
          </details>
        </div>
      );
    }

    return this.props.children;
  }
}

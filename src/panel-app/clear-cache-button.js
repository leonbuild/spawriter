import React, { useState } from "react";
import { useCss, always } from "kremling";
import browser from "webextension-polyfill";

const ClearCacheButton = React.forwardRef(({ sharedState, setSharedState }, ref) => {
  const styles = useCss(css);
  
  // 使用共享状态或本地状态
  const [localIsClearing, setLocalIsClearing] = useState(false);
  const [localStatus, setLocalStatus] = useState(null);
  
  const isClearing = sharedState ? sharedState.isClearing : localIsClearing;
  const status = sharedState ? sharedState.status : localStatus;
  
  const setIsClearing = (value) => {
    if (sharedState && setSharedState) {
      setSharedState(prev => ({ ...prev, isClearing: value }));
    } else {
      setLocalIsClearing(value);
    }
  };
  
  const setStatus = (value) => {
    if (sharedState && setSharedState) {
      setSharedState(prev => ({ ...prev, status: value }));
    } else {
      setLocalStatus(value);
    }
  };

  const handleClearCache = async () => {
    if (isClearing) return;
    
    setIsClearing(true);
    setStatus(null);

    try {
      const tabId = browser.devtools.inspectedWindow.tabId;
      const response = await browser.runtime.sendMessage({
        type: "clear-cache",
        tabId,
        dataTypes: {
          cache: true,
          serviceWorkers: true
        }
      });

      if (response?.success) {
        setStatus("success");
      } else {
        setStatus("error");
        console.error("Clear cache failed:", response?.error);
      }
    } catch (error) {
      // Silently handle extension context invalidation
      if (error.message && error.message.includes("Extension context invalidated")) {
        console.debug("[single-spa-inspector-pro-mcp] Service worker terminated during clear cache");
        setStatus("error");
      } else {
        setStatus("error");
        console.error("Error sending clear-cache message:", error);
      }
    } finally {
      setIsClearing(false);
      // Reset status after 2 seconds
      setTimeout(() => setStatus(null), 2000);
    }
  };

  const getButtonText = () => {
    if (isClearing) return "Clearing...";
    if (status === "success") return "Cleared!";
    if (status === "error") return "Failed";
    return "Clear Cache & Refresh";
  };

  return (
    <button
      ref={ref}
      {...styles}
      className={always("clear-cache-btn")
        .maybe("clearing", isClearing)
        .maybe("success", status === "success")
        .maybe("error", status === "error")}
      onClick={handleClearCache}
      disabled={isClearing}
      title="Clear browser cache (HTTP cache, Service Workers) and refresh the page"
    >
      {getButtonText()}
    </button>
  );
});

ClearCacheButton.displayName = 'ClearCacheButton';

export default ClearCacheButton;

const css = `
& .clear-cache-btn {
  background: linear-gradient(135deg, #2d9a4c 0%, #1e8e3e 100%);
  border: none;
  border-radius: 5px;
  color: white;
  cursor: pointer;
  font-size: .9rem;
  font-weight: 600;
  padding: .5rem 1.5rem;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  white-space: nowrap;
  text-align: center;
  line-height: 1.4;
  user-select: none;
  box-sizing: border-box;
  min-width: 220px;
  box-shadow: 0 2px 8px rgba(30, 142, 62, 0.2);
  position: relative;
  overflow: hidden;
}

& .clear-cache-btn::before {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
  transition: left 0.5s;
}

& .clear-cache-btn:hover:not(:disabled)::before {
  left: 100%;
}

& .clear-cache-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, #34a855 0%, #2d9a4c 100%);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(30, 142, 62, 0.3);
}

& .clear-cache-btn:active:not(:disabled) {
  transform: translateY(0);
  box-shadow: 0 2px 6px rgba(30, 142, 62, 0.25);
}

& .clear-cache-btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
  transform: none;
}

& .clear-cache-btn.clearing {
  background: linear-gradient(135deg, #7c8a9d 0%, #5a6978 100%);
  box-shadow: 0 2px 8px rgba(90, 105, 120, 0.2);
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% {
    box-shadow: 0 2px 8px rgba(90, 105, 120, 0.2);
  }
  50% {
    box-shadow: 0 2px 12px rgba(90, 105, 120, 0.4);
  }
}

& .clear-cache-btn.success {
  background: linear-gradient(135deg, #34d058 0%, #28a745 100%);
  box-shadow: 0 2px 8px rgba(40, 167, 69, 0.3);
  animation: successPulse 0.5s ease-out;
}

@keyframes successPulse {
  0% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.05);
  }
  100% {
    transform: scale(1);
  }
}

& .clear-cache-btn.error {
  background: linear-gradient(135deg, #f44336 0%, #d32f2f 100%);
  box-shadow: 0 2px 8px rgba(211, 47, 47, 0.3);
  animation: shake 0.5s ease-out;
}

@keyframes shake {
  0%, 100% {
    transform: translateX(0);
  }
  25% {
    transform: translateX(-5px);
  }
  75% {
    transform: translateX(5px);
  }
}
`;

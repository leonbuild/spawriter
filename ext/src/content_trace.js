const DYNAMIC_CLASS_RE = /^(data-v-|_|css-|sc-|jss|styles_)/;
const DEBOUNCE_INPUT = 500;
const DEBOUNCE_SCROLL = 300;

function generateUniqueSelector(el) {
  const testId = el.getAttribute('data-testid');
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`;

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return `[aria-label="${CSS.escape(ariaLabel)}"]`;

  if (el.id) return `#${CSS.escape(el.id)}`;

  const parts = [];
  let current = el;
  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      parts.unshift(`#${CSS.escape(current.id)}`);
      break;
    }
    if (current.className && typeof current.className === 'string') {
      const stableClasses = current.className.trim().split(/\s+/)
        .filter(c => c && !DYNAMIC_CLASS_RE.test(c))
        .slice(0, 2);
      if (stableClasses.length) {
        selector += stableClasses.map(c => `.${CSS.escape(c)}`).join('');
      }
    }
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
      if (siblings.length > 1) {
        const idx = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${idx})`;
      }
    }
    parts.unshift(selector);
    current = current.parentElement;
  }
  return parts.join(' > ');
}

function getXPath(el) {
  const parts = [];
  let current = el;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let idx = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) idx++;
      sibling = sibling.previousElementSibling;
    }
    parts.unshift(`${current.tagName.toLowerCase()}[${idx}]`);
    current = current.parentElement;
  }
  return '/' + parts.join('/');
}

if (!window.__spawriter_trace_injected) {
  window.__spawriter_trace_injected = true;

  let traceActive = false;
  let inputTimer = null;
  let scrollTimer = null;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'trace_start') traceActive = true;
    if (msg.type === 'trace_stop') traceActive = false;
  });

  function getElementInfo(el) {
    return {
      tagName: el.tagName?.toLowerCase(),
      role: el.getAttribute('role') || el.tagName?.toLowerCase(),
      name: el.getAttribute('aria-label') || el.innerText?.slice(0, 50) || '',
      cssSelector: generateUniqueSelector(el),
      xpath: getXPath(el),
      type: el.type || undefined,
    };
  }

  function sendTraceEvent(event) {
    if (!traceActive) return;
    chrome.runtime.sendMessage({
      type: 'trace_event',
      payload: {
        ...event,
        timestamp: Date.now(),
        url: window.location.href,
      }
    });
  }

  document.addEventListener('click', (e) => {
    sendTraceEvent({
      type: 'click',
      element: getElementInfo(e.target),
      position: { x: e.clientX, y: e.clientY },
    });
  }, true);

  document.addEventListener('input', (e) => {
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => {
      const value = e.target.type === 'password' ? '********' : e.target.value;
      sendTraceEvent({
        type: 'fill',
        element: getElementInfo(e.target),
        value,
      });
    }, DEBOUNCE_INPUT);
  }, true);

  document.addEventListener('change', (e) => {
    if (e.target.type === 'checkbox' || e.target.type === 'radio') {
      sendTraceEvent({
        type: e.target.checked ? 'check' : 'uncheck',
        element: getElementInfo(e.target),
      });
    } else if (e.target.tagName === 'SELECT') {
      sendTraceEvent({
        type: 'select',
        element: getElementInfo(e.target),
        value: e.target.value,
      });
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (['Enter', 'Escape', 'Tab', 'Backspace', 'Delete'].includes(e.key) ||
        (e.ctrlKey || e.metaKey)) {
      sendTraceEvent({
        type: 'press',
        key: e.key,
        modifiers: {
          ctrl: e.ctrlKey,
          alt: e.altKey,
          shift: e.shiftKey,
          meta: e.metaKey,
        },
        element: getElementInfo(e.target),
      });
    }
  }, true);

  document.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      sendTraceEvent({
        type: 'scroll',
        position: { x: window.scrollX, y: window.scrollY },
      });
    }, DEBOUNCE_SCROLL);
  }, true);
}

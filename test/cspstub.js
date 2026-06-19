// External (same-origin) stub so it's allowed under a strict script-src 'self'
// CSP — mirrors how VS Code injects acquireVsCodeApi for the real webview.
window.__posts = [];
window.acquireVsCodeApi = () => ({
  postMessage: (m) => window.__posts.push(m),
});
window.__send = (m) => window.postMessage(m, "*");
window.__lastState = () => {
  const s = window.__posts.filter((p) => p && p.type === "state");
  return s.length ? s[s.length - 1] : null;
};

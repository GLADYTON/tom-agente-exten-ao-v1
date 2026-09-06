export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function renderInlineMd(text) {
  const esc = escapeHtml(text);
  return esc
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
      `<pre><code class="lang-${lang}">${code}</code></pre>`)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/^### (.*$)/gim, '<h4 style="margin:8px 0 4px;font-size:14px;color:var(--text, #f1f5f9);">$1</h4>')
    .replace(/^## (.*$)/gim, '<h3 style="margin:10px 0 6px;font-size:15px;color:var(--text, #f1f5f9);">$1</h3>')
    .replace(/^# (.*$)/gim, '<h2 style="margin:12px 0 8px;font-size:16px;color:var(--text, #f1f5f9);">$1</h2>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^\s*[-*]\s+(.*$)/gim, '<li style="margin-left:18px;margin-bottom:3px;">$1</li>')
    .replace(/\n/g, '<br>');
}

export function fmtCost(n) {
  if (!n) return '$0.0000';
  return '$' + n.toFixed(4);
}

export function fmtTokens(n) {
  if (n == null) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(1) + 'k';
  return (n / 1e6).toFixed(2) + 'M';
}

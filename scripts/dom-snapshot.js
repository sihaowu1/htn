// Read as a string and evaluated in Chromium, so Node/TypeScript helpers never leak into the page.
(() => {
  const selectors = new Map();
  function selector(el) {
    if (selectors.has(el)) return selectors.get(el);
    const parent = el.parentElement;
    const index = parent ? Array.from(parent.children).filter(x => x.tagName === el.tagName).indexOf(el) + 1 : 1;
    const path = (parent ? selector(parent) + ' > ' : '') + el.tagName.toLowerCase() + `:nth-of-type(${index})`;
    selectors.set(el, path); return path;
  }
  const visible = el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const all = Array.from(document.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[role="link"],[contenteditable="true"]')).filter(visible);
  const elements = all.map(el => {
    const labels = 'labels' in el ? Array.from(el.labels || []).map(x => x.textContent).join(' ') : '';
    return { selector: selector(el), tag: el.tagName.toLowerCase(), type: el.type || el.getAttribute('role') || '',
      label: (el.getAttribute('aria-label') || labels || el.textContent || el.getAttribute('placeholder') || el.name || '').trim().slice(0, 300),
      value: el.type === 'password' ? '[redacted]' : el.value || '',
      options: el instanceof HTMLSelectElement ? Array.from(el.options).filter(o => !o.disabled).map(o => o.value) : [] };
  });
  function tree(el) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName) || !visible(el)) return '';
    const attrs = ['aria-label', 'aria-expanded', 'aria-selected', 'role', 'href', 'disabled'].filter(key => el.hasAttribute(key)).map(key => ` ${key}=${JSON.stringify(el.getAttribute(key))}`).join('');
    const checked = el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type) ? ` checked=${el.checked}` : '';
    const ownText = Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent?.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
    return `<${el.tagName.toLowerCase()}${attrs}${checked}>${ownText}${Array.from(el.children).map(tree).join('')}</${el.tagName.toLowerCase()}>`;
  }
  return { url: location.href, title: document.title, text: document.body.innerText,
    dom: tree(document.body), elements,
    unsupported: [
      ...(document.querySelector('iframe') ? ['iframe contents are not explored'] : []),
      ...(document.querySelector('canvas') ? ['canvas controls are not explored'] : []),
      ...(Array.from(document.querySelectorAll('*')).some(e => e.shadowRoot) ? ['shadow DOM is not explored'] : []),
      ...(document.querySelector('input[type="file"]') ? ['file uploads are not explored'] : []),
      ...(document.querySelector('input[type="password"]') ? ['password inputs require fixture sign-in'] : []),
      ...(document.querySelector('[contenteditable="true"]') ? ['contenteditable controls are not explored'] : []),
    ] };
})()

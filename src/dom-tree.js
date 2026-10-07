/**
 * Browser Use-inspired DOM snapshot extraction.
 *
 * It deliberately runs in the page context, as browser-use's buildDomTree does:
 * actionable nodes are found from semantics, visibility and geometry, then
 * represented with compact text for the model. IDs are new for every snapshot;
 * never cache them after the page changes.
 */
export function buildDomTree(idPrefix = '') {
  const INTERACTIVE_SELECTOR = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'textarea', 'select',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[contenteditable="true"]',
    '[onclick]', '[tabindex]:not([tabindex="-1"])'
  ].join(',');
  const ID_ATTRIBUTE = 'data-sap-ai-id';

  const textOf = (element) =>
    (element.getAttribute('aria-label') || element.getAttribute('title') ||
      element.getAttribute('placeholder') || element.innerText || element.value || '')
      .replace(/\s+/g, ' ').trim().slice(0, 160);

  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' &&
      Number(style.opacity) !== 0 && rect.width > 1 && rect.height > 1;
  };

  // UI5 often places the listener/role on a wrapper. Keep the actual matching
  // element so click and type can use a deterministic attribute selector.
  const nodes = [...document.querySelectorAll(INTERACTIVE_SELECTOR)]
    .filter(visible)
    .filter((element) => !element.closest('[aria-hidden="true"]'));

  document.querySelectorAll(`[${ID_ATTRIBUTE}]`).forEach((element) =>
    element.removeAttribute(ID_ATTRIBUTE));

  return nodes.map((element, index) => {
    const id = `${idPrefix}${index + 1}`;
    element.setAttribute(ID_ATTRIBUTE, id);
    const rect = element.getBoundingClientRect();
    return {
      id,
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') || undefined,
      type: element.getAttribute('type') || undefined,
      // This is intentionally narrow: it prevents the model from trying to
      // type into focusable links/wrappers that UI5 exposes as interactive.
      editable: (
        (element.matches('input:not([readonly]):not([disabled])') &&
          !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(element.type)) ||
        element.matches('textarea:not([readonly]):not([disabled])') ||
        element.getAttribute('contenteditable') === 'true'
      ),
      name: textOf(element) || undefined,
      disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
      checked: element.getAttribute('aria-checked') || element.checked || undefined,
      value: ['password'].includes(element.type) ? undefined : (element.value || undefined),
      bounds: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
    };
  });
}

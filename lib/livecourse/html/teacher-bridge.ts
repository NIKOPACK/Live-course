export const HTML_TEXT_SELECTION_LIMIT = 500;

const TEACHER_BRIDGE = `<script data-livecourse-teacher-bridge>
(function () {
  var pending = [];
  var restoreHighlight = null;
  var note = null;
  function clearHighlight() {
    if (restoreHighlight) restoreHighlight();
    restoreHighlight = null;
  }
  function apply(data) {
    if (typeof data.target !== 'string' || !data.target.trim()) {
      throw new Error('Teacher action requires a target selector');
    }
    var target = document.querySelector(data.target);
    if (!target) throw new Error('Teacher action target not found: ' + data.target);
    if (data.type === 'REVEAL_ELEMENT') {
      target.removeAttribute('hidden');
      var style = window.getComputedStyle(target);
      if (style.display === 'none') target.style.setProperty('display', 'revert', 'important');
      if (style.visibility === 'hidden') target.style.setProperty('visibility', 'visible', 'important');
      if (style.opacity === '0') target.style.setProperty('opacity', '1', 'important');
      return;
    }
    if (data.type === 'HIGHLIGHT_ELEMENT') {
      clearHighlight();
      if (note) { note.remove(); note = null; }
      var original = target.style.getPropertyValue('outline');
      var priority = target.style.getPropertyPriority('outline');
      var offset = target.style.getPropertyValue('outline-offset');
      var offsetPriority = target.style.getPropertyPriority('outline-offset');
      var restore = function () {
        if (original) target.style.setProperty('outline', original, priority);
        else target.style.removeProperty('outline');
        if (offset) target.style.setProperty('outline-offset', offset, offsetPriority);
        else target.style.removeProperty('outline-offset');
      };
      restoreHighlight = restore;
      target.style.setProperty('outline', '3px solid currentColor', 'important');
      target.style.setProperty('outline-offset', '5px', 'important');
      if (target.scrollIntoView) target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    if (typeof data.content === 'string' && data.content.trim()) {
      if (note) note.remove();
      var label = document.createElement('div');
      label.setAttribute('role', 'status');
      label.setAttribute('data-livecourse-teacher-note', '');
      label.textContent = data.content;
      label.style.cssText = 'position:fixed;z-index:2147483647;max-width:min(28rem,calc(100vw - 24px));box-sizing:border-box;padding:8px 12px;border:1px solid currentColor;border-radius:6px;background:Canvas;color:CanvasText;font:14px/1.5 system-ui;pointer-events:none;overflow-wrap:anywhere';
      var rect = target.getBoundingClientRect();
      label.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - 300)) + 'px';
      label.style.top = Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 80)) + 'px';
      document.body.appendChild(label);
      note = label;
      window.setTimeout(function () { label.remove(); if (note === label) note = null; }, 5000);
    }
  }
  function respond(data, result) {
    window.parent.postMessage(Object.assign({
      __livecourseTeacher: true,
      requestId: data.requestId
    }, result), '*');
  }
  function handle(data) {
    if (data.type === 'TEACHER_READY_REQUEST') {
      respond(data, { type: 'TEACHER_READY' });
      return;
    }
    if (data.__livecourseTeacher !== true || typeof data.requestId !== 'string') {
      apply(data);
      return;
    }
    try {
      apply(data);
      respond(data, { type: 'TEACHER_ACTION_RESULT', success: true });
    } catch (error) {
      respond(data, { type: 'TEACHER_ACTION_RESULT', success: false, error: String(error.message || error) });
    }
  }
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || ['TEACHER_READY_REQUEST', 'HIGHLIGHT_ELEMENT', 'ANNOTATE_ELEMENT', 'REVEAL_ELEMENT'].indexOf(data.type) < 0) return;
    if (document.readyState === 'loading') pending.push(data);
    else handle(data);
  });
  document.addEventListener('DOMContentLoaded', function () {
    var actions = pending;
    pending = [];
    actions.forEach(handle);
  });
  var selectionTimer = null;
  document.addEventListener('selectionchange', function () {
    window.clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(function () {
      var selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return;
      var node = selection.anchorNode;
      var element = node && (node.nodeType === 1 ? node : node.parentElement);
      var editable = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
      if (document.activeElement && document.activeElement.closest(editable)) return;
      if (!element || element.closest(editable)) return;
      if (selection.getRangeAt(0).cloneContents().querySelector(editable)) return;
      var text = selection.toString().replace(/\\s+/g, ' ').trim().slice(0, ${HTML_TEXT_SELECTION_LIMIT});
      if (!text) return;
      window.parent.postMessage({
        __livecourseTeacher: true,
        type: 'HTML_TEXT_SELECTED',
        text: text
      }, '*');
    }, 200);
  });
})();
</script>`;

/** New HTML pages share the existing teacher action protocol, not a layout template. */
export function attachHtmlTeacherBridge(html: string): string {
  return html
    .replace(/<script\b[^>]*\bdata-livecourse-teacher-bridge\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<head\b[^>]*>/i, (head) => head + TEACHER_BRIDGE);
}

export function hasHtmlTeacherBridge(html: string): boolean {
  return /<script\b[^>]*\bdata-livecourse-teacher-bridge\b/i.test(html);
}

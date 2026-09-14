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
      window.setTimeout(function () { if (restoreHighlight === restore) clearHighlight(); }, 3000);
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
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || ['HIGHLIGHT_ELEMENT', 'ANNOTATE_ELEMENT', 'REVEAL_ELEMENT'].indexOf(data.type) < 0) return;
    if (document.readyState === 'loading') pending.push(data);
    else apply(data);
  });
  document.addEventListener('DOMContentLoaded', function () {
    var actions = pending;
    pending = [];
    actions.forEach(apply);
  });
})();
</script>`;

/** New HTML pages share the existing teacher action protocol, not a layout template. */
export function attachHtmlTeacherBridge(html: string): string {
  return html.replace(/<head\b[^>]*>/i, (head) => head + TEACHER_BRIDGE);
}

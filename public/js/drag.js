// 轻量拖拽：基于 mouse 事件 + 坐标命中，不依赖 HTML5 原生 DnD。
// 原生 dragstart 在部分内嵌 WebView / 预览面板里不触发，这里自己实现以保证通用。
// 用法：bindDrag({ handle, container, selector, payload, onDrop, onHover })
//   handle   : 可拖元素的 CSS 选择器
//   container: 绑定 mousedown 的根元素（默认 document）。视图重渲染会重建按钮，
//              重复对同一 container + handle 调用 bindDrag 时会自动解绑旧监听，避免累积。
//   selector : 放置目标 CSS 选择器（用 document.elementFromPoint 命中）
//   payload  : (handleEl) => 任意数据，drop 时回传
//   onDrop   : (payload, targetEl, handleEl) => void|Promise
//   onHover  : (targetEl, selector) => void  用于高亮，可选

// container -> Map(handleSelector -> AbortController)，重复绑定先 abort 旧的
const BOUND = new WeakMap();

export function bindDrag({
  handle,
  container = document,
  selector,
  payload,
  onDrop,
  onHover,
  startThreshold = 3
}) {
  const roots = typeof container === 'string' ? [document] : [container];
  const scope = typeof container === 'string' ? container : null;

  roots.forEach(root => {
    let byHandle = BOUND.get(root);
    if (!byHandle) { byHandle = new Map(); BOUND.set(root, byHandle); }
    const prev = byHandle.get(handle);
    if (prev) prev.abort();               // 关键：解绑同一容器+手柄的旧监听
    const ac = new AbortController();
    byHandle.set(handle, ac);

    root.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const h = e.target.closest(handle);
      if (!h) return;
      // 手柄位于指定作用域内（避免跨模块误触）
      if (scope && !h.closest(scope)) return;
      // 排除表单控件
      if (e.target.closest('input,select,textarea,button,a')) return;
      e.preventDefault();
      const data = typeof payload === 'function' ? payload(h) : payload;
      const startX = e.clientX, startY = e.clientY;
      let active = false;
      let lastTarget = null;

      const clearHover = () => {
        if (onHover) onHover(null, selector);
        lastTarget = null;
      };
      const hit = (x, y) => {
        const el = document.elementFromPoint(x, y);
        return el ? el.closest(selector) : null;
      };
      const move = (ev) => {
        if (!active) {
          if (Math.abs(ev.clientX - startX) < startThreshold && Math.abs(ev.clientY - startY) < startThreshold) return;
          active = true;
          document.body.style.userSelect = 'none';
        }
        ev.preventDefault();
        const t = hit(ev.clientX, ev.clientY);
        if (t !== lastTarget) {
          if (onHover) onHover(t, selector);
          lastTarget = t;
        }
      };
      const up = (ev) => {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', up, true);
        document.body.style.userSelect = '';
        const t = active ? hit(ev.clientX, ev.clientY) : null;
        clearHover();
        if (!active || !t) return;
        try {
          const r = onDrop(data, t, h);
          if (r && typeof r.catch === 'function') r.catch(err => console.error('[drag] onDrop 失败', err));
        } catch (err) {
          console.error('[drag] onDrop 异常', err);
        }
      };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
    }, { signal: ac.signal });
  });
}

// 供高亮使用的辅助：给命中元素加 class，移出时清除（整个文档统一清一遍最稳妥）
export function clearDropHighlight(cls) {
  document.querySelectorAll('.' + cls).forEach(el => el.classList.remove(cls));
}

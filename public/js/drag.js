// 轻量拖拽：基于 pointer / mouse 事件 + 坐标命中，不依赖 HTML5 原生 DnD。
// 内嵌 WebView / 预览面板里原生 dragstart 常常不触发，这里完全自实现：
//   1) 按下手柄并移动超过阈值才进入拖拽，避免误触点击；
//   2) 拖动时显示一个跟随鼠标的“幽灵卡片”，让拖拽肉眼可见；
//   3) 用 document.elementFromPoint 命中放置目标并高亮；
//   4) 松开时把 payload 交给 onDrop。
//
// 用法：bindDrag({ container, handle, selector, payload, onDrop, onHover, ghostText })
//   container : 绑定按下事件的根元素（元素或选择器），视图重渲染会重建节点，
//               同一 container + handle 重复绑定时自动解绑旧监听，避免累积。
//   handle    : 可拖手柄的 CSS 选择器
//   selector  : 放置目标的 CSS 选择器
//   payload   : (handleEl) => 任意数据
//   onDrop    : (payload, targetEl, handleEl) => void|Promise
//   onHover   : (targetEl, selector) => void，可选
//   ghostText : (handleEl) => string，可选，幽灵卡片文字

const BOUND = new WeakMap();       // container -> Map(handleSelector -> AbortController)
let ghostEl = null;
let ghostOwner = null;             // 当前正在拖拽的 handle，防止多处同时显示

function ensureGhost() {
  if (ghostEl) return ghostEl;
  const el = document.createElement('div');
  el.className = 'drag-ghost';
  el.style.cssText = [
    'position:fixed', 'z-index:99999', 'pointer-events:none',
    'left:0', 'top:0', 'padding:7px 12px', 'border-radius:999px',
    'background:#fff', 'border:1px solid var(--accent-line,#b9c8f5)',
    'box-shadow:0 8px 24px rgba(26,36,64,.18)',
    'color:var(--accent-ink,#3b5bbf)', 'font-size:12px', 'font-weight:500',
    'white-space:nowrap', 'transform:translate(-50%,-50%)'
  ].join(';');
  document.body.appendChild(el);
  ghostEl = el;
  return el;
}

function hideGhost() {
  if (ghostEl) ghostEl.style.display = 'none';
  ghostOwner = null;
}

function showGhost(text, x, y, handle) {
  const el = ensureGhost();
  el.textContent = String(text || '拖动中…').slice(0, 60);
  el.style.display = 'block';
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  ghostOwner = handle;
}

function defaultGhostText(h) {
  const label = h.dataset.dragLabel || h.getAttribute('title') || h.textContent.trim();
  if (label) return label;
  const card = h.closest('.flow-lane, .flow-step-edit, tr');
  return (card?.querySelector('.flow-name, .cell-main')?.textContent || '').trim() || '拖动中…';
}

export function bindDrag({
  handle,
  container = document,
  selector,
  payload,
  onDrop,
  onHover,
  ghostText = defaultGhostText,
  startThreshold = 3,
  ghost = true
}) {
  const roots = typeof container === 'string' ? [document] : [container];
  const scope = typeof container === 'string' ? container : null;
  const downEvent = window.PointerEvent ? 'pointerdown' : 'mousedown';
  const moveEvent = window.PointerEvent ? 'pointermove' : 'mousemove';
  const upEvent = window.PointerEvent ? 'pointerup' : 'mouseup';

  roots.forEach(root => {
    if (!root) return;
    let byHandle = BOUND.get(root);
    if (!byHandle) { byHandle = new Map(); BOUND.set(root, byHandle); }
    const prev = byHandle.get(handle);
    if (prev) prev.abort();                 // 重渲染后重绑，先清掉旧监听
    const ac = new AbortController();
    byHandle.set(handle, ac);

    root.addEventListener(downEvent, (e) => {
      if (e.button !== 0 && e.pointerType !== 'touch') return;
      const h = e.target.closest?.(handle);
      if (!h) return;
      if (scope && !h.closest(scope)) return;
      if (e.target.closest('input,select,textarea,button,a')) return;
      e.preventDefault();
      const data = typeof payload === 'function' ? payload(h) : payload;
      const text = typeof ghostText === 'function' ? ghostText(h) : ghostText;
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
        if (ghostOwner !== h) return;
        if (!active) {
          if (Math.abs(ev.clientX - startX) < startThreshold && Math.abs(ev.clientY - startY) < startThreshold) return;
          active = true;
          document.body.style.userSelect = 'none';
          document.body.style.cursor = 'grabbing';
          if (ghost) showGhost(text, ev.clientX, ev.clientY, h);
        }
        ev.preventDefault();
        if (ghost) showGhost(text, ev.clientX, ev.clientY, h);
        const t = hit(ev.clientX, ev.clientY);
        if (t !== lastTarget) {
          if (onHover) onHover(t, selector);
          lastTarget = t;
        }
      };
      const up = (ev) => {
        if (ghostOwner !== h) return;
        document.removeEventListener(moveEvent, move, true);
        document.removeEventListener(upEvent, up, true);
        document.removeEventListener('pointercancel', up, true);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        const t = active ? hit(ev.clientX, ev.clientY) : null;
        clearHover();
        hideGhost();
        if (!active || !t) return;
        try {
          const r = onDrop(data, t, h);
          if (r && typeof r.catch === 'function') r.catch(err => console.error('[drag] onDrop 失败', err));
        } catch (err) {
          console.error('[drag] onDrop 异常', err);
        }
      };
      ghostOwner = h;                        // 登记本次拖拽，防止重复按下时互相干扰
      document.addEventListener(moveEvent, move, true);
      document.addEventListener(upEvent, up, true);
      document.addEventListener('pointercancel', up, true);
    }, { signal: ac.signal });
  });
}

// 供高亮使用的辅助：给命中元素加 class，移出时清除
export function clearDropHighlight(cls) {
  document.querySelectorAll('.' + cls).forEach(el => el.classList.remove(cls));
}

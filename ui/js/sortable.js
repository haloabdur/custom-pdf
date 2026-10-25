// Pointer-based drag-to-reorder for lists and grids. HTML5 drag and drop is
// unreliable inside desktop webviews that also accept OS file drops, so this
// moves a ghost copy with the pointer instead.

/**
 * @param {HTMLElement} container  holds the items (directly or nested)
 * @param {object} opts
 * @param {string} opts.items      selector for the sortable items
 * @param {'x'|'y'} opts.axis      'y' for vertical lists, 'x' for grids/rows
 * @param {(from:number,to:number)=>void} opts.onMove  called with the new index
 */
export function makeSortable(container, { items, axis = 'y', onMove }) {
  let drag = null;

  const itemEls = () => [...container.querySelectorAll(items)];

  const scroller = (() => {
    let el = container;
    while (el && el !== document.body) {
      const s = getComputedStyle(el);
      if (/(auto|scroll)/.test(s.overflowY + s.overflowX)) return el;
      el = el.parentElement;
    }
    return null;
  })();

  function clearMarks() {
    container.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  }

  function targetIndex(x, y) {
    const els = itemEls();
    let best = null;
    let bestDist = Infinity;
    els.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const d = Math.hypot(cx - x, cy - y);
      if (d < bestDist) {
        bestDist = d;
        best = { el, i, after: axis === 'y' ? y > cy : x > cx };
      }
    });
    return best;
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    const item = e.target.closest(items);
    if (!item || !container.contains(item)) return;
    if (e.target.closest('button, input, select, a, [contenteditable]')) return;
    drag = { item, from: itemEls().indexOf(item), x: e.clientX, y: e.clientY, started: false, pointerId: e.pointerId };
  }

  function start() {
    const r = drag.item.getBoundingClientRect();
    const ghost = drag.item.cloneNode(true);
    ghost.classList.add('sort-ghost');
    // Canvases do not clone their pixels; copy them over.
    const src = drag.item.querySelectorAll('canvas');
    ghost.querySelectorAll('canvas').forEach((c, i) => {
      c.width = src[i].width;
      c.height = src[i].height;
      c.getContext('2d').drawImage(src[i], 0, 0);
    });
    Object.assign(ghost.style, { width: `${r.width}px`, height: `${r.height}px`, left: `${r.left}px`, top: `${r.top}px` });
    document.body.append(ghost);
    drag.ghost = ghost;
    drag.dx = drag.x - r.left;
    drag.dy = drag.y - r.top;
    drag.item.classList.add('sort-source');
    drag.started = true;
    document.body.style.cursor = 'grabbing';
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
      start();
    }
    e.preventDefault();
    drag.ghost.style.left = `${e.clientX - drag.dx}px`;
    drag.ghost.style.top = `${e.clientY - drag.dy}px`;
    clearMarks();
    const t = targetIndex(e.clientX, e.clientY);
    if (t && t.el !== drag.item) t.el.classList.add(t.after ? 'drop-after' : 'drop-before');
    drag.target = t;
    autoScroll(e.clientY);
  }

  function autoScroll(y) {
    if (!scroller) return;
    const r = scroller.getBoundingClientRect();
    const edge = 60;
    if (y < r.top + edge) scroller.scrollTop -= Math.ceil((r.top + edge - y) / 4);
    else if (y > r.bottom - edge) scroller.scrollTop += Math.ceil((y - (r.bottom - edge)) / 4);
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    if (!d.started) return;
    d.ghost.remove();
    d.item.classList.remove('sort-source');
    document.body.style.cursor = '';
    clearMarks();
    const t = d.target;
    if (!t || t.el === d.item) return;
    let to = t.i + (t.after ? 1 : 0);
    if (d.from < to) to -= 1;
    if (to !== d.from) onMove(d.from, to);
  }

  container.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  return () => {
    container.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
  };
}

export function moveItem(arr, from, to) {
  const copy = arr.slice();
  const [x] = copy.splice(from, 1);
  copy.splice(to, 0, x);
  return copy;
}

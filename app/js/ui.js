// ui.js — pequenos construtores de interface (DOM puro) usados pelo Studio.
export const $ = s => document.querySelector(s);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k in e && k !== 'style' && k !== 'list') { try { e[k] = v; } catch { e.setAttribute(k, v); } }
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};
export const fmt = v => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
export function slider(label, min, max, step, value, onInput, { fmt: f = fmt } = {}) {
  const val = h('span', { class: 'val' }, f(value));
  const inp = h('input', { type: 'range', min, max, step, value });
  inp.addEventListener('input', () => { const v = +inp.value; val.textContent = f(v); onInput(v); });
  return h('div', { class: 'row' }, h('label', {}, label), inp, val);
}
export const check = (label, value, onChange) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!value, onchange: e => onChange(e.target.checked) }), ' ' + label);
export function select(options, value, onChange) {
  const s = h('select', {}, options.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) }, t)));
  s.addEventListener('change', () => onChange(s.value));
  return s;
}
let toastT;
export function toast(msg, ms = 2800) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms);
}

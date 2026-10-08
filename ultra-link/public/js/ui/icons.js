// Inline SVG icon set (24×24, stroke-based, built with the DOM — no innerHTML, no network).
import { s } from './dom.js';

const P = (d) => s('path', { d });
const C = (cx, cy, r, extra) => s('circle', { cx, cy, r, ...extra });

const ICONS = {
  mic: () => [s('rect', { x: 9, y: 2.5, width: 6, height: 11.5, rx: 3 }), P('M5 11a7 7 0 0 0 14 0'), P('M12 18v3.5'), P('M8.5 21.5h7')],
  send: () => [P('M21.5 2.5 10.6 13.4'), P('M21.5 2.5 14.6 21.5l-4-8.1-8.1-4z')],
  check: () => [P('M5 12.5l4.5 4.5L19 7.5')],
  plus: () => [P('M12 5.5v13'), P('M5.5 12h13')],
  minus: () => [P('M5.5 12h13')],
  question: () => [P('M9.2 9.2a2.9 2.9 0 0 1 5.6 1c0 2-2.8 2.4-2.8 4.3'), C(12, 18, 0.6, { fill: 'currentColor' })],
  info: () => [P('M12 11v6.5'), C(12, 7.4, 0.6, { fill: 'currentColor' })],
  close: () => [P('M6 6l12 12'), P('M18 6 6 18')],
  chevronRight: () => [P('M9 5.5l6.5 6.5L9 18.5')],
  chevronLeft: () => [P('M15 5.5 8.5 12l6.5 6.5')],
  chevronDown: () => [P('M6 9.5l6 6 6-6')],
  edit: () => [P('M4 20h4L19.2 8.8a2.4 2.4 0 0 0-3.4-3.4L4.6 16.6 4 20z'), P('M13.8 7.2l3 3')],
  pause: () => [P('M9 6v12'), P('M15 6v12')],
  play: () => [P('M8 5.5v13l10.5-6.5z')],
  phone: () => [P('M5.2 3.5h3.3l1.8 4.6-2.3 1.4a11.5 11.5 0 0 0 6.5 6.5l1.4-2.3 4.6 1.8v3.3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 3.2 5.7a2 2 0 0 1 2-2.2z')],
  bell: () => [P('M6 16.5V11a6 6 0 1 1 12 0v5.5l1.8 1.8H4.2z'), P('M10 20.5a2.1 2.1 0 0 0 4 0')],
  home: () => [P('M3.5 11 12 4l8.5 7'), P('M5.8 9.5V20h12.4V9.5'), P('M10 20v-5.5h4V20')],
  search: () => [C(11, 11, 6.5), P('M20 20l-4.4-4.4')],
  tag: () => [P('M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.6 8.6a1.4 1.4 0 0 1 0 2l-6.6 6.6a1.4 1.4 0 0 1-2 0z'), C(8, 8, 1.4)],
  link: () => [P('M10 14.2a4.2 4.2 0 0 0 6 0l3-3a4.2 4.2 0 0 0-6-6l-1.2 1.2'), P('M14 9.8a4.2 4.2 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1.2-1.2')],
  refresh: () => [P('M20.5 12a8.5 8.5 0 1 1-2.6-6.1L20.5 8.5'), P('M20.5 3.5v5h-5')],
  alert: () => [P('M12 3.8 21.2 20H2.8z'), P('M12 10v4.5'), C(12, 17.2, 0.6, { fill: 'currentColor' })],
  sparkle: () => [P('M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9-1.9 5.1-1.9-5.1L5 10.5l5.1-1.9z'), P('M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z')],
  flask: () => [P('M9 3.5h6'), P('M10 3.5v5.8L4.8 18.4A1.5 1.5 0 0 0 6.1 20.5h11.8a1.5 1.5 0 0 0 1.3-2.1L14 9.3V3.5'), P('M7.3 14.5h9.4')],
  user: () => [C(12, 8, 4), P('M4.5 20.5a7.5 7.5 0 0 1 15 0')],
  clock: () => [C(12, 12, 8.5), P('M12 7.5V12l3 2')],
  pin: () => [P('M12 21s-6.8-6-6.8-11.2a6.8 6.8 0 0 1 13.6 0C18.8 15 12 21 12 21z'), C(12, 9.8, 2.4)],
  money: () => [s('rect', { x: 2.8, y: 6, width: 18.4, height: 12, rx: 2 }), C(12, 12, 2.6), P('M6 9.5v.01'), P('M18 14.5v.01')],
  calendar: () => [s('rect', { x: 3.8, y: 5, width: 16.4, height: 15.5, rx: 2 }), P('M3.8 10h16.4'), P('M8.5 3v4'), P('M15.5 3v4')],
  grid: () => [s('rect', { x: 4, y: 4, width: 6.5, height: 6.5, rx: 1.5 }), s('rect', { x: 13.5, y: 4, width: 6.5, height: 6.5, rx: 1.5 }), s('rect', { x: 4, y: 13.5, width: 6.5, height: 6.5, rx: 1.5 }), s('rect', { x: 13.5, y: 13.5, width: 6.5, height: 6.5, rx: 1.5 })],
  swap: () => [P('M16.5 3.5 20 7l-3.5 3.5'), P('M4 7h16'), P('M7.5 13.5 4 17l3.5 3.5'), P('M20 17H4')],
  lock: () => [s('rect', { x: 5, y: 10.5, width: 14, height: 10, rx: 2 }), P('M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3')],
  hourglass: () => [P('M6.5 3.5h11'), P('M6.5 20.5h11'), P('M7.5 3.5c0 4.5 4.5 5.5 4.5 8.5s-4.5 4-4.5 8.5'), P('M16.5 3.5c0 4.5-4.5 5.5-4.5 8.5s4.5 4 4.5 8.5')],
  checkAll: () => [P('M2.5 12.5 6.5 16.5 15 8'), P('M11.5 15.5l1 1L21 8')],
  keyboard: () => [s('rect', { x: 2.8, y: 6, width: 18.4, height: 12, rx: 2 }), P('M7 10h.01M10.3 10h.01M13.7 10h.01M17 10h.01M8 14h8')],
  people: () => [C(9, 8.5, 3.3), P('M3 19.5a6 6 0 0 1 12 0'), P('M15.5 5.6a3.3 3.3 0 0 1 0 6'), P('M17.5 13.8a6 6 0 0 1 3.5 5.7')],
  inbox: () => [P('M3.5 13.5 6 5.5h12l2.5 8v5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z'), P('M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5')],
};

/**
 * icon(name, { size = 20, label, className }) → <svg>.
 * Decorative by default (aria-hidden). Pass `label` to expose it as an image with an accessible name.
 */
export function icon(name, { size = 20, label, className } = {}) {
  const make = ICONS[name] ?? ICONS.info;
  const attrs = {
    class: ['icon', `icon-${name}`, className],
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.9,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    focusable: 'false',
  };
  if (label) {
    attrs.role = 'img';
    attrs['aria-label'] = label;
  } else {
    attrs['aria-hidden'] = 'true';
  }
  return s('svg', attrs, make());
}

/** Brand mark: two linked rings (the "link" in ألترا لينك). */
export function logoMark({ size = 30 } = {}) {
  const gid = `ul-logo-g-${Math.random().toString(36).slice(2, 8)}`;
  return s('svg', { class: 'logo-mark', viewBox: '0 0 32 32', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
    s('defs', null,
      s('linearGradient', { id: gid, x1: 0, y1: 0, x2: 1, y2: 1 },
        s('stop', { offset: '0', 'stop-color': '#7af7e1' }),
        s('stop', { offset: '1', 'stop-color': '#8b7bff' }),
      ),
    ),
    s('circle', { cx: 12, cy: 16, r: 7.2, fill: 'none', stroke: `url(#${gid})`, 'stroke-width': 3 }),
    s('circle', { cx: 20, cy: 16, r: 7.2, fill: 'none', stroke: `url(#${gid})`, 'stroke-width': 3, opacity: 0.9 }),
    s('circle', { cx: 16, cy: 16, r: 1.9, fill: '#eef2ff' }),
  );
}

export const ICON_NAMES = Object.keys(ICONS);

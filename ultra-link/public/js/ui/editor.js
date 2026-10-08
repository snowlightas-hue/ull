// Intent editor: an accessible modal sheet (role=dialog, aria-modal, focus trap, Esc closes,
// background made inert, focus restored to the opener). Details appear only when needed: price and
// time sections stay collapsed behind "إضافة …" buttons until the intent has them or the user asks.
import { h, uid, focusableWithin } from './dom.js';
import { icon } from './icons.js';
import {
  ar, CURRENCY_AR, PRICE_UNIT_LABEL_AR, parseAmountToMinor, minorToInput, compareMinor,
} from './format.js';

export const DEAL_AR = {
  sale: 'بيع وشراء', rent: 'إيجار', service: 'خدمة', lesson: 'دروس', activity: 'نشاط مشترك', help: 'مساعدة',
};

const OP_AR = {
  lte: 'حتى (حدّ أعلى)', eq: 'بالضبط', gte: 'لا يقل عن', between: 'بين حدّين', approx: 'حوالي (تقريبي)',
};

let openCount = 0;

function selectField({ id, labelAr, options, value, onChange, hintAr }) {
  const select = h('select', { id, class: 'select' },
    options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value ?? '') }, o.labelAr)));
  if (options.some((o) => String(o.value) === String(value ?? ''))) select.value = String(value ?? '');
  if (onChange) select.addEventListener('change', onChange);
  return {
    el: h('div', { class: 'field' },
      h('label', { class: 'field-label', for: id }, labelAr),
      h('div', { class: 'select-wrap' }, select, h('span', { class: 'select-caret', 'aria-hidden': 'true' }, icon('chevronDown', { size: 18 }))),
      hintAr ? h('p', { class: 'field-hint' }, hintAr) : null),
    input: select,
  };
}

function textField({ id, labelAr, value = '', placeholder = '', inputmode, type = 'text', dir, hintAr }) {
  const errId = `${id}-err`;
  const input = h('input', { id, type, class: 'input', value, placeholder, inputmode, dir, autocomplete: 'off', 'aria-describedby': errId });
  const err = h('p', { class: 'field-error', id: errId, hidden: true });
  return {
    el: h('div', { class: 'field' }, h('label', { class: 'field-label', for: id }, labelAr), input,
      hintAr ? h('p', { class: 'field-hint' }, hintAr) : null, err),
    input,
    setError(msg) {
      err.textContent = msg || '';
      err.hidden = !msg;
      if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    },
  };
}

/** Segmented radio group for required / preferred. */
function strengthToggle({ name, value = 'required', labels }) {
  const radios = {};
  const el = h('fieldset', { class: 'seg-field' },
    h('legend', { class: 'field-label' }, 'مدى الإلزام'),
    h('div', { class: 'seg' }, ['required', 'preferred'].map((v) => {
      radios[v] = h('input', { type: 'radio', name, value: v, checked: v === value });
      return h('label', null, radios[v], h('span', null, labels[v]));
    })));
  return {
    el,
    get value() { return radios.required.checked ? 'required' : 'preferred'; },
    set value(v) { radios[v === 'preferred' ? 'preferred' : 'required'].checked = true; },
    lockPreferred(lock) {
      radios.required.disabled = lock;
      if (lock) radios.preferred.checked = true;
    },
  };
}

function isoToDateInput(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dateInputToIso(value, addDays = 0) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + addDays).toISOString();
}

/**
 * openIntentEditor(intent, { onSave(changes) → Promise|void, onCancel(), choices? }) → { el, close() }
 *
 * `intent` is an IntentCard, optionally extended with:
 *   spec?:    IntentSpec — structured values used to prefill the fields
 *   choices?: { categories?: {code, labelAr, deals?: DealCode[]}[], places?: {id, labelAr}[] }
 * `changes` passed to onSave is a Partial<IntentSpec> holding only the sections the user changed:
 *   categoryCode, deal, place, price (PriceSpec | null to remove), when (TimeWindow | null to remove).
 * If onSave returns a promise the sheet shows a saving state, closes on resolve and shows
 * `error.messageAr` (or a generic Arabic message) on reject.
 */
export function openIntentEditor(intent, { onSave, onCancel, choices: choicesArg } = {}) {
  const card = intent || {};
  const spec = card.spec || null;
  const choices = choicesArg || card.choices || {};
  const side = spec?.side || card.side || 'seek';
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const titleId = uid('ed-title');
  const descId = uid('ed-desc');
  const dirty = { category: false, deal: false, place: false, price: false, when: false };
  const mark = (k) => () => { dirty[k] = true; };

  // ── What ──
  let categoryField = null;
  let cats = Array.isArray(choices.categories) ? choices.categories : null;
  // the server refuses moving an intent to another vertical, so only offer siblings of the current one
  const currentCat = cats?.find((c) => c.code === spec?.categoryCode);
  if (cats && currentCat?.vertical) cats = cats.filter((c) => c.vertical === currentCat.vertical);
  if (cats && cats.length) {
    categoryField = selectField({
      id: uid('ed-cat'), labelAr: 'النوع', value: spec?.categoryCode,
      options: [...(spec?.categoryCode ? [] : [{ value: '', labelAr: card.categoryAr ? `${ar(card.categoryAr)} (الحالي)` : 'اختر النوع' }]),
        ...cats.map((c) => ({ value: c.code, labelAr: ar(c.labelAr) }))],
      onChange: () => { dirty.category = true; refreshDeals(); },
    });
  }
  const dealOptions = () => {
    const cat = cats?.find((c) => c.code === categoryField?.input.value);
    const codes = Array.isArray(cat?.deals) && cat.deals.length ? cat.deals : Object.keys(DEAL_AR);
    return codes.map((c) => ({ value: c, labelAr: DEAL_AR[c] ?? c }));
  };
  const dealField = selectField({ id: uid('ed-deal'), labelAr: 'نوع الصفقة', value: spec?.deal, options: dealOptions(), onChange: mark('deal') });
  if (!spec?.deal && card.dealAr) {
    const match = Object.entries(DEAL_AR).find(([, v]) => v === card.dealAr);
    if (match) dealField.input.value = match[0];
  }
  function refreshDeals() {
    const prev = dealField.input.value;
    dealField.input.replaceChildren(...dealOptions().map((o) => h('option', { value: o.value, selected: o.value === prev }, o.labelAr)));
  }

  const whatSection = h('fieldset', { class: 'ed-section' },
    h('legend', { class: 'ed-legend' }, icon('grid', { size: 18 }), 'ماذا؟'),
    categoryField ? categoryField.el : h('div', { class: 'field' },
      h('p', { class: 'field-label' }, 'النوع'),
      h('p', { class: 'ed-readonly' }, ar(card.categoryAr || 'غير محدد')),
      h('p', { class: 'field-hint' }, 'لتغيير النوع، قل طلبًا جديدًا بصوتك.')),
    dealField.el);

  // ── Where ──
  let placeField = null;
  const places = Array.isArray(choices.places) ? choices.places : null;
  const currentPlaceId = spec?.place?.scopePlaceIds?.[0] ?? spec?.place?.pointPlaceId ?? null;
  if (places && places.length) {
    placeField = selectField({
      id: uid('ed-place'), labelAr: 'المكان', value: currentPlaceId ?? '',
      options: [...(currentPlaceId === null ? [{ value: '', labelAr: card.placeAr ? `${ar(card.placeAr)} (الحالي)` : 'غير محدد' }] : []),
        ...places.map((p) => ({ value: String(p.id), labelAr: ar(p.labelAr) }))],
      onChange: mark('place'),
    });
  }
  const placeStrength = strengthToggle({
    name: uid('ed-pstr'), value: spec?.place?.scopeStrength || 'required',
    labels: { required: 'هذا المكان فقط', preferred: 'يُفضَّل، وغيره مقبول' },
  });
  placeStrength.el.addEventListener('change', mark('place'));
  const whereSection = h('fieldset', { class: 'ed-section' },
    h('legend', { class: 'ed-legend' }, icon('pin', { size: 18 }), 'أين؟'),
    placeField ? placeField.el : h('div', { class: 'field' },
      h('p', { class: 'field-label' }, 'المكان'),
      h('p', { class: 'ed-readonly' }, ar(card.placeAr || 'غير محدد'))),
    placeStrength.el);

  // ── Price (only when needed) ──
  const price = spec?.price || null;
  const hasPrice = !!(price || card.priceAr);
  const opsForSide = side === 'provide' ? ['eq', 'approx'] : ['lte', 'eq', 'gte', 'between', 'approx'];
  const opField = selectField({
    id: uid('ed-op'), labelAr: side === 'provide' ? 'السعر المطلوب' : 'شرط السعر',
    value: price?.op || (side === 'provide' ? 'eq' : 'lte'),
    options: opsForSide.map((o) => ({ value: o, labelAr: OP_AR[o] })),
    onChange: () => { dirty.price = true; syncOp(); },
  });
  const firstAmount = price ? (price.op === 'lte' ? price.hi : price.lo ?? price.hi) : null;
  const amount = textField({
    id: uid('ed-amt'), labelAr: 'المبلغ', value: firstAmount ? minorToInput(firstAmount, price.currency || 'USD') : '',
    placeholder: card.priceAr && !price ? `الحالي: ${ar(card.priceAr)}` : 'مثلًا ٢٠٠', inputmode: 'decimal',
  });
  const amount2 = textField({
    id: uid('ed-amt2'), labelAr: 'إلى', value: price?.op === 'between' && price.hi ? minorToInput(price.hi, price.currency || 'USD') : '',
    placeholder: 'مثلًا ٣٠٠', inputmode: 'decimal',
  });
  const currencyField = selectField({
    id: uid('ed-cur'), labelAr: 'العملة', value: price?.currency || '',
    options: [{ value: '', labelAr: 'غير محددة' }, ...Object.entries(CURRENCY_AR).map(([k, v]) => ({ value: k, labelAr: v }))],
    onChange: mark('price'),
  });
  const unitField = selectField({
    id: uid('ed-unit'), labelAr: 'يُدفع', value: price?.unit || '',
    options: [{ value: '', labelAr: 'غير محدد' }, ...Object.entries(PRICE_UNIT_LABEL_AR).map(([k, v]) => ({ value: k, labelAr: v }))],
    onChange: mark('price'),
  });
  const priceStrength = strengthToggle({
    name: uid('ed-prstr'), value: price?.strength || 'required',
    labels: { required: 'شرط أساسي', preferred: 'تفضيل' },
  });
  priceStrength.el.addEventListener('change', mark('price'));
  amount.input.addEventListener('input', () => { dirty.price = true; amount.setError(''); });
  amount2.input.addEventListener('input', () => { dirty.price = true; amount2.setError(''); });
  function syncOp() {
    const op = opField.input.value;
    amount2.el.hidden = op !== 'between';
    amount.el.querySelector('label').textContent = op === 'between' ? 'من' : 'المبلغ';
    priceStrength.lockPreferred(op === 'approx');
  }
  syncOp();
  const priceFields = h('div', { class: 'ed-fields', hidden: !hasPrice },
    opField.el,
    h('div', { class: 'field-row' }, amount.el, amount2.el),
    h('div', { class: 'field-row' }, currencyField.el, unitField.el),
    priceStrength.el,
    h('button', { type: 'button', class: 'link-btn ed-remove', onClick: () => removeSection('price') }, icon('close', { size: 16 }), 'إزالة السعر'));
  const addPriceBtn = h('button', { type: 'button', class: 'btn btn-sm ed-add', hidden: hasPrice, onClick: () => revealSection('price') },
    icon('plus', { size: 16 }), 'إضافة سعر');
  let priceRemoved = false;
  const priceSection = h('fieldset', { class: 'ed-section' },
    h('legend', { class: 'ed-legend' }, icon('money', { size: 18 }), 'كم؟'),
    addPriceBtn, priceFields);

  // ── When (only when needed) ──
  const when = spec?.when || null;
  const hasWhen = !!(when || card.whenAr);
  const whenLabel = textField({ id: uid('ed-wl'), labelAr: 'وصف الموعد', value: when?.label ? ar(when.label) : '', placeholder: card.whenAr ? `الحالي: ${ar(card.whenAr)}` : 'مثلًا: يوم الجمعة' });
  const whenFrom = textField({ id: uid('ed-wf'), labelAr: 'من تاريخ', type: 'date', value: isoToDateInput(when?.from) });
  const whenTo = textField({ id: uid('ed-wt'), labelAr: 'إلى تاريخ', type: 'date', value: when?.to ? isoToDateInput(new Date(Date.parse(when.to) - 1).toISOString()) : '' });
  const whenStrength = strengthToggle({ name: uid('ed-wstr'), value: when?.strength || 'preferred', labels: { required: 'شرط أساسي', preferred: 'تفضيل' } });
  for (const f of [whenLabel, whenFrom, whenTo]) f.input.addEventListener('input', () => { dirty.when = true; f.setError(''); });
  whenStrength.el.addEventListener('change', mark('when'));
  const whenFields = h('div', { class: 'ed-fields', hidden: !hasWhen },
    whenLabel.el,
    h('div', { class: 'field-row' }, whenFrom.el, whenTo.el),
    whenStrength.el,
    h('button', { type: 'button', class: 'link-btn ed-remove', onClick: () => removeSection('when') }, icon('close', { size: 16 }), 'إزالة الموعد'));
  const addWhenBtn = h('button', { type: 'button', class: 'btn btn-sm ed-add', hidden: hasWhen, onClick: () => revealSection('when') },
    icon('plus', { size: 16 }), 'إضافة موعد');
  let whenRemoved = false;
  const whenSection = h('fieldset', { class: 'ed-section' },
    h('legend', { class: 'ed-legend' }, icon('calendar', { size: 18 }), 'متى؟'),
    addWhenBtn, whenFields);

  function revealSection(which) {
    const [fields, btn, first] = which === 'price' ? [priceFields, addPriceBtn, amount.input] : [whenFields, addWhenBtn, whenLabel.input];
    fields.hidden = false;
    btn.hidden = true;
    if (which === 'price') priceRemoved = false; else whenRemoved = false;
    first.focus();
  }
  function removeSection(which) {
    const [fields, btn] = which === 'price' ? [priceFields, addPriceBtn] : [whenFields, addWhenBtn];
    fields.hidden = true;
    btn.hidden = false;
    dirty[which] = true;
    if (which === 'price') priceRemoved = true; else whenRemoved = true;
    btn.focus();
  }

  // ── Frame ──
  const formError = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, icon('check', { size: 18 }), 'حفظ التعديلات');
  const cancelBtn = h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => cancel() }, 'إلغاء');
  const closeX = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'إغلاق', onClick: () => cancel() }, icon('close', { size: 20 }));
  const form = h('form', { class: 'editor-form', novalidate: true },
    whatSection, whereSection, priceSection, whenSection, formError,
    h('footer', { class: 'sheet-foot' }, saveBtn, cancelBtn));

  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': descId },
    h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
    h('header', { class: 'sheet-head' },
      h('h2', { class: 'sheet-title', id: titleId }, side === 'provide' ? 'تعديل العرض' : 'تعديل الطلب'),
      closeX),
    h('p', { class: 'sheet-sub', id: descId }, ar(card.titleAr || ''), ' — ', 'غيّر ما تريد فقط، والباقي يبقى كما هو.'),
    form);
  const backdrop = h('div', { class: 'sheet-backdrop' }, sheet);

  // ── Modal mechanics ──
  const inerted = [];
  for (const child of Array.from(document.body.children)) {
    if (child.classList.contains('toast-region') || child.inert) continue;
    child.inert = true;
    inerted.push(child);
  }
  document.documentElement.classList.add('ul-modal-open');
  openCount += 1;
  document.body.append(backdrop);

  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) cancel(); });
  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusableWithin(sheet);
    if (items.length === 0) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !sheet.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !sheet.contains(document.activeElement))) {
      e.preventDefault();
      first.focus();
    }
  });

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    const finish = () => {
      backdrop.remove();
      for (const el of inerted) el.inert = false;
      openCount -= 1;
      if (openCount <= 0) document.documentElement.classList.remove('ul-modal-open');
      if (opener && opener.isConnected) opener.focus();
    };
    backdrop.dataset.closing = 'true';
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { finish(); return; }
    let done = false;
    const once = () => { if (!done) { done = true; finish(); } };
    sheet.addEventListener('animationend', once, { once: true });
    setTimeout(once, 260);
  }
  function cancel() {
    if (closed) return;
    close();
    if (typeof onCancel === 'function') onCancel();
  }

  function collect() {
    let ok = true;
    const changes = {};
    if (dirty.category && categoryField?.input.value) changes.categoryCode = categoryField.input.value;
    if (dirty.deal || (dirty.category && dealField.input.value !== spec?.deal)) changes.deal = dealField.input.value;
    if (dirty.place) {
      const base = spec?.place || { pointPlaceId: null, scopePlaceIds: [], scopeStrength: 'required' };
      const pid = placeField?.input.value;
      changes.place = {
        ...base,
        scopePlaceIds: pid ? [Number(pid)] : base.scopePlaceIds,
        scopeStrength: placeStrength.value,
      };
    }
    if (dirty.price) {
      if (priceRemoved) changes.price = null;
      else {
        const op = opField.input.value;
        const currency = currencyField.input.value || null;
        const a = parseAmountToMinor(amount.input.value, currency || 'USD');
        if (a === null) { amount.setError('اكتب مبلغًا صحيحًا، مثل ٢٠٠ أو ١٥٠٫٥'); ok = false; }
        let b = null;
        if (op === 'between') {
          b = parseAmountToMinor(amount2.input.value, currency || 'USD');
          if (b === null) { amount2.setError('اكتب الحدّ الأعلى'); ok = false; }
          else if (a !== null && compareMinor(a, b) > 0) { amount2.setError('الحدّ الأعلى يجب أن يكون أكبر من الأدنى'); ok = false; }
        }
        if (ok) {
          const lohi = {
            eq: [a, a], approx: [a, a], lte: [null, a], gte: [a, null], between: [a, b],
          }[op] || [a, a];
          changes.price = {
            ...(price || {}),
            op,
            lo: lohi[0],
            hi: lohi[1],
            currency,
            unit: unitField.input.value || null,
            strength: op === 'approx' ? 'preferred' : priceStrength.value,
          };
          delete changes.price.evidence;
        }
      }
    }
    if (dirty.when) {
      if (whenRemoved) changes.when = null;
      else {
        const from = dateInputToIso(whenFrom.input.value);
        const toDay = whenTo.input.value || whenFrom.input.value;
        const to = dateInputToIso(toDay, 1); // half-open window [from, to)
        if (!from) { whenFrom.setError('اختر تاريخ البداية'); ok = false; }
        else if (!to || Date.parse(to) <= Date.parse(from)) { whenTo.setError('تاريخ النهاية يجب أن يكون بعد البداية'); ok = false; }
        if (ok) {
          const label = whenLabel.input.value.trim();
          changes.when = { from, to, strength: whenStrength.value, ...(label ? { label } : {}) };
        }
      }
    }
    return ok ? changes : null;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    formError.hidden = true;
    const changes = collect();
    if (!changes) {
      sheet.querySelector('[aria-invalid="true"]')?.focus();
      return;
    }
    if (Object.keys(changes).length === 0) { cancel(); return; }
    const res = typeof onSave === 'function' ? onSave(changes) : undefined;
    if (res && typeof res.then === 'function') {
      saveBtn.disabled = true;
      saveBtn.setAttribute('aria-busy', 'true');
      const prev = Array.from(saveBtn.childNodes);
      saveBtn.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'جارٍ الحفظ…');
      res.then(() => close(), (err) => {
        saveBtn.disabled = false;
        saveBtn.removeAttribute('aria-busy');
        saveBtn.replaceChildren(...prev);
        formError.textContent = ar(err?.messageAr || 'تعذّر حفظ التعديلات. حاول مرة أخرى.');
        formError.hidden = false;
      });
    } else {
      close();
    }
  });

  // initial focus: first form control
  requestAnimationFrame(() => {
    const first = focusableWithin(form)[0] || closeX;
    first.focus();
  });

  return { el: sheet, close };
}

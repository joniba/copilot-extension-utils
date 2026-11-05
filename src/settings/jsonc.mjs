import { applyEdits, getNodeValue, modify, parseTree } from 'jsonc-parser';

function document(text) {
  if (typeof text !== 'string') throw new TypeError('Settings document must be text.');
  const bom = text.startsWith('\ufeff') ? '\ufeff' : '';
  const raw = text.slice(bom.length);
  const errors = [];
  const tree = parseTree(raw, errors, { allowTrailingComma: true });
  if (errors.length || tree?.type !== 'object') throw new SyntaxError('Settings must be a valid JSONC object.');
  function check(node) {
    if (node.type === 'object') {
      const names = new Set();
      for (const property of node.children) {
        const key = property.children[0].value;
        if (names.has(key)) throw new SyntaxError('Duplicate settings properties are ambiguous.');
        names.add(key);
        check(property.children[1]);
      }
    } else if (node.type === 'array') {
      for (const child of node.children) check(child);
    }
  }
  check(tree);
  return { bom, raw, tree };
}

function validateValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || ancestors.has(value) || ancestors.size >= 64
    || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) {
    throw new TypeError('Setting value must be finite, acyclic JSON data.');
  }
  ancestors.add(value);
  for (const child of Object.values(value)) validateValue(child, ancestors);
  ancestors.delete(value);
}

export function parseSettings(text) {
  return getNodeValue(document(text).tree);
}

export function patchSettings(text, edits) {
  if (!Array.isArray(edits)) throw new TypeError('Settings edits must be an array.');
  let { bom, raw } = document(text);
  const indent = /^([ \t]+)"/m.exec(raw)?.[1] ?? '  ';
  const formattingOptions = {
    insertSpaces: !indent.includes('\t'), tabSize: indent.length,
    eol: raw.includes('\r\n') ? '\r\n' : '\n',
  };
  for (const edit of edits) {
    if (!edit || !Array.isArray(edit.path) || edit.path.length === 0
      || edit.path.some(key => typeof key !== 'string' || !key || ['__proto__', 'prototype', 'constructor'].includes(key))) {
      throw new TypeError('Setting paths must contain nonempty, safe object-property names.');
    }
    validateValue(edit.value);
    let parent = parseSettings(raw);
    for (const key of edit.path.slice(0, -1)) {
      if (!Object.hasOwn(parent, key)) break;
      parent = parent[key];
      if (!parent || typeof parent !== 'object' || Array.isArray(parent)) {
        throw new TypeError('Cannot traverse a non-object setting.');
      }
    }
    raw = applyEdits(raw, modify(raw, edit.path, edit.value, { formattingOptions }));
  }
  return { text: bom + raw, value: parseSettings(raw) };
}

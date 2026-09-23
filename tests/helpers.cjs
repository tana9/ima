const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = name => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
const script = name => source(name).match(/<script>([\s\S]*?)<\/script>/)[1];

function element(id = '') {
  const listeners = {};
  const fields = {};
  return {
    id, value: '', files: [], style: {}, disabled: false, hidden: false, textContent: '',
    classList: { add() {}, remove() {}, toggle() {} },
    set innerHTML(value) {
      this.html = value;
      for (const key of Object.keys(fields)) delete fields[key];
      for (const match of value.matchAll(/class="([^"]+)"/g)) {
        const node = element();
        for (const name of match[1].split(' ')) fields['.' + name] = node;
      }
    },
    get innerHTML() { return this.html || ''; },
    querySelector(selector) { return fields[selector] || null; },
    addEventListener(type, callback) { (listeners[type] ||= []).push(callback); },
    removeEventListener(type, callback) { listeners[type] = (listeners[type] || []).filter(fn => fn !== callback); },
    async emit(type, event = {}) {
      for (const callback of listeners[type] || []) await callback({ target: this, ...event });
    },
    appendChild() {}, closest() { return null; }, setAttribute() {},
    reportValidity() { return true; }, focus() {}, scrollIntoView() {}
  };
}

function client(now = new Date(2026, 8, 23, 12).getTime()) {
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const fields = {};
  for (const match of source('Index.html').matchAll(/id="([^"]+)"/g)) fields[match[1]] = element(match[1]);
  const result = { calls: [], messages: [] };
  const handlers = {
    finishActivity: end => { result.end = end; return { active: false }; },
    getDashboard: () => ({ status: { active: false }, events: [], titles: [] })
  };
  function runner(success, failure) {
    return new Proxy({}, { get(_, key) {
      if (key === 'withSuccessHandler') return fn => runner(fn, failure);
      if (key === 'withFailureHandler') return fn => runner(success, fn);
      return (...args) => {
        result.calls.push({ method: key, args });
        Promise.resolve().then(() => {
          if (!handlers[key]) throw new Error('Unexpected API: ' + key);
          return handlers[key](...args);
        }).then(success, failure);
      };
    } });
  }
  const document = {
    getElementById: id => fields[id],
    querySelectorAll: () => Object.values(fields),
    querySelector: () => element(),
    createElement: () => element(),
    body: element()
  };
  const context = vm.createContext({ Date: FixedDate, document,
    google: { script: { run: runner() } },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}
  });
  for (const name of ['DateTime', 'Api', 'State', 'App']) {
    vm.runInContext(script(name + '.html').replace(/\binit\(\);\s*$/, ''), context, { filename: name });
  }
  context.appState.status = { active: false };
  context.showMessage = (message, error) => result.messages.push({ message, error });
  context.showConfirm = async message => { result.confirmation = message; return true; };
  return { context, input: fields.finishTimeInput, fields, handlers, result };
}

module.exports = { source, script, client, element };

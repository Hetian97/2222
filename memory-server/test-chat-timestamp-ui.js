const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const loaderSource = fs.readFileSync(path.join(__dirname, '..', 'modules', 'ui-loaders.js'), 'utf8');
const timeZoneSource = fs.readFileSync(path.join(__dirname, '..', 'time-zone-utils.js'), 'utf8');
const bindingsSource = fs.readFileSync(path.join(__dirname, '..', 'modules', 'init-event-bindingsB.js'), 'utf8');
const chatSource = fs.readFileSync(path.join(__dirname, '..', 'modules', 'chat-interface.js'), 'utf8');

assert(loaderSource.includes("wrapper.dataset.systemTimestamp = 'true'"));
assert(loaderSource.includes("wrapper.dataset.forTimestamp = String(timestamp || '')"));
assert(bindingsSource.includes("document.querySelectorAll('#chat-messages [data-system-timestamp=\"true\"]')"));
assert(bindingsSource.includes('await renderChatInterface(state.activeChatId)'));
assert(chatSource.includes('messagesContainer.innerHTML ='));
assert(chatSource.includes('msg.timestamp - lastTimestamp > 600000'));
assert(chatSource.includes('TimeZoneUtils?.stampMessage(msg'));

const sandbox = {
  window: {},
  state: { chats: {}, globalSettings: {} },
  document: { getElementById: () => ({ textContent: '' }), createElement: () => ({ dataset: {}, appendChild() {} }) },
  console
};
vm.runInNewContext(timeZoneSource, sandbox, { filename: 'time-zone-utils.js' });
vm.runInNewContext(loaderSource, sandbox, { filename: 'ui-loaders.js' });

const zone = 'Asia/Shanghai';
const now = Date.now();
assert.match(sandbox.window.formatSystemTimestamp(now, zone), /^\d{2}:\d{2}$/);
assert.match(sandbox.window.formatSystemTimestamp(now - 86400000, zone), /^昨天 \d{2}:\d{2}$/);
assert.match(sandbox.window.formatSystemTimestamp(now - 2 * 86400000, zone), /^\d{2}月\d{2}日 \d{2}:\d{2}$/);

console.log('Chat timestamp UI tests passed');

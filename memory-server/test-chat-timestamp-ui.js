const assert = require('assert');
const fs = require('fs');
const path = require('path');

const loaderSource = fs.readFileSync(path.join(__dirname, '..', 'modules', 'ui-loaders.js'), 'utf8');
const bindingsSource = fs.readFileSync(path.join(__dirname, '..', 'modules', 'init-event-bindingsB.js'), 'utf8');
const chatSource = fs.readFileSync(path.join(__dirname, '..', 'modules', 'chat-interface.js'), 'utf8');

assert(loaderSource.includes("wrapper.dataset.systemTimestamp = 'true'"));
assert(loaderSource.includes("wrapper.dataset.forTimestamp = String(timestamp || '')"));
assert(bindingsSource.includes("document.querySelectorAll('#chat-messages [data-system-timestamp=\"true\"]')"));
assert(bindingsSource.includes('await renderChatInterface(state.activeChatId)'));
assert(chatSource.includes('messagesContainer.innerHTML ='));
assert(chatSource.includes('msg.timestamp - lastTimestamp > 600000'));

console.log('Chat timestamp UI tests passed');

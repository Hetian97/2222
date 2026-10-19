/* Regex execution is interruptible; this worker never accesses application storage. */
importScripts('rendering-rule-engine.js' + self.location.search);
self.onmessage = event => {
  const { id, input, rules, chatId, meta, stage, preview } = event.data;
  try {
    const result = self.RenderingRuleEngine.run(input, rules, chatId, meta, stage, preview, index => self.postMessage({ id, running: index }));
    self.postMessage({ id, result });
  } catch (error) { self.postMessage({ id, error: error.message }); }
};

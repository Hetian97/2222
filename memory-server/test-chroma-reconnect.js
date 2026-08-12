const assert = require('assert');
const {
  isRetryableChromaConnectionError,
  withChromaReconnect
} = require('./chroma-client');

async function main() {
  assert.equal(isRetryableChromaConnectionError(new Error('fetch failed: ECONNREFUSED')), true);
  assert.equal(isRetryableChromaConnectionError(new Error('socket was closed')), true);
  assert.equal(isRetryableChromaConnectionError(new Error('embedding dimension mismatch')), false);

  let reconnectAttempts = 0;
  const recovered = await withChromaReconnect('test-query', async () => {
    reconnectAttempts++;
    if (reconnectAttempts === 1) throw new Error('fetch failed: connection reset');
    return 'recovered';
  }, { retryDelayMs: 0 });

  assert.equal(recovered, 'recovered');
  assert.equal(reconnectAttempts, 2);

  let validationAttempts = 0;
  await assert.rejects(
    withChromaReconnect('test-validation', async () => {
      validationAttempts++;
      throw new Error('embedding dimension mismatch');
    }, { retryDelayMs: 0 }),
    /dimension mismatch/
  );
  assert.equal(validationAttempts, 1);

  let failedRetryAttempts = 0;
  await assert.rejects(
    withChromaReconnect('test-down', async () => {
      failedRetryAttempts++;
      throw new Error('service unavailable 503');
    }, { retryDelayMs: 0 }),
    /unavailable/
  );
  assert.equal(failedRetryAttempts, 2);

  console.log('Chroma reconnect tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

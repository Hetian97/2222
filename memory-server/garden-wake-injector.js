async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (
    envelope?.version !== 1 ||
    envelope?.type !== 'garden_wake' ||
    typeof envelope.reason !== 'string' ||
    !envelope.reason.trim() ||
    typeof envelope.message !== 'string' ||
    !envelope.message.trim()
  ) {
    throw new Error('Invalid Garden wake envelope.');
  }

  const endpoint = String(
    process.env.EPHONE_GARDEN_WAKE_ENDPOINT ||
    'http://127.0.0.1:8765/garden-wake/events'
  ).trim();
  const token = String(process.env.EPHONE_GARDEN_WAKE_API_TOKEN || '').trim();

  if (!token) {
    throw new Error('EPHONE_GARDEN_WAKE_API_TOKEN is required.');
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: token.toLowerCase().startsWith('bearer ') ? token : `Bearer ${token}`
    },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(15000)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(data.error || `EPhone wake queue HTTP ${response.status}`);
  }

  process.stdout.write(JSON.stringify({ ok: true, eventId: data.eventId }) + '\n');
}

main().catch(error => {
  process.stderr.write((error.message || String(error)) + '\n');
  process.exitCode = 1;
});

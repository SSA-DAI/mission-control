// KESULTANAN-FIX-002 live verification: abort → verify on a REAL gateway run.
//
// Reproduces the MRN-106 double-builder scenario end-to-end against a live
// OpenClaw gateway:
//   1. create a scratch MC-managed session key,
//   2. send a long-running prompt (exec sleep keeps the turn active cheaply),
//   3. wait until the gateway reports hasActiveRun,
//   4. run the MC abort path (abortAndVerifySessionIdle — the exact function
//      the dispatch rotation uses before creating the fresh session),
//   5. assert the run is gone (status killed/done, hasActiveRun=false).
//
// Exit 0 = acceptance proven live. Requires OPENCLAW_GATEWAY_URL (or
// ws://127.0.0.1:18789) + OPENCLAW_GATEWAY_TOKEN. Run with tsx:
//   npx tsx scripts/ks2-live-abort-verify.mts
import clientMod from '../src/lib/openclaw/client';
import abortMod from '../src/lib/session-abort';

const cmod = (clientMod as any).default ?? clientMod;
const ClientCtor = typeof cmod === 'function' ? cmod : (clientMod as any).OpenClawClient;
const amod = (abortMod as any).default ?? abortMod;
const { abortAndVerifySessionIdle } = amod;

const client = new ClientCtor(
  process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789',
  process.env.OPENCLAW_GATEWAY_TOKEN || ''
);
await client.connect();
console.log('[ks2] connected to gateway');

const KEY = `agent:builder:mission-control-abort-e2e-${Date.now()}`;
console.log('[ks2] scratch session key:', KEY);

await client.call('chat.send', {
  sessionKey: KEY,
  message: 'Run this exact shell command and reply with only the exit code: `sleep 150`. Do not interrupt it.',
  idempotencyKey: `ks2-e2e-${Date.now()}`,
});
console.log('[ks2] long-running prompt sent; waiting for the turn to become active...');

let active = false;
for (let i = 0; i < 20 && !active; i++) {
  await new Promise(r => setTimeout(r, 1500));
  const sessions = await client.listSessions();
  const row = (sessions as any[]).find(s => s.key === KEY || s.sessionId === KEY);
  if (row && (row.hasActiveRun || row.status === 'running')) {
    active = true;
    console.log('[ks2] run ACTIVE:', JSON.stringify({ status: row.status, hasActiveRun: row.hasActiveRun, activeRunIds: row.activeRunIds }));
  }
}
if (!active) {
  console.error('[ks2] FAIL: run never became active');
  client.disconnect();
  process.exit(2);
}

const result = await abortAndVerifySessionIdle({
  client,
  sessionKey: KEY,
  timeoutMs: 15_000,
  verifyIntervalMs: 1_000,
  forceWs: true,
});
console.log('[ks2] abort result:', JSON.stringify(result));

const sessions = await client.listSessions();
const row = (sessions as any[]).find(s => s.key === KEY || s.sessionId === KEY);
console.log('[ks2] final row:', JSON.stringify(row ? { status: row.status, hasActiveRun: row.hasActiveRun, abortedLastRun: row.abortedLastRun } : null));

const pass =
  result.ok === true &&
  result.aborted === true &&
  result.verifiedIdle === true &&
  row &&
  row.hasActiveRun === false;

client.disconnect();
if (pass) {
  console.log('[ks2] PASS: active turn aborted and verified idle on the gateway — no second run can double-execute.');
  process.exit(0);
}
console.error('[ks2] FAIL: abort/verify did not confirm an idle old session');
process.exit(1);

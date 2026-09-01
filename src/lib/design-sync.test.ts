import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

type Db = typeof import('@/lib/db');
type DesignSync = typeof import('@/lib/design-sync');

let db: Db;
let ds: DesignSync;

const TEST_DB = `.tmp/design-sync-${process.pid}.db`;

before(async () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(TEST_DB + suffix, { force: true }); } catch { /* noop */ }
  }
  process.env.DATABASE_PATH = TEST_DB;
  db = await import('@/lib/db');
  ds = await import('@/lib/design-sync');
});

describe('design-sync (AWANFLEET Open Design)', () => {
  test('sync state machine transitions are valid', () => {
    assert.deepEqual(ds.DESIGN_SYNC_STATES, [
      'NO_DESIGN', 'DRAFT', 'DESIGN_READY', 'IMPLEMENTATION_PENDING', 'IMPLEMENTING',
      'TESTING', 'REVIEWING', 'SYNCED', 'DESIGN_DRIFT', 'BLOCKED',
    ]);
  });

  test('computeDesignSyncState invariant: authority==implemented==deployed → SYNCED', () => {
    assert.equal(ds.computeDesignSyncState({ authorityVersion: 'v1', implementedVersion: 'v1', developmentDeployment: 'dev-app' }), 'SYNCED');
  });

  test('computeDesignSyncState: no authority → NO_DESIGN', () => {
    assert.equal(ds.computeDesignSyncState({ authorityVersion: null, implementedVersion: null, developmentDeployment: null }), 'NO_DESIGN');
  });

  test('computeDesignSyncState: authority advanced beyond impl → DESIGN_DRIFT', () => {
    assert.equal(ds.computeDesignSyncState({ authorityVersion: 'v2', implementedVersion: 'v1', developmentDeployment: 'dev-app' }), 'DESIGN_DRIFT');
  });

  test('computeDesignSyncState: design ready but not implemented → DESIGN_READY', () => {
    assert.equal(ds.computeDesignSyncState({ authorityVersion: 'v1', implementedVersion: null, developmentDeployment: null }), 'DESIGN_READY');
  });

  test('transitionDesignSyncState throws when not bound', () => {
    assert.throws(() => ds.transitionDesignSyncState('ws-nope', 'DRAFT'), /OPEN_DESIGN_PROJECT_NOT_BOUND/);
  });

  test('concurrency defaults per work item §18', () => {
    assert.equal(ds.DESIGN_CONCURRENCY.globalMax, 10);
    assert.equal(ds.DESIGN_CONCURRENCY.perProjectMutating, 1);
  });

  test('acquireDesignJobSlot allows first job, blocks per-project second mutating', () => {
    const dbh = db.getDb();
    dbh.prepare(`INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES ('ws-a', 'WS A', 'ws-a')`).run();
    dbh.prepare(`INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES ('ws-b', 'WS B', 'ws-b')`).run();
    dbh.prepare(`
      INSERT INTO frontend_design_authority (id, autensa_workspace_id, open_design_project_id, sync_state)
      VALUES ('fda-1', 'ws-a', 'od-a', 'DRAFT')
    `).run();
    dbh.prepare(`
      INSERT INTO tasks (id, title, status, workspace_id, metadata)
      VALUES ('task-1', 'design create', 'in_progress', 'ws-a', '{"frontend_work_item_type":"FRONTEND_DESIGN_CREATE","open_design_project_id":"od-a"}')
    `).run();

    const slot = ds.acquireDesignJobSlot({
      taskId: 'task-2', autensaWorkspaceId: 'ws-a', openDesignProjectId: 'od-a',
      type: 'FRONTEND_DESIGN_REVISION', mutating: true,
    });
    assert.equal(slot.ok, false);
    assert.match(slot.reason || '', /per-project mutating/);

    const other = ds.acquireDesignJobSlot({
      taskId: 'task-3', autensaWorkspaceId: 'ws-b', openDesignProjectId: 'od-b',
      type: 'FRONTEND_DESIGN_CREATE', mutating: true,
    });
    assert.equal(other.ok, true);
  });
});

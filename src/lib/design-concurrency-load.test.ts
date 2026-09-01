// Load validation untuk work item §18: global max 10, per-project mutating 1.
// acquireDesignJobSlot MEMBACA task in_progress; slot diwakili task yang di-insert pemanggil.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

type Db = typeof import('@/lib/db');
type DesignSync = typeof import('@/lib/design-sync');

let db: Db;
let ds: DesignSync;
const TEST_DB = `.tmp/concurrency-${process.pid}.db`;

before(async () => {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(TEST_DB + suffix, { force: true }); } catch {} }
  process.env.DATABASE_PATH = TEST_DB;
  db = await import('@/lib/db');
  ds = await import('@/lib/design-sync');
});

beforeEach(() => {
  // Isolasi: tutup semua task design yang tersisa dari test sebelumnya
  const dbh = db.getDb();
  dbh.prepare(`UPDATE tasks SET status='done' WHERE metadata LIKE '%"frontend_work_item_type"%' AND status != 'done'`).run();
});

describe('design concurrency load (§18)', () => {
  test('global cap 10: 9 aktif + 1 acquire → 11th ditolak', () => {
    const dbh = db.getDb();
    for (let i = 0; i < 9; i++) {
      const ws = `ws-g-${i}`; const od = `od-g-${i}`;
      dbh.prepare(`INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES (?, ?, ?)`).run(ws, ws, ws);
      dbh.prepare(`INSERT OR IGNORE INTO frontend_design_authority (id, autensa_workspace_id, open_design_project_id, sync_state) VALUES (?, ?, ?, 'DRAFT')`).run(`fda-g-${i}`, ws, od);
      dbh.prepare(`INSERT INTO tasks (id, title, status, workspace_id, metadata) VALUES (?, ?, 'in_progress', ?, ?)`)
        .run(`t-g-${i}`, `design ${i}`, ws, JSON.stringify({frontend_work_item_type:'FRONTEND_DESIGN_CREATE', open_design_project_id: od}));
    }
    dbh.prepare(`INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES ('ws-g-new', 'New', 'ws-g-new')`).run();
    dbh.prepare(`INSERT OR IGNORE INTO frontend_design_authority (id, autensa_workspace_id, open_design_project_id, sync_state) VALUES ('fda-g-new', 'ws-g-new', 'od-g-new', 'DRAFT')`).run();

    const tenth = ds.acquireDesignJobSlot({taskId:'t-g-10', autensaWorkspaceId:'ws-g-new', openDesignProjectId:'od-g-new', type:'FRONTEND_DESIGN_CREATE', mutating:true});
    assert.equal(tenth.ok, true, '10th job should acquire');
    dbh.prepare(`INSERT INTO tasks (id, title, status, workspace_id, metadata) VALUES ('t-g-10', 'd10', 'in_progress', 'ws-g-new', '{"frontend_work_item_type":"FRONTEND_DESIGN_CREATE","open_design_project_id":"od-g-new"}')`).run();

    const eleventh = ds.acquireDesignJobSlot({taskId:'t-g-11', autensaWorkspaceId:'ws-g-new', openDesignProjectId:'od-g-new', type:'FRONTEND_DESIGN_CREATE', mutating:true});
    assert.equal(eleventh.ok, false, '11th job should be rejected');
    assert.match(eleventh.reason || '', /global design job cap/);
  });

  test('per-project cap 1: dua mutating di project sama → kedua ditolak', () => {
    const dbh = db.getDb();
    dbh.prepare(`INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES ('ws-p', 'P', 'ws-p')`).run();
    dbh.prepare(`INSERT OR IGNORE INTO frontend_design_authority (id, autensa_workspace_id, open_design_project_id, sync_state) VALUES ('fda-p', 'ws-p', 'od-p', 'DRAFT')`).run();
    dbh.prepare(`INSERT INTO tasks (id, title, status, workspace_id, metadata) VALUES ('t-p-1', 'p1', 'in_progress', 'ws-p', '{"frontend_work_item_type":"FRONTEND_DESIGN_REVISION","open_design_project_id":"od-p"}')`).run();
    const second = ds.acquireDesignJobSlot({taskId:'t-p-2', autensaWorkspaceId:'ws-p', openDesignProjectId:'od-p', type:'FRONTEND_DESIGN_REVISION', mutating:true});
    assert.equal(second.ok, false);
    assert.match(second.reason || '', /per-project mutating/);
  });

  test('read-only tidak kena per-project cap', () => {
    const dbh = db.getDb();
    // 1 mutating aktif di ws-p
    dbh.prepare(`INSERT OR IGNORE INTO tasks (id, title, status, workspace_id, metadata) VALUES ('t-p-3', 'p3', 'in_progress', 'ws-p', '{"frontend_work_item_type":"FRONTEND_DESIGN_REVISION","open_design_project_id":"od-p"}')`).run();
    const readOnly = ds.acquireDesignJobSlot({taskId:'t-p-ro', autensaWorkspaceId:'ws-p', openDesignProjectId:'od-p', type:'FRONTEND_DESIGN_SYNC', mutating:false});
    assert.equal(readOnly.ok, true);
  });
});

import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { DESKTOP_MIGRATIONS, getDesktopMigrationPlan, runDesktopMigrations } from "./migrations";

it("upgrades 006 heads without losing rows, recovery identity, indexes or foreign keys", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    runDesktopMigrations(db, { plan: { applied: [], pending: DESKTOP_MIGRATIONS.slice(0, 6) } });
    db.exec("INSERT INTO demo_assets(demo_id,content_hash,relative_path,original_filename,byte_size,status,imported_at,last_opened_at) VALUES('demo','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','demo.dem','demo.dem',8,'READY','old','old')");
    for (const [index, boundary] of ["ROUTE_START", "CUE_PAUSED", "WRAP_UP"].entries()) {
      db.prepare("INSERT INTO reviews(review_id,demo_id,selected_player_id,selected_player_name,title,status,created_at,last_opened_at) VALUES(?,'demo','player','Player','Review','READY','old','old')").run(`review-${index}`);
      db.prepare("INSERT INTO review_revisions(review_revision_id,review_id,analysis_version,graph_version,prompt_version,model_json,route_hash,status,created_at) VALUES(?,?,'a','g','p','{}','route','READY','old')").run(`revision-${index}`, `review-${index}`);
      db.prepare("INSERT INTO review_artifacts(artifact_id,review_revision_id,artifact_type,artifact_key,artifact_revision,schema_version,checksum,storage_kind,json_payload,byte_size,idempotency_key,created_at) VALUES(?,?,'SESSION_RECOVERY',?,1,'v2',?,'SQLITE_JSON','{}',2,?,'old')").run(`artifact-${index}`, `revision-${index}`, `recovery-${index}`, "b".repeat(64), `idem-${index}`);
      db.prepare("INSERT INTO review_runtime_heads(review_id,review_revision_id,session_id,run_id,demo_id,demo_content_hash,selected_player_id,route_id,route_hash,recovery_boundary,checkpoint_thread_id,checkpoint_namespace,checkpoint_id,current_cue_id,default_route_cursor,completed_cue_count,total_cue_count,last_playback_tick,stable_progress_json,updated_at,recovery_artifact_id,recovery_artifact_key,recovery_artifact_revision) VALUES(?,?,'session','run','demo',?,'player','route','hash',?,'thread','','checkpoint',?,3,2,4,99,'{}','old',?,?,1)").run(`review-${index}`, `revision-${index}`, "a".repeat(64), boundary, boundary === "CUE_PAUSED" ? "cue" : null, `artifact-${index}`, `recovery-${index}`);
    }
    const rows = db.prepare("SELECT * FROM review_runtime_heads ORDER BY review_id").all();
    const references = db.prepare("PRAGMA foreign_key_list(review_runtime_heads)").all();
    expect(getDesktopMigrationPlan(db).pending.map(item => item.id)).toEqual(["desktop-runtime-head-ordinary-007"]);
    expect(runDesktopMigrations(db)).toEqual(["desktop-runtime-head-ordinary-007"]);
    expect(runDesktopMigrations(db)).toEqual([]);
    expect(db.prepare("SELECT * FROM review_runtime_heads ORDER BY review_id").all()).toEqual(rows);
    expect(db.prepare("PRAGMA foreign_key_list(review_runtime_heads)").all()).toEqual(references);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='review_runtime_heads_recovery_artifact_idx'").get()).toBeDefined();
    db.exec("UPDATE review_runtime_heads SET recovery_boundary='ORDINARY_SEGMENT' WHERE review_id='review-0'");
    expect(() => db.exec("UPDATE review_runtime_heads SET checkpoint_id=NULL,checkpoint_thread_id=NULL,checkpoint_namespace=NULL WHERE review_id='review-0'")).toThrow();
    expect(() => db.exec("UPDATE review_runtime_heads SET current_cue_id='cue' WHERE review_id='review-0'")).toThrow();
    expect(() => db.exec("UPDATE review_runtime_heads SET recovery_artifact_id='artifact-1' WHERE review_id='review-0'")).toThrow();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.exec("DELETE FROM review_artifacts WHERE artifact_id='artifact-0'");
    expect(db.prepare("SELECT * FROM review_runtime_heads WHERE review_id='review-0'").get()).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 3 });
  } finally { db.close(); }
});

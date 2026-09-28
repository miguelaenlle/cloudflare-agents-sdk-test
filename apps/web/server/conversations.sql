-- BLOCK listen
LISTEN conversation_changed;

-- BLOCK notify
SELECT pg_notify('conversation_changed', $1);

-- BLOCK list_conversations
SELECT id, title FROM conversations ORDER BY created_at DESC;

-- BLOCK insert_conversation
INSERT INTO conversations (id, title) VALUES ($1, $2);

-- BLOCK has_conversation
SELECT id FROM conversations WHERE id=$1;

-- BLOCK begin
BEGIN;

-- BLOCK lock_conversation
SELECT revision FROM conversations WHERE id=$1 FOR UPDATE;

-- BLOCK select_operation
SELECT payload, revision FROM operations WHERE conversation_id=$1 AND id=$2;

-- BLOCK same_operation
SELECT payload=$3::jsonb AS same FROM operations WHERE conversation_id=$1 AND id=$2;

-- BLOCK commit
COMMIT;

-- BLOCK advance_revision
UPDATE conversations SET revision=$2 WHERE id=$1;

-- BLOCK insert_operation
INSERT INTO operations VALUES ($1,$2,$3,$4);

-- BLOCK rollback
ROLLBACK;

-- BLOCK select_publication
SELECT * FROM publications WHERE id=$1;

-- BLOCK insert_publication
INSERT INTO publications (id,conversation_id,job) VALUES ($1,$2,$3)
ON CONFLICT (conversation_id) DO UPDATE SET
  id=EXCLUDED.id, job=EXCLUDED.job, decision=NULL, published_sha=NULL,
  outcome=NULL, delivered=false, created_at=now()
WHERE publications.delivered AND (publications.job->>'sequence')::bigint < (EXCLUDED.job->>'sequence')::bigint;

-- BLOCK list_publications
SELECT * FROM publications WHERE conversation_id=$1 ORDER BY created_at;

-- BLOCK save_candidate
UPDATE publications SET job=$2 WHERE id=$1 AND decision IS NULL;

-- BLOCK select_revision
SELECT revision FROM conversations WHERE id=$1;

-- BLOCK claim_publication
SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked;

-- BLOCK save_decision
UPDATE publications SET decision=$2 WHERE id=$1 AND decision IS NULL;

-- BLOCK save_outcome
UPDATE publications SET outcome=$2 WHERE id=$1;

-- BLOCK mark_delivered
UPDATE publications SET delivered=true WHERE id=$1;

-- BLOCK save_sha
UPDATE publications SET published_sha=$2 WHERE id=$1;

-- BLOCK release_publication
SELECT pg_advisory_unlock(hashtextextended($1,0));

-- BLOCK pending_publication
SELECT id FROM publications WHERE conversation_id=$1 AND NOT delivered;

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


-- BLOCK select_revision
SELECT revision FROM conversations WHERE id=$1;


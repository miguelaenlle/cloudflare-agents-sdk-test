-- Prototype schema: PL integration will use the existing application database and migrations.
CREATE TABLE IF NOT EXISTS conversations (
  id text PRIMARY KEY,
  title text NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS operations (
  conversation_id text NOT NULL REFERENCES conversations(id),
  id text NOT NULL,
  payload jsonb NOT NULL,
  revision bigint NOT NULL,
  PRIMARY KEY (conversation_id, id)
);
INSERT INTO conversations (id, title) VALUES ('playground', 'Playground') ON CONFLICT DO NOTHING;

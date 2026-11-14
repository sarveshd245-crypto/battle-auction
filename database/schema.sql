-- PostgreSQL starter schema. Apply with your database migration tool.
CREATE TABLE IF NOT EXISTS universes (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  category TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS characters (
  id BIGSERIAL PRIMARY KEY,
  external_key TEXT UNIQUE,
  name TEXT NOT NULL,
  version TEXT,
  rating INTEGER CHECK (rating BETWEEN 0 AND 100),
  abilities JSONB NOT NULL DEFAULT '[]',
  strengths JSONB NOT NULL DEFAULT '[]',
  weaknesses JSONB NOT NULL DEFAULT '[]',
  source_urls JSONB NOT NULL DEFAULT '[]',
  confidence TEXT,
  approval_status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS character_universes (
  character_id BIGINT REFERENCES characters(id) ON DELETE CASCADE,
  universe_id BIGINT REFERENCES universes(id) ON DELETE CASCADE,
  PRIMARY KEY(character_id, universe_id)
);
CREATE TABLE IF NOT EXISTS game_rooms (
  id BIGSERIAL PRIMARY KEY,
  room_code VARCHAR(8) NOT NULL UNIQUE,
  host_user_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'lobby',
  settings JSONB NOT NULL DEFAULT '{}',
  shuffled_character_ids JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS room_players (
  id BIGSERIAL PRIMARY KEY,
  room_id BIGINT REFERENCES game_rooms(id) ON DELETE CASCADE,
  player_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  budget NUMERIC(12,2) NOT NULL DEFAULT 100,
  team JSONB NOT NULL DEFAULT '[]',
  UNIQUE(room_id, player_key)
);
CREATE TABLE IF NOT EXISTS auction_events (
  id BIGSERIAL PRIMARY KEY,
  room_id BIGINT REFERENCES game_rooms(id) ON DELETE CASCADE,
  character_key TEXT NOT NULL,
  player_key TEXT,
  event_type TEXT NOT NULL,
  bid_amount NUMERIC(12,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS match_reports (
  id BIGSERIAL PRIMARY KEY,
  room_id BIGINT REFERENCES game_rooms(id) ON DELETE CASCADE,
  team_a_key TEXT NOT NULL,
  team_b_key TEXT NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY,
  news_text TEXT NOT NULL,
  source_text TEXT NOT NULL DEFAULT '',
  owner_telegram_id BIGINT,
  title TEXT NOT NULL DEFAULT 'Новый проект',
  status TEXT NOT NULL DEFAULT 'draft',
  target_duration_sec INTEGER NOT NULL DEFAULT 30,
  delivery_style TEXT NOT NULL DEFAULT 'news',
  voice_id TEXT NOT NULL DEFAULT 'irina',
  caption_font TEXT NOT NULL DEFAULT 'DejaVu Sans',
  caption_color TEXT NOT NULL DEFAULT '&H00FFD68A',
  caption_size INTEGER NOT NULL DEFAULT 58,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS render_jobs (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'queued',
  status TEXT NOT NULL DEFAULT 'queued',
  output_path TEXT,
  error_message TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  snapshot JSONB,
  telegram_chat_id BIGINT,
  telegram_message_id BIGINT,
  notified_at TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assets (
  id UUID PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  object_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  duration_seconds NUMERIC,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_provider TEXT,
  source_url TEXT,
  source_author TEXT,
  source_license TEXT,
  embedding vector(768),
  position INTEGER,
  width INTEGER,
  height INTEGER,
  trim_start_sec NUMERIC NOT NULL DEFAULT 0,
  trim_end_sec NUMERIC,
  crop_mode TEXT NOT NULL DEFAULT 'center',
  description TEXT NOT NULL DEFAULT '',
  telegram_file_id TEXT,
  sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_assets (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, asset_id)
);

CREATE TABLE IF NOT EXISTS bot_sessions (
  telegram_user_id BIGINT PRIMARY KEY,
  telegram_chat_id BIGINT NOT NULL,
  current_project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'idle',
  state_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS script_versions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  text TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  estimated_duration_sec NUMERIC,
  measured_duration_sec NUMERIC,
  origin TEXT NOT NULL,
  model TEXT,
  prompt_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, version_no)
);

CREATE TABLE IF NOT EXISTS processed_updates (
  update_id BIGINT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projects_owner_updated_idx
  ON projects(owner_telegram_id, updated_at DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS assets_project_position_idx
  ON assets(project_id, position) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS render_jobs_notify_idx
  ON render_jobs(status, notified_at) WHERE telegram_chat_id IS NOT NULL;

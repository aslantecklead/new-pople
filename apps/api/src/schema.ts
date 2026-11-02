import type { Pool } from 'pg';

export async function ensureSchema(db: Pool) {
  await db.query(`
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner_telegram_id BIGINT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT 'Новый проект';
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_text TEXT NOT NULL DEFAULT '';
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS target_duration_sec INTEGER NOT NULL DEFAULT 30;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS delivery_style TEXT NOT NULL DEFAULT 'news';
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS voice_id TEXT NOT NULL DEFAULT 'irina';
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS caption_font TEXT NOT NULL DEFAULT 'DejaVu Sans';
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS caption_color TEXT NOT NULL DEFAULT '&H00FFD68A';
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS caption_size INTEGER NOT NULL DEFAULT 58;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

    ALTER TABLE assets ADD COLUMN IF NOT EXISTS position INTEGER;
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS width INTEGER;
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS height INTEGER;
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS trim_start_sec NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS trim_end_sec NUMERIC;
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS crop_mode TEXT NOT NULL DEFAULT 'center';
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS telegram_file_id TEXT;
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS sha256 TEXT;
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ready';
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

    ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS output_path TEXT;
    ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS error_message TEXT;
    ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS progress INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS snapshot JSONB;
    ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT;
    ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT;
    ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;
    ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;

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
  `);
}

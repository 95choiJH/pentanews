-- ============================================================
-- Pentanews Supabase Schema
-- Supabase Dashboard > SQL Editor 에서 실행하세요
-- ============================================================

-- 1. History (뉴스레터 히스토리)
CREATE TABLE IF NOT EXISTS history (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'pentaprism',
  issue_key   TEXT,
  issue_data  JSONB,
  html        TEXT NOT NULL,
  footer_date JSONB,
  og          JSONB,
  saved_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_history_saved_at ON history (saved_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_source_issue ON history (source, issue_key);

-- 2. Templates (뉴스레터 템플릿)
CREATE TABLE IF NOT EXISTS templates (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  html       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Drafts (자동저장 드래프트, 단일 row)
CREATE TABLE IF NOT EXISTS drafts (
  id          TEXT PRIMARY KEY DEFAULT 'current',
  html        TEXT NOT NULL,
  footer_date JSONB,
  source      TEXT,
  issue_data  JSONB,
  og          JSONB,
  saved_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Image Library 메타데이터
CREATE TABLE IF NOT EXISTS image_folders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'pentaprism',
  issue_key  TEXT NOT NULL DEFAULT '',
  ftp_path   TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS image_items (
  id           TEXT PRIMARY KEY,
  folder_id    TEXT NOT NULL REFERENCES image_folders(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  public_url   TEXT NOT NULL
);

-- ============================================================
-- RLS (Row Level Security) - anon 역할 전체 허용
-- ============================================================

ALTER TABLE history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all" ON history FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all" ON templates FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all" ON drafts FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE image_folders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all" ON image_folders FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE image_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all" ON image_items FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- Storage Bucket (이미지 보관함)
-- Dashboard > Storage 에서 'images' 버킷을 Public으로 생성하세요
-- 또는 아래 SQL 실행:
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('images', 'images', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "anon_upload" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'images');
CREATE POLICY "anon_read" ON storage.objects FOR SELECT USING (bucket_id = 'images');
CREATE POLICY "anon_delete" ON storage.objects FOR DELETE USING (bucket_id = 'images');

-- ============================================================
-- Migration: image_folders에 source, issue_key, ftp_path 컬럼 추가
-- 기존 테이블이 있는 경우 아래 SQL을 실행하세요:
-- ============================================================

ALTER TABLE image_folders ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'pentaprism';
ALTER TABLE image_folders ADD COLUMN IF NOT EXISTS issue_key TEXT NOT NULL DEFAULT '';
ALTER TABLE image_folders ADD COLUMN IF NOT EXISTS ftp_path TEXT NOT NULL DEFAULT '';

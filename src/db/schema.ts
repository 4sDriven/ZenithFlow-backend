import {
  boolean,
  date,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'

export const roleEnum = pgEnum('role', ['admin', 'user'])

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: varchar('username', { length: 64 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  role: roleEnum('role').notNull().default('user'),
  displayName: varchar('display_name', { length: 128 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert

export const videoProjectStatusEnum = pgEnum('video_project_status', [
  'draft',
  'scripted',
  'done',
])

export const shotStatusEnum = pgEnum('shot_status', [
  'pending',
  'generating',
  'done',
  'failed',
])

export const renderStatusEnum = pgEnum('render_status', [
  'idle',
  'rendering',
  'done',
  'failed',
])

export const videoProjects = pgTable('video_projects', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 200 }).notNull(),
  topic: text('topic').notNull(),
  style: varchar('style', { length: 64 }),
  durationSec: integer('duration_sec').notNull().default(15),
  status: videoProjectStatusEnum('status').notNull().default('draft'),
  videoModel: varchar('video_model', { length: 64 }).notNull().default('wan2.5-t2v-preview'),
  resolution: varchar('resolution', { length: 16 }).notNull().default('720P'),
  voice: varchar('voice', { length: 32 }).notNull().default('Cherry'),
  voiceTone: varchar('voice_tone', { length: 128 }),
  finalVideoPath: text('final_video_path'),
  renderStatus: renderStatusEnum('render_status').notNull().default('idle'),
  renderError: text('render_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const videoShots = pgTable('video_shots', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id')
    .notNull()
    .references(() => videoProjects.id, { onDelete: 'cascade' }),
  shotIndex: integer('shot_index').notNull(),
  description: text('description').notNull(),
  narration: text('narration'),
  durationSec: integer('duration_sec').notNull().default(5),
  status: shotStatusEnum('status').notNull().default('pending'),
  taskId: varchar('task_id', { length: 128 }),
  videoUrl: text('video_url'),
  localVideoPath: text('local_video_path'),
  audioUrl: text('audio_url'),
  localAudioPath: text('local_audio_path'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type VideoProject = typeof videoProjects.$inferSelect
export type VideoShot = typeof videoShots.$inferSelect

export const knowledgeSourceTypeEnum = pgEnum('knowledge_source_type', ['note', 'url', 'text', 'file'])

export const knowledgeItemStatusEnum = pgEnum('knowledge_item_status', [
  'processing',
  'ready',
  'failed',
])

export const knowledgeItems = pgTable('knowledge_items', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 300 }).notNull(),
  sourceType: knowledgeSourceTypeEnum('source_type').notNull(),
  sourceUrl: text('source_url'),
  fileName: varchar('file_name', { length: 255 }),
  tags: text('tags').array().notNull().default([]),
  contentText: text('content_text').notNull(),
  status: knowledgeItemStatusEnum('status').notNull().default('processing'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const knowledgeChunks = pgTable('knowledge_chunks', {
  id: serial('id').primaryKey(),
  itemId: integer('item_id')
    .notNull()
    .references(() => knowledgeItems.id, { onDelete: 'cascade' }),
  chunkIndex: integer('chunk_index').notNull(),
  content: text('content').notNull(),
  embedding: real('embedding').array().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type KnowledgeItem = typeof knowledgeItems.$inferSelect
export type KnowledgeChunk = typeof knowledgeChunks.$inferSelect

export type TranscriptTurn = { speaker: string; text: string }
export type VocabularyEntry = { word: string; meaning: string }

export const englishSeries = pgTable('english_series', {
  id: serial('id').primaryKey(),
  slug: varchar('slug', { length: 64 }).notNull().unique(),
  name: varchar('name', { length: 200 }).notNull(),
  feedUrl: text('feed_url').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const englishEpisodeStatusEnum = pgEnum('english_episode_status', ['ready', 'failed'])

export const englishEpisodes = pgTable('english_episodes', {
  id: serial('id').primaryKey(),
  seriesId: integer('series_id')
    .notNull()
    .references(() => englishSeries.id, { onDelete: 'cascade' }),
  guid: varchar('guid', { length: 600 }).notNull().unique(),
  title: varchar('title', { length: 400 }).notNull(),
  pageUrl: text('page_url').notNull(),
  audioUrl: text('audio_url'),
  thumbnailUrl: text('thumbnail_url'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  transcript: jsonb('transcript').$type<TranscriptTurn[]>().notNull().default([]),
  vocabulary: jsonb('vocabulary').$type<VocabularyEntry[]>().notNull().default([]),
  alignment: jsonb('alignment').$type<number[]>().notNull().default([]),
  status: englishEpisodeStatusEnum('status').notNull().default('ready'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const englishAssignmentStatusEnum = pgEnum('english_assignment_status', [
  'pending',
  'done',
  'skipped',
])

export const englishAssignments = pgTable(
  'english_assignments',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    episodeId: integer('episode_id')
      .notNull()
      .references(() => englishEpisodes.id, { onDelete: 'cascade' }),
    assignedDate: date('assigned_date').notNull(),
    status: englishAssignmentStatusEnum('status').notNull().default('pending'),
    note: text('note'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('english_assignments_user_date_uq').on(table.userId, table.assignedDate),
  ],
)

export type EnglishSeries = typeof englishSeries.$inferSelect
export type EnglishEpisode = typeof englishEpisodes.$inferSelect
export type EnglishAssignment = typeof englishAssignments.$inferSelect

/** 站点账号绑定的 B 站登录态；Cookie 与 refresh_token 均加密存储 */
export const biliAccounts = pgTable(
  'bili_accounts',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mid: varchar('mid', { length: 32 }).notNull(),
    uname: varchar('uname', { length: 128 }).notNull().default(''),
    cookiesEnc: text('cookies_enc').notNull(),
    refreshTokenEnc: text('refresh_token_enc'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    boundAt: timestamp('bound_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('bili_accounts_user_uq').on(table.userId)],
)

export type BiliAccount = typeof biliAccounts.$inferSelect

/** 每日报纸：只保留最新一期，新一期成功后删除旧日期 */
export const newspaperEditionStatusEnum = pgEnum('newspaper_edition_status', [
  'generating',
  'ready',
  'failed',
])

export type NewspaperSectionKey = 'hangzhou' | 'benxi' | 'bili' | 'steam' | 'china' | 'world'
export type NewspaperItemKind = 'official' | 'folk' | 'mixed'

export type NewspaperItem = {
  title: string
  summary: string
  source: string
  url: string | null
  publishedAt: string | null
  publishedLabel: string | null
  heat: string | null
  kind: NewspaperItemKind
  tags: string[]
}

export type NewspaperSection = {
  key: NewspaperSectionKey
  title: string
  subtitle: string
  intro: string
  items: NewspaperItem[]
  degraded: boolean
  note: string | null
}

export const newspaperEditions = pgTable('newspaper_editions', {
  id: serial('id').primaryKey(),
  editionDate: date('edition_date').notNull().unique(),
  status: newspaperEditionStatusEnum('status').notNull().default('generating'),
  sections: jsonb('sections').$type<NewspaperSection[]>().notNull().default([]),
  sourceStats: jsonb('source_stats').$type<Record<string, number>>().notNull().default({}),
  itemCount: integer('item_count').notNull().default(0),
  error: text('error'),
  generatedAt: timestamp('generated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type NewspaperEditionRow = typeof newspaperEditions.$inferSelect

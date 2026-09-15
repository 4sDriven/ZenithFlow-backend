import {
  integer,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
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

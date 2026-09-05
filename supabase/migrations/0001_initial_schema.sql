-- EduPlatform schema
--
-- A multi-tenant learning platform. Every university is its own ecosystem:
-- accounts, classrooms, and conversations never cross a university boundary.
-- That boundary is carried as `university_id` on every root table and enforced
-- by the application on every query.
--
-- Run once against a fresh Supabase project. Safe to re-run; every statement
-- is guarded.

create extension if not exists "pgcrypto";
-- Case-insensitive text, so Ada@uni.edu and ada@uni.edu are one account.
create extension if not exists "citext";

/* ---- Universities --------------------------------------------------------
   The tenant boundary. `slug` is the URL segment (or subdomain) a university
   is reached by; `email_domain` is what gates self-signup -- an address ending
   in the domain lands the new account in that university and nowhere else. */
create table if not exists public.universities (
  id            uuid        primary key default gen_random_uuid(),
  name          text        not null,
  slug          citext      not null unique,
  email_domain  citext      not null unique,
  -- Optional. Presenting this at signup grants the new account faculty rights,
  -- which is what lets a teacher create classrooms. Null means nobody can
  -- self-promote and an admin must grant the role by hand.
  faculty_signup_code citext,
  created_at    timestamptz not null default now()
);

/* ---- Users ---------------------------------------------------------------
   Passwords are scrypt hashes and TOTP secrets are stored as issued; the
   application does its own authentication and never exposes this table.

   Email is unique *per university*, not globally. The same person may hold an
   account at two universities, and a global constraint would block the second
   one for no good reason.

   `platform_role` is what someone may do at the university level -- create
   classrooms, administer the tenant. It is deliberately NOT what they may do
   inside a classroom; see classroom_members. */
create table if not exists public.users (
  id                 uuid        primary key default gen_random_uuid(),
  university_id      uuid        not null references public.universities(id) on delete cascade,
  name               text        not null,
  email              citext      not null,
  password_salt      text        not null,
  password_hash      text        not null,
  totp_secret        text        not null,
  totp_confirmed     boolean     not null default false,
  recovery_codes     jsonb       not null default '[]'::jsonb,
  token_version      integer     not null default 1,
  platform_role      text        not null default 'student'
                                 check (platform_role in ('admin', 'faculty', 'student')),
  -- Until this is set the account may sign in but not join anything: an
  -- unverified address is not yet proof of belonging to the university.
  email_verified_at  timestamptz,
  created_at         timestamptz not null default now(),
  last_sign_in_at    timestamptz,
  unique (university_id, email)
);

create index if not exists users_university_idx on public.users (university_id);

/* ---- Classrooms ----------------------------------------------------------
   Private by default: a classroom is invisible to anyone who is not a member
   unless its owner publishes it. `join_code` is the secret a teacher shares;
   it is unique per university rather than globally, so two universities may
   both hold code ABC123 without collision. Rotating the code is how a teacher
   closes enrolment without removing anyone. */
create table if not exists public.classrooms (
  id             uuid        primary key default gen_random_uuid(),
  university_id  uuid        not null references public.universities(id) on delete cascade,
  owner_id       uuid        not null references public.users(id) on delete restrict,
  name           text        not null,
  description    text        not null default '',
  visibility     text        not null default 'private'
                             check (visibility in ('private', 'public')),
  join_code      citext      not null,
  -- Free text ("Fall 2026") rather than a term table; nothing joins on it.
  term           text,
  -- Archived classrooms stay readable to their members but accept no writes.
  archived_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (university_id, join_code)
);

create index if not exists classrooms_university_idx on public.classrooms (university_id);
create index if not exists classrooms_owner_idx on public.classrooms (owner_id);

/* ---- Membership ----------------------------------------------------------
   Role lives here, on the enrolment, not on the user. A graduate student may
   teach one classroom and take another in the same term, and any model that
   puts a single role on the account cannot express that. */
create table if not exists public.classroom_members (
  classroom_id  uuid        not null references public.classrooms(id) on delete cascade,
  user_id       uuid        not null references public.users(id) on delete cascade,
  role          text        not null default 'student'
                            check (role in ('teacher', 'ta', 'student')),
  joined_at     timestamptz not null default now(),
  primary key (classroom_id, user_id)
);

-- "Which classrooms am I in?" is the single most common query in the product.
create index if not exists classroom_members_user_idx on public.classroom_members (user_id);

/* ---- Content -------------------------------------------------------------
   A tree of folders, files, links and written notes. Files live in Supabase
   Storage; `storage_path` is the object key, so no file bytes ever sit in
   Postgres. `published_at` null means draft -- visible to teaching staff, not
   to students -- which lets a teacher build a week's material ahead of time. */
create table if not exists public.content_items (
  id               uuid        primary key default gen_random_uuid(),
  classroom_id     uuid        not null references public.classrooms(id) on delete cascade,
  parent_id        uuid        references public.content_items(id) on delete cascade,
  kind             text        not null check (kind in ('folder', 'file', 'link', 'text')),
  title            text        not null,
  body             text,       -- kind = 'text'
  url              text,       -- kind = 'link'
  storage_path     text,       -- kind = 'file'
  file_size_bytes  bigint,
  mime_type        text,
  position         integer     not null default 0,
  published_at     timestamptz,
  created_by       uuid        references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists content_items_classroom_idx
  on public.content_items (classroom_id, parent_id, position);

/* ---- Calendar ------------------------------------------------------------
   Only events someone typed by hand. Quiz due dates are NOT copied in here;
   they are unioned in at read time by the classroom_calendar view below, so a
   due date can never drift out of sync with the quiz that owns it. */
create table if not exists public.calendar_events (
  id            uuid        primary key default gen_random_uuid(),
  classroom_id  uuid        not null references public.classrooms(id) on delete cascade,
  title         text        not null,
  description   text        not null default '',
  starts_at     timestamptz not null,
  ends_at       timestamptz,
  all_day       boolean     not null default false,
  kind          text        not null default 'other'
                            check (kind in ('class', 'due', 'exam', 'office_hours', 'other')),
  created_by    uuid        references public.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists calendar_events_classroom_idx
  on public.calendar_events (classroom_id, starts_at);

/* ---- Announcements -------------------------------------------------------
   One-way broadcast from teaching staff to a classroom. Deliberately a table
   of its own rather than a discussion thread with replies disabled: the two
   have different permissions, different notification rules, and only this one
   needs pinning. */
create table if not exists public.announcements (
  id            uuid        primary key default gen_random_uuid(),
  classroom_id  uuid        not null references public.classrooms(id) on delete cascade,
  author_id     uuid        references public.users(id) on delete set null,
  title         text        not null,
  body          text        not null,
  pinned        boolean     not null default false,
  published_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists announcements_classroom_idx
  on public.announcements (classroom_id, pinned desc, published_at desc);

/* ---- Discussions ---------------------------------------------------------
   Threads hold posts; posts nest through parent_id. Posts are soft-deleted so
   that removing one does not silently take its replies with it. */
create table if not exists public.discussion_threads (
  id            uuid        primary key default gen_random_uuid(),
  classroom_id  uuid        not null references public.classrooms(id) on delete cascade,
  author_id     uuid        references public.users(id) on delete set null,
  title         text        not null,
  locked        boolean     not null default false,
  pinned        boolean     not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists discussion_threads_classroom_idx
  on public.discussion_threads (classroom_id, pinned desc, updated_at desc);

create table if not exists public.discussion_posts (
  id          uuid        primary key default gen_random_uuid(),
  thread_id   uuid        not null references public.discussion_threads(id) on delete cascade,
  parent_id   uuid        references public.discussion_posts(id) on delete cascade,
  author_id   uuid        references public.users(id) on delete set null,
  body        text        not null,
  edited_at   timestamptz,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists discussion_posts_thread_idx
  on public.discussion_posts (thread_id, created_at);

/* ---- Quizzes -------------------------------------------------------------
   Carried over from SegueQuiz, re-scoped to a classroom. Two changes matter:

   The primary key is now a uuid, not the six-character join code. A quiz is
   reached by being enrolled, and `join_code` survives only as an optional
   secondary for the live QR-code run, which is worth keeping.

   Questions stay in a jsonb column for the same reason as before: a quiz is
   always read and written whole, and question order is part of the document,
   so splitting them out would buy joins nobody makes. */
create table if not exists public.quizzes (
  id                  uuid        primary key default gen_random_uuid(),
  classroom_id        uuid        not null references public.classrooms(id) on delete cascade,
  created_by          uuid        references public.users(id) on delete set null,
  title               text        not null,
  description         text        not null default '',
  time_limit_seconds  integer     not null check (time_limit_seconds >= 10),
  questions           jsonb       not null default '[]'::jsonb,
  is_published        boolean     not null default false,
  allow_retakes       boolean     not null default false,
  end_on_leave        boolean     not null default true,
  shuffle_questions   boolean     not null default false,
  shuffle_options     boolean     not null default false,
  reveal_answers      boolean     not null default false,
  -- Optional live-run code, unique per university when present.
  join_code           citext,
  available_from      timestamptz,
  due_at              timestamptz,
  points_possible     numeric(8, 2) not null default 100,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists quizzes_classroom_idx on public.quizzes (classroom_id);
-- Partial, so the many quizzes with no live code do not fight over one null.
create unique index if not exists quizzes_join_code_idx
  on public.quizzes (join_code) where join_code is not null;

/* ---- Quiz attempts -------------------------------------------------------
   The sharpest break from SegueQuiz: an attempt belongs to an enrolled
   student, not to a typed-in name plus a device marker. Retakes are numbered
   rather than overwritten, so a gradebook can show every try. */
create table if not exists public.quiz_attempts (
  id              uuid        primary key default gen_random_uuid(),
  quiz_id         uuid        not null references public.quizzes(id) on delete cascade,
  student_id      uuid        not null references public.users(id) on delete cascade,
  attempt_number  integer     not null default 1,
  status          text        not null check (status in ('in_progress', 'submitted')),
  started_at      timestamptz not null default now(),
  deadline_at     timestamptz not null,
  submitted_at    timestamptz,
  duration_ms     integer,
  timed_out       boolean     not null default false,
  ended_reason    text        check (ended_reason in ('submitted', 'timed_out', 'left_quiz')),
  answers         jsonb       not null default '{}'::jsonb,
  score           integer     not null default 0,
  correct_count   integer     not null default 0,
  max_score       integer     not null default 0,
  answered_count  integer     not null default 0,
  unique (quiz_id, student_id, attempt_number)
);

create index if not exists quiz_attempts_quiz_idx on public.quiz_attempts (quiz_id);
create index if not exists quiz_attempts_student_idx on public.quiz_attempts (student_id);
create index if not exists quiz_attempts_leaderboard_idx
  on public.quiz_attempts (quiz_id, score desc, duration_ms asc)
  where status = 'submitted';

/* ---- Gradebook -----------------------------------------------------------
   A grade_item is a column; a grade is a cell. A column either mirrors a quiz
   (source_type = 'quiz') or is typed by hand, which is what lets participation
   marks and essays live beside auto-marked quizzes in one table. */
create table if not exists public.grade_items (
  id               uuid        primary key default gen_random_uuid(),
  classroom_id     uuid        not null references public.classrooms(id) on delete cascade,
  title            text        not null,
  points_possible  numeric(8, 2) not null default 100,
  position         integer     not null default 0,
  source_type      text        not null default 'manual'
                               check (source_type in ('manual', 'quiz')),
  source_id        uuid        references public.quizzes(id) on delete set null,
  due_at           timestamptz,
  created_at       timestamptz not null default now(),
  -- A quiz-backed column must name its quiz; a manual one must not.
  check ((source_type = 'quiz') = (source_id is not null))
);

create index if not exists grade_items_classroom_idx
  on public.grade_items (classroom_id, position);

create table if not exists public.grades (
  grade_item_id  uuid        not null references public.grade_items(id) on delete cascade,
  student_id     uuid        not null references public.users(id) on delete cascade,
  points         numeric(8, 2),
  feedback       text        not null default '',
  graded_by      uuid        references public.users(id) on delete set null,
  graded_at      timestamptz not null default now(),
  primary key (grade_item_id, student_id)
);

create index if not exists grades_student_idx on public.grades (student_id);

/* ---- Messages ------------------------------------------------------------
   Person-to-person, scoped to a university rather than a classroom: two people
   who share any classroom may keep talking after the term ends, but a message
   never crosses a tenant boundary. `last_read_at` on the membership is what
   drives unread counts without a row per recipient per message. */
create table if not exists public.conversations (
  id             uuid        primary key default gen_random_uuid(),
  university_id  uuid        not null references public.universities(id) on delete cascade,
  subject        text        not null default '',
  created_at     timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id  uuid        not null references public.conversations(id) on delete cascade,
  user_id          uuid        not null references public.users(id) on delete cascade,
  last_read_at     timestamptz,
  primary key (conversation_id, user_id)
);

create index if not exists conversation_members_user_idx
  on public.conversation_members (user_id);

create table if not exists public.messages (
  id               uuid        primary key default gen_random_uuid(),
  conversation_id  uuid        not null references public.conversations(id) on delete cascade,
  sender_id        uuid        references public.users(id) on delete set null,
  body             text        not null,
  created_at       timestamptz not null default now()
);

create index if not exists messages_conversation_idx
  on public.messages (conversation_id, created_at desc);

/* ---- Calendar view -------------------------------------------------------
   What the Calendar tab actually reads: hand-made events plus every published
   quiz due date, derived rather than duplicated. A teacher who moves a due
   date moves the calendar entry by definition. */
create or replace view public.classroom_calendar as
  select
    e.id,
    e.classroom_id,
    e.title,
    e.starts_at,
    e.ends_at,
    e.all_day,
    e.kind,
    'event'::text as source_type,
    e.id          as source_id
  from public.calendar_events e
  union all
  select
    q.id,
    q.classroom_id,
    q.title,
    q.due_at      as starts_at,
    q.due_at      as ends_at,
    false         as all_day,
    'due'::text   as kind,
    'quiz'::text  as source_type,
    q.id          as source_id
  from public.quizzes q
  where q.due_at is not null and q.is_published;

/* ---- Row level security --------------------------------------------------
   RLS is on with no policies, which denies everything to the anon and
   authenticated roles. Only the service_role key bypasses RLS, and that key
   lives on the EduPlatform server and never reaches a browser.

   Every rule about who may see what -- tenant isolation, classroom
   membership, draft content, the answer key -- is enforced by the application
   layer, exactly as SegueQuiz does it. */
alter table public.universities        enable row level security;
alter table public.users               enable row level security;
alter table public.classrooms          enable row level security;
alter table public.classroom_members   enable row level security;
alter table public.content_items       enable row level security;
alter table public.calendar_events     enable row level security;
alter table public.announcements       enable row level security;
alter table public.discussion_threads  enable row level security;
alter table public.discussion_posts    enable row level security;
alter table public.quizzes             enable row level security;
alter table public.quiz_attempts       enable row level security;
alter table public.grade_items         enable row level security;
alter table public.grades              enable row level security;
alter table public.conversations       enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages            enable row level security;

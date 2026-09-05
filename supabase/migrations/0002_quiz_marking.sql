-- Marking for questions a computer cannot grade.
--
-- A drawn answer has no answer key, so an attempt containing one is submitted
-- with the score earned so far rather than a final one. `marks` holds a
-- person's decision per question, and `pending_mark_count` is how many are
-- still owed -- stored rather than derived, because the results table sorts on
-- the score and would otherwise re-grade every attempt on every read.

alter table public.quiz_attempts
  add column if not exists marks jsonb not null default '{}'::jsonb;

alter table public.quiz_attempts
  add column if not exists pending_mark_count integer not null default 0;

-- The marking queue asks for exactly this: submitted attempts still owed a
-- decision, newest first.
create index if not exists quiz_attempts_pending_marks_idx
  on public.quiz_attempts (quiz_id, submitted_at desc)
  where status = 'submitted' and pending_mark_count > 0;

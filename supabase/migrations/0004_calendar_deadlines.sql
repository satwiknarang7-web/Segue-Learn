-- Everything with a deadline belongs on the calendar.
--
-- The view already unioned hand-made events with published quiz due dates.
-- Gradebook columns carry a due date too -- an essay deadline is exactly the
-- kind of thing somebody opens a calendar to find -- and leaving them out meant
-- half the deadlines in a course were invisible.
--
-- Quiz-backed gradebook columns are excluded, because the quiz half of this
-- union already carries that date and showing it twice would be worse than not
-- showing it at all.
--
-- Still derived, never copied: moving a due date moves the calendar entry by
-- definition, so the two cannot drift.

create or replace view public.classroom_calendar as
  select
    e.id,
    e.classroom_id,
    e.title,
    e.starts_at,
    e.ends_at,
    e.all_day,
    e.kind,
    'event'::text  as source_type,
    e.id           as source_id,
    e.description
  from public.calendar_events e

  union all

  select
    q.id,
    q.classroom_id,
    q.title,
    q.due_at       as starts_at,
    q.due_at       as ends_at,
    false          as all_day,
    'due'::text    as kind,
    'quiz'::text   as source_type,
    q.id           as source_id,
    q.description
  from public.quizzes q
  where q.due_at is not null and q.is_published

  union all

  select
    i.id,
    i.classroom_id,
    i.title,
    i.due_at       as starts_at,
    i.due_at       as ends_at,
    false          as all_day,
    'due'::text    as kind,
    'assessment'::text as source_type,
    i.id           as source_id,
    ''             as description
  from public.grade_items i
  where i.due_at is not null and i.source_type = 'manual';

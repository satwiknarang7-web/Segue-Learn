-- A quiz that counts towards a grade cannot simply vanish.
--
-- source_id was "on delete set null", which fought the check constraint that
-- says a quiz column must name a quiz: deleting a graded quiz failed with a
-- constraint violation rather than anything a person could act on.
--
-- Restrict says the same thing honestly. Grades are the most consequential
-- data here, and a gradebook column can hold marks a teacher typed by hand as
-- an override, so deleting the quiz must not take them with it. The service
-- checks first and explains; this is the backstop for anything that does not.

alter table public.grade_items
  drop constraint if exists grade_items_source_id_fkey;

alter table public.grade_items
  add constraint grade_items_source_id_fkey
  foreign key (source_id) references public.quizzes(id) on delete restrict;

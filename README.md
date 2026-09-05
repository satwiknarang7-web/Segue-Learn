# EduPlatform

A multi-tenant learning platform. Each university is its own ecosystem:
accounts, classrooms and conversations never cross an institution boundary.

Inside a classroom there are seven tabs — Content, Calendar, Announcements,
Discussions, Quiz, Gradebook and Messages — plus People and, for teaching
staff, Settings.

## Running it

```bash
npm install
npm run university -- --name "Test University" --slug test \
  --domain test.edu --faculty-code STAFF-2026
npm run dev
```

There is nothing else to install. With no `DATABASE_URL` set the app runs an
**embedded Postgres** (PGlite) under `data/pgdata`. It is real Postgres running
the real migrations, so queries behave exactly as they will against Supabase.

To start over: `rm -rf data/pgdata` and run the university command again.

## Connecting Supabase

Set `DATABASE_URL` to the connection string (Project Settings → Database →
Connection string → URI; use the pooled connection on port 6543 for a hosted
deployment). Nothing else changes — the same migrations run at boot.

Also set `EDUPLATFORM_SESSION_SECRET` on any hosted deployment. Without it a
new signing key is generated on every restart, which signs everybody out.

See `.env.example` for the rest.

## Accounts

Signing up is gated by email domain: an address's domain decides which
university the account joins, and a domain no university owns gets no account.
Universities are created from the CLI rather than a web form, because handing
that out would let anyone claim an institution.

Every account uses an authenticator app for two-factor. Nothing is ever
emailed — there is no mail server — so a forgotten password is authorised by
the second factor or by one of the recovery codes issued at signup.

A **staff code** at signup grants the rights to create classrooms. Without one
every new account is a student.

> **Not done yet:** email addresses are not verified. Domain-gating assumes the
> address is really yours, and nothing currently proves that. `email_verified_at`
> is in the schema, unused, waiting for Supabase to send the mail.

## Quizzes

Carried over from SegueQuiz and re-scoped to a classroom. Teaching staff write
questions, set a time limit and an optional open/due window, and publish; a
student sees only published quizzes and only their own results.

Multiple-choice and short-answer questions are marked automatically. Short
answers are compared with case, spacing and typographic quotes folded away, so
`  TWO  ` matches an accepted answer of `two`. Answers autosave as they are
given, and the clock is drawn from a deadline the server issued rather than
counted in the browser, so a paused tab buys no time.

Retakes are numbered rather than overwritten. With retakes off, one attempt is
all anybody gets — and clearing a quiz's results is what lets the same quiz be
run again with another group.

> **Not built yet:** drawn answers and the marking queue that goes with them,
> question images, and AI question generation. All three need file storage. The
> domain layer still knows how to grade and mark a drawing — see
> `src/lib/questionTypes.js` — so switching it back on is adding `DRAW` to
> `SUPPORTED_TYPES` in `quizService.js`, not rebuilding the feature.

## Announcements

One-way notices from teaching staff to a classroom. Deliberately without
replies — a notice that wants a conversation belongs in Discussions, which has
the threading and permissions for it.

A notice with no `published_at` is a draft: visible to staff, and withheld from
a student's payload entirely rather than hidden in the page. Publishing stamps
the moment it went out, so a notice drafted on Monday and sent on Friday is a
Friday notice — and correcting one that is already out keeps its original date,
because the class saw it when they saw it.

Pinned notices float above newer ones. Bodies are plain text rendered into
paragraph elements through the `el()` helper, so a notice containing markup
displays as markup rather than becoming it — structurally, not by escaping.

> **Not built yet:** read tracking (who has seen what) needs a per-student
> table the schema does not have, so there are no unread badges.

## Dashboard

`/home` is one dashboard that shows a **Teaching** half to anyone who teaches
and a **Studying** half to anyone who studies. Somebody who does both — a
graduate student running one seminar and sitting another — sees both. That is
the whole reason role lives on the enrolment rather than on the account, so the
dashboard reads memberships rather than `platform_role`.

Teaching cards count what is waiting: marks to enter, questions nobody has
answered, draft quizzes, draft notices. Each count is a link to the tab where
you deal with it — a dashboard that names a problem without taking you to it is
a to-do list you have to retype. Quiz-backed gradebook columns are never
counted, because they mark themselves.

Studying cards carry quiz standing and a link to that course's gradebook, and
"To do" lists published quizzes not yet submitted.

> Quiz marks only, not the gradebook total: the real grade would mean
> assembling every course's gradebook to draw one screen.

## Navigation

One bar on every signed-in page: **Dashboard**, **Courses**, **Calendar**, a
course switcher, and the account menu.

The switcher is labelled with the course you are in, lists every course in its
own colour, and — while you are inside one — also jumps straight to any of its
tabs, so the bar reaches every screen rather than only a course's front page.

On a narrow screen Dashboard and Courses drop out: the brand already leads to
the dashboard and the switcher already lists the courses, while Calendar and
the switcher have no other route.

## Calendar

Two of them, sharing one month grid (`public/js/lib/calendarGrid.js`) so they
cannot drift apart:

- **Per classroom**, in its Calendar tab. Chips are coloured by kind, because
  in one course the useful distinction is class-versus-deadline.
- **Across every course**, at `/calendar`. Chips are coloured by course,
  because across six the useful distinction is which course a thing belongs
  to — the kind is still there, in the badge. Read-only: a deadline belongs to
  a course and is changed there, so every entry links back to it.

The cross-course view is scoped by membership *and* by university, leaves out
archived classrooms, and carries derived deadlines through like any other.

A month grid, plus what is coming up next.

**Deadlines are derived, never copied.** The `classroom_calendar` view unions
hand-made events with the due dates of published quizzes and of gradebook
columns, so moving a quiz's due date moves its calendar entry by definition.
Nothing has to be kept in step because there is no second copy. A quiz that is
also a gradebook column appears once, not twice.

Derived entries are read-only here and say where they come from — "Set on the
quiz — change it there" — so the missing edit button makes sense.

**Every date decision is local.** The browser works out which six weeks the
grid is showing and asks for exactly that window, because only it knows the
reader's time zone and "which month is this" is a local-time question. Ranges
are half-open, so paging through months never shows a day twice.

On a phone the grid keeps all six weeks by shrinking event chips to coloured
dots; the day's detail below carries the reading.

## Discussions

The two-way counterpart to Announcements: anyone in the classroom can start a
thread, and anyone can reply.

**Replies nest two levels and no further.** A reply aimed at something already
at the cap is folded up to sit beside it rather than refused — the person still
gets to say their piece, and the conversation stays readable on a phone. The UI
stops offering "Reply" at the cap so it never promises nesting the server will
not deliver.

**Posts are soft-deleted.** A removed post keeps its row so replies beneath it
still make sense; its body is not served at all, so it cannot be read off the
wire. Only one post per thread has a null parent — the one that opened it — so
"reply to the thread" is stored as a reply to that post and a null parent is
never ambiguous.

**Staff may remove a post but never edit one.** Putting words in somebody's
mouth is not a moderation power. Locking stops students posting while leaving
staff able to close with a final word.

An author may delete their own thread only while it is still theirs alone to
delete: once somebody else has replied, deleting it would destroy their words
too, and once staff have closed it, deleting it would undo the moderation.
Neither is the author's call. Staff are not bound by either.

## Gradebook

A column per assessment, a row per student. A column is either typed by hand or
backed by a quiz.

**A quiz column stores no numbers.** Its cells are read from the attempts every
time the gradebook is opened, so re-marking an answer, clearing a quiz's
results, or adding a question to it moves the gradebook with it — a stale score
cannot be left behind, because there is no copy to go stale. When retakes are
on, the best attempt counts.

A teacher can still overrule one. A mark written against a quiz column is an
override: it wins over the derived score, is flagged in the grid, and reverting
it hands the cell back to the quiz.

The running total counts **only what has been graded**. An essay nobody has sat
yet would otherwise read as a zero and make every grade look like a failure in
week one.

Adding a quiz to the gradebook is deliberate rather than automatic on publish —
a quiz set as practice should not silently start counting towards a grade.

> A quiz that has a gradebook column cannot be deleted. The column can hold
> marks a teacher typed as an override, and losing those silently is worse than
> an extra step, so the service explains and `0003` makes the database enforce
> the same rule.

## Roles

Role lives on the *enrolment*, not the account. A graduate student can teach
one classroom and take another in the same term, which a single role on the
user record cannot express.

- `users.platform_role` — `admin` / `faculty` / `student`, university-wide
  rights such as creating classrooms.
- `classroom_members.role` — `teacher` / `ta` / `student`, per classroom.

## Layout

```
src/
  db/            one query surface over node-postgres or PGlite, and the migrator
  repositories/  SQL in, domain objects out
  services/      the rules: who may see and change what
  routes/        HTTP, thin
  lib/           router, http, TOTP, QR, quiz helpers (carried over from SegueQuiz)
public/          pages and their modules; no build step
supabase/
  migrations/    the schema, applied at boot and pasteable into the SQL editor
test/            node --test, against an in-memory Postgres
```

Every classroom read is scoped by the university taken from the signed-in
account, never from the request. A private classroom answers 404 rather than
403 to a non-member, so its existence is not disclosed.

## Tests

```bash
npm test
```

They run against an in-memory PGlite, so each file starts from an empty
database and leaves nothing behind.

## Relationship to SegueQuiz

A separate product with a separate database. The quiz engine, auth, router and
QR code generation are carried over as code; no data is shared.

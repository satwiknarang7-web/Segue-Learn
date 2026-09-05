import { config } from '../config.js';
import { sendHtmlPage } from '../lib/http.js';
import { Router } from '../lib/router.js';
import { databaseBackend } from '../db/index.js';
import { accountService } from '../services/accountService.js';

/**
 * Readable URLs for every screen.
 *
 * Public: the landing page and the sign-in / sign-up flow.
 * Signed in: home, and a classroom with its seven tabs.
 */
export const pageRoutes = new Router();

const page = (fileName) => async ({ res }) => sendHtmlPage(res, config.publicDir, fileName);
const signedIn = { signedIn: true };

/** Signed-in people get their classroom list; everyone else the landing page. */
pageRoutes.get('/', async ({ req, res }) => {
  if (await accountService.currentUser(req)) {
    res.writeHead(302, { Location: '/home', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  await sendHtmlPage(res, config.publicDir, 'landing.html');
});

pageRoutes.get('/home', page('home.html'), signedIn);

/** Everything due across every classroom, rather than one course at a time. */
pageRoutes.get('/calendar', page('calendar.html'), signedIn);

/**
 * One page serves every tab. The tab is a fragment the client reads, so moving
 * between Content and Gradebook does not reload the shell.
 */
pageRoutes.get('/classrooms/:classroomId', page('classroom.html'), signedIn);

/**
 * Quizzes get pages of their own rather than living inside the classroom tab.
 * Taking one in particular needs the screen to itself: the page watches for the
 * student navigating away, which a tab panel cannot sensibly do.
 */
pageRoutes.get(
  '/classrooms/:classroomId/quizzes/:quizId/edit',
  page('quiz-editor.html'),
  signedIn,
);
pageRoutes.get('/classrooms/:classroomId/quizzes/:quizId/take', page('quiz-take.html'), signedIn);
pageRoutes.get(
  '/classrooms/:classroomId/quizzes/:quizId/results',
  page('quiz-results.html'),
  signedIn,
);

pageRoutes.get('/signin', page('signin.html'));
pageRoutes.get('/signup', page('signup.html'));
pageRoutes.get('/reset', page('reset.html'));

/** Liveness probe for the hosting platform. Deliberately reveals nothing. */
pageRoutes.get('/healthz', () => ({ status: 'ok', storage: databaseBackend() }));

import { config } from './config.js';
import { HttpError } from './lib/errors.js';
import { readJsonBody, sendJson, serveStaticFile } from './lib/http.js';
import { Router } from './lib/router.js';
import { announcementRoutes } from './routes/announcementRoutes.js';
import { attemptRoutes } from './routes/attemptRoutes.js';
import { authRoutes } from './routes/authRoutes.js';
import { calendarRoutes } from './routes/calendarRoutes.js';
import { classroomRoutes } from './routes/classroomRoutes.js';
import { dashboardRoutes } from './routes/dashboardRoutes.js';
import { discussionRoutes } from './routes/discussionRoutes.js';
import { gradebookRoutes } from './routes/gradebookRoutes.js';
import { pageRoutes } from './routes/pageRoutes.js';
import { quizRoutes } from './routes/quizRoutes.js';
import { accountService } from './services/accountService.js';

const router = new Router()
  .use(authRoutes)
  .use(classroomRoutes)
  .use(quizRoutes)
  .use(attemptRoutes)
  .use(gradebookRoutes)
  .use(announcementRoutes)
  .use(discussionRoutes)
  .use(calendarRoutes)
  .use(dashboardRoutes)
  .use(pageRoutes);

const METHODS_WITH_BODY = new Set(['POST', 'PATCH', 'PUT']);

/**
 * The single request handler: match a route, check whether it needs a signed-in
 * account, hand it a small context, and turn whatever it returns (or throws)
 * into a response.
 */
export async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const method = req.method ?? 'GET';

  try {
    const match = router.match(method, url.pathname);

    if (match) {
      // Somebody is only "signed in" once the second factor has been proven.
      const user = await accountService.currentUser(req);

      if (match.options?.signedIn && !user) {
        refuseProtectedRoute(res, url);
        return;
      }

      const bodyLimit = match.options?.maxBodyBytes ?? config.maxRequestBodyBytes;
      const body = METHODS_WITH_BODY.has(method) ? await readJsonBody(req, bodyLimit) : {};

      const result = await match.handler({
        req,
        res,
        params: match.params,
        query: url.searchParams,
        body,
        user,
      });

      if (!res.writableEnded) sendJson(res, 200, result ?? {});
      return;
    }

    if (method === 'GET' && (await serveStaticFile(res, config.publicDir, url.pathname))) return;

    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    handleError(error, req, res);
  }
}

/** API callers get a 401 they can act on; browsers get sent to the sign-in page. */
function refuseProtectedRoute(res, url) {
  if (url.pathname.startsWith('/api/')) {
    sendJson(res, 401, { error: 'Sign in to do that.' });
    return;
  }

  const next = encodeURIComponent(url.pathname + url.search);
  res.writeHead(302, { Location: `/signin?next=${next}`, 'Cache-Control': 'no-store' });
  res.end();
}

function handleError(error, req, res) {
  if (res.writableEnded) return;

  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: error.message, details: error.details });
    return;
  }

  console.error(`[error] ${req.method} ${req.url}`, error);
  sendJson(res, 500, { error: 'Something went wrong on the server.' });
}

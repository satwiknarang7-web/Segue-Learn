import { Router } from '../lib/router.js';
import { dashboardService } from '../services/dashboardService.js';

/**
 * One dashboard, shaped by what the person actually does. Somebody who both
 * teaches and studies gets both halves; the page does not have to pick.
 */
export const dashboardRoutes = new Router();

dashboardRoutes.get('/api/dashboard', ({ user }) => dashboardService.forUser(user), {
  signedIn: true,
});

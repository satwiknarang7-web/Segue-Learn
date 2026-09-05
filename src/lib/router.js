/**
 * A very small path router: enough for this app, and one less dependency.
 * Patterns look like "/api/quizzes/:quizId/questions/:questionId".
 */
export class Router {
  #routes = [];

  #add(method, pattern, handler, options = {}) {
    const paramNames = [];
    const source = pattern
      .split('/')
      .map((segment) => {
        if (!segment.startsWith(':')) {
          return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
        paramNames.push(segment.slice(1));
        return '([^/]+)';
      })
      .join('/');

    this.#routes.push({
      method,
      regex: new RegExp(`^${source}/?$`),
      paramNames,
      handler,
      // `organiser: true` marks a route the passcode gate protects.
      options,
    });
    return this;
  }

  get(pattern, handler, options) {
    return this.#add('GET', pattern, handler, options);
  }

  post(pattern, handler, options) {
    return this.#add('POST', pattern, handler, options);
  }

  patch(pattern, handler, options) {
    return this.#add('PATCH', pattern, handler, options);
  }

  put(pattern, handler, options) {
    return this.#add('PUT', pattern, handler, options);
  }

  delete(pattern, handler, options) {
    return this.#add('DELETE', pattern, handler, options);
  }

  /** Merge another router's routes in, so route files stay separate. */
  use(router) {
    this.#routes.push(...router.routes);
    return this;
  }

  get routes() {
    return this.#routes;
  }

  match(method, pathname) {
    for (const route of this.#routes) {
      if (route.method !== method) continue;
      const match = route.regex.exec(pathname);
      if (!match) continue;

      const params = {};
      route.paramNames.forEach((name, index) => {
        params[name] = decodeURIComponent(match[index + 1]);
      });
      return { handler: route.handler, params, options: route.options };
    }
    return null;
  }
}

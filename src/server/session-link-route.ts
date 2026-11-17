// Fork patch #5 (docs/fork/STATUS.md): `GET /session/<claude-session-id>` opens that Claude
// session on the canvas. Everything that decides is here; `http.ts` only calls in.
//
// The route itself never reads disk or starts anything. It checks the id's shape and redirects to
// `/?session=<id>`, where the renderer looks the session up through `recentConversations.find`
// (core re-checks the id) and focuses or resumes it with the "Open recent" planner. A redirect rather
// than serving index.html here because the built page uses RELATIVE asset URLs
// (`./assets/…`), which would resolve under `/session/`.
//
// No confirm step, on purpose: the link can only reopen an existing session of this machine by its
// id; it carries no prompt, command, folder or text of anyone else's, so a page that navigates a
// browser here can at most bring a session the user already ran back onto their canvas.
import { CLAUDE_SESSION_UUID_RE } from '../shared/recent-conversations'

const PREFIX = '/session/'

/** `null`: not a session link. `{ok:false}`: a `/session/...` path whose id is not a session id. */
export function sessionLinkTarget(pathname: string): { ok: true; location: string } | { ok: false } | null {
  if (!pathname.startsWith(PREFIX)) return null
  const id = pathname.slice(PREFIX.length)
  if (!CLAUDE_SESSION_UUID_RE.test(id)) return { ok: false }
  return { ok: true, location: `/?session=${id}` }
}

/**
 * A post-login return path, accepted ONLY when it is exactly `/session/<uuid>`: anything wider is
 * an open redirect (`//evil.example`, `/\\evil`, an absolute URL). Used when the sign-in gate
 * sends a signed-out link click to the login page, and again when the form posts back.
 */
export function safeSessionNext(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = sessionLinkTarget(v)
  return t && t.ok ? v : null
}

/** `?next=…` for a login URL, or '' when there is no valid return path. */
export function nextQuery(next: string | null, sep: '?' | '&'): string {
  return next ? `${sep}next=${encodeURIComponent(next)}` : ''
}

export function notFoundSessionPage(): string {
  return '<!doctype html><html><head><meta charset="utf-8"><title>Not a session link — nodeterm</title></head><body style="font-family:system-ui,sans-serif;background:#111;color:#ddd;padding:40px"><h1 style="font-size:18px">Not a session link</h1><p>A nodeterm session link is <code>/session/&lt;Claude session id&gt;</code>, and this one does not name a session id.</p><p><a style="color:#8ab4f8" href="/">Open nodeterm</a></p></body></html>'
}

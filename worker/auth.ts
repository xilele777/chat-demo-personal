import { publicConfig } from './config.js'
import { SignJWT, jwtVerify } from 'jose'
import { HttpError, json, readJsonObject, type Env } from './types.js'

const SESSION_SECONDS = 30 * 24 * 60 * 60
const encoder = new TextEncoder()
const localRequest = (request: Request) =>
  ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname)
const configured = (env: Env) => Boolean(env.APP_PASSWORD && env.APP_PASSWORD.length >= 12)
const cookieName = (request: Request) =>
  new URL(request.url).protocol === 'https:' ? '__Host-personal-chat' : 'personal_chat_local'
export async function sessionBinding(request: Request) {
  const cookie =
    request.headers
      .get('Cookie')
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName(request)}=`)) ?? ''
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(cookie)))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
const key = async (env: Env) =>
  new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      encoder.encode(`personal-chat-session-v1:${env.APP_PASSWORD}`)
    )
  )

function sessionCookie(request: Request, value: string, age: number): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `${cookieName(request)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure}`
}

export async function authorize(request: Request, env: Env): Promise<void> {
  if (!configured(env)) {
    throw new HttpError(503, 'Set the APP_PASSWORD secret to a password of at least 12 characters.')
  }
  const cookie = request.headers
    .get('Cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName(request)}=`))
  if (!cookie) {
    throw new HttpError(401, 'Sign in with your access password.')
  }
  try {
    await jwtVerify(cookie.slice(cookie.indexOf('=') + 1), await key(env), {
      algorithms: ['HS256'],
      audience: 'personal-chat',
      issuer: new URL(request.url).origin,
      subject: 'owner',
      requiredClaims: ['exp', 'iat'],
    })
  } catch {
    throw new HttpError(401, 'Your session expired. Sign in again.')
  }
}

export async function authentication(
  request: Request,
  env: Env,
  path: string
): Promise<Response | null> {
  if (path === '/api/auth' && request.method === 'GET') {
    let authenticated = false
    try {
      await authorize(request, env)
      authenticated = true
    } catch {
      /* Only expose login state. */
    }
    return json({
      configured: configured(env),
      authenticated,
      ...(authenticated ? { config: publicConfig(env) } : {}),
    })
  }
  if (path === '/api/auth/login' && request.method === 'POST') {
    if (!configured(env)) {
      throw new HttpError(
        503,
        'Set the APP_PASSWORD secret to a password of at least 12 characters.'
      )
    }
    if (new URL(request.url).protocol !== 'https:' && !localRequest(request)) {
      throw new HttpError(400, 'Use HTTPS to sign in.')
    }
    if (!request.headers.get('Content-Type')?.includes('application/json')) {
      throw new HttpError(415, 'JSON is required')
    }
    const body = await readJsonObject(request)
    if (typeof body.password !== 'string' || body.password.length > 1024) {
      throw new HttpError(400, 'Invalid password')
    }
    const now = Math.floor(Date.now() / 1000)
    const ip = request.headers.get('CF-Connecting-IP') ?? 'local'
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode(`login:${ip}`))
    )
    const id = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    const attempts = await env.DB.batch([
      env.DB.prepare('DELETE FROM login_attempts WHERE expires_at <= ?').bind(now),
      env.DB.prepare(`INSERT INTO login_attempts (id, attempts, expires_at) VALUES (?, 1, ?)
        ON CONFLICT(id) DO UPDATE SET attempts = attempts + 1 RETURNING attempts`).bind(
        id,
        now + 900
      ),
    ])
    if (Number((attempts[1].results[0] as { attempts: number } | undefined)?.attempts) > 10) {
      throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.')
    }
    const [expected, actual] = await Promise.all([
      crypto.subtle.digest('SHA-256', encoder.encode(env.APP_PASSWORD)),
      crypto.subtle.digest('SHA-256', encoder.encode(body.password)),
    ])
    const left = new Uint8Array(expected)
    const right = new Uint8Array(actual)
    let difference = 0
    for (let i = 0; i < left.length; i++) {
      difference |= left[i] ^ right[i]
    }
    if (difference !== 0) {
      throw new HttpError(401, 'Incorrect access password.')
    }
    await env.DB.prepare('DELETE FROM login_attempts WHERE id = ?').bind(id).run()
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(`${SESSION_SECONDS}s`)
      .setAudience('personal-chat')
      .setSubject('owner')
      .setIssuer(new URL(request.url).origin)
      .sign(await key(env))
    const response = json({ ok: true })
    response.headers.set('Set-Cookie', sessionCookie(request, token, SESSION_SECONDS))
    return response
  }
  if (path === '/api/auth/logout' && request.method === 'POST') {
    const response = json({ ok: true })
    response.headers.set('Set-Cookie', sessionCookie(request, '', 0))
    // Keep unsynced local snapshots; logout must not silently delete the owner's work.
    response.headers.set('Clear-Site-Data', '"cookies", "cache"')
    return response
  }
  return null
}

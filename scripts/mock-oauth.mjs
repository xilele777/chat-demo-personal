import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

// A local OAuth server with PKCE and rotating refresh tokens, shared by API and browser checks.
export const mockOAuth = (port) => {
  const base = `http://127.0.0.1:${port}`
  const state = {
    access: '',
    refresh: '',
    registrations: 0,
    exchanges: 0,
    refreshes: 0,
    revoked: false,
    transient: false,
    short: false,
    unsafeMetadata: false,
  }
  const clients = new Map()
  const codes = new Map()
  const json = (res, value, status = 200) =>
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
  const issue = () => {
    state.access = `access-${randomUUID()}`
    state.refresh = `refresh-${randomUUID()}`
    const expires_in = state.short ? 1 : 3600
    state.short = false
    return {
      access_token: state.access,
      refresh_token: state.refresh,
      token_type: 'Bearer',
      expires_in,
    }
  }
  const handle = async (req, res) => {
    const url = new URL(req.url, base)
    if (
      url.pathname === '/oauth/resource' ||
      url.pathname.startsWith('/.well-known/oauth-protected-resource')
    ) {
      json(res, {
        resource: `${base}/oauth/mcp`,
        authorization_servers: [base],
        scopes_supported: ['read', 'write'],
      })
    } else if (url.pathname === '/.well-known/oauth-authorization-server') {
      json(res, {
        issuer: base,
        authorization_endpoint: `http://localhost:${port}/oauth/authorize`,
        token_endpoint: state.unsafeMetadata ? 'http://10.0.0.1/token' : `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true,
      })
    } else if (url.pathname === '/oauth/register') {
      let body = ''
      for await (const chunk of req) body += chunk
      const data = JSON.parse(body)
      assert.equal(data.token_endpoint_auth_method, 'none')
      assert.deepEqual(data.grant_types, ['authorization_code', 'refresh_token'])
      assert.ok(data.redirect_uris[0].endsWith('/mcp/oauth/callback'))
      const client_id = `client-${++state.registrations}`
      clients.set(client_id, data.redirect_uris[0])
      json(res, { ...data, client_id }, 201)
    } else if (url.pathname === '/oauth/authorize') {
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
      assert.equal(url.searchParams.get('resource'), `${base}/oauth/mcp`)
      assert.equal(
        url.searchParams.get('redirect_uri'),
        clients.get(url.searchParams.get('client_id'))
      )
      const code = randomUUID()
      codes.set(code, Object.fromEntries(url.searchParams))
      const callback = new URL(url.searchParams.get('redirect_uri'))
      callback.searchParams.set('code', code)
      callback.searchParams.set('state', url.searchParams.get('state'))
      callback.searchParams.set('iss', base)
      res.writeHead(302, { Location: callback.href }).end()
    } else if (url.pathname === '/oauth/token') {
      let body = ''
      for await (const chunk of req) body += chunk
      const data = new URLSearchParams(body)
      assert.equal(data.get('resource'), `${base}/oauth/mcp`)
      if (data.get('grant_type') === 'authorization_code') {
        const authorization = codes.get(data.get('code'))
        assert.ok(authorization)
        codes.delete(data.get('code'))
        assert.equal(data.get('client_id'), authorization.client_id)
        assert.equal(data.get('redirect_uri'), authorization.redirect_uri)
        assert.equal(
          createHash('sha256').update(data.get('code_verifier')).digest('base64url'),
          authorization.code_challenge
        )
        state.exchanges++
        state.revoked = false
        json(res, issue())
      } else {
        assert.equal(data.get('grant_type'), 'refresh_token')
        state.refreshes++
        await new Promise((resolve) => setTimeout(resolve, 150))
        if (state.transient) {
          json(res, { error: 'temporarily_unavailable', secret: state.refresh }, 503)
          return true
        }
        if (state.revoked || data.get('refresh_token') !== state.refresh) {
          json(res, { error: 'invalid_grant', secret: state.refresh }, 400)
        } else json(res, issue())
      }
    } else return false
    return true
  }
  return { state, handle }
}

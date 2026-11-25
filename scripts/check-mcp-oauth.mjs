import assert from 'node:assert/strict'

export async function checkMcpOAuth({ call, origin, cookie, mockPort, state }) {
  const config = {
    name: 'OAuth test',
    url: `http://127.0.0.1:${mockPort}/oauth/mcp`,
    enabled: true,
    authType: 'oauth',
    disabledTools: [],
  }
  const start = async (id = 'oauth-test', settings = config) => {
    const response = await call(`/mcp/servers/${id}/authorize`, 'POST', settings)
    assert.equal(response.status, 200, await response.clone().text())
    return (await response.json()).authorizationUrl
  }
  const consent = async (authorizationUrl) => {
    const response = await fetch(authorizationUrl, { redirect: 'manual' })
    assert.equal(response.status, 302)
    return response.headers.get('Location')
  }
  const callback = (url, headers = { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' }) =>
    fetch(url, { headers, redirect: 'manual' })
  const success = async (url) => {
    const response = await callback(url)
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Location'), '/?mcp_oauth=connected')
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer')
  }
  const failure = async (url, headers) => {
    const response = await callback(url, headers)
    assert.equal(response.headers.get('Location'), '/?mcp_oauth=failed')
  }
  assert.equal((await call('/mcp/servers/oauth-test/test', 'POST', config)).status, 428)
  state.unsafeMetadata = true
  assert.equal((await call('/mcp/servers/oauth-test/authorize', 'POST', config)).status, 400)
  state.unsafeMetadata = false
  const authorizationUrl = await start()
  assert.equal(state.registrations, 1)
  const returnUrl = await consent(authorizationUrl)
  const forged = new URL(returnUrl)
  forged.searchParams.set('state', 'forged')
  await failure(forged.href)
  await failure(returnUrl, {})
  assert.equal(state.exchanges, 0)
  await success(returnUrl)
  await failure(returnUrl)
  assert.equal(state.exchanges, 1)
  const list = await (await call('/mcp/servers')).json()
  assert.equal(list.servers[0].oauthStatus, 'authorized')
  assert.equal(list.servers[0].tools.length, 2)
  assert.doesNotMatch(JSON.stringify(list), /access-|refresh-|client-|code_verifier/)
  assert.equal(
    (
      await call('/mcp/servers/oauth-test', 'PUT', {
        ...list.servers[0],
        trustedReadTools: ['read_note'],
      })
    ).status,
    200
  )
  const chat = async () => {
    const response = await call('/anthropic/v1/messages', 'POST', {
      messages: [{ role: 'user', content: 'mcp-read' }],
    })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.match(text, /"status":"done"/)
    return text
  }
  await chat()
  state.access = 'rejected'
  await Promise.all([chat(), chat()])
  assert.equal(state.refreshes, 1, 'concurrent requests must share a rotating-token refresh')
  state.access = 'rejected'
  state.short = true
  await chat()
  await chat()
  assert.equal(state.refreshes, 3, 'short-lived tokens must refresh proactively')
  state.access = 'rejected'
  state.transient = true
  const transient = await (
    await call('/anthropic/v1/messages', 'POST', {
      messages: [{ role: 'user', content: 'mcp-read' }],
    })
  ).text()
  assert.doesNotMatch(transient, /refresh-/)
  assert.equal((await (await call('/mcp/servers')).json()).servers[0].oauthStatus, 'authorized')
  state.transient = false
  await chat()
  state.access = 'rejected'
  state.revoked = true
  const revoked = await (
    await call('/anthropic/v1/messages', 'POST', {
      messages: [{ role: 'user', content: 'mcp-read' }],
    })
  ).text()
  assert.doesNotMatch(revoked, /refresh-|access-/)
  assert.equal((await (await call('/mcp/servers')).json()).servers[0].oauthStatus, 'required')
  const renewals = state.refreshes
  await call('/mcp/servers/oauth-test/test', 'POST', config)
  assert.equal(state.refreshes, renewals, 'invalid_grant must not loop')
  await success(await consent(await start()))
  assert.equal(state.registrations, 1, 'reuse registration for the same URL, issuer and callback')
  const wrongIssuer = new URL(await consent(await start()))
  wrongIssuer.searchParams.set('iss', 'https://wrong.example')
  await failure(wrongIssuer.href)
  const cancelled = new URL(await consent(await start()))
  cancelled.searchParams.set('error', 'access_denied')
  await failure(cancelled.href)
  assert.equal((await (await call('/mcp/servers')).json()).servers[0].oauthStatus, 'authorized')
  // Change settings after the callback's initial check, while tools are being discovered.
  // Even if the final settings match the flow, its credentials must not overwrite the edit.
  const concurrentSettings = { ...config, name: 'Concurrent edit', enabled: false }
  const concurrentReturn = await consent(await start('oauth-test', concurrentSettings))
  state.beforeList = async () => {
    assert.equal((await call('/mcp/servers/oauth-test', 'PUT', concurrentSettings)).status, 200)
  }
  await failure(concurrentReturn)
  assert.equal((await call('/mcp/servers/oauth-test/test', 'POST', concurrentSettings)).status, 428)
  await success(await consent(await start()))
  const stale = await consent(await start())
  await call('/mcp/servers/oauth-test', 'PUT', {
    ...config,
    name: 'Edited while authorizing',
    enabled: false,
  })
  await failure(stale)
  const deleted = await consent(await start())
  await call('/mcp/servers/oauth-test', 'DELETE')
  await failure(deleted)
  assert.equal((await (await call('/mcp/servers')).json()).servers.length, 0)
  assert.equal(
    (
      await fetch(`${origin}/api/mcp/servers/oauth-test/authorize`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: 'https://another.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(config),
      })
    ).status,
    403
  )
  console.log(
    'PASS: MCP OAuth PKCE, session-bound single-use callback, hidden credentials, concurrent refresh, transient failures, revocation and stale-flow rejection'
  )
}

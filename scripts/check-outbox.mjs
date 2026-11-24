import assert from 'node:assert/strict'
import { outboxKey, recoverOutbox } from '../src/services/chat/outbox.ts'

const session = {
  id: 'conversation',
  title: 'Original',
  createdAt: 1,
  updatedAt: 2,
  cloud: { revision: 'r1', generation: 'g1' },
  messages: [],
}
const remote = new Set([session.id])
const a = {
  id: outboxKey(session.id, 'page-a'),
  writer: 'page-a',
  version: 'v-a',
  session: { ...session, title: 'A unsaved' },
}
const b = {
  id: outboxKey(session.id, 'page-b'),
  writer: 'page-b',
  version: 'v-b',
  session: { ...session, title: 'B unsaved' },
}
assert.notEqual(a.id, b.id)
assert.notEqual(outboxKey('a:b', 'c'), outboxKey('a', 'b:c'))
assert.equal(outboxKey(session.id), session.id)
const single = await recoverOutbox([a], 'g1', remote, 'Local copy')
assert.equal(single[0].session, a.session)
const recovered = await recoverOutbox([a, b], 'g1', remote, 'Local copy')
assert.equal(new Set(recovered.map((item) => item.session.id)).size, 2)
assert.ok(recovered.every((item) => item.session.id !== session.id))
assert.deepEqual(
  recovered.map((item) => item.session.title),
  ['A unsaved (Local copy)', 'B unsaved (Local copy)']
)
assert.ok(
  recovered.every(
    (item) => item.session.cloud.revision === null && item.session.cloud.generation === 'g1'
  )
)
assert.deepEqual(await recoverOutbox([a, b], 'g1', remote, 'Local copy'), recovered)
assert.equal(recovered[0].source, a)
assert.equal(recovered[1].source, b)
const editedCopy = {
  id: outboxKey(recovered[0].session.id, 'recovery-page'),
  writer: 'recovery-page',
  version: 'edited-copy',
  session: { ...recovered[0].session, title: 'Edited recovery copy' },
}
const secondCrash = await recoverOutbox([editedCopy, b, a], 'g1', remote, 'Local copy')
assert.equal(new Set(secondCrash.map((item) => item.session.id)).size, 3)
assert.ok(secondCrash.some((item) => item.session.title.includes('Edited recovery copy')))
assert.ok(secondCrash.some((item) => item.session.title.includes('A unsaved')))
assert.equal(a.session.id, session.id)
const replacement = await recoverOutbox([a], 'g2', remote, 'Local copy')
assert.notEqual(replacement[0].session.id, session.id)
assert.equal(replacement[0].session.cloud.generation, 'g2')
const deletion = await recoverOutbox([a], 'g1', new Set(), 'Local copy')
assert.notEqual(deletion[0].session.id, session.id)
const fresh = {
  id: 'new',
  session: { ...session, id: 'new', cloud: { revision: null, generation: 'g1' } },
}
assert.equal((await recoverOutbox([fresh], 'g1', remote, 'Local copy'))[0].session, fresh.session)
const legacy = { id: session.id, session }
const legacyRecovered = await recoverOutbox([legacy, a], 'g1', remote, 'Local copy')
assert.deepEqual(await recoverOutbox([legacy, a], 'g1', remote, 'Local copy'), legacyRecovered)
console.log(
  'PASS: per-page snapshot identities, distinct stable recovery copies, legacy compatibility and recovery after deletion/history replacement'
)

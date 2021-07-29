'use strict'
const Notify = require('pull-notify')
const pull = require('pull-stream')
const isBlobId = require('ssb-ref').isBlob
const pullDefer = require('pull-defer')

const MB = 1024 * 1024
const MAX_SIZE = 5 * MB

function isEmpty (o) {
  for (const k in o) if (k) return false
  return true
}

function clone (obj) {
  const o = {}
  for (const k in obj) { o[k] = obj[k] }
  return o
}

function onAbort (abortCb) {
  return function (read) {
    return function (abort, cb) {
      if (abort) abortCb(abort, cb)
      else read(null, cb)
    }
  }
}

function toBlobId (id) {
  if (Array.isArray(id)) return id// .map(toBlobId)
  return isBlobId(id) ? id : isBlobId(id && id.id) ? id.id : null
}

function wrap (fn) {
  return function (id, cb) {
    if (!toBlobId(id)) {
      cb = id
      return fn.call(this, cb)
    }
    return fn.call(this, toBlobId(id), cb)
  }
}

function isFunction (f) {
  return !!(f && f.constructor && f.call && f.apply)
}

module.exports = function inject (blobStore, blobPush, name, opts) {
  opts = opts || {}
  // sympathy controls whether you'll replicate
  const sympathy = opts.sympathy == null ? 3 : opts.sympathy | 0
  const stingy = opts.stingy === true
  const legacy = opts.legacy !== false
  const pushy = opts.pushy || 3
  const max = opts.max || MAX_SIZE

  const peers = {} // currently connected peers - { PeerId: RPC }
  const peerBlobs = {} // tracks blob locations - { PeerId: { BlobId: Size } }
  const streams = {} // { PeerId: PullSource }

  const want = {} // which blobs we'd like to get ahold of { BlobId: hops }
  const push = {} // who we've pushed a Blob to this session - { BlobId: { PeerId } }

  const wantCallbacks = {} // queue of callbacks from the want method - { BlobId: [function] }
  const getting = {} // blobs and which peers we're currently getting them from - { BlobId: PeerId }

  const pushed = Notify() // makes a stream of blob hashes which have reached 'pushy' goal
  const notify = Notify() // used with createWants + legacySync

  blobPush.updates(update => {
    const notification = {}
    Object.keys(update).forEach(blobId => {
      notification[blobId] = -1
      push[blobId] = push[blobId] || {}
    })
    notify(notification) // update all currently connected peers about new push
  })

  function registerWant (id, hops = -1) {
    if (hops >= 0) throw new Error(`registerWant expects hops >= 0, got ${hops}`)
    want[id] = hops
    notify({ [id]: hops })
  }

  function findPeerWithBlob (blobId) {
    for (const peerId in peers) {
      if (
        peers[peerId] &&
        peerBlobs[peerId] &&
        peerBlobs[peerId][blobId] < max
      ) return peerId
    }
  }

  function get (peerId, id) {
    if (getting[id]) return

    if (!peers[peerId]) peerId = findPeerWithBlob(id)
    if (!peerId) return

    getting[id] = peerId
    pull(
      peers[peerId].blobs.get({ key: id, max: max }), // source
      blobStore.add(id, (err, _id) => { // sink
        delete getting[id]
        if (err) {
          if (peerBlobs[peerId]) delete peerBlobs[peerId][id]
          // check if another peer has this.
          // if so get it from them.
          peerId = findPeerWithBlob(id)
          if (peerId) get(peerId, id)
        }
      })
    )
  }

  pull(
    blobStore.ls({ old: false, meta: true }),
    pull.drain(function (data) {
      registerHas(data.id, data.size)

      if (wantCallbacks[data.id]) {
        while (wantCallbacks[data.id].length) {
          if (isFunction(wantCallbacks[data.id])) {
            wantCallbacks[data.id].shift()(null, true)
          }
        }
      }
    })
  )
  function registerHas (id, size) {
    delete want[id]
    notify({ [id]: size })
  }

  function registerRemoteHas (peerId, blobId, size) {
    if (typeof peerId !== 'string') throw new Error('peer must be string id')
    peerBlobs[peerId] = peerBlobs[peerId] || {}
    peerBlobs[peerId][blobId] = size
    // if we are broadcasting this blob,
    // mark this peer has it.id
    // if N peers have it, we can stop broadcasting.
    if (push[blobId]) {
      push[blobId][peerId] = size
      if (Object.keys(push[blobId]).length >= pushy) {
        pushed({ key: blobId, peers: push[blobId] })

        blobPush.remove(blobId)
        delete push[blobId]
      }
    }

    if (getting[blobId]) return
    if (want[blobId]) {
      if (size < max) get(peerId, blobId)
      else console.warn(`want blob ${blobId} but size ${size} >= ${max} (currently set blobs.max)`)
    }
  }

  function dead (peerId) {
    delete peers[peerId]
    delete peerBlobs[peerId]
    delete streams[peerId]
  }

  function createWantStream (id) {
    if (!streams[id]) {
      streams[id] = notify.listen()

      // merge in ids we are pushing.
      const w = clone(want)
      for (const k in push) w[k] = -1
      streams[id].push(w)
    }
    return pull(
      streams[id],
      onAbort((err, cb) => {
        streams[id] = false
        cb(err)
      })
    )
  }

  function wantSink (peer) {
    createWantStream(peer.id) // set streams[peer.id]

    let modern = false
    return pull.drain(
      function (data) {
        modern = true
        // respond with list of blobs you already have,
        process(data, peer.id, function (err, hasData) {
          if (err) console.error(err) // ):
          if (isEmpty(hasData)) return

          if (streams[peer.id]) streams[peer.id].push(hasData)
        })
      },
      err => {
        if (err && !modern) {
          streams[peer.id] = false
          if (legacy) legacySync(peer)
          return
        }
        // if can handle unpeer another way,
        // then can refactor legacy handling out of sight.

        // handle error and fallback to legacy mode, if enabled.
        if (peers[peer.id] === peer) dead(peer.id)
      }
    )
  }
  function process (data, peer, cb) {
    const res = {}
    let n = 0

    for (const id in data) {
      (function (id) {
        if (isBlobId(id) && Number.isInteger(data[id])) {
          if (data[id] < 0 && (opts.stingy !== true || push[id])) { // interpret as "WANT"
            n++
            // check whether we already *HAVE* this file.
            // respond with it's size, if we do.
            blobStore.size(id, function (err, size) { // XXX
              if (err) return cb(err)

              if (size) res[id] = size
              else sympatheticGet(id, data[id] - 1) // a sympathetic get
              next()
            })
          } else if (data[id] > 0) { // interpret as "HAS"
            if (data[id] >= max) console.warn(`process found blob ${id} has size >= blobs.max`)
            registerRemoteHas(peer, id, data[id])
          }
        }
      }(id))
    }

    function next () {
      if (--n) return
      cb(null, res)
    }
  }
  function sympatheticGet (id, hops) {
    if (Math.abs(hops) > sympathy) return // sorry!
    if (want[id] && want[id] <= hops) return // higher priority want already happening

    registerWant(id, hops)
    const peerId = findPeerWithBlob(id)
    if (peerId) get(peerId, id)
  }

  // LEGACY LEGACY LEGACY
  function legacySync (peer) {
    if (!legacy) return

    let drain // eslint-disable-line
    // we need to keep a reference to drain so we can abort it when we get an error.
    function hasLegacy (hashes) {
      const ary = Object.keys(hashes).filter(function (k) {
        return hashes[k] < 0
      })
      if (ary.length) {
        peer.blobs.has(ary, function (err, haves) {
          if (err) drain.abort(err) // ERROR: abort this stream.
          else {
            haves.forEach(function (have, i) {
              if (have) registerRemoteHas(peer.id, ary[i], have)
            })
          }
        })
      }
    }

    drain = pull.drain(
      hash => registerRemoteHas(peer.id, hash, true),
      err => { if (err) dead(peer.id) }
    )

    pull(peer.blobs.changes(), drain)

    hasLegacy(want)

    // a stream of hashes
    pull(
      notify.listen(),
      pull.drain(
        hasLegacy,
        err => { if (err) dead(peer.id) }
      )
    )
  }
  // LEGACY LEGACY LEGACY

  const self = {
    // id: name,
    has: function (id, cb) {
      id = toBlobId(id)

      if (Array.isArray(id)) {
        for (let i = 0; i < id.length; i++) {
          if (!isBlobId(id[i])) return cb(new Error('invalid id:' + id[i]))
        }
      } else if (!isBlobId(id)) {
        return cb(new Error('invalid id:' + id))
      }

      if (legacy !== true) {
        blobStore.has.call(this, id, cb)
        return
      }

      // LEGACY LEGACY LEGACY
      if (this === self || !this || this === global) { // a local call
        return blobStore.has.call(this, id, cb)
      }
      // ELSE, interpret remote calls to has as a WANT request.
      // handling this by calling process (which calls size())
      // avoids a race condition in the tests.
      // (and avoids doubling the number of calls)
      const a = Array.isArray(id) ? id : [id]
      const o = {}
      a.forEach(function (h) { o[h] = -1 })
      // since this is always "has" process will never use the second arg.
      process(o, null, function (err, res) {
        if (err) return cb(err)
        const a = []; for (const k in o) a.push(res[k] > 0)
        cb(null, Array.isArray(id) ? a : a[0])
      })
      // LEGACY LEGACY LEGACY
    },
    size: wrap(blobStore.size),
    get: blobStore.get,
    getSlice: blobStore.getSlice,
    add (id, cb) {
      const blobId = toBlobId(id)
      cb = typeof cb === 'function'
        ? cb
        : typeof id === 'function'
          ? id
          : (err, blobId) => { if (err) throw err }

      const sink = blobId ? blobStore.add(blobId, cb) : blobStore.add(cb)
      let size = 0

      return pull(
        pull.asyncMap((m, cb) => {
          size += m.length
          if (size >= max) cb(new Error("Cannot add blob, it's bigger than blobs.max"))
          else cb(null, m)
        }),
        sink
      )
    },
    rm: wrap(blobStore.rm),
    ls: blobStore.ls,
    changes: function () {
      // XXX for bandwidth sensitive peers, don't tell them about blobs we arn't trying to push.
      return pull(
        blobStore.ls({ old: false, meta: false }),
        pull.filter(function (id) {
          return !stingy || push[id]
        })
      )
    },
    want: function (id, cb) {
      id = toBlobId(id)
      if (!isBlobId(id)) { return cb(new Error('invalid id:' + id)) }
      // always broadcast wants immediately, because of race condition
      // between has and adding a blob (needed to pass test/async.js)
      if (blobStore.isEmptyHash(id)) return cb(null, true)

      if (wantCallbacks[id]) wantCallbacks[id].push(cb)
      else {
        wantCallbacks[id] = [cb]
        blobStore.size(id, function (err, size) {
          if (err) return cb(err)
          if (size != null) {
            while (wantCallbacks[id].length) {
              if (isFunction(wantCallbacks[id])) {
                wantCallbacks[id].shift()(null, true)
              }
            }
            delete wantCallbacks[id]
          }
        })
      }

      const peerId = findPeerWithBlob(id)
      if (peerId) get(peerId, id) // NOTE used to early return here

      if (wantCallbacks[id]) registerWant(id)
    },
    push: function (id, cb) {
      id = toBlobId(id)
      if (!isBlobId(id)) return cb(new Error('invalid hash:' + id))

      registerWant(id) // pretend we want the blob to stimulate sympathetic replication
      blobPush.add(id, cb) // leads to update of push ^
    },
    pushed: function () {
      return pushed.listen()
    },
    createWants: function () {
      const source = pullDefer.source()
      blobPush.onReady(() => {
        source.resolve(createWantStream(this.id))
      })
      return source
    },
    // private api. used for testing. not exposed over rpc.
    _wantSink: wantSink,
    _onConnect: function (other, name) {
      peers[other.id] = other
      // sending of your wants starts when we know they are not legacy style.
      // process is called when wantSync doesn't immediately get an error.
      pull(
        other.blobs.createWants(),
        // pull.through(m => console.log('WANT STREAM', m)),
        wantSink(other)
      )
    },
    help: function () {
      return require('./help')
    }
  }

  return self
}

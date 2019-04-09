
import {
  GC,
  AbstractRef, ID, ItemType, AbstractItem, AbstractStruct // eslint-disable-line
} from '../internals.js'

import * as math from 'lib0/math.js'
import * as error from 'lib0/error.js'
import * as encoding from 'lib0/encoding.js'
import * as decoding from 'lib0/decoding.js'

export class StructStore {
  constructor () {
    /**
     * @type {Map<number,Array<AbstractStruct>>}
     */
    this.clients = new Map()
    /**
     * Store uncompleted struct readers here
     * @see tryResumePendingReaders
     * @type {Set<{stack:Array<AbstractRef>,structReaders:Map<number,IterableIterator<AbstractRef>>,missing:ID,structReaderIterator:IterableIterator<IterableIterator<AbstractRef>>,structReaderIteratorResult:IteratorResult<IterableIterator<AbstractRef>>}>}
     */
    this.pendingStructReaders = new Set()
    /**
     * @type {Array<decoding.Decoder>}
     */
    this.pendingDeleteReaders = []
  }
}

/**
 * Return the states as a Map<client,clock>.
 * Note that clock refers to the next expected clock id.
 *
 * @param {StructStore} store
 * @return {Map<number,number>}
 */
export const getStates = store => {
  const sm = new Map()
  store.clients.forEach((structs, client) => {
    const struct = structs[structs.length - 1]
    sm.set(client, struct.id.clock + struct.length)
  })
  return sm
}

/**
 * @param {StructStore} store
 * @param {number} client
 */
export const getState = (store, client) => {
  const structs = store.clients.get(client)
  if (structs === undefined) {
    return 0
  }
  const lastStruct = structs[structs.length - 1]
  return lastStruct.id.clock + lastStruct.length
}

/**
 * @param {StructStore} store
 */
export const integretyCheck = store => {
  store.clients.forEach(structs => {
    for (let i = 1; i < structs.length; i++) {
      const l = structs[i - 1]
      const r = structs[i]
      if (l.id.clock + l.length !== r.id.clock) {
        throw new Error('StructStore failed integrety check')
      }
    }
  })
}

/**
 * @param {StructStore} store
 * @param {AbstractStruct} struct
 */
export const addStruct = (store, struct) => {
  let structs = store.clients.get(struct.id.client)
  if (structs === undefined) {
    structs = []
    store.clients.set(struct.id.client, structs)
  } else {
    const lastStruct = structs[structs.length - 1]
    if (lastStruct.id.clock + lastStruct.length !== struct.id.clock) {
      throw error.unexpectedCase()
    }
  }
  structs.push(struct)
}

/**
 * Perform a binary search on a sorted array
 * @param {Array<any>} structs
 * @param {number} clock
 * @return {number}
 * @private
 */
export const findIndexSS = (structs, clock) => {
  let left = 0
  let right = structs.length - 1
  while (left <= right) {
    const midindex = math.floor((left + right) / 2)
    const mid = structs[midindex]
    const midclock = mid.id.clock
    if (midclock <= clock) {
      if (clock < midclock + mid.length) {
        return midindex
      }
      left = midindex + 1
    } else {
      right = midindex - 1
    }
  }
  // Always check state before looking for a struct in StructStore
  // Therefore the case of not finding a struct is unexpected
  throw error.unexpectedCase()
}

/**
 * Expects that id is actually in store. This function throws or is an infinite loop otherwise.
 *
 * @param {StructStore} store
 * @param {ID} id
 * @return {AbstractStruct}
 * @private
 */
export const find = (store, id) => {
  /**
   * @type {Array<AbstractStruct>}
   */
  // @ts-ignore
  const structs = store.clients.get(id.client)
  return structs[findIndexSS(structs, id.clock)]
}

/**
 * Expects that id is actually in store. This function throws or is an infinite loop otherwise.
 *
 * @param {StructStore} store
 * @param {ID} id
 * @return {AbstractItem}
 */
// @ts-ignore
export const getItem = (store, id) => find(store, id)

/**
 * Expects that id is actually in store. This function throws or is an infinite loop otherwise.
 *
 * @param {StructStore} store
 * @param {ID} id
 * @return {ItemType}
 */
// @ts-ignore
export const getItemType = (store, id) => find(store, id)

/**
 * Expects that id is actually in store. This function throws or is an infinite loop otherwise.
 * @param {StructStore} store
 * @param {ID} id
 * @return {AbstractItem}
 *
 * @private
 */
export const getItemCleanStart = (store, id) => {
  /**
   * @type {Array<AbstractItem>}
   */
  // @ts-ignore
  const structs = store.clients.get(id.client)
  const index = findIndexSS(structs, id.clock)
  /**
   * @type {AbstractItem}
   */
  let struct = structs[index]
  if (struct.id.clock < id.clock && struct.constructor !== GC) {
    struct = struct.splitAt(id.clock - struct.id.clock)
    structs.splice(index + 1, 0, struct)
  }
  return struct
}

/**
 * Expects that id is actually in store. This function throws or is an infinite loop otherwise.
 * @param {StructStore} store
 * @param {ID} id
 * @return {AbstractItem}
 *
 * @private
 */
export const getItemCleanEnd = (store, id) => {
  /**
   * @type {Array<AbstractItem>}
   */
  // @ts-ignore
  const structs = store.clients.get(id.client)
  const index = findIndexSS(structs, id.clock)
  const struct = structs[index]
  if (id.clock !== struct.id.clock + struct.length - 1 && struct.constructor !== GC) {
    structs.splice(index + 1, 0, struct.splitAt(id.clock - struct.id.clock + 1))
  }
  return struct
}

/**
 * Replace `item` with `newitem` in store
 * @param {StructStore} store
 * @param {AbstractStruct} struct
 * @param {AbstractStruct} newStruct
 */
export const replaceStruct = (store, struct, newStruct) => {
  /**
   * @type {Array<AbstractStruct>}
   */
  // @ts-ignore
  const structs = store.clients.get(struct.id.client)
  structs[findIndexSS(structs, struct.id.clock)] = newStruct
}

/**
 * @param {StructStore} store
 * @param {ID} id
 * @return {boolean}
 */
export const exists = (store, id) => id.clock < getState(store, id.client)

/**
 * Read StateMap from Decoder and return as Map
 *
 * @param {decoding.Decoder} decoder
 * @return {Map<number,number>}
 */
export const readStatesAsMap = decoder => {
  const ss = new Map()
  const ssLength = decoding.readVarUint(decoder)
  for (let i = 0; i < ssLength; i++) {
    const client = decoding.readVarUint(decoder)
    const clock = decoding.readVarUint(decoder)
    ss.set(client, clock)
  }
  return ss
}

/**
 * Write StateMap to Encoder
 *
 * @param {encoding.Encoder} encoder
 * @param {StructStore} store
 */
export const writeStates = (encoder, store) => {
  encoding.writeVarUint(encoder, store.clients.size)
  store.clients.forEach((structs, client) => {
    const id = structs[structs.length - 1].id
    encoding.writeVarUint(encoder, id.client)
    encoding.writeVarUint(encoder, id.clock)
  })
  return encoder
}
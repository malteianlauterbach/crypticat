import WebSocket from 'ws'
import crypto from 'crypto'
import createUid from 'uid-promise'
import { waitFor, assertDefined } from './lib'
import { EventEmitter } from 'events'

interface KeyPayload {
  key: string
}

export interface Room {
  name: string
  links: string[]
  prime: Buffer
}

declare interface CrypticatServer {
  on(event: 'connect', listener: (uid: string) => void): this
  on(event: 'join', listener: (uid: string, room: string) => void): this
  on(event: 'dispatch', listener: (fromUid: string, toUid: string) => void): this
  on(event: 'disconnect', listener: (uid: string) => void): this
}

class CrypticatServer extends EventEmitter {
  sockets: { [key: string]: WebSocket } = {}
  rooms: Room[] = []
  wss?: WebSocket.Server

  constructor() { super() }

  listen(port: number) {
    this.wss = new WebSocket.Server({ port })

    this.wss.on('connection', async (ws) => {
      const uid = await createUid(20)
      this.sockets[uid] = ws

      this.emit('connect', uid)
      let room: Room | null = null

      const leaveRoom = async () => {
        assertDefined(room)

        if (room.links[0] === uid) {
          // This is the head
          if (room.links[1]) {
            // There's a previous link in the chain
            this.sockets[room.links[1]].send(JSON.stringify({
              action: 'CLEAR_NEXT_LINK',
              payload: {}
            }))
            room.links.shift()
          } else {
            // This is the only link in the chain
            this.rooms.splice(this.rooms.findIndex(({ name }) => name === room?.name), 1)
          }
        } else if (room.links[room.links.length - 1] === uid) {
          // This is the end link
          this.sockets[room.links[room.links.length - 2]].send(JSON.stringify({
            action: 'CLEAR_PREV_LINK',
            payload: {}
          }))
          room.links.pop()
        } else {
          // This is a middle link, so faciliate key exchange between surrounding links
          const linkIndex = room.links.findIndex((item) => item === uid)

          const bobWs = this.sockets[room.links[linkIndex - 1]]
          const aliceWs = this.sockets[room.links[linkIndex + 1]]

          bobWs.send(JSON.stringify({
            action: 'GENERATE_KEY',
            payload: { prime: room.prime.toString('hex') }
          }))
          const { key: bobKey } = await waitFor<KeyPayload>(bobWs, 'KEY')

          aliceWs.send(JSON.stringify({
            action: 'GENERATE_KEY',
            payload: { prime: room.prime.toString('hex') }
          }))
          const { key: aliceKey } = await waitFor<KeyPayload>(aliceWs, 'KEY')

          bobWs.send(JSON.stringify({
            action: 'PREV_LINK',
            payload: { key: aliceKey, uid: room.links[linkIndex + 1] }
          }))

          aliceWs.send(JSON.stringify({
            action: 'NEXT_LINK',
            payload: { key: bobKey, uid: room.links[linkIndex - 1] }
          }))

          room.links.splice(linkIndex, 1)
        }

        room = null
      }

      ws.on('message', async (message: string) => {
        const { action, payload } = JSON.parse(message)

        switch (action) {
          case 'JOIN_ROOM': {
            this.emit('join', uid, payload.name)

            if (room) {
              await leaveRoom()
            }

            const existingRoom = this.rooms.find(({ name }) => name === payload.name)
            if (!existingRoom) {
              const df = crypto.createDiffieHellman(256)
              room = {
                name: payload.name,
                prime: df.getPrime(),
                links: [uid]
              }
              this.rooms.push(room)

              ws.send(JSON.stringify({
                action: 'ROOM_READY',
                payload: {}
              }))

              break
            }

            ws.send(JSON.stringify({
              action: 'GENERATE_KEY',
              payload: { prime: existingRoom.prime.toString('hex') }
            }))
            const { key: bobKey } = await waitFor<KeyPayload>(ws, 'KEY')

            const aliceWs = this.sockets[existingRoom.links[0]]
            aliceWs.send(JSON.stringify({
              action: 'GENERATE_KEY',
              payload: { prime: existingRoom.prime.toString('hex') }
            }))
            const { key: aliceKey } = await waitFor<KeyPayload>(aliceWs, 'KEY')

            ws.send(JSON.stringify({
              action: 'PREV_LINK',
              payload: { key: aliceKey, uid: existingRoom.links[0] }
            }))

            aliceWs.send(JSON.stringify({
              action: 'NEXT_LINK',
              payload: { key: bobKey, uid }
            }))

            existingRoom.links.unshift(uid)
            room = existingRoom

            ws.send(JSON.stringify({
              action: 'ROOM_READY',
              payload: {}
            }))

            break
          }

          case 'DISPATCH_ENCRYPTED': {
            this.emit('dispatch', uid, payload.recipient)

            const recipientWs = this.sockets[payload.recipient]
            recipientWs.send(JSON.stringify({
              action: 'ENCRYPTED_PAYLOAD',
              from: uid,
              payload: {
                encryptedMessage: payload.encryptedMessage,
                dir: payload.dir
              }
            }))

            break
          }
        }
      })

      ws.on('close', () => {
        this.emit('disconnect', uid)
        leaveRoom()
      })
    })
  }
}

export { CrypticatServer }
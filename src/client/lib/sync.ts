import { useEffect, useRef } from 'react'
import type { RealtimeMessage } from '@shared/types'
import { CLIENT_ID } from './api'
import { createBroadcast, type BroadcastPayload } from './db'
import { acknowledgeOutboxBaseAdvanced, acknowledgeOutboxResult, useNotes } from '../store/notes'
import { useSession } from '../store/session'


const HEARTBEAT_MS = 25_000
const SAFETY_POLL_MS = 5 * 60_000
const MAX_BACKOFF_MS = 30_000

export class SyncEngine {
  private socket: WebSocket | null = null
  private pollTimer = 0
  private heartbeatTimer = 0
  private reconnectTimer = 0
  private pullTimer = 0
  private leadershipTimer = 0
  private failures = 0
  private disposed = false
  private isLeader = false
  private ownClaimAt = 0
  private bestClaim: { clientId: string; at: number } | null = null
  private scheduledPullShouldBroadcast = false
  private pullDueAt = 0
  private lastPullAt = 0
  private lastPong = 0
  private broadcast = createBroadcast((payload) => this.onBroadcast(payload))

  constructor(
    private realtimeEnabled: boolean,
    private pollIntervalMs: number,
  ) {}

  /**
   * Applies live setting changes (realtime toggle, poll interval) without
   * tearing down the engine, its WebSocket, or its leadership claim.
   */
  updateConfig(realtimeEnabled: boolean, pollIntervalMs: number): void {
    const interval = Math.max(5000, pollIntervalMs)
    if (interval !== this.pollIntervalMs) {
      this.pollIntervalMs = interval
      this.startPolling()
    }
    if (realtimeEnabled === this.realtimeEnabled) return
    this.realtimeEnabled = realtimeEnabled
    if (realtimeEnabled) {
      if (this.isLeader) this.connect()
    } else {
      window.clearTimeout(this.reconnectTimer)
      window.clearInterval(this.heartbeatTimer)
      this.socket?.close()
      this.socket = null
    }
  }

  start(): void {
    this.claimLeadership()
    document.addEventListener('visibilitychange', this.onVisibility)
    window.addEventListener('focus', this.onFocus)
    window.addEventListener('online', this.onOnline)
    window.addEventListener('offline', this.onOffline)
    window.addEventListener('pagehide', this.onPageHide)
    this.startPolling()
  }

  dispose(): void {
    this.disposed = true
    document.removeEventListener('visibilitychange', this.onVisibility)
    window.removeEventListener('focus', this.onFocus)
    window.removeEventListener('online', this.onOnline)
    window.removeEventListener('offline', this.onOffline)
    window.removeEventListener('pagehide', this.onPageHide)
    window.clearInterval(this.pollTimer)
    window.clearInterval(this.heartbeatTimer)
    window.clearTimeout(this.reconnectTimer)
    window.clearTimeout(this.pullTimer)
    this.pullTimer = 0
    this.pullDueAt = 0
    window.clearTimeout(this.leadershipTimer)
    this.socket?.close()
    this.socket = null
    this.broadcast.close()
  }


  private claimLeadership(): void {
    const claim = { type: 'claim-leader' as const, clientId: CLIENT_ID, at: Date.now() }
    this.ownClaimAt = claim.at
    this.bestClaim = claim
    this.broadcast.post(claim)
    window.clearTimeout(this.leadershipTimer)
    this.leadershipTimer = window.setTimeout(() => {
      if (this.disposed) return
      const winner = this.bestClaim
      this.setLeadership(
        Boolean(
          winner &&
            winner.clientId === CLIENT_ID &&
            winner.at === claim.at &&
            this.ownClaimAt === claim.at,
        ),
      )
    }, 260)
  }

  private onBroadcast(payload: BroadcastPayload): void {
    if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') return
    if (payload.type === 'profile-changed') {
      if (payload.clientId !== CLIENT_ID) {
        void useSession.getState().refresh().catch(() => {})
      }
      this.schedulePull(payload.clientId === CLIENT_ID ? 700 : 300, false)
      return
    }
    if (payload.type === 'settings-changed') {
      if (payload.clientId !== CLIENT_ID) {
        void useSession.getState().refreshSettings().catch(() => {})
      }
      this.schedulePull(payload.clientId === CLIENT_ID ? 700 : 400, false)
      return
    }
    if (payload.type === 'site-changed') {
      if (payload.clientId !== CLIENT_ID) {
        void useSession.getState().refresh().catch(() => {})
      }
      return
    }
    if (payload.type === 'outbox-result') {
      if (payload.targetClientId === CLIENT_ID) acknowledgeOutboxResult(payload)
      return
    }
    if (payload.type === 'outbox-base-advanced') {
      if (payload.clientId !== CLIENT_ID) void acknowledgeOutboxBaseAdvanced(payload)
      return
    }
    if (payload.type === 'claim-leader') {
      if (
        payload.clientId === CLIENT_ID ||
        !Number.isFinite(payload.at) ||
        !payload.clientId
      ) {
        return
      }
      if (!this.bestClaim || compareClaims(payload, this.bestClaim) > 0) this.bestClaim = payload
      if (
        this.isLeader &&
        compareClaims(payload, { clientId: CLIENT_ID, at: this.ownClaimAt }) > 0
      ) {
        this.setLeadership(false)
      }
      return
    }
    if (payload.type === 'pulled' && payload.clientId !== CLIENT_ID) {
      if (payload.cursor > useNotes.getState().cursor) this.schedulePull(150, false)
      return
    }
    if (payload.type === 'local-write') {


      this.schedulePull(payload.clientId === CLIENT_ID ? 700 : 400, false)
    }
  }

  private setLeadership(isLeader: boolean): void {
    if (this.isLeader === isLeader) {
      if (isLeader && this.realtimeEnabled && !this.socket) this.connect()
      return
    }
    this.isLeader = isLeader
    if (isLeader) {
      if (this.realtimeEnabled) this.connect()
      return
    }
    window.clearTimeout(this.reconnectTimer)
    window.clearInterval(this.heartbeatTimer)
    this.socket?.close()
    this.socket = null
  }


  private connect(): void {
    if (this.disposed || this.socket) return
    try {
      const url = new URL('/api/sync/ws', location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(url.toString())
      this.socket = socket

      socket.onopen = () => {
        if (this.disposed || !this.isLeader || this.socket !== socket) {
          socket.close()
          return
        }
        this.failures = 0
        this.lastPong = Date.now()
        this.startHeartbeat()

        this.schedulePull(50)
      }

      socket.onmessage = (event) => {
        if (this.disposed || this.socket !== socket) return
        let message: RealtimeMessage
        try {
          const parsed: unknown = JSON.parse(String(event.data))
          if (!isRealtimeMessage(parsed)) return
          message = parsed
        } catch {
          return
        }
        if (message.type === 'pong') {
          this.lastPong = Date.now()
          return
        }
        if (message.type === 'changed') {
          if (message.origin === CLIENT_ID) return
          if (message.cursor > useNotes.getState().cursor) this.schedulePull(180)
        }
      }

      socket.onclose = () => {
        if (this.socket !== socket) return
        this.socket = null
        window.clearInterval(this.heartbeatTimer)
        if (!this.disposed && this.isLeader) this.scheduleReconnect()
      }

      socket.onerror = () => {
        socket.close()
      }
    } catch {
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    this.failures += 1
    const exponent = Math.min(this.failures - 1, 16)
    const delay = Math.min(MAX_BACKOFF_MS, 800 * 2 ** exponent)
    window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay)
  }

  private startHeartbeat(): void {
    window.clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = window.setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) return
      if (Date.now() - this.lastPong > HEARTBEAT_MS * 3) {
        this.socket.close()
        return
      }
      this.socket.send(JSON.stringify({ type: 'ping' } satisfies RealtimeMessage))
    }, HEARTBEAT_MS)
  }


  private startPolling(): void {
    window.clearInterval(this.pollTimer)
    this.pollTimer = window.setInterval(() => {
      if (document.hidden || !this.isLeader) return

      const wsHealthy = this.socket?.readyState === WebSocket.OPEN
      if (wsHealthy && Date.now() - this.lastPong < HEARTBEAT_MS * 2) {
        if (Date.now() - this.lastPullAt < SAFETY_POLL_MS) return
      }
      void this.pull(true)
    }, this.pollIntervalMs)
  }

  private schedulePull(delay: number, shouldBroadcast = true): void {
    if (this.disposed) return
    this.scheduledPullShouldBroadcast ||= shouldBroadcast
    const dueAt = Date.now() + Math.max(0, delay)
    if (this.pullTimer && this.pullDueAt <= dueAt) return
    window.clearTimeout(this.pullTimer)
    this.pullDueAt = dueAt
    this.pullTimer = window.setTimeout(() => {
      this.pullTimer = 0
      this.pullDueAt = 0
      const announce = this.scheduledPullShouldBroadcast
      this.scheduledPullShouldBroadcast = false
      void this.pull(announce)
    }, delay)
  }

  private async pull(shouldBroadcast: boolean): Promise<void> {
    if (this.disposed) return
    const cursorBefore = useNotes.getState().cursor
    let pulled = false
    try {
      await useNotes.getState().pull()
      pulled = true
    } catch {

    }
    try {

      await useNotes.getState().replayPending()
    } catch {

    }
    if (pulled) {
      this.lastPullAt = Date.now()
      const cursor = useNotes.getState().cursor
      if (shouldBroadcast && cursor > cursorBefore) {
        this.broadcast.post({ type: 'pulled', cursor, clientId: CLIENT_ID })
      }
    }
  }

  private onVisibility = () => {
    if (!document.hidden) {
      this.schedulePull(120)
      if (this.isLeader && this.realtimeEnabled && !this.socket) this.connect()
    }
  }

  private onFocus = () => {
    this.claimLeadership()
    this.schedulePull(200)
  }

  private onOnline = () => {
    useNotes.getState().setOnline(true)
    this.failures = 0
    this.schedulePull(50)
    if (this.isLeader && this.realtimeEnabled) this.connect()
  }

  private onOffline = () => {
    useNotes.getState().setOnline(false)
  }


  private onPageHide = () => {
    void useNotes.getState().flush({ immediate: true })
  }
}

function isRealtimeMessage(value: unknown): value is RealtimeMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const message = value as Record<string, unknown>
  if (message.type === 'ping') return true
  if (message.type === 'pong') {
    return typeof message.serverTime === 'number' && Number.isFinite(message.serverTime)
  }
  return message.type === 'changed' &&
    typeof message.cursor === 'number' &&
    Number.isSafeInteger(message.cursor) &&
    message.cursor >= 0 &&
    (message.origin === null || typeof message.origin === 'string')
}

function compareClaims(
  left: { clientId: string; at: number },
  right: { clientId: string; at: number },
): number {
  return left.at - right.at || left.clientId.localeCompare(right.clientId)
}

export function useSyncEngine(): void {
  const realtime = useSession((s) => s.site?.realtimeEnabled ?? false)
  const enabled = useSession((s) => s.settings.sync.realtime)
  const interval = useSession((s) => s.settings.sync.pollIntervalMs)
  const bootstrap = useNotes((s) => s.bootstrap)
  const realtimeEnabled = realtime && enabled
  const engineRef = useRef<SyncEngine | null>(null)

  // The engine is created exactly once; later setting changes are pushed
  // through updateConfig instead of rebuilding the whole engine.
  useEffect(() => {
    let disposed = false
    void bootstrap()
      .catch(() => {

      })
      .then(() => {
        if (disposed) return
        const state = useSession.getState()
        engineRef.current = new SyncEngine(
          Boolean(state.site?.realtimeEnabled) && state.settings.sync.realtime,
          Math.max(5000, state.settings.sync.pollIntervalMs),
        )
        engineRef.current.start()
      })

    return () => {
      disposed = true
      engineRef.current?.dispose()
      engineRef.current = null
    }
  }, [bootstrap])

  useEffect(() => {
    engineRef.current?.updateConfig(realtimeEnabled, interval)
  }, [realtimeEnabled, interval])
}

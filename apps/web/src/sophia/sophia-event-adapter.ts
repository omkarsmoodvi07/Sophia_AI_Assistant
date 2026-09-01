import type {
  UIStreamEvent,
  UIRuntimeDeltaEvent,
  UIRuntimeSnapshotEvent,
  UIStreamRunAcceptedEvent,
  UIStreamErrorEvent,
} from '@/composables/api/useChat.types'

import { SophiaBehaviourEngine } from './sophia-behaviour.js'

export class SophiaEventAdapter {
  private behaviour: SophiaBehaviourEngine

  constructor(behaviour: SophiaBehaviourEngine) {
    this.behaviour = behaviour
  }

  handle(event: UIStreamEvent) {
    switch (event.type) {
      case 'run_accepted':
        this.handleRunAccepted(event)
        break

      case 'runtime_snapshot':
        this.handleRuntimeSnapshot(event)
        break

      case 'runtime_delta':
        this.handleRuntimeDelta(event)
        break

      case 'error':
        this.handleError(event)
        break

      case 'run_rejected':
        this.behaviour.idle()
        break

      default:
        break
    }
  }

  private handleRunAccepted(
    event: UIStreamRunAcceptedEvent,
  ) {
    console.log(
      '[Sophia] Run accepted:',
      event.run_id,
    )

    this.behaviour.thinking()
  }

  private handleRuntimeSnapshot(
    event: UIRuntimeSnapshotEvent,
  ) {
    const run = event.snapshot.current_run_view

    if (!run) {
      this.behaviour.idle()
      return
    }

    this.handleRunStatus(run.status)

    this.inspectMessages(run.messages)
  }

  private handleRuntimeDelta(
    event: UIRuntimeDeltaEvent,
  ) {
    const delta = event.delta

    if (delta.run?.status) {
      this.handleRunStatus(delta.run.status)
    }

    if (delta.current_run_view) {
      this.handleRunStatus(
        delta.current_run_view.status,
      )
    }

    if (delta.message_appends?.length) {
      const hasText = delta.message_appends.some(
        message => message.type === 'text',
      )

      if (hasText) {
        this.behaviour.speaking()
      }
    }

    if (delta.message_upserts?.length) {
      this.inspectMessages(
        delta.message_upserts,
      )
    }
  }

  private handleRunStatus(
    status:
      | 'admitting'
      | 'running'
      | 'waiting_decision'
      | 'aborting'
      | 'completed'
      | 'aborted'
      | 'errored'
      | 'lost',
  ) {
    switch (status) {
      case 'admitting':
      case 'running':
        this.behaviour.thinking()
        break

      case 'waiting_decision':
        this.behaviour.thinking()
        break

      case 'completed':
        this.behaviour.onAssistantEnd()
        break

      case 'aborted':
      case 'errored':
      case 'lost':
        this.behaviour.idle()
        break

      case 'aborting':
        this.behaviour.thinking()
        break
    }
  }

  private inspectMessages(
    messages: Array<{
      type: string
      content?: string
    }>,
  ) {
    for (const message of messages) {
      if (
        message.type === 'text' &&
        message.content?.trim()
      ) {
        this.behaviour.speaking()
      }
    }
  }

  private handleError(
    event: UIStreamErrorEvent,
  ) {
    console.error(
      '[Sophia] Runtime error:',
      event.message,
    )

    this.behaviour.idle()
  }
}

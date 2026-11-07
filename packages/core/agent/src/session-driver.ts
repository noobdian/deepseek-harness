/** Optional external runtime for complete, text-only Session turns. */
import type { ModelSelection } from './types.ts'
import type { Session } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** External conversation owned by this Session, never inherited from a fork. */
    'session/driver-bound': { provider: string; threadId?: string }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionDriver: SessionDriver
  }
}

/** A discoverable model in an external runtime's account catalog. */
export interface SessionDriverModel {
  id: string
  name: string
  reasoning: { efforts: { id: string; name: string }[]; defaultEffort: string }
}

/** Plugin responsible for an external model catalog and full conversation turns. */
export interface SessionDriver {
  readonly provider: string
  readonly displayName: string
  /** Discover picker entries under the active account.
   * @returns model ids and their available reasoning efforts.
   */
  listModels(): Promise<SessionDriverModel[]>
  /** Complete one turn, preserving the remote conversation across Host restarts.
   * @param session - owner of the remote conversation binding.
   * @param selection - model and reasoning effort captured at turn start.
   * @param input - admitted text in message order.
   * @param signal - interruption or driver disposal.
   * @returns the completed assistant answer.
   */
  run(session: Session, selection: ModelSelection, input: string[], signal: AbortSignal): Promise<string>
}

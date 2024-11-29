import { Context, SessionFlavor } from 'grammy'
import { FileFlavor } from '@grammyjs/files'

import OpenAI from 'openai'

export enum ResponseTypes {
    Text = 'text',
    Dice = 'dice',
    Action = 'action'
}

export enum Actions {
    StartNewGame = 'START_NEW_GAME',
    RollDice = 'ROLL_DICE'
}

export interface SessionData {
    chatMessages: OpenAI.ChatCompletionMessageParam[]
}

// Transformative Context flavor
export type MyContext = FileFlavor<Context> & SessionFlavor<SessionData>

export interface TextResponse {
    type: ResponseTypes.Text
    voice: OpenAI.Audio.SpeechCreateParams['voice']
    text: string
    role: string
}

export interface DiceResponse {
    type: ResponseTypes.Dice
    role: string
    skill: string
    base: number
    result: number
}

// TODO: enum с экшонами
export interface ActionResponse {
    type: ResponseTypes.Action
    action: Actions
}

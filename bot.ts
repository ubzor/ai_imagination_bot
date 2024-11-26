import fs from 'node:fs'

import 'dotenv/config'

import { Bot, session, InputFile } from 'grammy'
import { hydrateFiles } from '@grammyjs/files'
import { FileAdapter } from '@grammyjs/storage-file'

import OpenAI from 'openai'

import {
    ResponseTypes,
    Actions,
    type TextResponse,
    type ActionResponse,
    type DiceResponse,
    type MyContext
} from './types'

// TODO: заюзать Local Bot API Server
// @see https://grammy.dev/guide/api#running-a-local-bot-api-server

// TODO: lazy sessions

class ImaginationBot {
    #bot: Bot<MyContext>
    #openai: OpenAI

    isReady = false

    constructor() {
        this.init()
    }

    async init() {
        await this.initOpenAI()
        await this.initBot()

        this.isReady = true
    }

    async initOpenAI() {
        if (!process.env.AI_API_TOKEN) {
            throw new Error('AI_API_TOKEN is not defined')
        }

        this.#openai = new OpenAI({ baseURL: 'https://api.proxyapi.ru/openai/v1', apiKey: process.env.AI_API_TOKEN })
    }

    async initBot() {
        if (!process.env.TELEGRAM_BOT_TOKEN) {
            throw new Error('TELEGRAM_BOT_TOKEN is not defined')
        }

        this.#bot = new Bot<MyContext>(process.env.TELEGRAM_BOT_TOKEN)
        this.#bot.api.config.use(hydrateFiles(this.#bot.token))

        this.#bot.use(
            session({
                initial: () => ({
                    chatMessages: []
                }),
                storage: new FileAdapter({
                    dirName: 'sessions'
                })
            })
        )

        this.#bot.command('start', async (ctx) => {
            await this.handleStartCommand(ctx)
        })

        // triggered on new text message
        this.#bot.on('message:text', async (ctx) => {
            await this.handleTextMessage(ctx)
        })

        // triggered when voice message is received
        this.#bot.on('message:voice', async (ctx) => {
            await this.handleVoiceMessage(ctx)
        })

        this.#bot.start()
    }

    async handleStartCommand(ctx: MyContext) {
        this.startNewGame(ctx)
    }

    async handleTextMessage(ctx: MyContext) {
        try {
            await this.processTextMessage(ctx)
            await this.doTheChitChat(ctx)
            await this.sendTextReply(ctx)
            await this.sendVoiceReply(ctx)
            await this.dispatchActions(ctx)

            // TODO: отправлять дополнительно картинку
        } catch (error: any) {
            console.log(error)

            // TODO: выводить сообщения ошибок пользователю
        }
    }

    async handleVoiceMessage(ctx: MyContext) {
        try {
            await this.processVoice(ctx)
            await this.doTheChitChat(ctx)
            await this.sendTextReply(ctx)
            await this.sendVoiceReply(ctx)
            await this.dispatchActions(ctx)

            // TODO: отправлять дополнительно картинку
        } catch (error: any) {
            console.log(error)

            // TODO: выводить сообщения ошибок пользователю
        }
    }

    // get voice file from ctx, transcribe it and store text to session
    async processVoice(ctx: MyContext) {
        try {
            const messageId = this.messageId(ctx)

            // save voice message to temporary file
            const file = await ctx.getFile()
            const path = await file.download(`/tmp/${messageId}.ogg`)

            // getting voice message transcription
            const { text } = await this.#openai.audio.transcriptions.create({
                file: fs.createReadStream(path),
                model: 'whisper-1'
            })

            // deleting temporary file
            fs.unlinkSync(path)

            if (!text) {
                throw new Error('No transcription text')
            }

            // TODO: пропускать через коррекцию текста

            // add transcribed message to session
            ctx.session.chatMessages.push({ role: 'user', content: text })
        } catch (error: any) {
            console.log(error)
        }
    }

    async processTextMessage(ctx: MyContext) {
        // TODO: проверять введённый текст на валидность

        if (!ctx.message?.text) {
            throw new Error('No text message')
        }

        // add text message to session
        ctx.session.chatMessages.push({ role: 'user', content: ctx.message.text })
    }

    async textToVoiceFile(input: string, path: string, voice: OpenAI.Audio.SpeechCreateParams['voice'] = 'shimmer') {
        try {
            const mp3 = await this.#openai.audio.speech.create({
                model: 'tts-1',
                voice,
                input
            })

            const buffer = Buffer.from(await mp3.arrayBuffer())

            await fs.promises.writeFile(path, buffer)
        } catch (error: any) {
            console.log(error)
        }
    }

    // generates text answer based on session data and stores it to session
    async doTheChitChat(ctx: MyContext) {
        try {
            // generating answer text
            const completion = await this.#openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [
                    {
                        role: 'system',
                        content: `
                            Ты выступаешь в роли ведущего в ролевой игре.
                            Твои сообщения должны содержать строго только массив формата JSON с несколькими видами объектов.

                            Первый вид объектов (используется по умолчанию):

                                {
                                    type: 'text',
                                    voice: 'код голоса',
                                    role: 'имя персонажа/название роли, русскими буквами',
                                    text - 'фразы рассказчика и NPC'
                                }

                                У рассказчика голос всегда 'nova'
                                
                                другие роли используют один из пяти голосов:
                                
                                    ['echo', 'fable', 'onyx'] - для мужских голосов (от низкого к высокому)
                                    
                                    ['alloy', 'shimmer'] - для женских голосов (пониже и повыше)

                            Eсли игрок хочет начать новую игру, ему нужно зачитать предупреждение о том что
                            данные текущей игры будут потеряны и спросить готов ли он продолжить (используя первый тип объектов).

                            Второй вид объектов (используется если нужно выполнить действие):

                                {
                                    type: 'action',
                                    action: 'START_NEW_GAME' | 'ROLL_DICE'
                                }

                                название действия может быть одним из следующих:

                                    если игрок прослушал предупреждение исоглашается с началом новой игры, используем:

                                        START_NEW_GAME

                                    если игрок хочет совершить действие, зависящее от его характеристик или удачи:

                                        ROLL_DICE

                            Третий тип объектов (используется если нужно вывести результаты броска кубика):

                                {
                                    type: 'dice',
                                    role: 'имя персонажа/название роли, русскими буквами, который кидал кубик',
                                    result: 'результат броска кубика'
                                }

                            Учитывать броски кубика при определении результата действий игроков,
                            зависящих от их характеристик или удачи,
                            ранжировать их по шкале от 1 (оглушительный провал) до 20 (полный успех),
                            при этом чем больше компетенция персонажа в данной области,
                            тем меньшее количество ему нужно будет выкинуть для успешного выполнения действия.

                            Если использовались броски кубика, то нужно добавить это в массив данных,
                            выводимых в следующем сообщении (используя третий тип объектов)
                        `
                            .replace(/\s+/g, ' ')
                            .trim()
                    },
                    ...ctx.session.chatMessages
                ]
            })

            if (!completion.choices[0].message || !completion.choices[0].message.content?.replace(/\s+/g, ' ').trim()) {
                throw new Error('No text message')
            }

            // add answer text to session
            ctx.session.chatMessages.push({
                ...completion.choices[0].message,
                content: completion.choices[0].message.content?.replace(/\s+/g, ' ')
            })
        } catch (error: any) {
            console.log(error)
        }
    }

    // returns last answer phrases array
    lastAnswerPhrases(ctx: MyContext) {
        // converting answer text to correct JSON string
        const trimmedMessageContent = (ctx.session.chatMessages[ctx.session.chatMessages.length - 1].content as string)
            .replaceAll('```json', '')
            .replaceAll('```', '')
            .replaceAll('\n', '')

        // getting phrases from JSON
        const phrases: (TextResponse | ActionResponse)[] = JSON.parse(trimmedMessageContent)

        return phrases
    }

    lastAnswerTextPhrases(ctx: MyContext) {
        return this.lastAnswerPhrases(ctx).filter(({ type }) =>
            [ResponseTypes.Text, ResponseTypes.Dice].includes(type)
        ) as (TextResponse | DiceResponse)[]
    }

    lastAnswerActionPhrases(ctx: MyContext) {
        return this.lastAnswerPhrases(ctx).filter(({ type }) => type === ResponseTypes.Action) as ActionResponse[]
    }

    // returns current message id
    messageId(ctx: MyContext) {
        const messageId = ctx.message?.message_id

        if (!messageId) {
            throw new Error('No message id')
        }
    }

    // sends text reply to user based on last answer
    async sendTextReply(ctx: MyContext) {
        // formatting reply text
        const answer = this.lastAnswerTextPhrases(ctx)
            .map((phrase) =>
                phrase.type === ResponseTypes.Text
                    ? phrase.voice === 'nova'
                        ? // narrator text
                          phrase.text
                        : // npc text
                          `
                        <blockquote>
                            <strong>${phrase.role}:</strong>
                            ${phrase.text}
                        </blockquote>
                    `
                    : // dice roll result text
                      `
                        <blockquote>
                            <strong>${phrase.role}:</strong>
                            выбросил ${phrase.result}
                        </blockquote>
                    `
            )
            .join('\n')
            .replace(/\s+/g, ' ')
            .trim()

        if (!answer) return

        // sending text reply
        await ctx.reply(answer, { parse_mode: 'HTML' })
    }

    async sendVoiceReply(ctx: MyContext) {
        const phrases = this.lastAnswerTextPhrases(ctx)
        const messageId = this.messageId(ctx)

        // generating voice replies
        const voiceFiles = await Promise.all(
            phrases.map(async (phrase, index) => {
                const replyPath = `/tmp/${messageId}_reply_${index}.mp3`
                await this.textToVoiceFile(
                    phrase.type === ResponseTypes.Dice ? `${phrase.role}: выбросил ${phrase.result}` : phrase.text,
                    replyPath,
                    phrase.type === ResponseTypes.Dice ? 'nova' : phrase.voice
                )

                return new InputFile(replyPath)
            })
        )

        // sending voice replies
        for (const voiceFile of voiceFiles) {
            await ctx.replyWithVoice(voiceFile)
        }

        // deleting temporary voice files
        phrases.forEach((_, index) => {
            fs.unlinkSync(`/tmp/${messageId}_reply_${index}.mp3`)
        })
    }

    async dispatchActions(ctx: MyContext) {
        // get last answer action phrases
        const actionPhrases = this.lastAnswerActionPhrases(ctx)

        if (actionPhrases.find(({ action }) => action === Actions.StartNewGame)) {
            // start new game
            await this.startNewGame(ctx)
        }

        if (actionPhrases.filter(({ action }) => action === Actions.RollDice).length) {
            await this.rollTheDices(ctx)
        }
    }

    async startNewGame(ctx: MyContext) {
        ctx.session.chatMessages = []

        // TODO: давать вводную инструкцию

        return await ctx.reply('Hi!')
    }

    async rollTheDices(ctx: MyContext) {
        // get roll count
        const rollCount = this.lastAnswerActionPhrases(ctx).filter(({ action }) => action === Actions.RollDice).length

        // rolling dices
        const dices = Array.from({ length: rollCount }, () => Math.floor(Math.random() * 20) + 1)

        ctx.session.chatMessages.push(
            // setting dice results
            {
                role: 'system',
                content: `На кубик${dices.length > 1 ? 'ах' : 'е'} выпало: ${dices.join(', ')}`
            },
            // continuing the game
            {
                role: 'user',
                content: `Продолжаем игру с учётом броска кубик${dices.length > 1 ? 'ов' : 'а'}`
            }
        )

        await this.doTheChitChat(ctx)
        await this.sendTextReply(ctx)
        await this.sendVoiceReply(ctx)
        await this.dispatchActions(ctx)
    }
}

export { ImaginationBot as Bot }

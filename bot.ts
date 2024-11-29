import fs from 'node:fs'

import { parse } from 'yaml'
import { compileFile, type compileTemplate as CompileTemplate } from 'pug'

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

    #diceRollCompiler: CompileTemplate
    #characterTextCompiler: CompileTemplate
    #narratorTextCompiler: CompileTemplate

    #initialPrompt: string

    tmpDirectory = '/tmp'

    isReady = false
    numbers: Record<string, string> = {}

    isVoiceReplyEnabled = true
    isTextReplyEnabled = true

    constructor() {
        this.init()
    }

    async init() {
        // setting tmp directory
        if (process.env.TMP_DIRECTORY) {
            this.tmpDirectory = process.env.TMP_DIRECTORY
        }

        // setting isVoiceReplyEnabled
        if (process.env.VOICE_REPLY_ENABLED === 'false') {
            this.isVoiceReplyEnabled = false
        }

        // setting isTextReplyEnabled
        if (process.env.TEXT_REPLY_ENABLED === 'false') {
            this.isTextReplyEnabled = false
        }

        // loading initial prompt
        this.#initialPrompt = fs.readFileSync('./prompt.txt', 'utf8').replace(/\s+/g, ' ').trim()

        // loading ['1' => 'один', ...] conversion data
        this.numbers = parse(fs.readFileSync('./numbers.yaml', 'utf8'))

        // init dice roll template compiler
        this.#diceRollCompiler = compileFile('./templates/diceRoll.pug')

        // init text reply template compiler
        this.#characterTextCompiler = compileFile('./templates/characterText.pug')

        // init narrator text reply template compiler
        this.#narratorTextCompiler = compileFile('./templates/narratorText.pug')

        await this.initOpenAI()
        await this.initBot()

        this.isReady = true
    }

    async initOpenAI() {
        if (!process.env.AI_API_TOKEN) {
            throw new Error('AI_API_TOKEN is not defined')
        }

        if (!process.env.AI_API_URL) {
            throw new Error('AI_API_URL is not defined')
        }

        // initializing openai api
        this.#openai = new OpenAI({ baseURL: process.env.AI_API_URL, apiKey: process.env.AI_API_TOKEN })
    }

    async initBot() {
        if (!process.env.TELEGRAM_BOT_TOKEN) {
            throw new Error('TELEGRAM_BOT_TOKEN is not defined')
        }

        // initializing telegram bot
        this.#bot = new Bot<MyContext>(process.env.TELEGRAM_BOT_TOKEN)

        // configuring files
        this.#bot.api.config.use(hydrateFiles(this.#bot.token))

        // configuring session storage
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

        // triggered on start command
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

        // starting bot
        this.#bot.start()
    }

    async handleStartCommand(ctx: MyContext) {
        this.startNewGame(ctx)
    }

    async handleTextMessage(ctx: MyContext) {
        try {
            await this.processTextMessage(ctx)
            await this.processChatAndResponses(ctx)

            // TODO: отправлять дополнительно картинку
        } catch (error: any) {
            console.log(error)

            // TODO: выводить сообщения ошибок пользователю
        }
    }

    async handleVoiceMessage(ctx: MyContext) {
        try {
            await this.processVoice(ctx)
            await this.processChatAndResponses(ctx)

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
            const path = await file.download(`${this.tmpDirectory}/${messageId}.ogg`)

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

    async processChatAndResponses(ctx: MyContext) {
        await this.doTheChitChat(ctx)

        if (this.isTextReplyEnabled) {
            await this.sendTextReply(ctx)
        }

        if (this.isVoiceReplyEnabled) {
            await this.sendVoiceReply(ctx)
        }

        await this.dispatchActions(ctx)
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
                        content: this.#initialPrompt
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
                          this.#narratorTextCompiler(phrase)
                        : // npc text
                          this.#characterTextCompiler(phrase)
                    : // dice roll result text
                      this.#diceRollCompiler({ ...phrase, sum: phrase.result + phrase.base })
            )
            .join('\n')

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
                // temp file path
                const replyPath = `${this.tmpDirectory}/${messageId}_reply_${index}.mp3`

                // generating voice reply
                await this.textToVoiceFile(
                    phrase.type === ResponseTypes.Dice
                        ? `${phrase.role} при проверке навыка ${phrase.skill} выбросил ${
                              this.numbers[phrase.result.toString()]
                          } плюс ${phrase.base} итого ${phrase.result + phrase.base}`
                        : phrase.text,
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
            fs.unlinkSync(`${this.tmpDirectory}/${messageId}_reply_${index}.mp3`)
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
            // roll the dice(s)
            await this.rollTheDices(ctx)
        }
    }

    async startNewGame(ctx: MyContext) {
        ctx.session.chatMessages = [
            {
                role: 'system',
                content: 'Пользователь ознакомился с предупреждением и подтвердил начало новой игры'
            },
            {
                role: 'user',
                content: 'Начинаем игру! Расскажи о своём предназначении и предложи дальнейшие шаги.'
            }
        ]

        await this.processChatAndResponses(ctx)
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

        await this.processChatAndResponses(ctx)
    }
}

export { ImaginationBot as Bot }

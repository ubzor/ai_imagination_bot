import fs from 'node:fs'

import 'dotenv/config'

import { Bot, Context, session, SessionFlavor, InputFile, InputMediaBuilder } from 'grammy'
import { FileFlavor, hydrateFiles } from '@grammyjs/files'
import { FileAdapter } from '@grammyjs/storage-file'

import OpenAI from 'openai'

// TODO: заюзать Local Bot API Server
// @see https://grammy.dev/guide/api#running-a-local-bot-api-server

// TODO: lazy sessions

interface SessionData {
    chatMessages: OpenAI.ChatCompletionMessageParam[]
}

if (!process.env.TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is not defined')
}

if (!process.env.AI_API_TOKEN) {
    throw new Error('AI_API_TOKEN is not defined')
}

// Transformative Context flavor
type MyContext = FileFlavor<Context> & SessionFlavor<SessionData>

const voiceFileToText = async (path: string) => {
    try {
        const { text } = await openai.audio.transcriptions.create({
            file: fs.createReadStream(path),
            model: 'whisper-1'
        })

        fs.unlinkSync(path)

        return text
    } catch (error: any) {
        console.log(error)
    }
}

const textToVoiceFile = async (
    input: string,
    path: string,
    voice: OpenAI.Audio.SpeechCreateParams['voice'] = 'shimmer'
) => {
    try {
        const mp3 = await openai.audio.speech.create({
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

const generateText = async (session: SessionData) => {
    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: `
                            Ты выступаешь в роли ведущего в ролевой игре.
                            Твои сообщения должны содержать строго только массив формата JSON
                            с объектами содержащими поля voice и text - фразы рассказчика и NPC.
                            У рассказчика голос всегда "nova"
                            другие роли используют один из оставшихся пяти голосов:
                            "echo", "fable" и "onyx" - для мужских голосов (от низкого к высокому)
                            "alloy", "shimmer" - для женских голосов (пониже и повыше)
                        `
                },
                ...session.chatMessages
            ]
        })

        return completion.choices[0].message
    } catch (error: any) {
        console.log(error)
    }
}

const openai = new OpenAI({ baseURL: 'https://api.proxyapi.ru/openai/v1', apiKey: process.env.AI_API_TOKEN })

const bot = new Bot<MyContext>(process.env.TELEGRAM_BOT_TOKEN)

bot.api.config.use(hydrateFiles(bot.token))

bot.use(
    session({
        initial: () => ({
            chatMessages: []
        }),
        storage: new FileAdapter({
            dirName: 'sessions'
        })
    })
)

bot.command('start', async (ctx) => {
    return await ctx.reply('Hi!')
})

bot.on('message:text', async (ctx) => {
    return await ctx.reply('Hi there!')
})

// triggered when voice message is received
bot.on('message:voice', async (ctx) => {
    try {
        // save voice message to temporary file
        const file = await ctx.getFile()
        const path = await file.download(`/tmp/${file.file_id}.ogg`)

        // getting voice message transcription
        const transcriptionText = await voiceFileToText(path)

        if (!transcriptionText) {
            throw new Error('No transcription text')
        }

        // TODO: пропускать через коррекцию текста

        // add transcribed message to session
        ctx.session.chatMessages.push({ role: 'user', content: transcriptionText })

        // generating answer text
        const message = await generateText(ctx.session)

        if (!message || !message.content) {
            throw new Error('No text message')
        }

        // add generated message to session
        ctx.session.chatMessages.push(message)

        const trimmedMessageContent = message.content
            .replaceAll('```json', '')
            .replaceAll('```', '')
            .replaceAll('\n', '')

        const phrases: { voice: OpenAI.Audio.SpeechCreateParams['voice']; text: string }[] =
            JSON.parse(trimmedMessageContent)

        const answer = phrases
            .map(({ text, voice }) =>
                voice === 'nova'
                    ? text
                    : `
                    <blockquote>
                        <strong>${voice}:</strong>
                        ${text}
                    </blockquote>
                `
            )
            .join('\n')

        await ctx.reply(answer, { parse_mode: 'HTML' })

        const voiceFiles = await Promise.all(
            phrases.map(async ({ voice, text }, index) => {
                const replyPath = `/tmp/${file.file_id}_reply_${index}.mp3`
                await textToVoiceFile(text, replyPath, voice)

                return new InputFile(replyPath)
            })
        )

        for (const voiceFile of voiceFiles) {
            await ctx.replyWithVoice(voiceFile)
        }

        phrases.forEach((_, index) => {
            fs.unlinkSync(`/tmp/${file.file_id}_reply_${index}.mp3`)
        })

        // TODO: отправлять пользователю одновременно текст и аудио
        // TODO: отправлять дополнительно картинку
    } catch (error: any) {
        console.log(error)

        // TODO: выводить сообщения ошибок пользователю
    }
})

bot.start()

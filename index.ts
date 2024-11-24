import 'dotenv/config'

import fetch, { fileFrom } from 'node-fetch'

import { Bot, Context, session, SessionFlavor } from 'grammy'
import { FileFlavor, hydrateFiles } from '@grammyjs/files'
import { FileAdapter } from '@grammyjs/storage-file'

// TODO: заюзать Local Bot API Server
// @see https://grammy.dev/guide/api#running-a-local-bot-api-server

interface SessionData {
    // counter: number;
}

if (!process.env.TOKEN) {
    throw new Error('TOKEN is not defined')
}

// Transformative Context flavor
type MyContext = FileFlavor<Context> & SessionFlavor<SessionData>

const bot = new Bot<MyContext>(process.env.TOKEN)

bot.api.config.use(hydrateFiles(bot.token))

bot.use(
    session({
        initial: () => ({
            // counter: 0,
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
    console.log(`User sent a message: ${ctx.update.message.text}`)
    return await ctx.reply('Hi there!')
})

bot.on('message:voice', async (ctx) => {
    console.log(`User sent a voice message`, ctx.update.message.voice)

    const file = await ctx.getFile()
    const path = await file.download()
    console.log('File saved at ', path)

    const formData = new FormData()
    formData.append('audio_file', await fileFrom(path))

    try {
        const response = await fetch('http://localhost:9000/asr', {
            method: 'POST',
            headers: {},
            body: formData
        })

        console.log(await response.text())
    } catch (error: any) {
        console.log(`Error: ${error}`)
    }

    // TODO: удалять скачанный файл

    // return await ctx.replyWithVoice()
})

bot.start()

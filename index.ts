import { Bot, Context } from 'grammy'
import { FileFlavor, hydrateFiles } from '@grammyjs/files'

import 'dotenv/config'

if (!process.env.TOKEN) {
    throw new Error('TOKEN is not defined')
}

// Transformative Context flavor
type MyContext = FileFlavor<Context>

const bot = new Bot<MyContext>(process.env.TOKEN)

bot.api.config.use(hydrateFiles(bot.token))

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

    // or file.getUrl()
})

bot.start()

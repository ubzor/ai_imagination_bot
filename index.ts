import { Bot } from 'grammy'
import 'dotenv/config'

if (!process.env.TOKEN) {
    throw new Error('TOKEN is not defined')
}

const bot = new Bot(process.env.TOKEN) // <-- put your bot token between the "" (https://t.me/BotFather)

bot.command('start', (ctx) => {
    return ctx.reply('Hi!')
})

// Reply to any message with "Hi there!".
bot.on('message', (ctx) => {
    console.log(`User sent a message: ${ctx.update.message.text}`)
    return ctx.reply('Hi there!')
})

bot.start()

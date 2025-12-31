import { serve } from '@hono/node-server'
import app from './app.js'
import config from './src/config.js'

const server = serve({
    fetch: app.fetch,
    port: config.PORT
}, (info) => {
    console.log(`🚀 服务器运行在 http://localhost:${info.port}`)
})

let isShuttingDown = false

const shutdown = async () => {
    if (isShuttingDown) return
    isShuttingDown = true
    
    console.log('\n🛑 正在关闭服务器...')
   
    server.close(async (err) => {
        if (err) {
            console.error('关闭服务器失败:', err)
            process.exit(1)
        }
        
        console.log('✅ 服务器已关闭')
        
        if (app.cleanup) {
            try {
                await app.cleanup()
            } catch (error) {
                console.error('清理失败:', error)
            }
        }
        
        setTimeout(() => {
            process.exit(0)
        }, 100)
    })
    
    setTimeout(() => {
        console.error('关闭超时，强制退出')
        process.exit(1)
    }, 10000)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

process.on('uncaughtException', (error) => {
    console.error('未处理的异常:', error)
    shutdown()
})

process.on('unhandledRejection', (reason) => {
    console.error('未处理的Promise拒绝:', reason)
    shutdown()
})
import api from './src/service/api.js'
import { handler } from './src/template.js'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { cors } from 'hono/cors'
import config from './src/config.js'
import { get_runtime, get_url } from './src/util.js'

const app = new Hono()

app.use('*', cors())
app.use('*', logger())
app.get('/api', api)
app.get('/test', handler)

app.get('/', (c) => {
    const currentTime = new Date().toLocaleString('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        weekday: 'long',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    })

    const runtime = get_runtime()
    const baseUrl = get_url(c)
    
    const getApiUrl = () => {
        const protocol = c.req.header('X-Forwarded-Proto') || 'https' 
        const host = c.req.header('Host') || new URL(c.req.url).host 
        
        let base = `${protocol}://${host}`  
        
        const currentPath = new URL(c.req.url).pathname 
        
        if (currentPath.startsWith('/meting')) {
            return `${base}/api`
        } else {
            return `${base}/meting/api`
        }
    }
    
    const apiUrl = getApiUrl()
    
    const getTestUrl = () => {
        const protocol = c.req.header('X-Forwarded-Proto') || 'https'
        const host = c.req.header('Host') || new URL(c.req.url).host
        let base = `${protocol}://${host}`
        const currentPath = new URL(c.req.url).pathname
        
        if (currentPath.startsWith('/meting')) {
            return `${base}/test`
        } else {
            return `${base}/meting/test`
        }
    }
    
    const testUrl = getTestUrl()
    
    const getCorrectBaseUrl = () => {
        const protocol = c.req.header('X-Forwarded-Proto') || 'https'
        const host = c.req.header('Host') || new URL(c.req.url).host
        return `${protocol}://${host}`
    }
    
    const correctBaseUrl = getCorrectBaseUrl()
    
    return c.html(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>初叶🍂Meting API</title> 
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
            min-height: 100vh;
            color: #333;
            line-height: 1.6;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 2rem;
        }
        
        header {
            text-align: center;
            margin-bottom: 3rem;
            padding: 2rem;
            background: rgba(255, 255, 255, 0.9);
            border-radius: 20px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.1);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.2);
        }
        
        .logo {
            font-size: 3.5rem;
            margin-bottom: 1rem;
            animation: float 3s ease-in-out infinite;
        }
        
        h1 {
            font-size: 2.5rem;
            color: #2c3e50;
            margin-bottom: 0.5rem;
            background: linear-gradient(45deg, #3498db, #2ecc71);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        
        .tagline {
            font-size: 1.2rem;
            color: #7f8c8d;
            margin-bottom: 1rem;
        }
        
        .version-badge {
            display: inline-block;
            background: linear-gradient(45deg, #ff7e5f, #feb47b);
            color: white;
            padding: 0.5rem 1rem;
            border-radius: 50px;
            font-size: 0.9rem;
            font-weight: bold;
            margin-bottom: 1rem;
        }
        
        .info-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 1.5rem;
            margin-bottom: 3rem;
        }
        
        .info-card {
            background: rgba(255, 255, 255, 0.9);
            padding: 1.5rem;
            border-radius: 15px;
            box-shadow: 0 5px 15px rgba(0, 0, 0, 0.08);
            transition: transform 0.3s ease, box-shadow 0.3s ease;
            border: 1px solid rgba(255, 255, 255, 0.2);
        }
        
        .info-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.15);
        }
        
        .info-card h3 {
            color: #3498db;
            margin-bottom: 1rem;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }
        
        .info-card h3::before {
            content: '📋';
            font-size: 1.2rem;
        }
        
        .info-item {
            margin-bottom: 1rem;
            padding-bottom: 1rem;
            border-bottom: 1px solid #eee;
        }
        
        .info-item:last-child {
            border-bottom: none;
            margin-bottom: 0;
            padding-bottom: 0;
        }
        
        .label {
            font-weight: 600;
            color: #555;
            margin-bottom: 0.25rem;
        }
        
        .value {
            color: #2c3e50;
            word-break: break-all;
        }
        
        .status-badge {
            display: inline-block;
            padding: 0.25rem 0.75rem;
            border-radius: 20px;
            font-size: 0.85rem;
            font-weight: 600;
            margin-left: 0.5rem;
        }
        
        .status-online {
            background: linear-gradient(45deg, #2ecc71, #27ae60);
            color: white;
        }
        
        .status-local {
            background: linear-gradient(45deg, #3498db, #2980b9);
            color: white;
        }
        
        .actions {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1.5rem;
            margin-top: 2rem;
        }
        
        .action-card {
            background: rgba(255, 255, 255, 0.9);
            padding: 2rem;
            border-radius: 15px;
            text-align: center;
            box-shadow: 0 5px 15px rgba(0, 0, 0, 0.08);
            transition: all 0.3s ease;
            border: 1px solid rgba(255, 255, 255, 0.2);
        }
        
        .action-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 15px 30px rgba(0, 0, 0, 0.15);
            background: white;
        }
        
        .action-icon {
            font-size: 3rem;
            margin-bottom: 1rem;
        }
        
        .action-card h3 {
            color: #2c3e50;
            margin-bottom: 1rem;
        }
        
        .action-card p {
            color: #7f8c8d;
            margin-bottom: 1.5rem;
            font-size: 0.95rem;
        }
        
        .btn {
            display: inline-block;
            padding: 0.75rem 1.5rem;
            background: linear-gradient(45deg, #3498db, #2980b9);
            color: white;
            text-decoration: none;
            border-radius: 50px;
            font-weight: 600;
            transition: all 0.3s ease;
            border: none;
            cursor: pointer;
            font-size: 1rem;
        }
        
        .btn:hover {
            transform: scale(1.05);
            box-shadow: 0 5px 15px rgba(52, 152, 219, 0.4);
        }
        
        .btn-api {
            background: linear-gradient(45deg, #9b59b6, #8e44ad);
        }
        
        .btn-api:hover {
            box-shadow: 0 5px 15px rgba(155, 89, 182, 0.4);
        }
        
        .btn-test {
            background: linear-gradient(45deg, #2ecc71, #27ae60);
        }
        
        .btn-test:hover {
            box-shadow: 0 5px 15px rgba(46, 204, 113, 0.4);
        }
        
        footer {
            text-align: center;
            margin-top: 3rem;
            padding: 2rem;
            color: #7f8c8d;
            font-size: 0.9rem;
            background: rgba(255, 255, 255, 0.8);
            border-radius: 15px;
            border: 1px solid rgba(255, 255, 255, 0.2);
        }
        
        .time-display {
            font-size: 1.1rem;
            color: #e74c3c;
            font-weight: 600;
            margin-top: 0.5rem;
        }
        
        @keyframes float {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-10px); }
        }
        
        @media (max-width: 768px) {
            .container {
                padding: 1rem;
            }
            
            h1 {
                font-size: 2rem;
            }
            
            .logo {
                font-size: 2.5rem;
            }
            
            .info-grid {
                grid-template-columns: 1fr;
            }
            
            .actions {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <header style="text-align: center; margin-bottom: 3rem; padding: 2rem; background: rgba(255, 255, 255, 0.9); border-radius: 20px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.1); backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.2);">
            <div style="font-size: 3.5rem; margin-bottom: 1rem; animation: float 3s ease-in-out infinite; display: flex; justify-content: center; align-items: center;">
                <img src="https://cloud.chuyel.top/f/PkZsP/tu%E5%B7%B2%E5%8E%BB%E5%BA%95.png" 
                     alt="初叶Logo" 
                     style="width: 80px; height: 80px; border-radius: 50%; object-fit: cover; border: 4px solid rgba(255, 255, 255, 0.3); box-shadow: 0 8px 25px rgba(0, 0, 0, 0.15); background: linear-gradient(45deg, #fff, #f5f7fa); padding: 3px; animation: float 3s ease-in-out infinite;">
            </div>
            <h1 style="font-size: 2.5rem; color: #2c3e50; margin-bottom: 0.5rem; background: linear-gradient(45deg, #3498db, #2ecc71); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;">初叶 Meting API</h1>
            <p style="font-size: 1.2rem; color: #7f8c8d; margin-bottom: 1rem;">初叶MetingAPI-1.3.4</p>
            <div style="display: inline-block; background: linear-gradient(45deg, #ff7e5f, #feb47b); color: white; padding: 0.5rem 1rem; border-radius: 50px; font-size: 0.9rem; font-weight: bold; margin-bottom: 1rem;">版本 v1.3.4</div>
        </header>
        
        <div class="info-grid">
            <div class="info-card">
                <h3>系统信息</h3>
                <div class="info-item">
                    <div class="label">运行环境</div>
                    <div class="value">
                        ${runtime}
                        <span class="status-badge ${runtime.includes('Node') ? 'status-online' : 'status-local'}">
                            ${runtime.includes('Node') ? '生产环境' : '开发环境'}
                        </span>
                    </div>
                </div>
                <div class="info-item">
                    <div class="label">服务端口</div>
                    <div class="value">${config.PORT}</div>
                </div>
                <div class="info-item">
                    <div class="label">部署地区</div>
                    <div class="value">
                        ${config.OVERSEAS ? '海外服务器' : '中国大陆服务器'}
                        <span class="status-badge ${config.OVERSEAS ? 'status-local' : 'status-online'}">
                            ${config.OVERSEAS ? '海外' : '大陆'}
                        </span>
                    </div>
                </div>
                <!-- 修复后的API地址项 -->
                <div class="info-item">
                    <div class="label">API地址</div>
                    <div class="value">
                        <a href="${apiUrl}" style="color: #3498db; text-decoration: none; word-break: break-all;">${apiUrl}</a>
                        <br>
                    </div>
                </div>
            </div>
            
            <div class="info-card">
                <h3>服务状态</h3>
                <div class="info-item">
                    <div class="label">当前时间</div>
                    <div class="value time-display">${currentTime}</div>
                </div>
                <div class="info-item">
                    <div class="label">API 状态</div>
                    <div class="value">
                        <span class="status-badge status-online">运行正常</span>
                    </div>
                </div>
                <div class="info-item">
                    <div class="label">访问地址</div>
                    <div class="value">
                        <a href="${c.req.url}" style="color: #3498db; text-decoration: none;">${c.req.url}</a>
                    </div>
                </div>
                <div class="info-item">
                    <div class="label">实际地址</div>
                    <div class="value">
                        <a href="${correctBaseUrl}" style="color: #3498db; text-decoration: none;">${correctBaseUrl}</a>
                    </div>
                </div>
            </div>
        </div>
        
        <div class="actions">
            <div class="action-card">
                <div class="action-icon">🔧</div>
                <h3>测试接口</h3>
                <p>验证服务是否正常运行，查看基本响应信息</p>
                <a href="${testUrl}" class="btn btn-test">前往测试</a>
            </div>
            
<div class="action-card">
    <div class="action-icon">
        <img src="https://cloud.chuyel.top/f/PkZsP/tu%E5%B7%B2%E5%8E%BB%E5%BA%95.png"
             alt="底下三栏第二个图标"
             style="width: 60px; height: 60px; border-radius: 50%; object-fit: cover; border: 2px solid rgba(255, 255, 255, 0.3);">
    </div>
    <h3>初叶🍂网站</h3>
    <p>该项目作者的官方网站</p>
    <a href="https://www.chuyel.top" class="btn btn-api" target="_blank">点击访问</a>
</div>
            
            <div class="action-card">
                <div class="action-icon">📚</div>
                <h3>文档</h3>
                <p>查看 API 使用文档和示例代码</p>
                <button class="btn" onclick="alert('文档功能开发中...')">查看文档</button>
            </div>
        </div>
        
        <footer>
            <p>© 2024-2025 初叶 Meting API | 提供稳定可靠的API支持</p>
            <p>如有问题，请查看文档或联系技术支持</p>
        </footer>
    </div>
    
    <script>
        // 实时更新时间
        function updateTime() {
            const now = new Date();
            const options = {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                weekday: 'long',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            };
            const timeStr = now.toLocaleString('zh-CN', options);
            const timeElement = document.querySelector('.time-display');
            if (timeElement) {
                timeElement.textContent = timeStr;
            }
        }
        
        // 每秒更新一次时间
        setInterval(updateTime, 1000);
        
        // 添加简单的页面加载动画
        document.addEventListener('DOMContentLoaded', function() {
            const cards = document.querySelectorAll('.info-card, .action-card');
            cards.forEach((card, index) => {
                card.style.opacity = '0';
                card.style.transform = 'translateY(20px)';
                
                setTimeout(() => {
                    card.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
                    card.style.opacity = '1';
                    card.style.transform = 'translateY(0)';
                }, index * 100);
            });
        });
    </script>
</body>
</html>
    `)
})

export default app

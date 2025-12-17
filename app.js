import api from './src/service/api.js'
import { handler } from './src/template.js'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { cors } from 'hono/cors'
import config from './src/config.js'
import { get_runtime, get_url } from './src/util.js'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'

const app = new Hono()

const STATS_FILE = './stats.json'

let apiStats = {
    totalCalls: 0,
    dailyCalls: {},
    hourlyCalls: {},
    lastUpdated: new Date().toISOString(),
    lastResetDate: new Date().toISOString().split('T')[0]
};

const checkAndResetDailyStats = () => {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    
    console.log(`🔍 检查日期: 当前日期=${today}, 上次重置日期=${apiStats.lastResetDate}`);
    
    if (today !== apiStats.lastResetDate) {
        console.log(`🔄 日期已变化！重置今日统计：${apiStats.lastResetDate} -> ${today}`);
        
        apiStats.lastResetDate = today;
        
        if (!apiStats.dailyCalls[today]) {
            apiStats.dailyCalls[today] = 0;
        }
        
        const twoDaysAgo = new Date(now);
        twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
        const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];
        
        Object.keys(apiStats.hourlyCalls).forEach(key => {
            const date = key.split('-')[0];
            if (date < twoDaysAgoStr) {
                delete apiStats.hourlyCalls[key];
            }
        });
        
        saveStats().then(() => {
            console.log('💾 日期变化已保存');
        }).catch(err => {
            console.error('❌ 保存日期变化失败:', err);
        });
        
        return true;
    }
    
    return false;
};

const loadStats = async () => {
    try {
        if (existsSync(STATS_FILE)) {
            const data = await fs.readFile(STATS_FILE, 'utf8')
            const savedStats = JSON.parse(data)
            
            apiStats.totalCalls = savedStats.totalCalls || 0
            apiStats.dailyCalls = savedStats.dailyCalls || {}
            apiStats.hourlyCalls = savedStats.hourlyCalls || {}
            apiStats.lastUpdated = savedStats.lastUpdated || new Date().toISOString()
            apiStats.lastResetDate = savedStats.lastResetDate || new Date().toISOString().split('T')[0]
            
            console.log('✅ 统计数据加载成功')
            console.log(`📊 当前统计：总调用=${apiStats.totalCalls}, 上次重置=${apiStats.lastResetDate}`)
            
            const resetHappened = checkAndResetDailyStats();
            if (resetHappened) {
                console.log('🔄 启动时检测到日期变化，今日统计已重置');
            }
        }
    } catch (error) {
        console.log('📝 创建新的统计文件')
        await saveStats()
    }
}

const saveStats = async () => {
    try {
        apiStats.lastUpdated = new Date().toISOString()
        await fs.writeFile(STATS_FILE, JSON.stringify(apiStats, null, 2), 'utf8')
        console.log('💾 统计数据已保存')
    } catch (error) {
        console.error('❌ 保存统计数据失败:', error)
    }
}

const updateStats = async () => {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const hour = now.getHours();
    
    console.log(`📝 更新统计: 日期=${today}, 小时=${hour}`);
    
    checkAndResetDailyStats();
    
    apiStats.totalCalls++;
    console.log(`📈 总调用次数增加: ${apiStats.totalCalls}`);
    
    apiStats.dailyCalls[today] = (apiStats.dailyCalls[today] || 0) + 1;
    console.log(`📅 今日调用次数: ${apiStats.dailyCalls[today]}`);
    
    const hourKey = `${today}-${hour}`;
    apiStats.hourlyCalls[hourKey] = (apiStats.hourlyCalls[hourKey] || 0) + 1;
    
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];
    
    Object.keys(apiStats.dailyCalls).forEach(date => {
        if (date < thirtyDaysAgoStr) {
            delete apiStats.dailyCalls[date];
        }
    });
    
    const twoDaysAgo = new Date(now);
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];
    
    Object.keys(apiStats.hourlyCalls).forEach(key => {
        const date = key.split('-')[0];
        if (date < twoDaysAgoStr) {
            delete apiStats.hourlyCalls[key];
        }
    });
    
    await saveStats();
    
    return apiStats;
};

const getTodayCalls = () => {
    const today = new Date().toISOString().split('T')[0];
    
    checkAndResetDailyStats();
    
    return apiStats.dailyCalls[today] || 0;
};

const getNextResetTime = () => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    
    const timeDiff = tomorrow.getTime() - now.getTime();
    const hours = Math.floor(timeDiff / (1000 * 60 * 60));
    const minutes = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((timeDiff % (1000 * 60)) / 1000);
    
    return {
        time: tomorrow.toLocaleString('zh-CN'),
        hours,
        minutes,
        seconds,
        formatted: `${hours}小时${minutes}分${seconds}秒后`
    };
};

loadStats();

app.use('/api', async (c, next) => {
    await next();
    if (c.res.status === 200) {
        await updateStats();
    }
});

app.use('*', async (c, next) => {
    checkAndResetDailyStats();
    await next();
});

app.use('*', cors())
app.use('*', logger())
app.get('/api', api)
app.get('/test', handler)

app.get('/stats', (c) => {
    const today = new Date().toISOString().split('T')[0];
    const todayCalls = apiStats.dailyCalls[today] || 0;
    const nextReset = getNextResetTime();
    
    checkAndResetDailyStats();
    
    return c.json({
        success: true,
        data: {
            totalCalls: apiStats.totalCalls,
            todayCalls: todayCalls,
            dailyStats: apiStats.dailyCalls,
            hourlyStats: apiStats.hourlyCalls,
            lastUpdated: apiStats.lastUpdated,
            lastResetDate: apiStats.lastResetDate,
            nextReset: nextReset.time,
            timeToReset: nextReset.formatted,
            resetInfo: "总调用次数永不重置，今日调用每天00:00自动重置",
            timestamp: new Date().toISOString()
        }
    });
});

app.post('/stats/reset-today', async (c) => {
    const today = new Date().toISOString().split('T')[0];
    
    apiStats.dailyCalls[today] = 0;
    apiStats.lastResetDate = today;
    
    await saveStats();
    return c.json({ 
        success: true, 
        message: '今日统计已重置',
        resetDate: today,
        totalCalls: apiStats.totalCalls,
        todayCalls: 0
    });
});

app.post('/stats/reset-all', async (c) => {
    const today = new Date().toISOString().split('T')[0];
    
    apiStats = {
        totalCalls: 0,
        dailyCalls: {},
        hourlyCalls: {},
        lastUpdated: new Date().toISOString(),
        lastResetDate: today
    };
    
    await saveStats();
    return c.json({ 
        success: true, 
        message: '所有统计数据已重置',
        warning: '总调用次数也被重置了！'
    });
});

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
    
    checkAndResetDailyStats();
    
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
    
    const today = new Date().toISOString().split('T')[0];
    const totalCalls = apiStats.totalCalls;
    const todayCalls = apiStats.dailyCalls[today] || 0;
    const lastUpdated = new Date(apiStats.lastUpdated).toLocaleString('zh-CN');
    const nextReset = getNextResetTime();
    
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
            transition: background-color 0.3s ease, color 0.3s ease, border-color 0.3s ease;
        }
        
        /* 深色主题变量 */
        :root {
            --bg-gradient: linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.5)), 
                          url('https://api.boxmoe.com/random.php?size=mw1024') no-repeat center center fixed;
            --bg-overlay: rgba(0, 0, 0, 0.4);
            --header-bg: rgba(255, 255, 255, 0.15);
            --card-bg: rgba(255, 255, 255, 0.15);
            --card-bg-hover: rgba(255, 255, 255, 0.2);
            --text-primary: #ffffff;
            --text-secondary: rgba(255, 255, 255, 0.9);
            --text-muted: rgba(255, 255, 255, 0.8);
            --border-color: rgba(255, 255, 255, 0.2);
            --shadow-color: rgba(0, 0, 0, 0.3);
            --accent-color: #3498db;
            --accent-hover: #2980b9;
            --success-color: #2ecc71;
            --warning-color: #ff6b6b;
            --btn-primary: linear-gradient(45deg, #3498db, #2980b9);
            --btn-success: linear-gradient(45deg, #2ecc71, #27ae60);
            --btn-purple: linear-gradient(45deg, #9b59b6, #8e44ad);
            --btn-orange: linear-gradient(45deg, #ff7e5f, #feb47b);
            --stat-total: #3498db;
            --stat-today: #2ecc71;
        }
        
        /* 浅色主题变量 */
        [data-theme="light"] {
            --bg-gradient: linear-gradient(rgba(255, 255, 255, 0.8), rgba(255, 255, 255, 0.8)), 
                          url('https://api.boxmoe.com/random.php?size=mw1024') no-repeat center center fixed;
            --bg-overlay: rgba(255, 255, 255, 0.4);
            --header-bg: rgba(255, 255, 255, 0.9);
            --card-bg: rgba(255, 255, 255, 0.85);
            --card-bg-hover: rgba(255, 255, 255, 0.95);
            --text-primary: #2c3e50;
            --text-secondary: #34495e;
            --text-muted: #7f8c8d;
            --border-color: rgba(0, 0, 0, 0.1);
            --shadow-color: rgba(0, 0, 0, 0.15);
            --accent-color: #3498db;
            --accent-hover: #2980b9;
            --success-color: #2ecc71;
            --warning-color: #e74c3c;
            --btn-primary: linear-gradient(45deg, #3498db, #2980b9);
            --btn-success: linear-gradient(45deg, #2ecc71, #27ae60);
            --btn-purple: linear-gradient(45deg, #9b59b6, #8e44ad);
            --btn-orange: linear-gradient(45deg, #ff7e5f, #feb47b);
            --stat-total: #3498db;
            --stat-today: #2ecc71;
        }
        
        body {
            font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
            background: var(--bg-gradient);
            background-size: cover;
            min-height: 100vh;
            color: var(--text-primary);
            line-height: 1.6;
            position: relative;
        }
        
        body::before {
            content: '';
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: var(--bg-overlay);
            z-index: -1;
        }
        
        /* 主题切换按钮 */
        .theme-toggle {
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 1000;
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 50px;
            padding: 8px 16px;
            backdrop-filter: blur(10px);
            box-shadow: 0 4px 15px var(--shadow-color);
            display: flex;
            align-items: center;
            gap: 8px;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        
        .theme-toggle:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px var(--shadow-color);
        }
        
        .theme-toggle span {
            font-size: 0.9rem;
            font-weight: 600;
            color: var(--text-primary);
        }
        
        .theme-icon {
            font-size: 1.2rem;
            transition: transform 0.3s ease;
        }
        
        [data-theme="light"] .theme-icon.sun {
            display: none;
        }
        
        [data-theme="light"] .theme-icon.moon {
            display: inline;
        }
        
        [data-theme="dark"] .theme-icon.sun {
            display: inline;
        }
        
        [data-theme="dark"] .theme-icon.moon {
            display: none;
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
            background: var(--header-bg);
            border-radius: 20px;
            box-shadow: 0 10px 30px var(--shadow-color);
            backdrop-filter: blur(10px);
            border: 1px solid var(--border-color);
        }
        
        .logo {
            font-size: 3.5rem;
            margin-bottom: 1rem;
            animation: float 3s ease-in-out infinite;
        }
        
        h1 {
            font-size: 2.5rem;
            color: var(--text-primary);
            margin-bottom: 0.5rem;
            text-shadow: 0 2px 10px var(--shadow-color);
        }
        
        .tagline {
            font-size: 1.2rem;
            color: var(--text-secondary);
            margin-bottom: 1rem;
            text-shadow: 0 1px 5px var(--shadow-color);
        }
        
        .version-badge {
            display: inline-block;
            background: var(--btn-orange);
            color: white;
            padding: 0.5rem 1rem;
            border-radius: 50px;
            font-size: 0.9rem;
            font-weight: bold;
            margin-bottom: 1rem;
            box-shadow: 0 4px 15px var(--shadow-color);
        }
        
        .info-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 1.5rem;
            margin-bottom: 3rem;
        }
        
        .info-card {
            background: var(--card-bg);
            padding: 1.5rem;
            border-radius: 15px;
            box-shadow: 0 5px 15px var(--shadow-color);
            transition: transform 0.3s ease, box-shadow 0.3s ease;
            border: 1px solid var(--border-color);
            backdrop-filter: blur(10px);
        }
        
        .info-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 15px 30px var(--shadow-color);
            background: var(--card-bg-hover);
        }
        
        .info-card h3 {
            color: var(--accent-color);
            margin-bottom: 1rem;
            display: flex;
            align-items: center;
            gap: 0.5rem;
            text-shadow: 0 1px 5px var(--shadow-color);
        }
        
        .info-card h3::before {
            content: '📋';
            font-size: 1.2rem;
        }
        
        .info-item {
            margin-bottom: 1rem;
            padding-bottom: 1rem;
            border-bottom: 1px solid var(--border-color);
        }
        
        .info-item:last-child {
            border-bottom: none;
            margin-bottom: 0;
            padding-bottom: 0;
        }
        
        .label {
            font-weight: 600;
            color: var(--text-secondary);
            margin-bottom: 0.25rem;
            text-shadow: 0 1px 3px var(--shadow-color);
        }
        
        .value {
            color: var(--text-primary);
            word-break: break-all;
            text-shadow: 0 1px 3px var(--shadow-color);
        }
        
        .value a {
            color: var(--accent-color);
            text-decoration: none;
            text-shadow: none;
        }
        
        .value a:hover {
            color: var(--accent-hover);
        }
        
        .status-badge {
            display: inline-block;
            padding: 0.25rem 0.75rem;
            border-radius: 20px;
            font-size: 0.85rem;
            font-weight: 600;
            margin-left: 0.5rem;
            box-shadow: 0 2px 8px var(--shadow-color);
        }
        
        .status-online {
            background: var(--btn-success);
            color: white;
        }
        
        .status-local {
            background: var(--btn-primary);
            color: white;
        }
        
        .actions {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1.5rem;
            margin-top: 2rem;
        }
        
        .action-card {
            background: var(--card-bg);
            padding: 2rem;
            border-radius: 15px;
            text-align: center;
            box-shadow: 0 5px 15px var(--shadow-color);
            transition: all 0.3s ease;
            border: 1px solid var(--border-color);
            backdrop-filter: blur(10px);
        }
        
        .action-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 20px 40px var(--shadow-color);
            background: var(--card-bg-hover);
        }
        
        .action-icon {
            font-size: 3rem;
            margin-bottom: 1rem;
            filter: drop-shadow(0 2px 5px var(--shadow-color));
        }
        
        .action-card h3 {
            color: var(--text-primary);
            margin-bottom: 1rem;
            text-shadow: 0 1px 5px var(--shadow-color);
        }
        
        .action-card p {
            color: var(--text-secondary);
            margin-bottom: 1.5rem;
            font-size: 0.95rem;
            text-shadow: 0 1px 3px var(--shadow-color);
        }
        
        .btn {
            display: inline-block;
            padding: 0.75rem 1.5rem;
            background: var(--btn-primary);
            color: white;
            text-decoration: none;
            border-radius: 50px;
            font-weight: 600;
            transition: all 0.3s ease;
            border: none;
            cursor: pointer;
            font-size: 1rem;
            box-shadow: 0 4px 15px var(--shadow-color);
        }
        
        .btn:hover {
            transform: scale(1.05);
            box-shadow: 0 6px 20px rgba(52, 152, 219, 0.4);
        }
        
        .btn-api {
            background: var(--btn-purple);
        }
        
        .btn-api:hover {
            box-shadow: 0 6px 20px rgba(155, 89, 182, 0.4);
        }
        
        .btn-test {
            background: var(--btn-success);
        }
        
        .btn-test:hover {
            box-shadow: 0 6px 20px rgba(46, 204, 113, 0.4);
        }
        
        footer {
            text-align: center;
            margin-top: 3rem;
            padding: 2rem;
            color: var(--text-muted);
            font-size: 0.9rem;
            background: var(--card-bg);
            border-radius: 15px;
            border: 1px solid var(--border-color);
            backdrop-filter: blur(10px);
        }
        
        .time-display {
            font-size: 1.1rem;
            color: var(--warning-color);
            font-weight: 600;
            margin-top: 0.5rem;
            text-shadow: 0 1px 5px var(--shadow-color);
        }
        
        .stats-container {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-top: 10px;
        }
        
        .stat-item {
            text-align: center;
            flex: 1;
        }
        
        .stat-number {
            font-size: 1.5rem;
            font-weight: bold;
            margin-bottom: 5px;
            text-shadow: 0 2px 8px var(--shadow-color);
        }
        
        .stat-label {
            font-size: 0.85rem;
            color: var(--text-secondary);
            text-shadow: 0 1px 3px var(--shadow-color);
        }
        
        .stat-total {
            color: var(--stat-total);
        }
        
        .stat-today {
            color: var(--stat-today);
        }
        
        .stat-divider {
            width: 1px;
            height: 40px;
            background: var(--border-color);
            margin: 0 20px;
        }
        
        @keyframes float {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-10px); }
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        .spinning {
            animation: spin 0.5s linear;
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
            
            .theme-toggle {
                top: 10px;
                right: 10px;
                padding: 6px 12px;
            }
            
            .info-grid {
                grid-template-columns: 1fr;
            }
            
            .actions {
                grid-template-columns: 1fr;
            }
            
            .stats-container {
                flex-direction: column;
            }
            
            .stat-item {
                margin-bottom: 15px;
            }
            
            .stat-divider {
                display: none;
            }
        }
    </style>
</head>
<body>
    <!-- 主题切换按钮 -->
    <div class="theme-toggle" id="themeToggle" title="切换深色/浅色模式">
        <span class="theme-icon sun">🌞</span>
        <span class="theme-icon moon">🌙</span>
        <span id="themeText">深色模式</span>
    </div>
    
    <div class="container">
        <header style="text-align: center; margin-bottom: 3rem; padding: 2rem; background: var(--header-bg); border-radius: 20px; box-shadow: 0 10px 30px var(--shadow-color); backdrop-filter: blur(10px); border: 1px solid var(--border-color);">
            <div style="font-size: 3.5rem; margin-bottom: 1rem; animation: float 3s ease-in-out infinite; display: flex; justify-content: center; align-items: center;">
                <img src="https://cloud.chuyel.top/f/PkZsP/tu%E5%B7%B2%E5%8E%BB%E5%BA%95.png" 
                     alt="初叶Logo" 
                     style="width: 80px; height: 80px; border-radius: 50%; object-fit: cover; border: 4px solid var(--border-color); box-shadow: 0 8px 25px var(--shadow-color); background: var(--card-bg); padding: 3px; animation: float 3s ease-in-out infinite;">
            </div>
            <h1 style="font-size: 2.5rem; color: var(--text-primary); margin-bottom: 0.5rem; text-shadow: 0 2px 10px var(--shadow-color);">初叶🍂Meting API</h1>
            <p style="font-size: 1.2rem; color: var(--text-secondary); margin-bottom: 1rem; text-shadow: 0 1px 5px var(--shadow-color);">初叶🍂Meting API-1.3.8</p>
            <div style="display: inline-block; background: var(--btn-orange); color: white; padding: 0.5rem 1rem; border-radius: 50px; font-size: 0.9rem; font-weight: bold; margin-bottom: 1rem; box-shadow: 0 4px 15px var(--shadow-color);">版本 v1.3.8</div>
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
                <div class="info-item">
                    <div class="label">API地址</div>
                    <div class="value">
                        <a href="${apiUrl}" style="color: var(--accent-color); text-decoration: none; word-break: break-all;">${apiUrl}</a>
                    </div>
                </div>
                <div class="info-item">
                    <div class="label">API 调用统计</div>
                    <div class="value">
                        <div class="stats-container">
                            <div class="stat-item">
                                <div class="stat-number stat-total">${totalCalls.toLocaleString()}</div>
                                <div class="stat-label">总调用次数</div>
                            </div>
                            <div class="stat-divider"></div>
                            <div class="stat-item">
                                <div class="stat-number stat-today">${todayCalls.toLocaleString()}</div>
                                <div class="stat-label">今日调用</div>
                            </div>
                        </div>
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
                    <div class="label">统计更新</div>
                    <div class="value">${lastUpdated}</div>
                </div>
                <div class="info-item">
                    <div class="label">访问地址</div>
                    <div class="value">
                        <a href="${c.req.url}" style="color: var(--accent-color); text-decoration: none;">${c.req.url}</a>
                    </div>
                </div>
                <div class="info-item">
                    <div class="label">实际地址</div>
                    <div class="value">
                        <a href="${correctBaseUrl}" style="color: var(--accent-color); text-decoration: none;">${correctBaseUrl}</a>
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
                         alt="初叶图标"
                         style="width: 60px; height: 60px; border-radius: 50%; object-fit: cover; border: 2px solid var(--border-color); box-shadow: 0 4px 15px var(--shadow-color);">
                </div>
                <h3>初叶🍂网站</h3>
                <p>该项目作者的官方网站</p>
                <a href="https://www.chuyel.top" class="btn btn-api" target="_blank">点击访问</a>
            </div>
            
            <div class="action-card">
                <div class="action-icon">📚</div>
                <h3>文档</h3>
                <p>查看 API 使用文档</p>
                <a href="https://www.chuyel.top/archives/472" class="btn" target="_blank">查看文档</a>
            </div>
        </div>
        
        <footer>
            <p>© 2024-2025 初叶🍂Meting API| 提供稳定可靠的API支持</p>
            <p>API调用统计：总 ${totalCalls.toLocaleString()} 次 | 今日 ${todayCalls.toLocaleString()} 次 | 下次重置：${nextReset.time}</p>
            <p>最后更新：${lastUpdated} | 如有问题，请查看文档或联系技术支持</p>
            <p style="margin-top: 10px; font-size: 0.8rem; color: var(--text-muted);">
                当前主题：<span id="currentTheme">深色模式</span>
            </p>
        </footer>
    </div>
    
    <script>
        // 主题切换功能
        const themeToggle = document.getElementById('themeToggle');
        const themeText = document.getElementById('themeText');
        const currentThemeSpan = document.getElementById('currentTheme');
        const html = document.documentElement;
        
        // 从localStorage获取保存的主题，或者根据系统偏好设置
        const savedTheme = localStorage.getItem('theme');
        const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        
        // 初始化主题
        function initTheme() {
            let theme = 'dark'; // 默认深色
            
            if (savedTheme) {
                theme = savedTheme;
            } else if (systemPrefersDark) {
                theme = 'dark';
            } else {
                theme = 'light';
            }
            
            applyTheme(theme);
        }
        
        // 应用主题
        function applyTheme(theme) {
            html.setAttribute('data-theme', theme);
            
            if (theme === 'light') {
                themeText.textContent = '浅色模式';
                currentThemeSpan.textContent = '浅色模式';
            } else {
                themeText.textContent = '深色模式';
                currentThemeSpan.textContent = '深色模式';
            }
            
            // 保存到localStorage
            localStorage.setItem('theme', theme);
            
            // 添加旋转动画
            const icon = themeToggle.querySelector('.theme-icon');
            icon.classList.add('spinning');
            setTimeout(() => {
                icon.classList.remove('spinning');
            }, 500);
            
            // 更新背景图片
            updateBackgroundImage();
        }
        
        // 切换主题
        function toggleTheme() {
            const currentTheme = html.getAttribute('data-theme') || 'dark';
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            applyTheme(newTheme);
        }
        
        // 更新背景图片
        function updateBackgroundImage() {
            const currentTheme = html.getAttribute('data-theme') || 'dark';
            const bgOverlay = currentTheme === 'dark' 
                ? 'linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.5))' 
                : 'linear-gradient(rgba(255, 255, 255, 0.8), rgba(255, 255, 255, 0.8))';
            
            document.body.style.background = bgOverlay + ', url("https://api.boxmoe.com/random.php?size=mw1024") no-repeat center center fixed';
            document.body.style.backgroundSize = 'cover';
        }
        
        // 事件监听
        themeToggle.addEventListener('click', toggleTheme);
        
        // 监听系统主题变化
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
            if (!savedTheme) { // 如果用户没有手动选择主题
                const newTheme = e.matches ? 'dark' : 'light';
                applyTheme(newTheme);
            }
        });
        
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
            // 初始化主题
            initTheme();
            
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
        
        // 每5分钟检查一次是否需要重置（客户端辅助）
        setInterval(() => {
            const now = new Date();
            const hours = now.getHours();
            const minutes = now.getMinutes();
            
            // 如果是00:00附近，刷新页面以获取最新统计
            if (hours === 0 && minutes < 5) {
                console.log('🕛 检测到00:00，刷新页面获取最新统计');
                window.location.reload();
            }
        }, 300000);
        
        // 添加键盘快捷键 (Ctrl+Shift+T 切换主题)
        document.addEventListener('keydown', function(e) {
            if (e.ctrlKey && e.shiftKey && e.key === 'T') {
                e.preventDefault();
                toggleTheme();
            }
        });
        
        // 背景图片加载完成后的处理
        window.addEventListener('load', function() {
            const bgImage = new Image();
            bgImage.src = 'https://api.boxmoe.com/random.php?size=mw1024';
            bgImage.onload = function() {
                console.log('🎨 背景图片加载完成');
                updateBackgroundImage();
            };
            bgImage.onerror = function() {
                console.log('⚠️ 背景图片加载失败，使用备用背景');
                document.body.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
                const currentTheme = html.getAttribute('data-theme') || 'dark';
                if (currentTheme === 'dark') {
                    document.body.style.background = 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)';
                } else {
                    document.body.style.background = 'linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%)';
                }
            };
        });
    </script>
</body>
</html>
    `)
})

export default app